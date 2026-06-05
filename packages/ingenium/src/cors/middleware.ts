import type { IngeniumMiddleware } from '../middleware/types.ts'
import type { IngeniumContext } from '../context/context.ts'
import type { CorsOptions, CorsOrigin } from './types.ts'
import { IngeniumError } from '../errors.ts'

const IS_DEV = process.env.NODE_ENV !== 'production'

const DEFAULT_METHODS: readonly string[] = [
  'GET',
  'HEAD',
  'PUT',
  'PATCH',
  'POST',
  'DELETE',
]

/**
 * Append a value to the `Vary` response header, de-duplicating field names
 * (case-insensitive).
 */
function appendVary(ctx: IngeniumContext, field: string): void {
  const existing = ctx.getHeader('vary')
  if (!existing) {
    ctx.set('vary', field)
    return
  }
  const cur = Array.isArray(existing) ? existing.join(', ') : existing
  const seen = cur
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)
  if (seen.includes(field.toLowerCase())) return
  ctx.set('vary', cur.length > 0 ? `${cur}, ${field}` : field)
}

/**
 * Resolve the `origin` option against the request's `Origin` header.
 * Returns the literal value to put on `Access-Control-Allow-Origin`, or
 * `null` to omit the header (request is denied / had no `Origin`).
 *
 * Also returns `reflected` — `true` when the value mirrors the request's
 * `Origin`, so the caller knows to add `Vary: Origin`.
 */
async function resolveOrigin(
  spec: CorsOrigin,
  reqOrigin: string | undefined,
  ctx: IngeniumContext,
): Promise<{ value: string | null; reflected: boolean }> {
  // Static wildcard: never depends on the request, never reflects.
  if (spec === '*') return { value: '*', reflected: false }
  if (spec === false) return { value: null, reflected: false }

  // Anything below requires an Origin header on the request.
  if (typeof reqOrigin !== 'string' || reqOrigin.length === 0) {
    return { value: null, reflected: false }
  }

  // `origin: true` reflects whatever the request sends — except the literal
  // string "null". Browsers send `Origin: null` for sandboxed iframes, `file://`
  // pages, and redirected/data-URL contexts; reflecting it back hands those
  // untrusted, un-attributable contexts a same-origin-equivalent grant. It is
  // only honoured when an explicit allowlist array opts into it (handled below).
  if (spec === true) {
    return reqOrigin === 'null'
      ? { value: null, reflected: true }
      : { value: reqOrigin, reflected: true }
  }

  if (typeof spec === 'string') {
    return spec === reqOrigin
      ? { value: reqOrigin, reflected: true }
      : { value: null, reflected: true }
  }

  if (Array.isArray(spec)) {
    return spec.includes(reqOrigin)
      ? { value: reqOrigin, reflected: true }
      : { value: null, reflected: true }
  }

  if (spec instanceof RegExp) {
    return spec.test(reqOrigin)
      ? { value: reqOrigin, reflected: true }
      : { value: null, reflected: true }
  }

  if (typeof spec === 'function') {
    const result = await spec(reqOrigin, ctx)
    if (result === true) return { value: reqOrigin, reflected: true }
    if (result === false) return { value: null, reflected: true }
    if (typeof result === 'string') {
      // Custom string — not a literal reflection; only Vary if it's not '*'.
      return { value: result, reflected: result !== '*' }
    }
    return { value: null, reflected: true }
  }

  return { value: null, reflected: false }
}

/**
 * CORS middleware. Implements the standard CORS protocol (Fetch spec
 * §3.2.4) for both simple requests and preflight (`OPTIONS` +
 * `Access-Control-Request-Method`).
 *
 * @example
 *   app.use(ingenium.cors())
 *   app.use(ingenium.cors({ origin: ['https://app.example.com'], credentials: true }))
 */
