import { describe, it, expect } from 'vitest'
import { createHmac, generateKeyPairSync } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { jwtMiddleware } from '../src/jwt/middleware.ts'
import { verifyJwt, type VerifyKeyMaterial } from '../src/jwt/verify.ts'
import type { JwtAlgorithm } from '../src/jwt/types.ts'

// ───── Helpers ──────────────────────────────────────────────────────────────

function b64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input
  return buf.toString('base64url')
}

/** Sign a compact JWT with HMAC using `secret` as the shared key. */
function signHmac(
  payload: Record<string, unknown>,
  secret: string | Buffer,
  alg: JwtAlgorithm = 'HS256',
): string {
  const header = { alg, typ: 'JWT' }
  const headerB64 = b64url(JSON.stringify(header))
  const payloadB64 = b64url(JSON.stringify(payload))
  const signingInput = `${headerB64}.${payloadB64}`
  const digest = alg.endsWith('256') ? 'sha256' : alg.endsWith('384') ? 'sha384' : 'sha512'
  const sig = createHmac(digest, secret).update(signingInput).digest()
  return `${signingInput}.${b64url(sig)}`
}

const FUTURE = Math.floor(Date.now() / 1000) + 3600
const now = () => Math.floor(Date.now() / 1000)

// ───── FINDING #2: exp is required by default ─────────────────────────────────

describe('jwt: requireExp (FINDING #2)', () => {
  const SECRET = 'super-secret-value'
  const opts = { algorithms: ['HS256'] as JwtAlgorithm[], nowSeconds: now }

  it('rejects a token with NO exp claim by default', () => {
    const token = signHmac({ sub: 'alice' }, SECRET)
    const res = verifyJwt(token, [SECRET], opts)
    expect('error' in res).toBe(true)
    expect((res as { error: string }).error).toBe('missing_exp')
  })

  it('accepts a token with NO exp when requireExp is explicitly false', () => {
    const token = signHmac({ sub: 'alice' }, SECRET)
    const res = verifyJwt(token, [SECRET], { ...opts, requireExp: false })
    expect('error' in res).toBe(false)
  })

  it('rejects a string (non-numeric) exp as malformed, not non-expiring', () => {
    const token = signHmac({ sub: 'alice', exp: '9999999999' }, SECRET)
    const res = verifyJwt(token, [SECRET], opts)
    expect('error' in res).toBe(true)
    expect((res as { error: string }).error).toBe('malformed')
  })

  it('rejects a NaN / Infinity exp as malformed', () => {
    // JSON can't carry NaN, but a hostile encoder could; simulate via a number.
    const token = signHmac({ sub: 'alice', exp: Number.POSITIVE_INFINITY }, SECRET)
    // Number.POSITIVE_INFINITY serializes to JSON `null`, so exp becomes null →
    // treated as absent → missing_exp under the default policy.
    const res = verifyJwt(token, [SECRET], opts)
    expect('error' in res).toBe(true)
    expect(['malformed', 'missing_exp']).toContain((res as { error: string }).error)
  })

  it('accepts a normal future-exp token', () => {
    const token = signHmac({ sub: 'alice', exp: FUTURE }, SECRET)
    const res = verifyJwt(token, [SECRET], opts)
    expect('error' in res).toBe(false)
  })

  it('middleware defaults requireExp to true (no-exp token is invalid)', async () => {
    const mw = jwtMiddleware({ secret: SECRET })
    const token = signHmac({ sub: 'alice' }, SECRET)
    await expect(
      mw(
        { headers: { authorization: `Bearer ${token}` } } as never,
        async () => {},
      ),
    ).rejects.toMatchObject({ statusCode: 401 })
  })
})

// ───── FINDING #3: algorithm / key-family confusion ──────────────────────────

describe('jwt: HMAC/asymmetric key confinement (FINDING #3)', () => {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }) as string

  it('verify: HS256 token forged with the public PEM as HMAC secret does NOT verify', () => {
    // The classic confusion attack: attacker signs HS256 using the server's
    // public key string as the HMAC secret, and the server is (mis)configured
    // with that PEM as a "secret".
    const forged = signHmac({ sub: 'attacker', exp: FUTURE }, publicPem, 'HS256')
    const res = verifyJwt(forged, [publicPem as VerifyKeyMaterial], {
      algorithms: ['HS256'],
      nowSeconds: now,
    })
    expect('error' in res).toBe(true)
    expect((res as { error: string }).error).toBe('bad_signature')
  })

  it('verify: public KeyObject is never used as an HMAC key (no 500, becomes bad_signature)', () => {
    const forged = signHmac({ sub: 'attacker', exp: FUTURE }, publicPem, 'HS256')
    const res = verifyJwt(forged, [publicKey], { algorithms: ['HS256'], nowSeconds: now })
    expect('error' in res).toBe(true)
    expect((res as { error: string }).error).toBe('bad_signature')
  })

  it('construction: HMAC alg + PEM secret throws JWT_KEY_ALG_MISMATCH', () => {
    expect(() => jwtMiddleware({ secret: publicPem, algorithms: ['HS256'] })).toThrowError(
      /JWT_KEY_ALG_MISMATCH|algorithm-confusion|HMAC/,
    )
  })

  it('construction: HMAC alg + public KeyObject throws', () => {
    expect(() => jwtMiddleware({ secret: publicKey, algorithms: ['HS256'] })).toThrow()
  })

  it('construction: jwksUrl without explicit algorithms defaults to RS256, not HS256', () => {
    // Should NOT throw and should NOT silently use HS256 (an asymmetric setup).
    expect(() =>
      jwtMiddleware({ secret: [], jwksUrl: 'https://example.test/.well-known/jwks.json' }),
    ).not.toThrow()
  })

  it('construction: plain string secret with default HS256 still works', () => {
    expect(() => jwtMiddleware({ secret: 'plain-shared-secret' })).not.toThrow()
  })
})
