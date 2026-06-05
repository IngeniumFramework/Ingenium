import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import {
  constants as cryptoConstants,
  createHmac,
  createSign,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto'
import { Buffer } from 'node:buffer'
import { IngeniumContext } from '../src/context/context.ts'
import { IngeniumUnauthorizedError } from '../src/errors.ts'
import { jwtMiddleware } from '../src/jwt/middleware.ts'
import { verifyJwt } from '../src/jwt/verify.ts'
import { clearJwksCache } from '../src/jwt/jwks.ts'
import type { JwtAlgorithm, JwtVerified } from '../src/jwt/types.ts'

// ───── Helpers ──────────────────────────────────────────────────────────────

function b64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input
  return buf.toString('base64url')
}

function ctxWith(headers: Record<string, string | string[]> = {}): IngeniumContext {
  const c = new IngeniumContext()
  c.method = 'GET'
  c.headers = headers
  c.rawQuery = ''
  return c
}

const next = (): Promise<void> => Promise.resolve()

// verifyJwt now requires `exp` by default (requireExp). Sign helpers inject a
// valid far-future exp unless the test supplied its own, so tests keep
// exercising signature/alg/kid/JWKS behavior rather than tripping on expiry.
const withDefaultExp = (p: Record<string, unknown>): Record<string, unknown> =>
  'exp' in p ? p : { ...p, exp: Math.floor(Date.now() / 1000) + 60 }

/** Sign a JWT with an asymmetric key. Picks the right OpenSSL options per alg. */
function signAsym(
  payload: Record<string, unknown>,
  privateKey: KeyObject,
  alg: JwtAlgorithm,
  headerOverrides: Record<string, unknown> = {},
): string {
  const header = { alg, typ: 'JWT', ...headerOverrides }
  const headerB64 = b64url(JSON.stringify(header))
  const payloadB64 = b64url(JSON.stringify(withDefaultExp(payload)))
  const signingInput = `${headerB64}.${payloadB64}`

  const digest = alg.endsWith('256') ? 'sha256' : alg.endsWith('384') ? 'sha384' : 'sha512'

  let sig: Buffer
  if (alg.startsWith('RS')) {
    const s = createSign(digest)
    s.update(signingInput)
    sig = s.sign(privateKey)
  } else if (alg.startsWith('PS')) {
    const s = createSign(digest)
    s.update(signingInput)
    sig = s.sign({
      key: privateKey,
      padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
      saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
    })
  } else if (alg.startsWith('ES')) {
    const s = createSign(digest)
    s.update(signingInput)
    // Spec mandates raw r||s (not DER) on the wire.
    sig = s.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' })
  } else {
    throw new Error(`signAsym does not handle ${alg}`)
  }

  return `${signingInput}.${sig.toString('base64url')}`
}

/** Sign with HMAC — used for the algorithm-confusion test. */
function signHmac(
  payload: Record<string, unknown>,
  secret: string,
  alg: JwtAlgorithm,
  headerOverrides: Record<string, unknown> = {},
): string {
  const digest = alg.endsWith('256') ? 'sha256' : alg.endsWith('384') ? 'sha384' : 'sha512'
  const header = { alg, typ: 'JWT', ...headerOverrides }
  const headerB64 = b64url(JSON.stringify(header))
  const payloadB64 = b64url(JSON.stringify(withDefaultExp(payload)))
  const signingInput = `${headerB64}.${payloadB64}`
  const sig = createHmac(digest, secret).update(signingInput).digest('base64url')
  return `${signingInput}.${sig}`
}

// ───── Keypairs (cached for the suite — RSA gen is slow) ────────────────────

let rsa: { publicKey: KeyObject; privateKey: KeyObject }
let rsa2: { publicKey: KeyObject; privateKey: KeyObject }
let ec256: { publicKey: KeyObject; privateKey: KeyObject }
let ec384: { publicKey: KeyObject; privateKey: KeyObject }

beforeAll(() => {
  rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
  rsa2 = generateKeyPairSync('rsa', { modulusLength: 2048 })
  ec256 = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  ec384 = generateKeyPairSync('ec', { namedCurve: 'P-384' })
}, 30_000)

