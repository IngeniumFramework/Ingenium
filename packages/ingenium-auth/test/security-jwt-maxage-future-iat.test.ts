import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { verifyJwt } from '../src/jwt/verify.ts'
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

// Pin "now" so the temporal checks are deterministic.
const NOW = 1_700_000_000
const now = () => NOW

// ───── FINDING: maxAge must reject a future-dated iat ─────────────────────────

describe('jwt: maxAgeSeconds rejects a future-dated iat (unbounded-freshness gap)', () => {
  const SECRET = 'super-secret-value'
  const opts = {
    algorithms: ['HS256'] as JwtAlgorithm[],
    maxAgeSeconds: 300,
    nowSeconds: now,
  }

  it('rejects a token whose iat is far in the future with too_old', () => {
    // iat is 1 hour ahead of "now" — well past clock-skew tolerance. Without
    // the fix, `iat + maxAge` stays above `now` so the freshness ceiling never
    // trips, making the window effectively unbounded.
    const token = signHmac(
      { sub: 'alice', iat: NOW + 3600, exp: NOW + 7200 },
      SECRET,
    )
    const res = verifyJwt(token, [SECRET], opts)
    expect('error' in res).toBe(true)
    expect((res as { error: string }).error).toBe('too_old')
  })

  it('still verifies a recent iat inside the maxAge window', () => {
    // iat is 60s ago, well within the 300s ceiling, exp in the future.
    const token = signHmac(
      { sub: 'alice', iat: NOW - 60, exp: NOW + 3600 },
      SECRET,
    )
    const res = verifyJwt(token, [SECRET], opts)
    expect('error' in res).toBe(false)
  })

  it('accepts an iat within clock skew of "now" (slight future is tolerated)', () => {
    // iat a few seconds ahead — inside default 5s skew — must NOT be rejected.
    const token = signHmac(
      { sub: 'alice', iat: NOW + 3, exp: NOW + 3600 },
      SECRET,
    )
    const res = verifyJwt(token, [SECRET], opts)
    expect('error' in res).toBe(false)
  })

  it('rejects an iat older than maxAge with too_old (lower bound still enforced)', () => {
    const token = signHmac(
      { sub: 'alice', iat: NOW - 3600, exp: NOW + 3600 },
      SECRET,
    )
    const res = verifyJwt(token, [SECRET], opts)
    expect('error' in res).toBe(true)
    expect((res as { error: string }).error).toBe('too_old')
  })
})
