import type { IngeniumContext } from '../context/context.ts'

/**
 * Where the CSRF token lives between requests.
 *
 * - `'cookie'` (default): double-submit cookie pattern. Token is generated
 *   on safe requests, written to a non-HttpOnly cookie, and the client must
 *   echo it back via a header on unsafe requests. No session required.
 * - `'session'`: synchronizer pattern. Token is stored on `ctx.session`
 *   and validated against the submitted token on unsafe requests. Requires
 *   `sessionMiddleware` to run before this middleware.
 */
export type CsrfStorage = 'cookie' | 'session'

/** How to extract the submitted token from an incoming request. */
export type CsrfValueReader = (ctx: IngeniumContext) => string | undefined | Promise<string | undefined>

export interface CsrfCookieOptions {
  /** Cookie name. Default `ingenium.csrf`. */
  name?: string
  /** Restrict cookie to a single subpath. Default `/`. */
  path?: string
  /** Restrict cookie to a domain. Default unset. */
  domain?: string
  /** SameSite policy. Default `'lax'`. */
  sameSite?: 'lax' | 'strict' | 'none'
  /**
   * Mark cookie Secure. **Default `true`** so the CSRF cookie is never sent
   * over plaintext HTTP where a network attacker could read it and forge the
   * double-submit header. Override to `false` only for local HTTP development;
   * doing so emits a dev-mode warning.
   */
  secure?: boolean
  /**
   * Mark cookie HttpOnly. **Default `false`** — clients must read the cookie
   * to copy the value into the request header. Setting `true` would break the
   * double-submit pattern; only enable with a custom value reader that pulls
   * the token from elsewhere.
   */
  httpOnly?: boolean
  /** Cookie max-age (seconds). Default 7 days. */
  maxAgeSeconds?: number
}

export interface CsrfOptions {
  /**
   * HMAC secret used to sign the token. Required for the cookie storage
   * mode (signed double-submit). For session storage the secret is optional
   * — the session id already authenticates the binding.
   */
  secret?: string | string[]
  /** Token storage strategy. Default `'cookie'`. */
  storage?: CsrfStorage
  /** Cookie options when `storage === 'cookie'`. */
  cookie?: CsrfCookieOptions
  /**
   * Bind a cookie-mode token to a per-session/per-user identifier (e.g. a
   * session id or authenticated user id derived from `ctx`).
   *
   * Without binding, a signed double-submit token is only proven to have been
   * minted by *this server* — any token the server ever issued is globally
   * valid for any user, so a leaked or shared token defeats the protection.
   * When this returns a stable value, the token is HMAC'd over
   * `raw + '.' + binding` and the binding is re-verified on unsafe requests,
   * so a token minted for one session cannot be replayed against another.
   *
   * Returning `undefined` (e.g. before login) falls back to plain
   * double-submit and emits a dev-mode warning. Has no effect in session
   * storage mode, where the session id already authenticates the binding.
   */
  sessionBinding?: (ctx: IngeniumContext) => string | undefined
  /** Methods that bypass validation. Default `['GET', 'HEAD', 'OPTIONS', 'TRACE']`. */
  ignoreMethods?: readonly string[]
  /**
   * How to extract the submitted token. Default reads (in order):
   *   1. `X-CSRF-Token` header
   *   2. `X-XSRF-Token` header (Angular convention)
   *   3. `_csrf` query string parameter
   */
  value?: CsrfValueReader
  /**
   * Per-request opt-out. Return `true` to skip validation entirely for
   * this request (and skip token issuance).
   */
  skip?: (ctx: IngeniumContext) => boolean | Promise<boolean>
}
