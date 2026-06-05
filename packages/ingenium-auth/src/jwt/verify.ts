import {
  constants as cryptoConstants,
  createHmac,
  createPublicKey,
  verify as cryptoVerify,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto'
import { Buffer } from 'node:buffer'
import type {
  JwtAlgorithm,
  JwtHeader,
  JwtVerified,
  JwtVerifyError,
} from './types.ts'

/**
 * Per-algorithm wire descriptor.
 *
 * `family` selects the verifier branch; the digest / openssl-name fields are
 * only consulted by the matching family.
 */
interface AlgSpec {
  family: 'hmac' | 'rsa' | 'rsa-pss' | 'ecdsa'
  /** node:crypto digest name (`sha256`, `sha384`, `sha512`). HMAC + asymmetric both use it. */
  digest: string
  /** Expected raw signature length for ECDSA (r||s, two equal-sized halves). */
  ecSigLen?: number
}

const ALG_SPEC: Readonly<Record<JwtAlgorithm, AlgSpec>> = {
  HS256: { family: 'hmac', digest: 'sha256' },
  HS384: { family: 'hmac', digest: 'sha384' },
  HS512: { family: 'hmac', digest: 'sha512' },
  RS256: { family: 'rsa', digest: 'sha256' },
  RS384: { family: 'rsa', digest: 'sha384' },
  RS512: { family: 'rsa', digest: 'sha512' },
  PS256: { family: 'rsa-pss', digest: 'sha256' },
  PS384: { family: 'rsa-pss', digest: 'sha384' },
  PS512: { family: 'rsa-pss', digest: 'sha512' },
  // ECDSA: r||s lengths come from the curve order — 32B for P-256,
  // 48B for P-384, 66B for P-521 (the curve is 521 bits, padded to 528 = 66B).
  ES256: { family: 'ecdsa', digest: 'sha256', ecSigLen: 64 },
  ES384: { family: 'ecdsa', digest: 'sha384', ecSigLen: 96 },
  ES512: { family: 'ecdsa', digest: 'sha512', ecSigLen: 132 },
}

/**
 * A verification key as supplied by the caller (post-resolution).
 * - `string` / `Buffer` for HMAC secrets and PEM blobs.
 * - `KeyObject` for pre-built node:crypto keys (and JWKS-derived keys).
 */
export type VerifyKeyMaterial = string | Buffer | KeyObject

/** Optional kid-tagged variant — what middleware passes after kid resolution. */
export interface KidTaggedKey {
  kid?: string
  key: VerifyKeyMaterial
}

/** Options accepted by {@link verifyJwt}. Mirrors the relevant subset of `JwtOptions`. */
export interface VerifyOptions {
  algorithms: readonly JwtAlgorithm[]
  audience?: string | readonly string[]
  issuer?: string | readonly string[]
  maxAgeSeconds?: number
  clockSkewSeconds?: number
  /**
   * Require a finite numeric `exp`. Default `true` — a token without an
   * expiry would otherwise verify forever (see middleware `requireExp`).
   */
  requireExp?: boolean
  /** Override "now" for deterministic tests. Returns seconds since epoch. */
  nowSeconds?: () => number
}

/**
 * Decode a base64url-encoded JSON segment. Returns `null` on malformed input
 * (so callers can fold it into the generic `'malformed'` failure mode).
 */
function decodeJsonSegment<T = unknown>(segment: string): T | null {
  if (!segment) return null
  try {
    const buf = Buffer.from(segment, 'base64url')
    if (buf.length === 0) return null
    const parsed = JSON.parse(buf.toString('utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object') return null
    return parsed as T
  } catch {
    return null
  }
}

/**
 * Does this key material belong to the symmetric (HMAC) family?
 *
 * This is the load-bearing guard against the classic algorithm-confusion
 * attack: a server configured for an asymmetric alg but tricked into running
 * HMAC verifies the forgery with the PUBLIC key as the shared secret. A PEM
 * (or any asymmetric `KeyObject`) is therefore NEVER eligible as an HMAC key.
 * Only a raw string/Buffer secret, or a `secret`-type `KeyObject`, qualifies.
 */
function isSymmetricKey(key: VerifyKeyMaterial): boolean {
  if (typeof key === 'string') return !looksLikePem(key)
  if (Buffer.isBuffer(key)) return !looksLikePem(key.toString('latin1'))
  // KeyObject: only the 'secret' type is HMAC-eligible; 'public'/'private' are not.
  return (key as KeyObject).type === 'secret'
}

/** A PEM-armored blob is asymmetric key material, never an HMAC secret. */
function looksLikePem(s: string): boolean {
  return s.trimStart().startsWith('-----BEGIN')
}

/**
 * Constant-time HMAC verification.
 *
 * `timingSafeEqual` requires equal-length buffers — feeding mismatched lengths
 * would itself leak length info via the throw. So we compare `signingInput`'s
 * computed signature against the supplied one only after the explicit length
 * check; both branches return `false` in O(constant) time relative to the
 * caller's view (the throw path never executes).
 *
 * The caller MUST have already established via {@link isSymmetricKey} that
 * `secret` is HMAC-eligible — a public/private `KeyObject` would throw inside
 * `export({format:'buffer'})`, and a PEM string would be silently (and
 * dangerously) used as a shared secret. This function additionally try/catches
 * so a mis-typed key degrades to `false` (bad_signature) rather than a 500.
 */
function hmacVerifies(
  digest: string,
  secret: VerifyKeyMaterial,
  signingInput: string,
  sig: Buffer,
): boolean {
  try {
    // HMAC accepts string or Buffer; a 'secret' KeyObject exports to a buffer.
    const secretInput: string | Buffer =
      typeof secret === 'string' || Buffer.isBuffer(secret)
        ? secret
        : secret.export({ format: 'buffer' } as never)
    const expected = createHmac(digest, secretInput).update(signingInput).digest()
    if (sig.length !== expected.length) return false
    return timingSafeEqual(sig, expected)
  } catch {
    return false
  }
}

/**
 * Asymmetric verification via OpenSSL. The key may be a PEM (string/Buffer)
 * or a pre-built `KeyObject`; we normalise via `createPublicKey` once. RSA
 * algorithms (RSxxx) use PKCS1-v1_5; PS* uses PSS (with MGF1 + salt = digest);
 * ECDSA decodes from raw r||s (per JOSE) rather than DER.
 *
 * `crypto.verify` from OpenSSL is constant-time relative to the key — we
 * don't add an extra timing shield ourselves.
 */
function asymmetricVerifies(
  spec: AlgSpec,
  keyMaterial: VerifyKeyMaterial,
  signingInput: string,
  sig: Buffer,
): boolean {
  let key: KeyObject
  try {
    key =
      typeof keyMaterial === 'string' || Buffer.isBuffer(keyMaterial)
        ? createPublicKey(keyMaterial)
        : keyMaterial
  } catch {
    return false
  }

  // ECDSA: spec mandates raw r||s (concatenation of two fixed-length integers).
  // node:crypto's default DSA encoding is DER; we have to set 'ieee-p1363' to
  // get the JOSE wire format. Length-check up front so a malformed sig never
  // hits openssl with garbage.
  if (spec.family === 'ecdsa') {
    if (typeof spec.ecSigLen === 'number' && sig.length !== spec.ecSigLen) return false
    try {
      return cryptoVerify(spec.digest, Buffer.from(signingInput, 'utf8'), {
        key,
        dsaEncoding: 'ieee-p1363',
      }, sig)
    } catch {
      return false
    }
  }

  if (spec.family === 'rsa-pss') {
    try {
      return cryptoVerify(spec.digest, Buffer.from(signingInput, 'utf8'), {
        key,
        padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
        // RFC 7518 §3.5: salt length equals the digest output length.
        saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
      }, sig)
    } catch {
      return false
    }
  }

  // Plain RSA-PKCS1-v1_5.
  try {
    return cryptoVerify(spec.digest, Buffer.from(signingInput, 'utf8'), key, sig)
  } catch {
    return false
  }
}

/**
 * A JWT temporal claim (`exp`/`nbf`/`iat`) is only meaningful as a finite
 * number of seconds. `NaN`/`Infinity` would defeat the `<=` comparisons, so
 * they're rejected the same as a missing claim.
 */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** Allowed claim resolution — both single value and array forms are common in spec. */
function audienceMatches(claim: unknown, expected: string | readonly string[]): boolean {
  const wanted = typeof expected === 'string' ? [expected] : expected
  if (typeof claim === 'string') return wanted.includes(claim)
  if (Array.isArray(claim)) {
    for (const c of claim) {
      if (typeof c === 'string' && wanted.includes(c)) return true
    }
  }
  return false
}

function issuerMatches(claim: unknown, expected: string | readonly string[]): boolean {
  if (typeof claim !== 'string') return false
  return typeof expected === 'string' ? expected === claim : expected.includes(claim)
}

/**
 * Pure JWT verifier. No I/O, no logging — returns either a `JwtVerified` or
 * a tagged failure object. The middleware layer is responsible for collapsing
 * every failure into the same `IngeniumUnauthorizedError('Invalid token')` so
 * the wire never reveals which check tripped.
 *
 * `keys` is a flat array because key-resolution (rotation, kid-lookup, JWKS)
 * is the caller's responsibility; this function just tries them in order.
 * Each entry may carry an optional `kid` — when present AND `header.kid` is
 * set, only matching entries are considered. Without a `header.kid`, every
 * entry is tried.
 *
 * `alg: 'none'` is rejected unconditionally, even if for some reason the
 * allowlist were extended to include it. Defence in depth.
 */
export function verifyJwt<T = Record<string, unknown>>(
  token: string,
  keys: readonly (VerifyKeyMaterial | KidTaggedKey)[],
  opts: VerifyOptions,
): JwtVerified<T> | JwtVerifyError {
  if (typeof token !== 'string' || token.length === 0) return { error: 'malformed' }

  // Compact serialization: header.payload.signature
  const firstDot = token.indexOf('.')
  if (firstDot <= 0) return { error: 'malformed' }
  const secondDot = token.indexOf('.', firstDot + 1)
  if (secondDot <= firstDot + 1) return { error: 'malformed' }
  if (token.indexOf('.', secondDot + 1) !== -1) return { error: 'malformed' }
  // The signature segment may legally be empty only for 'alg: none', which
  // we reject anyway. Treat empty as malformed.
  if (secondDot === token.length - 1) return { error: 'malformed' }

  const headerB64 = token.slice(0, firstDot)
  const payloadB64 = token.slice(firstDot + 1, secondDot)
  const sigB64 = token.slice(secondDot + 1)

  const header = decodeJsonSegment<JwtHeader>(headerB64)
  if (!header || typeof header.alg !== 'string') return { error: 'malformed' }

  // Hard-reject 'none' BEFORE the allowlist check — even if a buggy caller
  // somehow lets it through. This is the canonical JWT-library footgun.
  if (header.alg === 'none' || header.alg.toLowerCase() === 'none') {
    return { error: 'unsupported_alg' }
  }

  const alg = header.alg as JwtAlgorithm
  if (!opts.algorithms.includes(alg)) return { error: 'unsupported_alg' }
  const spec = ALG_SPEC[alg]
  if (!spec) return { error: 'unsupported_alg' }

  const payload = decodeJsonSegment<T & Record<string, unknown>>(payloadB64)
  if (!payload) return { error: 'malformed' }

  const signingInput = `${headerB64}.${payloadB64}`

  // Decode signature once.
  let sig: Buffer
  try {
    sig = Buffer.from(sigB64, 'base64url')
  } catch {
    return { error: 'malformed' }
  }
  if (sig.length === 0) return { error: 'malformed' }

  // Filter keys by kid when both sides advertise one. This both narrows the
  // candidate set (perf) and is required for JWKS — the resolver may have
  // returned the entire keyset.
  const headerKid = typeof header.kid === 'string' ? header.kid : null
  const candidates = selectCandidates(keys, headerKid)
  if (candidates.length === 0) {
    // If the caller supplied kid-tagged keys but none matched, we know
    // nothing will verify — surface this as a distinct (internal) reason
    // so the logger can be precise. The wire still gets 'Invalid token'.
    return { error: headerKid ? 'kid_unknown' : 'bad_signature' }
  }

  let signatureOk = false
  for (const candidate of candidates) {
    // Bind the algorithm family to the key family. An HMAC alg must never be
    // attempted against an asymmetric key (the algorithm-confusion / key-as-
    // secret forgery), and an asymmetric alg must never run against a raw
    // symmetric secret. A mismatched candidate is simply skipped — if NONE of
    // the supplied keys are family-compatible we fall through to bad_signature.
    const candidateIsSymmetric = isSymmetricKey(candidate)
    if (spec.family === 'hmac') {
      if (!candidateIsSymmetric) continue
      if (hmacVerifies(spec.digest, candidate, signingInput, sig)) {
        signatureOk = true
        break
      }
    } else {
      if (candidateIsSymmetric) continue
      if (asymmetricVerifies(spec, candidate, signingInput, sig)) {
        signatureOk = true
        break
      }
    }
  }
  if (!signatureOk) return { error: 'bad_signature' }

  // Temporal claims.
  const now = (opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))()
  const skew = opts.clockSkewSeconds ?? 5
  const claims = payload as Record<string, unknown>

  // A present-but-non-numeric temporal claim is an attempt to slip past the
  // numeric checks below (e.g. `exp: "9999999999"` as a string). Treat any
  // such claim as malformed rather than silently skipping the comparison.
  if ('exp' in claims && !isFiniteNumber(claims.exp)) return { error: 'malformed' }
  if ('nbf' in claims && !isFiniteNumber(claims.nbf)) return { error: 'malformed' }
  if ('iat' in claims && !isFiniteNumber(claims.iat)) return { error: 'malformed' }

  const requireExp = opts.requireExp ?? true
  if (isFiniteNumber(claims.exp)) {
    if (claims.exp <= now - skew) return { error: 'expired' }
  } else if (requireExp) {
    // No usable expiry — refuse rather than accept a non-expiring token.
    return { error: 'missing_exp' }
  }
  if (isFiniteNumber(claims.nbf)) {
    if (claims.nbf > now + skew) return { error: 'not_yet_valid' }
  }
  if (typeof opts.maxAgeSeconds === 'number') {
    if (!isFiniteNumber(claims.iat)) return { error: 'too_old' }
    // A future-dated `iat` would otherwise sail past the freshness ceiling
    // (`iat + maxAge` stays far above `now`), making the max-age window
    // effectively unbounded. Reject `iat` beyond the clock-skew tolerance.
    if (claims.iat > now + skew) return { error: 'too_old' }
    if (claims.iat + opts.maxAgeSeconds <= now - skew) return { error: 'too_old' }
  }
  if (opts.audience !== undefined) {
    if (!audienceMatches(claims.aud, opts.audience)) return { error: 'aud_mismatch' }
  }
  if (opts.issuer !== undefined) {
    if (!issuerMatches(claims.iss, opts.issuer)) return { error: 'iss_mismatch' }
  }

  return { header, payload, raw: token }
}

/**
 * Reduce the supplied key array to the set worth trying:
 * - If `header.kid` is set, prefer entries whose `kid` matches. If at least
 *   one tagged key matches, ONLY those are tried (no fallback to untagged
 *   keys — an attacker shouldn't be able to coerce a kid-tagged JWKS into
 *   trying an unrelated rotation key).
 * - If `header.kid` is set but no tagged key matches, AND the array contains
 *   untagged keys, try the untagged ones (legacy / single-key callers).
 * - If `header.kid` is absent, try every entry's `key`.
 */
function selectCandidates(
  keys: readonly (VerifyKeyMaterial | KidTaggedKey)[],
  headerKid: string | null,
): VerifyKeyMaterial[] {
  if (headerKid) {
    const matched: VerifyKeyMaterial[] = []
    let sawAnyTagged = false
    const untagged: VerifyKeyMaterial[] = []
    for (const k of keys) {
      if (isKidTagged(k)) {
        sawAnyTagged = true
        if (k.kid === headerKid) matched.push(k.key)
      } else {
        untagged.push(k)
      }
    }
    if (matched.length > 0) return matched
    // No tag match — fall back to untagged only when nothing was tagged at
    // all (caller didn't intend kid routing). If they tagged some but the
    // header.kid matches none, refuse.
    if (sawAnyTagged) return []
    return untagged
  }

  const out: VerifyKeyMaterial[] = []
  for (const k of keys) {
    if (isKidTagged(k)) out.push(k.key)
    else out.push(k)
  }
  return out
}

function isKidTagged(k: VerifyKeyMaterial | KidTaggedKey): k is KidTaggedKey {
  return (
    typeof k === 'object' &&
    k !== null &&
    !Buffer.isBuffer(k) &&
    'key' in (k as object) &&
    'kid' in (k as object)
  )
}

/** Internal helper — exported for tests that want a stable digest map. */
export function digestFor(alg: JwtAlgorithm): string {
  return ALG_SPEC[alg].digest
}

/** Internal helper — surface the alg family for tests / introspection. */
export function familyFor(alg: JwtAlgorithm): AlgSpec['family'] {
  return ALG_SPEC[alg].family
}
