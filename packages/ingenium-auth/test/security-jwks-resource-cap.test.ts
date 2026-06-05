import { describe, it, expect, afterEach, vi } from 'vitest'
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { fetchJwks, clearJwksCache } from '../src/jwt/jwks.ts'

// Deterministic, offline DNS so the resolve-and-check guard treats our test
// hosts as public (and thus reaches the fetch + body parsing path). Hosts not
// named here throw ENOTFOUND, which the guard swallows.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async (host: string) => {
    if (host === 'issuer.example.com') return [{ address: '93.184.216.34', family: 4 }]
    const err = new Error('ENOTFOUND') as NodeJS.ErrnoException
    err.code = 'ENOTFOUND'
    throw err
  }),
}))

// ─────────────────────────────────────────────────────────────────────────────
// Resource caps for the JWKS fetcher (jwks.ts `doFetch` / `readBoundedText`).
//
// Even for an allowed (public-resolving, https) destination, a malicious or
// compromised IdP can hand back a body that OOMs / CPU-amplifies the process:
//   - a multi-GB streamed body that the 5s timeout doesn't bound by bytes, and
//   - a `keys` array with thousands of entries (one createPublicKey each).
//
// The fetcher must cap the buffered body at 1 MiB (streaming, abort on exceed;
// plus a cheap Content-Length pre-check) and reject keysets with > 100 keys.
// Both failures bubble as the same generic `jwks_fetch_failed`.
// ─────────────────────────────────────────────────────────────────────────────

const URL_OK = 'https://issuer.example.com/.well-known/jwks.json'

let rsa: { publicKey: KeyObject; privateKey: KeyObject } | null = null
function rsaJwk(): Record<string, unknown> {
  if (!rsa) rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return rsa.publicKey.export({ format: 'jwk' }) as Record<string, unknown>
}

describe('JWKS resource caps', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    clearJwksCache()
  })

  it('rejects a keyset with more than 100 keys (CPU / cache-bloat amplification)', async () => {
    const jwk = rsaJwk()
    // 101 well-formed-looking keys with distinct kids — over the MAX_JWKS_KEYS
    // cap of 100. Must be rejected outright, before any createPublicKey work.
    const keys = Array.from({ length: 101 }, (_, i) => ({
      ...jwk,
      kid: `k-${i}`,
      alg: 'RS256',
      use: 'sig',
    }))
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ keys }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    await expect(fetchJwks(URL_OK, 60_000)).rejects.toThrow('jwks_fetch_failed')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('accepts a keyset at exactly the 100-key cap (control: cap is an upper bound, not off-by-one)', async () => {
    const jwk = rsaJwk()
    const keys = Array.from({ length: 100 }, (_, i) => ({
      ...jwk,
      kid: `ok-${i}`,
      kty: 'RSA',
      alg: 'RS256',
      use: 'sig',
    }))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ keys }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const out = await fetchJwks(URL_OK, 60_000)
    expect(out.size).toBe(100)
  })

  it('rejects an honest oversized body via the Content-Length pre-check (no body read)', async () => {
    // A truthful Content-Length above 1 MiB must be rejected before a byte of
    // the stream is consumed. Body content is irrelevant here.
    const oversize = String(1024 * 1024 + 1)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ keys: [] }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': oversize,
        },
      }),
    )

    await expect(fetchJwks(URL_OK, 60_000)).rejects.toThrow('jwks_fetch_failed')
  })

  it('rejects a streamed body that exceeds the 1 MiB cap with a lying/absent Content-Length', async () => {
    // No (honest) Content-Length: the cap must be enforced by the streaming
    // reader, aborting once cumulative bytes cross 1 MiB. We emit 1 MiB + a bit
    // across several chunks. The reader should cancel before buffering it all.
    const CAP = 1024 * 1024
    const chunkSize = 256 * 1024
    const chunk = new Uint8Array(chunkSize).fill(0x61) // 'a'
    // Hard upper bound on how much we'll ever hand out. If the reader were
    // unbounded it would drain all of this; the cap must stop it well before.
    const MAX_EMIT = CAP * 8
    let emitted = 0

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted >= MAX_EMIT) {
          controller.close()
          return
        }
        controller.enqueue(chunk)
        emitted += chunkSize
      },
    })

    // Build a Response carrying our stream. Some runtimes refuse to construct a
    // Response from a stream without duplex hints; fall back to a plain object
    // exposing the `body`/`headers`/`ok` surface that readBoundedText touches.
    let res: Response
    try {
      res = new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    } catch {
      res = {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: stream,
        async text() {
          return ''
        },
      } as unknown as Response
    }

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(res)

    await expect(fetchJwks(URL_OK, 60_000)).rejects.toThrow('jwks_fetch_failed')
    // The reader must stop early rather than draining the whole body: it should
    // have aborted shortly after crossing the 1 MiB cap, NOT consumed MAX_EMIT.
    expect(emitted).toBeLessThan(MAX_EMIT)
    // Allow a small amount of stream-internal read-ahead (the queuing strategy
    // may pull one chunk past what the consumer has pulled) but it must abort
    // very near the cap — not anywhere close to the unbounded MAX_EMIT.
    expect(emitted).toBeLessThanOrEqual(CAP + 2 * chunkSize)
  })
})
