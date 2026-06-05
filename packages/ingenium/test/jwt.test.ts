import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { IngeniumContext } from '../src/context/context.ts'
import { IngeniumUnauthorizedError } from '../src/errors.ts'
import { jwtMiddleware } from '../src/jwt/middleware.ts'
import { verifyJwt } from '../src/jwt/verify.ts'
import type { JwtAlgorithm, JwtVerified } from '../src/jwt/types.ts'

const SECRET = 'test-secret-1'

// ───── Helpers ──────────────────────────────────────────────────────────────

// Only the HMAC subset is tested by the symmetric-token helper; asymmetric
// algorithms (RS*/PS*/ES*) are exercised by jwt-asymmetric.test.ts. We use
// a Partial map so this fixture doesn't need to enumerate every algorithm
// the union now supports.
const ALG_DIGEST: Partial<Record<JwtAlgorithm, string>> = {
  HS256: 'sha256',
  HS384: 'sha384',
  HS512: 'sha512',
}

function b64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input
  return buf.toString('base64url')
}

/** Inline JWT signer — keeps the test suite zero-dep. */
function signTestJwt(
  payload: Record<string, unknown>,
  secret: string,
  alg: JwtAlgorithm = 'HS256',
  headerOverrides: Record<string, unknown> = {},
): string {
  const header = { alg, typ: 'JWT', ...headerOverrides }
  const headerB64 = b64url(JSON.stringify(header))
  // verifyJwt now requires `exp` by default (requireExp). Tests that don't care
  // about expiry get a valid far-future exp so they keep exercising their actual
  // concern; tests asserting expiry/nbf still pass their own explicit exp.
  const withExp = 'exp' in payload ? payload : { ...payload, exp: nowSec() + 60 }
  const payloadB64 = b64url(JSON.stringify(withExp))
  const signingInput = `${headerB64}.${payloadB64}`
  const digest = ALG_DIGEST[alg]
  if (!digest) throw new Error(`signTestJwt: HMAC-only helper, got ${alg}`)
  const sig = createHmac(digest, secret).update(signingInput).digest('base64url')
  return `${signingInput}.${sig}`
}

function ctxWith(headers: Record<string, string | string[]> = {}, query = ''): IngeniumContext {
  const c = new IngeniumContext()
  c.method = 'GET'
  c.headers = headers
  c.rawQuery = query
  return c
}

function next(): Promise<void> {
  return Promise.resolve()
}

const nowSec = (): number => Math.floor(Date.now() / 1000)

// ───── verifyJwt (pure verifier) ────────────────────────────────────────────

describe('verifyJwt', () => {
  it('verifies an HS256 token', () => {
    const tok = signTestJwt({ sub: 'alice', exp: nowSec() + 60 }, SECRET, 'HS256')
    const r = verifyJwt(tok, [SECRET], { algorithms: ['HS256'] })
    expect('error' in r).toBe(false)
    if ('error' in r) return
    expect((r.payload as { sub: string }).sub).toBe('alice')
    expect(r.header.alg).toBe('HS256')
    expect(r.raw).toBe(tok)
  })

  it('verifies HS384 and HS512', () => {
    for (const alg of ['HS384', 'HS512'] as const) {
      const tok = signTestJwt({ x: 1 }, SECRET, alg)
      const r = verifyJwt(tok, [SECRET], { algorithms: [alg] })
      expect('error' in r).toBe(false)
    }
  })

  it('rejects bad signatures', () => {
    const tok = signTestJwt({ sub: 'alice' }, SECRET)
    const tampered = tok.slice(0, -2) + 'ZZ'
    const r = verifyJwt(tampered, [SECRET], { algorithms: ['HS256'] })
    expect('error' in r && r.error).toBe('bad_signature')
  })

  it('rejects malformed tokens', () => {
    expect('error' in verifyJwt('not-a-jwt', [SECRET], { algorithms: ['HS256'] })).toBe(true)
    expect('error' in verifyJwt('a.b', [SECRET], { algorithms: ['HS256'] })).toBe(true)
    expect('error' in verifyJwt('', [SECRET], { algorithms: ['HS256'] })).toBe(true)
  })

  it('enforces algorithm allowlist', () => {
    const tok = signTestJwt({}, SECRET, 'HS256')
    const r = verifyJwt(tok, [SECRET], { algorithms: ['HS512'] })
    expect('error' in r && r.error).toBe('unsupported_alg')
  })
})

// ───── jwtMiddleware ────────────────────────────────────────────────────────

