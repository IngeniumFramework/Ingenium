import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import type { IngeniumContext, ResponseBody } from '../context/context.ts'
import type { IngeniumMiddleware } from '../middleware/types.ts'
import type { HttpMethod } from '../router/types.ts'
import { IngeniumBadRequestError } from '../errors.ts'
import { IdempotencyMemoryStore } from './store.ts'
import type {
  CachedResponse,
  IdempotencyOptions,
  ResolvedIdempotencyOptions,
} from './types.ts'

/**
 * Module-scope so V8 dead-code-eliminates the `if (IS_DEV)` diagnostic
 * bodies in production builds. Read once at load — never per request.
 */
const IS_DEV = process.env.NODE_ENV !== 'production'

const DEFAULT_METHODS: readonly HttpMethod[] = ['POST', 'PATCH', 'DELETE']

/**
 * Length-prefixed encoding of the cache-key components. Prefixing each part
 * with its byte length makes the boundaries unambiguous regardless of what
 * characters (including `:`) appear inside any component, so no two distinct
 * tuples can encode to the same string. Fed into a hash by the caller.
 */
function idempotencyKeyParts(...parts: string[]): string {
  let out = ''
  for (const p of parts) out += Buffer.byteLength(p) + ':' + p + '\n'
  return out
}

/**
 * Build the store key for a request. A naive `${scope}:${method}:${path}:${key}`
 * join is ambiguous — `scope`/`path` can contain `:`, so distinct tuples could
 * collide and let one client replay another's cached response. We hash a
 * length-prefixed encoding so component boundaries are unambiguous and the
 * stored key is a fixed-length digest rather than the raw (often secret-derived)
 * scope.
 *
 * @internal Exposed for tests that assert the scope→key mapping; not a public
 * API and may change without a SemVer bump.
 */
export function buildIdempotencyCacheKey(
  scope: string,
  method: string,
  path: string,
  key: string,
): string {
  return createHash('sha256').update(idempotencyKeyParts(scope, method, path, key)).digest('hex')
}

/**
 * Upper bound on the `Idempotency-Key` header length. The key is embedded
 * verbatim in the cache key and retained in the store for the full TTL, so an
 * unbounded value lets a client cache arbitrarily large keys → memory DoS.
 * Stripe-style keys are short (≤ 64 chars in practice); 256 is generous.
 */
const MAX_IDEMPOTENCY_KEY_LENGTH = 256

/**
 * Default cacheable predicate: cache 2xx/3xx/4xx, NOT 5xx. Stripe
 * convention — a transient 500 must not be replayed forever.
 */
const DEFAULT_CACHEABLE = (status: number): boolean => status >= 200 && status < 500

/**
 * Sentinel returned by `defaultScope` for an unauthenticated request. A
 * unique symbol (not the string `'anon'`) so the middleware can reliably
 * distinguish "the framework couldn't isolate this client" from any string
 * a user-supplied scope function might legitimately return. We must NOT
 * cache across anonymous clients: the cache key is
 * `<scope>:<method>:<path>:<key>`, so collapsing every anonymous caller to
 * one constant lets client B reuse client A's idempotency key on the same
 * route and be served A's full cached response — body AND Set-Cookie. IP
 * is not a safe discriminator (shared NAT / spoofable), so we bypass.
 */
const ANON_SCOPE = Symbol('ingenium.idempotency.anon')

/**
 * Authorization-header-derived scope. Returns the `ANON_SCOPE` sentinel
 * (not a string) when there is no Authorization header so the caller can
 * detect the un-isolatable case and skip caching entirely.
 */
function defaultScope(ctx: IngeniumContext): string | typeof ANON_SCOPE {
  const auth = ctx.headers['authorization']
  if (typeof auth === 'string' && auth.length > 0) return auth
  if (Array.isArray(auth) && auth.length > 0 && typeof auth[0] === 'string') return auth[0]
  return ANON_SCOPE
}

/**
 * Response headers that carry per-client secrets/session state and must
 * NEVER be replayed from a cached entry onto a different request. Even with
 * correct scoping these are dangerous to copy verbatim; stripping them is
 * defense-in-depth so a misconfigured scope can't leak another client's
 * session cookie or bearer credential.
 */
