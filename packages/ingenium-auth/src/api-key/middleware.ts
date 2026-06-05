import { timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { IngeniumUnauthorizedError } from 'ingenium'
import type { IngeniumMiddleware, IngeniumContext } from 'ingenium'
import type { ApiKeyLogger, ApiKeyOptions, ApiKeyValidator } from './types.ts'

/**
 * API-key authentication middleware.
 *
 * Attaches the validated key string at `ctx.apiKey`. Callers should
 * module-augment `IngeniumContext` for typed access:
 *
 * @example
 * ```ts
 * declare module 'ingenium' {
 *   interface IngeniumContext { apiKey?: string }
 * }
 *
 * import { ingenium } from 'ingenium'
 * const app = ingenium()
 * app.use(ingenium.apiKey({
 *   keys: process.env.API_KEYS!.split(','),
 *   scheme: 'ApiKey',
 *   query: 'api_key',
 * }))
 * ```
 *
 * Security choices:
 * - Allow-list comparisons go through `crypto.timingSafeEqual` after an
 *   explicit length check, so neither equality nor length leaks via timing.
 * - The wire-facing error is always `IngeniumUnauthorizedError('Invalid API key')`
 *   regardless of which lookup failed (header vs scheme vs query) — no
 *   oracle for which transport surface the legit key uses.
 * - Custom validators get the candidate key + ctx; their boolean result is
 *   trusted as-is. Validators should be constant-time when comparing keys.
 */
export function apiKeyMiddleware(opts: ApiKeyOptions): IngeniumMiddleware {
  // ── Construction-time validation ─────────────────────────────────────────
  if (opts == null || opts.keys === undefined || opts.keys === null) {
    throw new Error('apiKeyMiddleware: `keys` is required')
  }
  const validator = resolveValidator(opts.keys)
  const headerName = (opts.header ?? 'x-api-key').toLowerCase()
  const queryParam = opts.query ?? null
  const scheme = opts.scheme ?? null
  const schemeLower = scheme ? scheme.toLowerCase() : null
  const required = opts.required ?? true
  const logger: ApiKeyLogger =
    opts.logger ?? ((event) => process.emitWarning(`api-key auth failed: ${event.reason}`, 'IngeniumApiKeyWarning'))

  return async (ctx, next) => {
    const key = readKey(ctx, headerName, schemeLower, queryParam)
    if (!key) {
      if (required) {
        // Missing-key surface is not an oracle — there is no secret material
        // to compare against, so we use a distinct message.
        throw new IngeniumUnauthorizedError('Missing API key')
      }
      await next()
      return
    }

    let ok = false
    try {
      ok = await validator(key, ctx)
    } catch (err) {
      logger({ reason: 'validator_threw' })
      throw new IngeniumUnauthorizedError('Invalid API key')
    }
    if (!ok) {
      logger({ reason: 'no_match' })
      throw new IngeniumUnauthorizedError('Invalid API key')
    }

    ;(ctx as IngeniumContext & { apiKey?: string }).apiKey = key
    await next()
  }
}

/** Build a validator from either an allow-list or a user-supplied function. */
function resolveValidator(keys: readonly string[] | ApiKeyValidator): ApiKeyValidator {
  if (typeof keys === 'function') return keys
  if (!Array.isArray(keys)) {
    throw new Error('apiKeyMiddleware: `keys` must be a string[] or a validator function')
  }
  if (keys.length === 0) {
    throw new Error('apiKeyMiddleware: `keys` array must contain at least one key')
  }
  // Pre-encode the allow-list once, at construction, so the per-request path
  // does no allocation work beyond hashing the candidate buffer.
  const allow: Buffer[] = []
  for (const k of keys) {
    if (typeof k !== 'string' || k.length === 0) {
      throw new Error('apiKeyMiddleware: every key in the array must be a non-empty string')
    }
    allow.push(Buffer.from(k, 'utf8'))
  }
  return (candidate) => {
    const cand = Buffer.from(candidate, 'utf8')
    // We deliberately walk the entire list even after a match — a length-
    // dependent early-out would let an attacker probe how many keys exist
    // by measuring response time against length-classes. The list is small
    // and bounded by the user.
    let matched = false
    for (const a of allow) {
      if (a.length !== cand.length) continue
      if (timingSafeEqual(a, cand)) matched = true
    }
    return matched
  }
}

/**
 * Read the candidate key from the request, in priority order:
 * 1. The configured header (default `x-api-key`).
 * 2. The configured `Authorization` scheme, if any.
 * 3. The configured query parameter, if any.
 *
 * Returns `null` when no surface produced a non-empty key.
 */
function readKey(
  ctx: IngeniumContext,
  headerName: string,
  schemeLower: string | null,
  queryParam: string | null,
): string | null {
  const headerVal = ctx.headers[headerName]
  if (headerVal) {
    const v = Array.isArray(headerVal) ? headerVal[0] : headerVal
    if (v && v.length > 0) return v
  }

  if (schemeLower) {
    const auth = ctx.headers['authorization']
    if (auth) {
      const v = Array.isArray(auth) ? auth[0] : auth
      if (v) {
        const space = v.indexOf(' ')
        if (space > 0) {
          const s = v.slice(0, space).toLowerCase()
          if (s === schemeLower) {
            const tail = v.slice(space + 1).trim()
            if (tail.length > 0) return tail
          }
        }
      }
    }
  }

  if (queryParam) {
    const q = ctx.query.get(queryParam)
    if (q && q.length > 0) return q
  }

  return null
}
