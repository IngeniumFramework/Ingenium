import { describe, it, expect, afterEach, vi } from 'vitest'
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { fetchJwks, clearJwksCache } from '../src/jwt/jwks.ts'

// Deterministic, offline DNS so the resolve-and-check guard can be exercised
// without touching a real resolver. Hosts not named here throw ENOTFOUND, which
// the guard swallows (an unresolvable host can't be connected to anyway).
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) => {
    if (host === 'resolves-to-metadata.example') return [{ address: '169.254.169.254', family: 4 }]
    if (host === 'resolves-to-private.example') return [{ address: '10.1.2.3', family: 4 }]
    if (host === 'resolves-to-public.example') return [{ address: '93.184.216.34', family: 4 }]
    const err = new Error('ENOTFOUND') as NodeJS.ErrnoException
    err.code = 'ENOTFOUND'
    throw err
  }),
}))

// ─────────────────────────────────────────────────────────────────────────────
// SSRF hardening for the JWKS fetcher (jwks.ts `doFetch`).
//
// The fetcher must refuse to issue a request for a destination that an
// attacker could use to pivot internally: non-https schemes (except a narrow
// localhost test allowance) and private/loopback/link-local literals. When it
// refuses, it bubbles the SAME generic `jwks_fetch_failed` error as any other
// failure, and — crucially — it must NOT call `fetch` at all for a blocked
// target.
// ─────────────────────────────────────────────────────────────────────────────

let rsa: { publicKey: KeyObject; privateKey: KeyObject } | null = null
function rsaKey(): KeyObject {
  if (!rsa) rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return rsa.publicKey
}

/** A well-formed JWKS body — used only for the should-succeed control case. */
function jwksResponse(kid: string): Response {
  const jwk = rsaKey().export({ format: 'jwk' }) as Record<string, unknown>
  const body = { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('JWKS SSRF guard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    clearJwksCache()
  })

  it('rejects a non-https, non-localhost URL without ever calling fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(
      fetchJwks('http://evil.example.com/.well-known/jwks.json', 60_000),
    ).rejects.toThrow('jwks_fetch_failed')

    // The guard must short-circuit BEFORE the network call.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects a private-IP (RFC1918) URL even over https, without calling fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    // 169.254.x is cloud-metadata land — the canonical SSRF target.
    await expect(
      fetchJwks('https://169.254.169.254/latest/meta-data/jwks.json', 60_000),
    ).rejects.toThrow('jwks_fetch_failed')
    // 10.x internal service.
    await expect(
      fetchJwks('https://10.0.0.5/.well-known/jwks.json', 60_000),
    ).rejects.toThrow('jwks_fetch_failed')

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects an IPv6 loopback literal over https without calling fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(
      fetchJwks('https://[::1]/.well-known/jwks.json', 60_000),
    ).rejects.toThrow('jwks_fetch_failed')

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects IPv4-mapped IPv6 literals (loopback / metadata / RFC1918) without calling fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    // These all carry colons, so the dotted-IPv4 regex never matched them and
    // the IPv6 prefix list didn't cover them — yet fetch routes them to the
    // embedded IPv4 host. The guard must normalize and block each.
    for (const host of [
      'https://[::ffff:127.0.0.1]/.well-known/jwks.json', // loopback
      'https://[::ffff:169.254.169.254]/latest/meta-data/x', // cloud metadata
      'https://[::ffff:10.0.0.5]/.well-known/jwks.json', // RFC1918
    ]) {
      await expect(fetchJwks(host, 60_000)).rejects.toThrow('jwks_fetch_failed')
    }

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects a hostname that RESOLVES to cloud metadata, without calling fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    // Literal check passes (it's a name, not an IP) — the resolve-and-check is
    // what must catch the host pointing at 169.254.169.254.
    await expect(
      fetchJwks('https://resolves-to-metadata.example/.well-known/jwks.json', 60_000),
    ).rejects.toThrow('jwks_fetch_failed')

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects a hostname that RESOLVES to RFC1918 space, without calling fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(
      fetchJwks('https://resolves-to-private.example/.well-known/jwks.json', 60_000),
    ).rejects.toThrow('jwks_fetch_failed')

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('allows a hostname that resolves to a public IP', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jwksResponse('pub-k1'))

    const keys = await fetchJwks('https://resolves-to-public.example/.well-known/jwks.json', 60_000)
    expect(keys.size).toBe(1)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('passes redirect:error + an abort signal through to fetch for an allowed https host', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jwksResponse('ok-k1'))

    const keys = await fetchJwks('https://issuer.example.com/.well-known/jwks.json', 60_000)
    expect(keys.size).toBe(1)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined
    expect(init?.redirect).toBe('error')
    // AbortSignal.timeout(...) yields an AbortSignal instance.
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })
})
