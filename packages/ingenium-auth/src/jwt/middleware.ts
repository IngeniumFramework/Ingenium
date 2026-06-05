import { Buffer } from 'node:buffer'
import type { KeyObject } from 'node:crypto'
import { IngeniumError, IngeniumUnauthorizedError } from 'ingenium'
import type { IngeniumMiddleware, IngeniumContext } from 'ingenium'
import type {
  JwtAlgorithm,
  JwtHeader,
  JwtKey,
  JwtOptions,
  JwtSecret,
  JwtSecretResolver,
  JwtTokenReader,
  JwtVerified,
} from './types.ts'
import { verifyJwt, type KidTaggedKey, type VerifyKeyMaterial } from './verify.ts'
import { fetchJwks } from './jwks.ts'

const DEFAULT_ALGORITHMS: readonly JwtAlgorithm[] = ['HS256']
// When the caller wires up JWKS (always asymmetric) but doesn't pin an
// algorithm, defaulting to the HMAC `HS256` would be a footgun — fall back to
// the most common asymmetric default instead.
const DEFAULT_ASYMMETRIC_ALGORITHMS: readonly JwtAlgorithm[] = ['RS256']
const DEFAULT_JWKS_TTL_MS = 10 * 60 * 1000
const SUPPORTED: ReadonlySet<JwtAlgorithm> = new Set([
  'HS256', 'HS384', 'HS512',
  'RS256', 'RS384', 'RS512',
  'PS256', 'PS384', 'PS512',
  'ES256', 'ES384', 'ES512',
])

/**
 * 500 — the configured algorithm allowlist and the supplied key material are
 * from different families (an HMAC alg paired with an asymmetric PEM / public
 * key, or vice versa). Allowing this is the canonical algorithm-confusion
 * footgun: an attacker forges `HS256` tokens using the server's *public* key
 * as the HMAC secret. We refuse the configuration at construction time so the
 * mistake surfaces at boot, not as a silent auth bypass.
 */
export class IngeniumJwtKeyAlgMismatchError extends IngeniumError {
  constructor(message: string) {
    super(500, 'JWT_KEY_ALG_MISMATCH', message)
  }
}

/** True for the HMAC (symmetric) algorithm family. */
function isHmacAlg(alg: JwtAlgorithm): boolean {
  return alg === 'HS256' || alg === 'HS384' || alg === 'HS512'
}

/** Default token reader — `Authorization: Bearer <token>`. */
const defaultGetToken: JwtTokenReader = (ctx) => {
  const raw = ctx.headers['authorization']
  if (!raw) return undefined
  const value = Array.isArray(raw) ? raw[0] : raw
  if (!value) return undefined
  // Bearer scheme is case-insensitive per RFC 6750 §2.1.
  const space = value.indexOf(' ')
  if (space < 0) return undefined
  const scheme = value.slice(0, space)
  if (scheme.toLowerCase() !== 'bearer') return undefined
  const token = value.slice(space + 1).trim()
  return token.length > 0 ? token : undefined
}

/**
 * Bearer-token JWT verification middleware.
 *
 * Attaches the verified token at `ctx.jwt`. Callers should module-augment
 * `IngeniumContext` for typed access (the framework purposely doesn't ship a
 * baked-in `jwt` field — payload shape is application-specific).
 *
 * @example
 * ```ts
 * declare module 'ingenium' {
 *   interface IngeniumContext {
 *     jwt?: import('ingenium').JwtVerified<{ sub: string; roles: string[] }>
 *   }
 * }
 *
 * import { ingenium } from 'ingenium'
 * const app = ingenium()
 * // HMAC
 * app.use(ingenium.jwt({ secret: process.env.JWT_SECRET! }))
 * // RSA via JWKS (Auth0, Okta, Cognito, Clerk, Supabase, ...)
 * app.use(ingenium.jwt({
 *   secret: [],
 *   algorithms: ['RS256'],
 *   jwksUrl: 'https://example.auth0.com/.well-known/jwks.json',
 *   issuer: 'https://example.auth0.com/',
 *   audience: 'https://api.example.com',
 * }))
 * ```
 *
 * Security choices:
 * - Default leeway (`clockSkewSeconds`) is **5 seconds** — enough for typical
 *   multi-host clock drift, small enough that an expired token does not stay
 *   usable for long.
 * - HMAC signature comparison uses `crypto.timingSafeEqual` after an explicit
 *   length check inside {@link verifyJwt}; asymmetric verification uses
 *   `crypto.verify` (constant-time within OpenSSL).
 * - The algorithm allowlist is enforced at verify time. Even if an attacker
 *   crafts `alg: 'RS256'` and we have a matching JWKS key, verification fails
 *   unless `RS256` appears in `algorithms`. This is the canonical defence
 *   against algorithm-confusion attacks.
 * - `'none'` is rejected unconditionally, regardless of the allowlist.
 * - The wire-facing error is always `IngeniumUnauthorizedError('Invalid token')`
 *   regardless of which check failed (signature vs exp vs aud) — this avoids
 *   handing attackers an oracle. Detailed reasons go to `opts.logger` (or
 *   `process.emitWarning` if no logger is supplied).
 */
