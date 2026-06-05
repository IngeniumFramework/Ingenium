import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { IngeniumError, IngeniumHeaderInjectionError } from '../errors.ts'
import type { IngeniumMiddleware } from '../middleware/types.ts'
import type { IngeniumContext } from '../context/context.ts'
import type { CsrfCookieOptions, CsrfOptions, CsrfValueReader } from './types.ts'

/** 403 Forbidden — CSRF token missing or mismatched. */
export class IngeniumCsrfError extends IngeniumError {
  constructor(message = 'CSRF token validation failed') {
    super(403, 'CSRF_FAILED', message)
  }
}

const IS_DEV = process.env.NODE_ENV !== 'production'

/** CR/LF detector — config-supplied cookie attributes must not inject headers. */
const CRLF_RE = /[\r\n]/

const TOKEN_BYTES = 18
const SAFE_METHODS_DEFAULT: readonly string[] = ['GET', 'HEAD', 'OPTIONS', 'TRACE']
const COOKIE_NAME_DEFAULT = 'ingenium.csrf'
const HEADER_NAMES_DEFAULT: readonly string[] = ['x-csrf-token', 'x-xsrf-token']

interface ResolvedOptions {
  secrets: string[]                   // first signs, all verify (rotation)
  storage: 'cookie' | 'session'
  cookie: Required<CsrfCookieOptions>
  ignoreMethods: Set<string>
  value: CsrfValueReader
  skip: ((ctx: IngeniumContext) => boolean | Promise<boolean>) | null
  sessionBinding: ((ctx: IngeniumContext) => string | undefined) | null
}

/**
 * CSRF protection middleware. Two modes:
 *
 * - `storage: 'cookie'` (default) — double-submit cookie pattern. A
 *   randomly-generated token is HMAC-signed, written to a non-HttpOnly
 *   cookie on safe requests, and the client must echo the cookie value
 *   back in a header (`X-CSRF-Token`) on unsafe requests. The signature
 *   prevents client-side forgery; the same-origin policy prevents
 *   cross-origin sites from reading the cookie.
 *
 * - `storage: 'session'` — synchronizer pattern. The token is stored on
 *   `ctx.session` and matched against the submitted token. Requires
 *   `sessionMiddleware` to run before this middleware.
 *
 * Use `ctx.state.csrfToken` (or call `(ctx as IngeniumContext & { csrfToken(): string }).csrfToken()`)
 * to read the current token to embed in HTML forms or send to a JS client.
 */
export function csrfMiddleware(opts: CsrfOptions = {}): IngeniumMiddleware {
  const resolved = resolveOptions(opts)
  if (resolved.storage === 'cookie' && resolved.secrets.length === 0) {
    throw new Error("csrfMiddleware: `secret` is required when storage is 'cookie'")
  }

  return async (ctx, next) => {
    if (resolved.skip && (await resolved.skip(ctx))) {
      await next()
      return
    }

    // Per-session binding (cookie mode only). When present, the token's
    // signature covers this value so a token minted for one session can't be
    // replayed against another. `undefined` falls back to plain double-submit.
    const binding =
      resolved.storage === 'cookie' && resolved.sessionBinding
        ? resolved.sessionBinding(ctx)
        : undefined
    if (
      IS_DEV &&
      resolved.storage === 'cookie' &&
      resolved.secrets.length > 0 &&
      binding === undefined
    ) {
      try {
        process.emitWarning(
          'csrfMiddleware: cookie-mode token has no session binding. Double-submit without binding assumes no XSS and a strict SameSite cookie — any token the server mints is globally valid. Provide `sessionBinding` to tie the token to a session/user.',
          { type: 'IngeniumCsrfUnboundTokenWarning' },
        )
      } catch {
        // process.emitWarning can throw in unusual runtimes (workers); swallow.
      }
    }

    // Resolve / mint the expected token for this request.
    let expected = readExpectedToken(ctx, resolved, binding)
    let mintedThisRequest = false
    if (!expected) {
      expected = mintToken(resolved, binding)
      mintedThisRequest = true
    }

    // Expose token to handlers via ctx.state.csrfToken AND a method.
    ctx.state.csrfToken = expected
    ;(ctx as IngeniumContext & { csrfToken: () => string }).csrfToken = () => expected as string

    const isUnsafe = !resolved.ignoreMethods.has(ctx.method)
    if (isUnsafe) {
      const submitted = await resolved.value(ctx)
      if (!submitted || !tokenMatches(submitted, expected)) {
        throw new IngeniumCsrfError()
      }
    }

    await next()

    // Issue (or refresh) the cookie on cookie-storage mode.
    if (resolved.storage === 'cookie' && (mintedThisRequest || isUnsafe)) {
      writeCookie(ctx, expected, resolved.cookie)
    } else if (resolved.storage === 'session' && mintedThisRequest) {
      writeSession(ctx, expected)
    }
  }
}