describe('jwtMiddleware', () => {
  it('populates ctx.jwt on a valid HS256 token', async () => {
    const tok = signTestJwt({ sub: 'alice', exp: nowSec() + 60 }, SECRET)
    const mw = jwtMiddleware({ secret: SECRET, logger: () => {} })
    const c = ctxWith({ authorization: `Bearer ${tok}` })
    let nextCalled = false
    await mw(c, async () => {
      nextCalled = true
    })
    expect(nextCalled).toBe(true)
    const verified = (c as IngeniumContext & { jwt?: JwtVerified }).jwt
    expect(verified).toBeDefined()
    expect((verified!.payload as { sub: string }).sub).toBe('alice')
  })

  it('accepts HS384 + HS512 when in algorithms allowlist', async () => {
    for (const alg of ['HS384', 'HS512'] as const) {
      const tok = signTestJwt({ a: alg }, SECRET, alg)
      const mw = jwtMiddleware({ secret: SECRET, algorithms: [alg], logger: () => {} })
      const c = ctxWith({ authorization: `Bearer ${tok}` })
      await expect(mw(c, next)).resolves.toBeUndefined()
      expect((c as IngeniumContext & { jwt?: JwtVerified }).jwt).toBeDefined()
    }
  })

  it('throws IngeniumUnauthorizedError on invalid signature', async () => {
    const tok = signTestJwt({ sub: 'x' }, SECRET)
    const tampered = tok.slice(0, -2) + 'ZZ'
    const mw = jwtMiddleware({ secret: SECRET, logger: () => {} })
    const c = ctxWith({ authorization: `Bearer ${tampered}` })
    await expect(mw(c, next)).rejects.toBeInstanceOf(IngeniumUnauthorizedError)
    await expect(mw(c, next)).rejects.toThrow('Invalid token')
  })

  it('rejects expired tokens (exp < now - skew)', async () => {
    const tok = signTestJwt({ exp: nowSec() - 60 }, SECRET)
    const mw = jwtMiddleware({ secret: SECRET, clockSkewSeconds: 5, logger: () => {} })
    const c = ctxWith({ authorization: `Bearer ${tok}` })
    await expect(mw(c, next)).rejects.toBeInstanceOf(IngeniumUnauthorizedError)
  })

  it('rejects not-yet-valid tokens (nbf > now + skew)', async () => {
    const tok = signTestJwt({ nbf: nowSec() + 600 }, SECRET)
    const mw = jwtMiddleware({ secret: SECRET, clockSkewSeconds: 5, logger: () => {} })
    const c = ctxWith({ authorization: `Bearer ${tok}` })
    await expect(mw(c, next)).rejects.toBeInstanceOf(IngeniumUnauthorizedError)
  })

  it('rejects wrong audience', async () => {
    const tok = signTestJwt({ aud: 'wrong-svc' }, SECRET)
    const mw = jwtMiddleware({ secret: SECRET, audience: 'right-svc', logger: () => {} })
    const c = ctxWith({ authorization: `Bearer ${tok}` })
    await expect(mw(c, next)).rejects.toBeInstanceOf(IngeniumUnauthorizedError)
  })

  it('accepts audience present in claim array', async () => {
    const tok = signTestJwt({ aud: ['a', 'b', 'right-svc'] }, SECRET)
    const mw = jwtMiddleware({ secret: SECRET, audience: 'right-svc', logger: () => {} })
    const c = ctxWith({ authorization: `Bearer ${tok}` })
    await expect(mw(c, next)).resolves.toBeUndefined()
  })

  it('rejects wrong issuer', async () => {
    const tok = signTestJwt({ iss: 'attacker' }, SECRET)
    const mw = jwtMiddleware({ secret: SECRET, issuer: 'real', logger: () => {} })
    const c = ctxWith({ authorization: `Bearer ${tok}` })
    await expect(mw(c, next)).rejects.toBeInstanceOf(IngeniumUnauthorizedError)
  })

  it('rejects tokens older than maxAgeSeconds', async () => {
    const tok = signTestJwt({ iat: nowSec() - 3600 }, SECRET)
    const mw = jwtMiddleware({ secret: SECRET, maxAgeSeconds: 60, logger: () => {} })
    const c = ctxWith({ authorization: `Bearer ${tok}` })
    await expect(mw(c, next)).rejects.toBeInstanceOf(IngeniumUnauthorizedError)
  })

  it('throws on missing token when required=true (default)', async () => {
    const mw = jwtMiddleware({ secret: SECRET, logger: () => {} })
    const c = ctxWith({})
    await expect(mw(c, next)).rejects.toBeInstanceOf(IngeniumUnauthorizedError)
  })

  it('calls next without setting ctx.jwt when missing + required=false', async () => {
    const mw = jwtMiddleware({ secret: SECRET, required: false, logger: () => {} })
    const c = ctxWith({})
    let nextCalled = false
    await mw(c, async () => {
      nextCalled = true
    })
    expect(nextCalled).toBe(true)
    expect((c as IngeniumContext & { jwt?: JwtVerified }).jwt).toBeUndefined()
  })

  it('supports secret rotation via array — both verify', async () => {
    const SECRETS = ['new-secret', 'old-secret']
    const mw = jwtMiddleware({ secret: SECRETS, logger: () => {} })
    for (const s of SECRETS) {
      const tok = signTestJwt({ sub: s }, s)
      const c = ctxWith({ authorization: `Bearer ${tok}` })
      await expect(mw(c, next)).resolves.toBeUndefined()
      expect((c as IngeniumContext & { jwt?: JwtVerified }).jwt).toBeDefined()
    }
  })

  it('supports a function secret resolver, invoked with the header and awaited', async () => {
    const tok = signTestJwt({ sub: 'kid-routed' }, SECRET, 'HS256', { kid: 'k1' })
    let receivedKid: string | undefined
    const mw = jwtMiddleware({
      secret: async (header) => {
        receivedKid = header.kid as string | undefined
        return SECRET
      },
      logger: () => {},
    })
    const c = ctxWith({ authorization: `Bearer ${tok}` })
    await expect(mw(c, next)).resolves.toBeUndefined()
    expect(receivedKid).toBe('k1')
  })

  it('honors a custom getToken (query string)', async () => {
    const tok = signTestJwt({ sub: 'q' }, SECRET)
    const mw = jwtMiddleware({
      secret: SECRET,
      getToken: (ctx) => ctx.query.get('jwt') ?? undefined,
      logger: () => {},
    })
    const c = ctxWith({}, `jwt=${encodeURIComponent(tok)}`)
    await expect(mw(c, next)).resolves.toBeUndefined()
    expect((c as IngeniumContext & { jwt?: JwtVerified }).jwt).toBeDefined()
  })

  it('rejects token signed with HS256 when only HS512 is allowed', async () => {
    const tok = signTestJwt({}, SECRET, 'HS256')
    const mw = jwtMiddleware({ secret: SECRET, algorithms: ['HS512'], logger: () => {} })
    const c = ctxWith({ authorization: `Bearer ${tok}` })
    await expect(mw(c, next)).rejects.toBeInstanceOf(IngeniumUnauthorizedError)
  })

  it('throws at construction time when an unsupported algorithm is requested', () => {
    expect(() =>
      jwtMiddleware({ secret: SECRET, algorithms: ['HS999' as unknown as JwtAlgorithm] }),
    ).toThrow(/unsupported algorithm/i)
  })

  it('rejects `alg: "none"` even if the allowlist is bypassed', async () => {
    // Hand-craft a "none" token: header { alg: 'none' }, payload, empty sig.
    const headerB64 = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))
    const payloadB64 = b64url(JSON.stringify({ sub: 'attacker' }))
    const noneToken = `${headerB64}.${payloadB64}.`
    const mw = jwtMiddleware({ secret: SECRET, logger: () => {} })
    const c = ctxWith({ authorization: `Bearer ${noneToken}` })
    await expect(mw(c, next)).rejects.toBeInstanceOf(IngeniumUnauthorizedError)
    // And construction-time: 'none' in the allowlist is forbidden too.
    expect(() =>
      jwtMiddleware({ secret: SECRET, algorithms: ['none' as unknown as JwtAlgorithm] }),
    ).toThrow(/none/i)
  })

  it('does not leak which check failed in the error message', async () => {
    const cases: Array<() => string> = [
      () => signTestJwt({ exp: nowSec() - 60 }, SECRET),                     // expired
      () => signTestJwt({ aud: 'nope' }, SECRET),                            // bad aud
      () => signTestJwt({}, 'wrong-secret'),                                 // bad sig
    ]
    const mw = jwtMiddleware({ secret: SECRET, audience: 'svc', logger: () => {} })
    for (const make of cases) {
      const c = ctxWith({ authorization: `Bearer ${make()}` })
      await expect(mw(c, next)).rejects.toThrow(/^Invalid token$/)
    }
  })
})