export function jwtMiddleware<T = Record<string, unknown>>(
  opts: JwtOptions<T>,
): IngeniumMiddleware {
  // ── Construction-time validation ─────────────────────────────────────────
  if (opts == null) {
    throw new Error('jwtMiddleware: options object is required')
  }
  // `secret` may be an empty array when the caller is leaning entirely on
  // `jwksUrl` for key material — treat that as a valid configuration.
  const hasJwks = typeof opts.jwksUrl === 'string' && opts.jwksUrl.length > 0
  if ((opts.secret as unknown) === undefined || opts.secret === null) {
    if (!hasJwks) {
      throw new Error('jwtMiddleware: `secret` (or `jwksUrl`) is required')
    }
  }

  // Algorithm defaulting is family-aware. The historical `HS256` default is
  // only safe for symmetric (string-secret) setups; when the caller leans on
  // JWKS (always asymmetric) without pinning an algorithm, defaulting to an
  // HMAC alg would silently invite the key-confusion bypass. In that case we
  // default to `RS256` instead so the families can never disagree by accident.
  const defaultAlgorithms = hasJwks ? DEFAULT_ASYMMETRIC_ALGORITHMS : DEFAULT_ALGORITHMS
  const algorithms = (opts.algorithms ?? defaultAlgorithms).slice() as JwtAlgorithm[]
  if (algorithms.length === 0) {
    throw new Error('jwtMiddleware: `algorithms` must contain at least one algorithm')
  }
  for (const alg of algorithms) {
    // 'none' is never permitted, even if a caller adds it to the allowlist.
    if ((alg as unknown as string) === 'none') {
      throw new Error('jwtMiddleware: `alg: "none"` is forbidden')
    }
    if (!SUPPORTED.has(alg)) {
      throw new Error(`jwtMiddleware: unsupported algorithm ${String(alg)}`)
    }
  }

  const required = opts.required ?? true
  const clockSkewSeconds = opts.clockSkewSeconds ?? 5
  const requireExp = opts.requireExp ?? true
  const jwksCacheMs = opts.jwksCacheMs ?? DEFAULT_JWKS_TTL_MS
  const jwksUrl = hasJwks ? opts.jwksUrl! : null
  const getToken = opts.getToken ?? defaultGetToken
  const logger = opts.logger ?? ((event) => {
    process.emitWarning(`jwt verification failed: ${event.reason}`, 'IngeniumJwtWarning')
  })

  const staticKeys = opts.secret != null && typeof opts.secret !== 'function'
    ? normaliseStaticKeys(opts.secret as JwtKey | JwtKey[])
    : []
  const keyResolver =
    typeof opts.secret === 'function'
      ? (opts.secret as JwtSecretResolver<T>)
      : null

  // ── Key/algorithm family confinement ─────────────────────────────────────
  // If the allowlist contains an HMAC alg, none of the STATIC key material may
  // be asymmetric (a PEM string/Buffer or a public/private KeyObject). Pairing
  // those is the algorithm-confusion bypass: an attacker forges `HS256` tokens
  // using the asymmetric *public* key as the HMAC secret. Refuse at boot.
  // (A function resolver / JWKS is checked per-request by the verifier, which
  // never runs HMAC against an asymmetric key.)
  if (algorithms.some(isHmacAlg)) {
    for (const k of staticKeys) {
      if (staticKeyIsAsymmetric(k)) {
        throw new IngeniumJwtKeyAlgMismatchError(
          'jwtMiddleware: an HMAC algorithm (HS256/384/512) was paired with an ' +
            'asymmetric key (PEM or public/private KeyObject). This enables an ' +
            'algorithm-confusion forgery — use an asymmetric algorithm (RS*/PS*/ES*) ' +
            'for asymmetric keys, or a raw shared secret for HMAC.',
        )
      }
    }
  }

  return async (ctx, next) => {
    const token = await getToken(ctx)
    if (!token) {
      if (required) {
        // Missing token IS allowed to leak (no secret material involved).
        throw new IngeniumUnauthorizedError('Missing token')
      }
      await next()
      return
    }

    // Peek the header so resolvers / JWKS can route by `kid`. Malformed
    // tokens still reach the verifier so they get the canonical error.
    const peeked = peekHeader(token)

    // Build the candidate key list for this request.
    let keys: (VerifyKeyMaterial | KidTaggedKey)[]
    try {
      keys = await collectKeys({
        peeked,
        staticKeys,
        keyResolver,
        jwksUrl,
        jwksCacheMs,
      })
    } catch (err) {
      if (err instanceof IngeniumUnauthorizedError) throw err
      const reason = err instanceof Error ? err.message : 'key_resolution_failed'
      logger({ reason })
      throw new IngeniumUnauthorizedError('Invalid token')
    }

    if (keys.length === 0) {
      logger({ reason: 'no_keys_available' })
      throw new IngeniumUnauthorizedError('Invalid token')
    }

    // Build VerifyOptions without spreading undefined keys (exactOptionalPropertyTypes).
    const verifyOpts: Parameters<typeof verifyJwt>[2] = { algorithms, clockSkewSeconds, requireExp }
    if (opts.audience !== undefined) verifyOpts.audience = opts.audience
    if (opts.issuer !== undefined) verifyOpts.issuer = opts.issuer
    if (opts.maxAgeSeconds !== undefined) verifyOpts.maxAgeSeconds = opts.maxAgeSeconds
    const result = verifyJwt<T>(token, keys, verifyOpts)

    if ('error' in result) {
      logger({ reason: result.error })
      throw new IngeniumUnauthorizedError('Invalid token')
    }

    ;(ctx as IngeniumContext & { jwt?: JwtVerified<T> }).jwt = result
    await next()
  }
}