// ───── Token mint / verify ─────────────────────────────────────────────────

function mintToken(opts: ResolvedOptions, binding: string | undefined): string {
  const raw = randomBytes(TOKEN_BYTES).toString('base64url')
  if (opts.storage === 'session' || opts.secrets.length === 0) return raw
  // Signed for double-submit so a forged cookie value can't pass verification.
  // When a binding is present it's folded into the signature so the token is
  // only valid for the session/user it was minted for.
  const sig = signToken(raw, opts.secrets[0]!, binding)
  return `${raw}.${sig}`
}

/**
 * HMAC the token body. The binding (when present) is mixed into the signed
 * message so the same `raw` value produces a different signature per session —
 * a token can't be lifted from one user's cookie and replayed by another.
 * The binding is never stored in the token; it's re-derived from the request
 * at verify time, so it doesn't leak the session id to the client.
 */
function signToken(raw: string, secret: string, binding?: string | undefined): string {
  const message = binding === undefined ? raw : `${raw}.${binding}`
  return createHmac('sha256', secret).update(message).digest('base64url')
}

function tokenMatches(submitted: string, expected: string): boolean {
  const a = Buffer.from(submitted)
  const b = Buffer.from(expected)
  // Length-mismatch already rules out a match; timingSafeEqual requires equal length.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function verifySignedToken(
  token: string,
  secrets: readonly string[],
  binding: string | undefined,
): boolean {
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return false
  const raw = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  for (const secret of secrets) {
    const expected = signToken(raw, secret, binding)
    if (expected.length !== sig.length) continue
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return true
  }
  return false
}

// ───── Storage ─────────────────────────────────────────────────────────────

function readExpectedToken(
  ctx: IngeniumContext,
  opts: ResolvedOptions,
  binding: string | undefined,
): string | null {
  if (opts.storage === 'cookie') {
    const cookies = parseCookies(ctx.headers['cookie'])
    const token = cookies[opts.cookie.name]
    if (!token) return null
    // Verify against the current request's binding: a token signed for another
    // session won't match this request's binding and is rejected here, forcing
    // a fresh mint rather than silently trusting a cross-session token.
    if (opts.secrets.length > 0 && !verifySignedToken(token, opts.secrets, binding)) return null
    return token
  }
  // Session storage
  const session = (ctx as IngeniumContext & { session?: { get: (k: string) => unknown } }).session
  if (!session) {
    throw new Error("csrfMiddleware: storage='session' requires sessionMiddleware to run first")
  }
  const token = session.get('csrfToken')
  return typeof token === 'string' && token.length > 0 ? token : null
}

// TODO: migrate to ctx.cookies — kept inline because csrf uses the
// double-submit pattern with a non-HttpOnly cookie + HMAC value, which the
// generic cookie API doesn't model directly.
function writeCookie(ctx: IngeniumContext, token: string, cookie: Required<CsrfCookieOptions>): void {
  const parts: string[] = [`${cookie.name}=${encodeURIComponent(token)}`]
  parts.push(`Path=${cookie.path}`)
  if (cookie.domain) parts.push(`Domain=${cookie.domain}`)
  parts.push(`Max-Age=${cookie.maxAgeSeconds}`)
  parts.push(`SameSite=${cookie.sameSite[0]!.toUpperCase() + cookie.sameSite.slice(1)}`)
  if (cookie.secure) parts.push('Secure')
  if (cookie.httpOnly) parts.push('HttpOnly')
  appendSetCookie(ctx, parts.join('; '))
}

function writeSession(ctx: IngeniumContext, token: string): void {
  const session = (ctx as IngeniumContext & { session?: { set: (k: string, v: unknown) => void } }).session
  if (!session) return
  session.set('csrfToken', token)
}