export function corsMiddleware(opts: CorsOptions = {}): IngeniumMiddleware {
  const origin: CorsOrigin = opts.origin ?? '*'
  const methods = opts.methods ?? DEFAULT_METHODS
  const allowedHeaders = opts.allowedHeaders
  const exposedHeaders = opts.exposedHeaders
  const credentials = opts.credentials ?? false
  const maxAge = opts.maxAge
  const optionsSuccessStatus = opts.optionsSuccessStatus ?? 204

  // Construction-time validation: `credentials: true` + wildcard origin is
  // forbidden by the CORS spec — browsers reject the response.
  if (credentials && origin === '*') {
    throw new IngeniumError(
      500,
      'CORS_CREDENTIALS_WILDCARD',
      "ingenium.cors: `credentials: true` is incompatible with `origin: '*'`. " +
        'Specify an explicit origin (string, array, regex, or function) instead.',
    )
  }

  // `credentials: true` + `origin: true` reflects *any* request Origin while
  // setting `Access-Control-Allow-Credentials: true`. That is the classic
  // credentialed-reflection vulnerability: any website can read authenticated
  // responses. Unlike `origin: '*'` the browser does NOT reject this, so we must
  // reject it ourselves at construction rather than silently shipping it.
  if (credentials && origin === true) {
    throw new IngeniumError(
      500,
      'CORS_CREDENTIALS_WILDCARD',
      'ingenium.cors: `credentials: true` is incompatible with `origin: true` ' +
        '(reflecting any Origin with credentials lets any site read authenticated ' +
        'responses). Specify an explicit allowlist (string, array, regex, or function).',
    )
  }

  // A function or RegExp origin combined with credentials can still reflect an
  // untrusted Origin if the predicate is too permissive. We can't statically
  // prove the predicate is safe, so warn (dev only) instead of throwing.
  if (
    IS_DEV &&
    credentials &&
    (typeof origin === 'function' || origin instanceof RegExp)
  ) {
    try {
      process.emitWarning(
        'ingenium.cors: `credentials: true` with a function/RegExp origin reflects ' +
          'the request Origin when the predicate matches. Ensure it never matches ' +
          'untrusted origins, or you expose authenticated responses to them.',
        { code: 'INGENIUM_CORS_CREDENTIALS_REFLECT' },
      )
    } catch {
      // Worker runtimes can throw on emitWarning; diagnostics are best-effort.
    }
  }

  // A function origin can return '*' for some requests and a specific origin
  // for others. Without `Vary: Origin` a shared cache could serve one caller's
  // allowed-origin response to a different origin (cache poisoning), so we force
  // the header on every response when the origin is computed per-request.
  const originIsFunction = typeof origin === 'function'

  const methodsHeader = methods.join(',')
  const exposedHeader = exposedHeaders && exposedHeaders.length > 0
    ? exposedHeaders.join(',')
    : undefined
  const allowedHeader = allowedHeaders && allowedHeaders.length > 0
    ? allowedHeaders.join(',')
    : undefined
  const maxAgeHeader = typeof maxAge === 'number' ? String(maxAge) : undefined

  return async (ctx, next) => {
    const reqOrigin = ctx.headers.origin
    const reqOriginStr = typeof reqOrigin === 'string' ? reqOrigin : undefined

    const { value: allowOrigin, reflected } = await resolveOrigin(
      origin,
      reqOriginStr,
      ctx,
    )

    if (reflected || originIsFunction) appendVary(ctx, 'Origin')

    if (allowOrigin !== null) {
      ctx.set('access-control-allow-origin', allowOrigin)
      if (credentials) {
        ctx.set('access-control-allow-credentials', 'true')
      }
    }

    // Detect preflight: OPTIONS + Access-Control-Request-Method header.
    const acrm = ctx.headers['access-control-request-method']
    const isPreflight =
      ctx.method === 'OPTIONS' && typeof acrm === 'string' && acrm.length > 0

    if (isPreflight) {
      ctx.set('access-control-allow-methods', methodsHeader)

      if (allowedHeader !== undefined) {
        ctx.set('access-control-allow-headers', allowedHeader)
      } else {
        const acrh = ctx.headers['access-control-request-headers']
        if (typeof acrh === 'string' && acrh.length > 0) {
          ctx.set('access-control-allow-headers', acrh)
          // The reflected headers vary with the request, so signal it.
          appendVary(ctx, 'Access-Control-Request-Headers')
        }
      }

      if (maxAgeHeader !== undefined) {
        ctx.set('access-control-max-age', maxAgeHeader)
      }

      // Preflight terminates here — no body, no downstream handlers.
      ctx.status(optionsSuccessStatus)
      ctx.set('content-length', '0')
      ctx._body = { kind: 'none' }
      ctx._written = true
      return
    }

    // Simple / actual request: expose headers, then continue the chain.
    if (exposedHeader !== undefined) {
      ctx.set('access-control-expose-headers', exposedHeader)
    }

    return next()
  }
}