// ───── verifyJwt — direct asymmetric verification ───────────────────────────

describe('verifyJwt — asymmetric', () => {
  it('verifies an RS256 token', () => {
    const tok = signAsym({ sub: 'rs256-user' }, rsa.privateKey, 'RS256')
    const r = verifyJwt(tok, [rsa.publicKey], { algorithms: ['RS256'] })
    expect('error' in r).toBe(false)
    if ('error' in r) return
    expect((r.payload as { sub: string }).sub).toBe('rs256-user')
  })

  it('verifies an ES256 token', () => {
    const tok = signAsym({ sub: 'ec' }, ec256.privateKey, 'ES256')
    const r = verifyJwt(tok, [ec256.publicKey], { algorithms: ['ES256'] })
    expect('error' in r).toBe(false)
  })

  it('verifies an ES384 token', () => {
    const tok = signAsym({ sub: 'ec384' }, ec384.privateKey, 'ES384')
    const r = verifyJwt(tok, [ec384.publicKey], { algorithms: ['ES384'] })
    expect('error' in r).toBe(false)
  })

  it('verifies a PS256 token', () => {
    const tok = signAsym({ sub: 'pss' }, rsa.privateKey, 'PS256')
    const r = verifyJwt(tok, [rsa.publicKey], { algorithms: ['PS256'] })
    expect('error' in r).toBe(false)
  })

  it('rejects RS256 verified against a wrong public key', () => {
    const tok = signAsym({ sub: 'a' }, rsa.privateKey, 'RS256')
    const r = verifyJwt(tok, [rsa2.publicKey], { algorithms: ['RS256'] })
    expect('error' in r && r.error).toBe('bad_signature')
  })

  it('rejects `alg: "none"` even if forced into the allowlist', () => {
    const headerB64 = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))
    const payloadB64 = b64url(JSON.stringify({ sub: 'evil' }))
    const tok = `${headerB64}.${payloadB64}.AA`
    const r = verifyJwt(tok, ['anything'], { algorithms: ['none' as unknown as JwtAlgorithm] })
    expect('error' in r && r.error).toBe('unsupported_alg')
  })
})

// ───── jwtMiddleware — asymmetric path ──────────────────────────────────────