/**
 * Normalise the static `secret` option to a flat array of either raw key
 * material or kid-tagged entries that `verifyJwt` understands.
 *
 * Accepts string / Buffer / KeyObject and the `{ kid, key }` wrapper.
 */
function normaliseStaticKeys(secret: JwtKey | JwtKey[]): (VerifyKeyMaterial | KidTaggedKey)[] {
  const list = Array.isArray(secret) ? secret : [secret]
  if (list.length === 0) {
    // An empty literal array IS allowed when paired with jwksUrl; the
    // top-level construction-time check already validated that constraint.
    return []
  }
  const out: (VerifyKeyMaterial | KidTaggedKey)[] = []
  for (const k of list) {
    out.push(coerceJwtKey(k))
  }
  return out
}

function coerceJwtKey(k: JwtKey): VerifyKeyMaterial | KidTaggedKey {
  if (typeof k === 'string') {
    if (k.length === 0) {
      throw new Error('jwtMiddleware: secret string must not be empty')
    }
    return k
  }
  if (Buffer.isBuffer(k)) return k
  if (isKeyObject(k)) return k
  if (typeof k === 'object' && k !== null && 'kid' in k && 'key' in k) {
    if (typeof k.kid !== 'string' || k.kid.length === 0) {
      throw new Error('jwtMiddleware: keyed entry requires a non-empty `kid`')
    }
    const key = k.key
    if (typeof key === 'string') {
      if (key.length === 0) throw new Error('jwtMiddleware: keyed entry `key` must not be empty')
      return { kid: k.kid, key }
    }
    if (Buffer.isBuffer(key) || isKeyObject(key)) return { kid: k.kid, key }
  }
  throw new Error('jwtMiddleware: invalid `secret` entry — expected string, Buffer, KeyObject, or { kid, key }')
}