const SENSITIVE_REPLAY_HEADERS: readonly string[] = [
  'set-cookie',
  'authorization',
  'proxy-authorization',
  'www-authenticate',
  'proxy-authenticate',
]

/** Pull a header value as a single string (first element if it came as an array). */
function readHeader(ctx: IngeniumContext, lowerName: string): string | undefined {
  const v = ctx.headers[lowerName]
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined
  return undefined
}

/**
 * Snapshot whatever the handler wrote to `ctx`. Streams are NOT cached —
 * we cannot rewind a `Readable`, so a streamed response makes the request
 * non-idempotent (the second call will run the handler again).
 *
 * Returns `null` to signal "do not cache" (stream / nothing written).
 */
function snapshot(ctx: IngeniumContext): CachedResponse | null {
  if (!ctx._written) return null
  const body = ctx._body
  let serialized: string | Buffer | null
  switch (body.kind) {
    case 'none':
      serialized = null
      break
    case 'string':
      serialized = body.data
      break
    case 'buffer':
      // Copy the buffer — caller may reuse the underlying memory.
      serialized = Buffer.from(body.data)
      break
    case 'stream':
      return null
  }
  // Shallow-copy headers; values are strings or string[] (immutable in practice).
  const headersCopy: Record<string, string | string[]> = Object.create(null)
  for (const k of Object.keys(ctx._headers)) {
    const v = ctx._headers[k]
    if (v === undefined) continue
    headersCopy[k] = Array.isArray(v) ? [...v] : v
  }
  return { statusCode: ctx._statusCode, headers: headersCopy, body: serialized }
}

/** Replay a cached response onto a fresh `ctx`. */
function replay(ctx: IngeniumContext, cached: CachedResponse): void {
  ctx._statusCode = cached.statusCode
  // Replace, not merge — replayed response is authoritative.
  ctx._headers = Object.create(null) as Record<string, string | string[]>
  for (const k of Object.keys(cached.headers)) {
    const v = cached.headers[k]
    if (v === undefined) continue
    // Never replay per-client secrets onto a different request — a cached
    // Set-Cookie / Authorization would hand one client another's session.
    if (SENSITIVE_REPLAY_HEADERS.includes(k.toLowerCase())) continue
    ctx._headers[k] = Array.isArray(v) ? [...v] : v
  }
  ctx._headers['idempotent-replayed'] = 'true'
  let nextBody: ResponseBody
  if (cached.body === null) {
    nextBody = { kind: 'none' }
  } else if (typeof cached.body === 'string') {
    nextBody = { kind: 'string', data: cached.body }
  } else {
    nextBody = { kind: 'buffer', data: Buffer.from(cached.body) }
  }
  ctx._body = nextBody
  ctx._written = true
}

/**
 * Idempotency-Key middleware (per Stripe / IETF idempotency-key draft).
 *
 * Behavior:
 * - Non-mutating method or missing header → pass through.
 * - Mutating method WITH header:
 *   1. Build cache key: `<scope>:<method>:<path>:<idempotency-key>`.
 *   2. Cache hit → replay the cached (status, headers, body) and set
 *      `Idempotent-Replayed: true`. Handler does NOT run.
 *   3. Cache miss → run handler. If the response is cacheable (i.e. not a
 *      stream and something was written), persist it under the key with
 *      the configured TTL.
 *   4. Concurrent in-flight requests for the same key are coordinated via
 *      an in-process Promise map: the second request awaits the first and
 *      replays its result.
 *
 * Note: the cache key intentionally does NOT include the request body —
 * the spec assumes the client guarantees byte-for-byte identical retries,
 * and reading the body at middleware-entry time would defeat lazy parsing.
 *
 * @example
 *   app.use(ingenium.idempotency({
 *     store: new IdempotencyMemoryStore(),
 *     ttlSeconds: 86_400,
 *   }))
 */