describe('jwtMiddleware — asymmetric', () => {
  it('verifies RS256 with a PEM string secret', async () => {
    const pem = rsa.publicKey.export({ format: 'pem', type: 'spki' }) as string
    const tok = signAsym({ sub: 'pem' }, rsa.privateKey, 'RS256')
    const mw = jwtMiddleware({ secret: pem, algorithms: ['RS256'], logger: () => {} })
    const c = ctxWith({ authorization: `Bearer ${tok}` })
    await expect(mw(c, next)).resolves.toBeUndefined()
    expect((c as IngeniumContext & { jwt?: JwtVerified }).jwt).toBeDefined()
  })

  it('verifies RS256 with a KeyObject secret', async () => {
    const tok = signAsym({ sub: 'ko' }, rsa.privateKey, 'RS256')
    const mw = jwtMiddleware({ secret: rsa.publicKey, algorithms: ['RS256'], logger: () => {} })
    const c = ctxWith({ authorization: `Bearer ${tok}` })
    await expect(mw(c, next)).resolves.toBeUndefined()
  })

  it('verifies ES256 via middleware', async () => {
    const tok = signAsym({ sub: 'ec' }, ec256.privateKey, 'ES256')
    const mw = jwtMiddleware({ secret: ec256.publicKey, algorithms: ['ES256'], logger: () => {} })
    const c = ctxWith({ authorization: `Bearer ${tok}` })
    await expect(mw(c, next)).resolves.toBeUndefined()
  })

  it('verifies PS256 via middleware', async () => {
    const tok = signAsym({ sub: 'pss' }, rsa.privateKey, 'PS256')
    const mw = jwtMiddleware({ secret: rsa.publicKey, algorithms: ['PS256'], logger: () => {} })
    const c = ctxWith({ authorization: `Bearer ${tok}` })
    await expect(mw(c, next)).resolves.toBeUndefined()
  })

  it('rejects RS256 signed with a different keypair (wrong key) → 401', async () => {
    const tok = signAsym({ sub: 'x' }, rsa.privateKey, 'RS256')
    const mw = jwtMiddleware({ secret: rsa2.publicKey, algorithms: ['RS256'], logger: () => {} })
    const c = ctxWith({ authorization: `Bearer ${tok}` })
    await expect(mw(c, next)).rejects.toBeInstanceOf(IngeniumUnauthorizedError)
  })

  // ─── Algorithm-confusion attack: HS256 token, RS256 allowlist ─────────────
  it('rejects an HS256-signed token when only RS256 is allowed', async () => {
    // Classic confusion attack: attacker signs an HS256 token using the
    // server's PUBLIC key as the HMAC secret. We must reject by alg.
    const pubPem = rsa.publicKey.export({ format: 'pem', type: 'spki' }) as string
    const tok = signHmac({ sub: 'attacker' }, pubPem, 'HS256')
    const mw = jwtMiddleware({ secret: rsa.publicKey, algorithms: ['RS256'], logger: () => {} })
    const c = ctxWith({ authorization: `Bearer ${tok}` })
    await expect(mw(c, next)).rejects.toBeInstanceOf(IngeniumUnauthorizedError)
  })

  it('rejects an RS256-signed token when only HS256 is allowed', async () => {
    const tok = signAsym({ sub: 'mismatch' }, rsa.privateKey, 'RS256')
    const mw = jwtMiddleware({ secret: 'irrelevant-hmac-secret', algorithms: ['HS256'], logger: () => {} })
    const c = ctxWith({ authorization: `Bearer ${tok}` })
    await expect(mw(c, next)).rejects.toBeInstanceOf(IngeniumUnauthorizedError)
  })

  // ─── kid-based key selection ─────────────────────────────────────────────
  it('selects the right key from an array based on header.kid', async () => {
    const tok = signAsym({ sub: 'kid-2' }, rsa2.privateKey, 'RS256', { kid: 'k2' })
    const mw = jwtMiddleware({
      secret: [
        { kid: 'k1', key: rsa.publicKey },
        { kid: 'k2', key: rsa2.publicKey },
      ],
      algorithms: ['RS256'],
      logger: () => {},
    })
    const c = ctxWith({ authorization: `Bearer ${tok}` })
    await expect(mw(c, next)).resolves.toBeUndefined()
    expect((c as IngeniumContext & { jwt?: JwtVerified }).jwt).toBeDefined()
  })

  it('refuses to verify with the wrong tagged key when header.kid points elsewhere', async () => {
    // Token signed by rsa2/k2 but presented to a server that only has rsa/k1
    // tagged. Even though k1 wouldn't verify, this also catches the bug
    // where we'd silently fall back to "try every key".
    const tok = signAsym({ sub: 'k2-signed' }, rsa2.privateKey, 'RS256', { kid: 'k2' })
    const mw = jwtMiddleware({
      secret: [{ kid: 'k1', key: rsa.publicKey }],
      algorithms: ['RS256'],
      logger: () => {},
    })
    const c = ctxWith({ authorization: `Bearer ${tok}` })
    await expect(mw(c, next)).rejects.toBeInstanceOf(IngeniumUnauthorizedError)
  })
})

// ───── JWKS fetching + caching ─────────────────────────────────────────────