/**
 * Classify a normalised static key as asymmetric (PEM blob or a public/private
 * KeyObject). Used by the construction-time family guard — a `kid`-tagged entry
 * is inspected by its inner `key`.
 */
function staticKeyIsAsymmetric(entry: VerifyKeyMaterial | KidTaggedKey): boolean {
  const key: VerifyKeyMaterial =
    typeof entry === 'object' && entry !== null && !Buffer.isBuffer(entry) && 'key' in entry
      ? (entry as KidTaggedKey).key
      : (entry as VerifyKeyMaterial)
  if (typeof key === 'string') return looksLikePem(key)
  if (Buffer.isBuffer(key)) return looksLikePem(key.toString('latin1'))
  // KeyObject: 'public' / 'private' are asymmetric; 'secret' is HMAC-eligible.
  return (key as KeyObject).type === 'public' || (key as KeyObject).type === 'private'
}

/** A PEM-armored blob is asymmetric key material, never an HMAC secret. */
function looksLikePem(s: string): boolean {
  return s.trimStart().startsWith('-----BEGIN')
}

function isKeyObject(v: unknown): v is KeyObject {
  // Avoid a hard import-time check; KeyObjects from node:crypto carry a
  // distinctive `asymmetricKeyType` getter or `type` property of
  // 'public' | 'private' | 'secret'.
  if (typeof v !== 'object' || v === null) return false
  const t = (v as { type?: unknown }).type
  return t === 'public' || t === 'private' || t === 'secret'
}

interface CollectKeysCtx<T> {
  peeked: JwtHeader | null
  staticKeys: (VerifyKeyMaterial | KidTaggedKey)[]
  keyResolver: JwtSecretResolver<T> | null
  jwksUrl: string | null
  jwksCacheMs: number
}

async function collectKeys<T>(ctx: CollectKeysCtx<T>): Promise<(VerifyKeyMaterial | KidTaggedKey)[]> {
  const out: (VerifyKeyMaterial | KidTaggedKey)[] = ctx.staticKeys.slice()

  if (ctx.keyResolver) {
    const resolved = await ctx.keyResolver(ctx.peeked ?? ({ alg: '' } as JwtHeader))
    if (resolved == null) {
      throw new Error('secret_resolver_returned_empty')
    }
    if (typeof resolved === 'string') {
      if (resolved.length === 0) throw new Error('secret_resolver_returned_empty')
      out.push(resolved)
    } else {
      out.push(coerceJwtKey(resolved as JwtKey))
    }
  }

  if (ctx.jwksUrl) {
    let jwks: Map<string, KeyObject>
    try {
      jwks = await fetchJwks(ctx.jwksUrl, ctx.jwksCacheMs)
    } catch {
      // Don't leak upstream details to clients OR to the logger reason —
      // a single canonical reason is enough for ops.
      throw new IngeniumUnauthorizedError('Token key fetch failed')
    }
    const headerKid = ctx.peeked && typeof ctx.peeked.kid === 'string' ? ctx.peeked.kid : null
    if (headerKid) {
      const match = jwks.get(headerKid)
      if (match) out.push({ kid: headerKid, key: match })
      // No-match isn't fatal here; verifier returns kid_unknown if the
      // entire candidate set is empty after key selection.
    } else {
      // No kid on the token — try every key in the JWKS as a tagged entry.
      for (const [kid, key] of jwks) {
        out.push({ kid, key })
      }
      // Also expose them untagged so the verifier's `selectCandidates` will
      // try them when the header lacks `kid`.
      for (const [, key] of jwks) {
        out.push(key)
      }
    }
  }

  return out
}

/** Best-effort header peek for resolver routing. Returns null on malformed tokens. */
function peekHeader(token: string): JwtHeader | null {
  const dot = token.indexOf('.')
  if (dot <= 0) return null
  try {
    const buf = Buffer.from(token.slice(0, dot), 'base64url')
    if (buf.length === 0) return null
    const parsed = JSON.parse(buf.toString('utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object') return null
    return parsed as JwtHeader
  } catch {
    return null
  }
}

// Backwards-compat re-exports for downstream code that imported these names.
export type { JwtSecret, JwtSecretResolver }
