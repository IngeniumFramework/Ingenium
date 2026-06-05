import type { KeyObject } from 'node:crypto'
import type { Buffer } from 'node:buffer'
import type { IngeniumContext } from 'ingenium'

/**
 * Supported JWT signing algorithms.
 *
 * - `HSxxx` — HMAC with the supplied shared secret.
 * - `RSxxx` — RSASSA-PKCS1-v1_5 with the supplied RSA public key (PEM / JWK / KeyObject).
 * - `PSxxx` — RSASSA-PSS (MGF1, salt length = digest length).
 * - `ESxxx` — ECDSA on P-256 / P-384 / P-521 (raw r||s, NOT DER — per the JWT spec).
 *
 * `alg: 'none'` is intentionally absent from this union and is hard-rejected
 * at the verifier — never accept unsigned tokens, even with an empty allowlist.
 */
export type JwtAlgorithm =
  | 'HS256' | 'HS384' | 'HS512'
  | 'RS256' | 'RS384' | 'RS512'
  | 'ES256' | 'ES384' | 'ES512'
  | 'PS256' | 'PS384' | 'PS512'

/** Decoded JWT header. The `alg` field is required by the spec. */
export interface JwtHeader {
  alg: string
  typ?: string
  kid?: string
  [k: string]: unknown
}

/**
 * A successfully verified JWT. `payload` carries the typed claims object,
 * `header` carries the decoded protected header, and `raw` is the original
 * compact-serialization string the client sent (useful for re-emitting).
 */
export interface JwtVerified<T = Record<string, unknown>> {
  header: JwtHeader
  payload: T
  raw: string
}

/** Internal — verifier failure mode. Public surface only ever sees `'Invalid token'`. */
export type JwtVerifyError =
  | { error: 'malformed' }
  | { error: 'unsupported_alg' }
  | { error: 'bad_signature' }
  | { error: 'expired' }
  | { error: 'missing_exp' }
  | { error: 'not_yet_valid' }
  | { error: 'too_old' }
  | { error: 'aud_mismatch' }
  | { error: 'iss_mismatch' }
  | { error: 'kid_unknown' }
  | { error: 'jwks_fetch_failed' }

/**
 * A single signing/verification key. For HMAC algorithms (HSxxx) this is the
 * shared secret as a string; for asymmetric algorithms it's the PUBLIC key in
 * PEM (string / Buffer) or as a pre-built `KeyObject`.
 *
 * Wrapping with `{ kid, key }` enables header-based key selection — the
 * verifier picks the entry whose `kid` matches `header.kid`.
 */
export type JwtKey =
  | string
  | Buffer
  | KeyObject
  | { kid: string; key: string | Buffer | KeyObject }

/**
 * Resolve a per-request key. Receives the decoded JWT header so callers can
 * implement `kid`-based JWKS-style routing without parsing the token themselves.
 */
export type JwtSecretResolver<_T = Record<string, unknown>> = (
  header: JwtHeader,
) => JwtKey | Promise<JwtKey>

/** All ways `secret` can be supplied. */
export type JwtSecret<T = Record<string, unknown>> =
  | JwtKey
  | JwtKey[]
  | JwtSecretResolver<T>

/** Signature for pulling the raw compact-serialization out of the request. */
export type JwtTokenReader = (
  ctx: IngeniumContext,
) => string | undefined | Promise<string | undefined>

/** Optional structured logger for redacted verification diagnostics. */
export type JwtLogger = (event: { reason: string; alg?: string }) => void

export interface JwtOptions<T = Record<string, unknown>> {
  /**
   * Verification key material. Accepts:
   * - A single key (string secret, PEM, Buffer, or `KeyObject`).
   * - `{ kid, key }` for explicit key-id tagging.
   * - An array of any of the above (rotation / multi-key — the verifier
   *   picks by `kid` if present, else tries each in order).
   * - A function `(header) => key | Promise<key>` for fully custom routing.
   */
  secret: JwtSecret<T>
  /** Allowed signing algorithms. Default `['HS256']`. */
  algorithms?: readonly JwtAlgorithm[]
  /** Required `aud` claim. Token's `aud` must match (or include) one of these. */
  audience?: string | readonly string[]
  /** Required `iss` claim. */
  issuer?: string | readonly string[]
  /** Reject tokens whose `iat` is older than N seconds. */
  maxAgeSeconds?: number
  /** Leeway for `nbf` / `exp` checks, in seconds. Default `5`. */
  clockSkewSeconds?: number
  /**
   * Require a numeric `exp` claim. Default `true`.
   *
   * Why default-on: a token that omits `exp` (or carries a non-numeric one)
   * would otherwise verify forever — a stolen token never stops working. We
   * refuse those by default and only relax it for callers who deliberately
   * issue non-expiring tokens (set this to `false`). Either way a present
   * `exp`/`nbf`/`iat` that is not a finite number is treated as malformed, not
   * silently skipped.
   */
  requireExp?: boolean
  /**
   * If `true` (default), missing tokens raise `IngeniumUnauthorizedError`.
   * If `false`, missing tokens just call `next()` with no `ctx.jwt`.
   */
  required?: boolean
  /**
   * Custom token reader. Default reads `Authorization: Bearer <token>`.
   * Return `undefined` to indicate "no token in this request".
   */
  getToken?: JwtTokenReader
  /**
   * Optional sink for redacted verification failure reasons. Useful for
   * observability without leaking the failure type to the wire (which would
   * be an oracle for attackers).
   */
  logger?: JwtLogger
  /**
   * Optional JWKS endpoint URL. When set, the middleware fetches the keys
   * from this URL on demand and looks them up by `header.kid`. Cached for
   * `jwksCacheMs` (default 10 minutes) per URL with a single in-flight
   * request coalesced across concurrent callers.
   */
  jwksUrl?: string
  /** JWKS cache TTL in milliseconds. Default `600_000` (10 minutes). */
  jwksCacheMs?: number
  /** Phantom — narrows `ctx.jwt.payload` for typed handlers. */
  _payload?: T
}