export function idempotencyMiddleware(opts: IdempotencyOptions = {}): IngeniumMiddleware {
  // When the user supplies their own scope function we trust it to isolate
  // clients and never bypass. Only the built-in `defaultScope` can yield the
  // un-isolatable anonymous sentinel, so we capture whether it's in play.
  const usingDefaultScope = opts.scope === undefined
  const scopeFn: (ctx: IngeniumContext) => string | typeof ANON_SCOPE = opts.scope ?? defaultScope

  const resolved: ResolvedIdempotencyOptions = {
    header: (opts.header ?? 'Idempotency-Key').toLowerCase(),
    store: opts.store ?? new IdempotencyMemoryStore(),
    ttlMs: (opts.ttlSeconds ?? 86_400) * 1000,
    scope: scopeFn as (ctx: IngeniumContext) => string,
    methodSet: new Set(opts.methods ?? DEFAULT_METHODS),
    cacheable: opts.cacheable ?? DEFAULT_CACHEABLE,
  }

  if (resolved.ttlMs <= 0) {
    throw new Error('idempotency: ttlSeconds must be > 0')
  }

  // Warn at most once per process — the bypass is correct but the developer
  // almost certainly wants an explicit `scope` for unauthenticated routes.
  let anonBypassWarned = false

  // Per-key in-flight map. The promise resolves once the first handler
  // finishes and its response has been snapshotted (or with `null` if the
  // response wasn't cacheable — second request then runs the handler).
  const inflight: Map<string, Promise<CachedResponse | null>> = new Map()

  return async (ctx, next) => {
    if (!resolved.methodSet.has(ctx.method)) {
      return next()
    }

    const headerValue = readHeader(ctx, resolved.header)
    if (!headerValue || headerValue.length === 0) {
      return next()
    }

    // Reject an over-long key BEFORE it reaches the cache key / store. An
    // unbounded Idempotency-Key would be retained verbatim for the whole TTL,
    // turning a single header into a memory-DoS lever.
    if (headerValue.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new IngeniumBadRequestError(
        `Idempotency-Key exceeds the maximum length of ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
      )
    }

    const scope = scopeFn(ctx)

    // Anonymous + default scope: there is no per-client discriminator, so
    // caching here would serve one client's response (body + Set-Cookie) to
    // another that happens to reuse the same Idempotency-Key on this route.
    // Bypass entirely — run the handler without replay/store. (Only the
    // built-in defaultScope can produce ANON_SCOPE; an explicit user scope
    // never reaches this branch and keeps its prior behavior.)
    if (scope === ANON_SCOPE) {
      if (IS_DEV && usingDefaultScope && !anonBypassWarned) {
        anonBypassWarned = true
        try {
          process.emitWarning(
            'idempotency: request to a cacheable route has no Authorization header, so the default scope cannot isolate clients. Idempotency caching was bypassed for this request to avoid serving one client the cached response of another. Supply an explicit `scope` function for unauthenticated endpoints.',
            { type: 'IngeniumIdempotencyWarning' },
          )
        } catch {
          // process.emitWarning can throw in unusual runtimes (workers); swallow.
        }
      }
      return next()
    }

    // Collision-safe composite key (see buildIdempotencyCacheKey).
    const cacheKey = buildIdempotencyCacheKey(scope, ctx.method, ctx.path, headerValue)

    // 1. Persisted cache hit?
    const existing = await resolved.store.get(cacheKey)
    if (existing) {
      replay(ctx, existing)
      return
    }

    // 2. In-flight from a concurrent request?
    const pending = inflight.get(cacheKey)
    if (pending) {
      const result = await pending
      if (result) {
        replay(ctx, result)
        return
      }
      // First request wasn't cacheable — fall through and run the handler.
    }

    // 3. Cache miss + no in-flight: take ownership.
    let resolveInflight!: (value: CachedResponse | null) => void
    const ownPromise = new Promise<CachedResponse | null>((res) => { resolveInflight = res })
    inflight.set(cacheKey, ownPromise)

    try {
      await next()
      const captured = snapshot(ctx)
      // Honor the `cacheable` predicate — by default 5xx is NOT cached so a
      // transient failure can't poison the key for the entire TTL. When
      // skipped, resolve the in-flight promise with `null` so any waiter
      // re-runs the handler instead of replaying a stale failure.
      if (captured && resolved.cacheable(captured.statusCode)) {
        await resolved.store.set(cacheKey, captured, resolved.ttlMs)
        resolveInflight(captured)
      } else {
        resolveInflight(null)
      }
    } catch (err) {
      // Don't cache failures — clear the in-flight slot so retries can run
      // the handler fresh, and let the error propagate.
      resolveInflight(null)
      throw err
    } finally {
      inflight.delete(cacheKey)
    }
  }
}