describe('jwtMiddleware — JWKS', () => {
  const JWKS_URL = 'https://example.test/.well-known/jwks.json'

  beforeEach(() => {
    clearJwksCache()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    clearJwksCache()
  })

  function jwksResponse(kid: string, key: KeyObject): Response {
    const jwk = key.export({ format: 'jwk' }) as Record<string, unknown>
    const body = { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  it('fetches the JWKS, caches it, and verifies', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jwksResponse('jwks-k1', rsa.publicKey))

    const tok = signAsym({ sub: 'jwks-user' }, rsa.privateKey, 'RS256', { kid: 'jwks-k1' })
    const mw = jwtMiddleware({
      secret: [],
      algorithms: ['RS256'],
      jwksUrl: JWKS_URL,
      logger: () => {},
    })

    // First request — fetches.
    const c1 = ctxWith({ authorization: `Bearer ${tok}` })
    await expect(mw(c1, next)).resolves.toBeUndefined()
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // Second request within TTL — cached.
    const c2 = ctxWith({ authorization: `Bearer ${tok}` })
    await expect(mw(c2, next)).resolves.toBeUndefined()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('refetches after the TTL expires', async () => {
    // A `Response` body is single-use (`res.json()` consumes the stream), and
    // this test triggers two real fetches (initial + post-TTL refetch). Return
    // a FRESH Response per call — mirroring real `fetch` — instead of reusing
    // one consumable object, which would make the second `res.json()` throw.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => jwksResponse('jwks-k1', rsa.publicKey))

    const tok = signAsym({ sub: 'ttl' }, rsa.privateKey, 'RS256', { kid: 'jwks-k1' })

    // Tiny TTL so the cache window closes immediately.
    const mw = jwtMiddleware({
      secret: [],
      algorithms: ['RS256'],
      jwksUrl: JWKS_URL,
      jwksCacheMs: 1,
      logger: () => {},
    })

    const c1 = ctxWith({ authorization: `Bearer ${tok}` })
    await expect(mw(c1, next)).resolves.toBeUndefined()
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // Wait past the 1ms TTL.
    await new Promise((r) => setTimeout(r, 10))

    const c2 = ctxWith({ authorization: `Bearer ${tok}` })
    await expect(mw(c2, next)).resolves.toBeUndefined()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent fetches into a single in-flight request', async () => {
    let resolveFetch: (v: Response) => void = () => {}
    const fetchPromise = new Promise<Response>((res) => { resolveFetch = res })
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockReturnValue(fetchPromise as unknown as Promise<Response>)

    const tok = signAsym({ sub: 'concurrent' }, rsa.privateKey, 'RS256', { kid: 'jwks-k1' })
    const mw = jwtMiddleware({
      secret: [],
      algorithms: ['RS256'],
      jwksUrl: JWKS_URL,
      logger: () => {},
    })

    const c1 = ctxWith({ authorization: `Bearer ${tok}` })
    const c2 = ctxWith({ authorization: `Bearer ${tok}` })
    const p1 = mw(c1, next)
    const p2 = mw(c2, next)

    // The middleware `await`s `getToken` before it ever reaches `fetchJwks`,
    // so `fetch` is dispatched on a later microtask — not synchronously here.
    // Flush the microtask queue so both calls have entered `fetchJwks` before
    // we assert. Both should then be awaiting the SAME in-flight fetch.
    await new Promise((r) => setTimeout(r, 0))
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    resolveFetch(jwksResponse('jwks-k1', rsa.publicKey))
    await Promise.all([p1, p2])
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('rejects with a wire-safe error when the JWKS fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('upstream is on fire'))

    const tok = signAsym({ sub: 'sad' }, rsa.privateKey, 'RS256', { kid: 'jwks-k1' })
    const mw = jwtMiddleware({
      secret: [],
      algorithms: ['RS256'],
      jwksUrl: JWKS_URL,
      logger: () => {},
    })
    const c = ctxWith({ authorization: `Bearer ${tok}` })

    await expect(mw(c, next)).rejects.toBeInstanceOf(IngeniumUnauthorizedError)
    // Crucially: the upstream message must NOT leak.
    await expect(mw(c, next)).rejects.toThrow(/^Token key fetch failed$|^Invalid token$/)
    await expect(mw(c, next)).rejects.not.toThrow(/upstream is on fire/)
  })

  it('rejects with 401 when the JWKS responds with a non-OK status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }),
    )
    const tok = signAsym({ sub: 'down' }, rsa.privateKey, 'RS256', { kid: 'jwks-k1' })
    const mw = jwtMiddleware({
      secret: [],
      algorithms: ['RS256'],
      jwksUrl: JWKS_URL,
      logger: () => {},
    })
    const c = ctxWith({ authorization: `Bearer ${tok}` })
    await expect(mw(c, next)).rejects.toBeInstanceOf(IngeniumUnauthorizedError)
  })
})