function appendSetCookie(ctx: IngeniumContext, value: string): void {
  // This write goes straight to the header bag, bypassing ctx.set's guard, so
  // re-assert the same CR/LF check here on the fully-composed value.
  if (CRLF_RE.test(value)) {
    throw new IngeniumHeaderInjectionError(
      'csrfMiddleware: Set-Cookie value contains CR/LF (possible header injection)',
    )
  }
  const existing = ctx._headers['set-cookie']
  if (!existing) {
    ctx._headers['set-cookie'] = [value]
  } else if (Array.isArray(existing)) {
    existing.push(value)
  } else {
    ctx._headers['set-cookie'] = [existing, value]
  }
}

function parseCookies(header: string | string[] | undefined): Record<string, string> {
  // Null-prototype: a cookie named `constructor`/`toString`/`__proto__` must be
  // stored as plain own-data, not collide with inherited members (which would
  // make the `k in out` first-wins guard mis-fire). Mirrors the session parser.
  const out: Record<string, string> = Object.create(null)
  if (!header) return out
  const flat = Array.isArray(header) ? header.join('; ') : header
  for (const piece of flat.split(';')) {
    const eq = piece.indexOf('=')
    if (eq < 0) continue
    const k = piece.slice(0, eq).trim()
    const v = piece.slice(eq + 1).trim()
    if (!k || k in out) continue // first occurrence wins
    try {
      out[k] = decodeURIComponent(v)
    } catch {
      out[k] = v
    }
  }
  return out
}

// ───── Options resolution ──────────────────────────────────────────────────

function resolveOptions(opts: CsrfOptions): ResolvedOptions {
  const secrets =
    typeof opts.secret === 'string'
      ? [opts.secret]
      : Array.isArray(opts.secret)
        ? [...opts.secret]
        : []
  const storage = opts.storage ?? 'cookie'
  const cookie: Required<CsrfCookieOptions> = {
    name: opts.cookie?.name ?? COOKIE_NAME_DEFAULT,
    path: opts.cookie?.path ?? '/',
    domain: opts.cookie?.domain ?? '',
    sameSite: opts.cookie?.sameSite ?? 'lax',
    // Secure-by-default: a plaintext CSRF cookie is readable by a network
    // attacker, who can then forge the double-submit header.
    secure: opts.cookie?.secure ?? true,
    httpOnly: opts.cookie?.httpOnly ?? false,
    maxAgeSeconds: opts.cookie?.maxAgeSeconds ?? 7 * 24 * 60 * 60,
  }
  // Config-supplied cookie attributes are interpolated raw into Set-Cookie;
  // reject CR/LF here so they can't bypass the framework's header-injection
  // guard (which the rest of the framework enforces via ctx.set).
  if (CRLF_RE.test(cookie.path) || CRLF_RE.test(cookie.domain) || CRLF_RE.test(cookie.name)) {
    throw new IngeniumHeaderInjectionError(
      'csrfMiddleware: cookie name/path/domain contains CR/LF (possible header injection)',
    )
  }
  if (storage === 'cookie' && cookie.secure === false && IS_DEV) {
    try {
      process.emitWarning(
        'csrfMiddleware: CSRF cookie issued with Secure=false — the token is sent over plaintext HTTP and can be read by a network attacker. Only disable Secure for local HTTP development.',
        { type: 'IngeniumCsrfInsecureCookieWarning' },
      )
    } catch {
      // process.emitWarning can throw in unusual runtimes (workers); swallow.
    }
  }
  const ignoreMethods = new Set((opts.ignoreMethods ?? SAFE_METHODS_DEFAULT).map((m) => m.toUpperCase()))
  const value = opts.value ?? defaultValueReader
  return {
    secrets,
    storage,
    cookie,
    ignoreMethods,
    value,
    skip: opts.skip ?? null,
    sessionBinding: opts.sessionBinding ?? null,
  }
}

const defaultValueReader: CsrfValueReader = (ctx) => {
  for (const name of HEADER_NAMES_DEFAULT) {
    const v = ctx.headers[name]
    if (v) return Array.isArray(v) ? v[0] : v
  }
  const q = ctx.query.get('_csrf')
  return q ?? undefined
}
