import { describe, it, expect, afterEach, vi } from 'vitest'
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { fetchJwks, clearJwksCache } from '../src/jwt/jwks.ts'

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
