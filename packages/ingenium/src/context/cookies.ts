import { createHmac, timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'
import type { IngeniumContext } from './context.ts'
import { IngeniumError } from '../errors.ts'

/**
 * Options accepted by {@link IngeniumCookies.set}. Maps 1:1 to RFC 6265 cookie
 * attributes plus a few modern extensions (`Priority`, `Partitioned`).
 *
 * `sameSite: true` is normalized to `'strict'` (Express compatibility);
 * `sameSite: false` omits the attribute entirely so the browser falls back
 * to its default policy.
 */
export interface CookieSetOptions {
  /** `Domain=` attribute. Omitted when undefined. */
  domain?: string
  /** `Path=` attribute. Defaults to `'/'`. */
  path?: string
  /** `Expires=` attribute. Serialized via `Date.toUTCString()`. */
  expires?: Date
  /** `Max-Age=` (seconds). Floored to an integer. */
  maxAge?: number
  /** `HttpOnly` flag. */
  httpOnly?: boolean
  /** `Secure` flag. */
  secure?: boolean
  /** `SameSite=` attribute. `true` → `'strict'`; `false`/omitted → no attr. */
  sameSite?: 'strict' | 'lax' | 'none' | true | false
  /** `Priority=` attribute (CHIPS / RFC 9220). Capitalized on the wire. */
  priority?: 'low' | 'medium' | 'high'
  /** `Partitioned` flag (CHIPS). */
  partitioned?: boolean
  /**
   * When `true`, the cookie value is HMAC-SHA-256 signed with the app's
   * `cookieSecrets[0]`. On the wire: `name=value.signature`. Throws
   * `IngeniumError(500, 'COOKIE_SECRET_MISSING')` if no secrets are configured.
   */
  signed?: boolean
}

/** Options accepted by {@link IngeniumCookies.get}. */
export interface CookieGetOptions {
  /**
   * When `true`, the cookie value is treated as `value.signature` and the
   * HMAC is verified against every configured secret (rotation-safe).
   * Returns `null` on tamper, missing signature, or no configured secrets.
   */
  signed?: boolean
}

/**
 * First-class cookie API exposed via `ctx.cookies`. Pool-bound and lazy —
 * the holder is allocated on first access and dropped to `null` on context
 * reset, so routes that never touch cookies pay zero overhead.
 *
 * Read side parses `ctx.headers.cookie` once and caches the resulting record.
 * Write side appends to the response `set-cookie` header, preserving prior
 * values (a single response may carry multiple `Set-Cookie` headers).
 */
export interface IngeniumCookies {
  /**
   * Read a cookie by name. With `{ signed: true }`, verifies the HMAC
   * suffix and returns `null` on mismatch. Returns `null` when the cookie
   * is absent.
   */
  get(name: string, opts?: CookieGetOptions): string | null
  /**
   * Snapshot of all parsed cookies. Signed cookies appear with their raw
   * `value.signature` suffix — call `.get(name, { signed: true })` to verify.
   */
  all(): Record<string, string>
  /**
   * Write a `Set-Cookie` header. Multiple calls accumulate (the response
   * carries one `Set-Cookie` header per call). With `{ signed: true }`,
   * the value is HMAC-SHA-256 signed.
   */
  set(name: string, value: string, opts?: CookieSetOptions): void
  /**
   * Expire a cookie. Emits `Max-Age=0` plus an `Expires` in the past, and
   * mirrors `path` / `domain` so the browser actually removes the right
   * cookie (a `Set-Cookie` only matches the existing cookie on those attrs).
   */
  clear(name: string, opts?: Pick<CookieSetOptions, 'domain' | 'path'>): void
}

// ───── Parser (RFC 6265 §5.2, defensive) ────────────────────────────────────

/**
 * Parse a `Cookie` request header into a name → value map. Mirrors the
 * `parseCookieHeader` helper in `session/middleware.ts` but kept inline here
 * so the cookie holder has no cross-module dependency on the session module.
 *
 * - First occurrence wins (RFC 6265 §5.4 typical browser behavior).
 * - Quoted values: surrounding `"` are stripped.
 * - Percent-encoded values are decoded via `decodeURIComponent`; bad encodings
 *   fall back to the raw value rather than throwing — this parser is exposed
 *   to attacker-controlled input and must never crash dispatch.
 */
function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>
  if (!header) return out

  const parts = header.split(';')
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const name = part.slice(0, eq).trim()
    if (!name || name in out) continue
    let value = part.slice(eq + 1).trim()
    if (
      value.length >= 2 &&
      value.charCodeAt(0) === 0x22 &&
      value.charCodeAt(value.length - 1) === 0x22
    ) {
      value = value.slice(1, -1)
    }
    try {
      out[name] = decodeURIComponent(value)
    } catch {
      out[name] = value
    }
  }
  return out
}

// ───── Serializer ───────────────────────────────────────────────────────────

/** Capitalize the first character; the rest stays as-is. */
function cap(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1)
}

/**
 * Serialize a single `Set-Cookie` value per RFC 6265 §4.1.1. The value is
 * `encodeURIComponent`-escaped so semicolons, whitespace, and control chars
 * cannot break the header (the read side mirrors this with `decodeURIComponent`).
 */
function serializeSetCookie(name: string, value: string, opts: CookieSetOptions): string {
  const segments: string[] = [`${name}=${encodeURIComponent(value)}`]
  if (opts.domain) segments.push(`Domain=${opts.domain}`)
  segments.push(`Path=${opts.path ?? '/'}`)

  if (opts.expires) {
    segments.push(`Expires=${opts.expires.toUTCString()}`)
  }
  if (typeof opts.maxAge === 'number') {
    // Max-Age must be an integer; floor to match RFC behaviour.
    segments.push(`Max-Age=${Math.floor(opts.maxAge)}`)
  }
  if (opts.httpOnly) segments.push('HttpOnly')
  if (opts.secure) segments.push('Secure')

  if (opts.sameSite !== undefined && opts.sameSite !== false) {
    // `true` → 'strict' for Express compat. Otherwise lowercase → Capitalized.
    const ss = opts.sameSite === true ? 'strict' : opts.sameSite
    segments.push(`SameSite=${cap(ss)}`)
  }
  if (opts.priority) segments.push(`Priority=${cap(opts.priority)}`)
  if (opts.partitioned) segments.push('Partitioned')

  return segments.join('; ')
}

/**
 * Append a `Set-Cookie` value to the response, preserving any existing
 * values. The header bag normalizes to an array on the second `.set()` so
 * the transport writes multiple `Set-Cookie` lines (per RFC 7230 §3.2.2,
 * `Set-Cookie` is the canonical exception to header-folding rules).
 */
function appendSetCookie(ctx: IngeniumContext<unknown>, value: string): void {
  const existing = ctx.getHeader('set-cookie')
  if (!existing) {
    ctx.set('set-cookie', value)
  } else if (Array.isArray(existing)) {
    ctx.set('set-cookie', [...existing, value])
  } else {
    ctx.set('set-cookie', [existing, value])
  }
}

// ───── HMAC sign / verify ───────────────────────────────────────────────────

/** HMAC-SHA-256(secret, value), base64url-encoded. */
function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url')
}

/**
 * Verify a `value.signature` cookie against any of the provided secrets.
 * Returns the un-signed value or `null`. Uses {@link timingSafeEqual} to
 * defeat byte-wise timing oracles. Splits on the LAST `.` so the underlying
 * value may itself contain dots.
 */
function verifySigned(raw: string, secrets: readonly string[]): string | null {
  const dot = raw.lastIndexOf('.')
  if (dot <= 0 || dot >= raw.length - 1) return null
  const value = raw.slice(0, dot)
  const sig = raw.slice(dot + 1)
  const sigBuf = Buffer.from(sig, 'base64url')
  if (sigBuf.length === 0) return null

  for (let i = 0; i < secrets.length; i++) {
    const expected = Buffer.from(sign(value, secrets[i]!), 'base64url')
    if (expected.length !== sigBuf.length) continue
    if (timingSafeEqual(expected, sigBuf)) return value
  }
  return null
}

// ───── Factory ──────────────────────────────────────────────────────────────

/**
 * Build the lazy cookie holder bound to `ctx`. The parsed-cookies cache is
 * populated on first read; the closed-over `parsed` reference is local to
 * the holder so a context that's reset and re-acquired gets a fresh holder
 * (because `ctx._cookies` is nulled on `reset()`).
 *
 * Secrets are read from `ctx._cookieSecrets`, which the app stamps at
 * dispatch entry when configured — same pattern as `_trustProxy`. The read
 * happens at sign/verify time (NOT at holder construction) so an app that
 * registers secrets after the holder is allocated still picks them up.
 */
export function makeIngeniumCookies<Params>(ctx: IngeniumContext<Params>): IngeniumCookies {
  let parsed: Record<string, string> | null = null

  const requireSecrets = (): readonly string[] => {
    const secrets = ctx._cookieSecrets
    if (!secrets || secrets.length === 0) {
      throw new IngeniumError(
        500,
        'COOKIE_SECRET_MISSING',
        'Signed cookies require `cookieSecrets` to be configured on the app.',
      )
    }
    return secrets
  }

  return {
    get(name, opts) {
      if (!parsed) parsed = parseCookieHeader(ctx.headers.cookie as string | undefined)
      const raw = parsed[name]
      if (raw === undefined) return null
      if (opts?.signed) {
        // Verify uses ALL secrets so rotation (new key first, old keys kept)
        // doesn't lock existing clients out mid-deploy.
        const secrets = requireSecrets()
        return verifySigned(raw, secrets)
      }
      return raw
    },
    all() {
      if (!parsed) parsed = parseCookieHeader(ctx.headers.cookie as string | undefined)
      return parsed
    },
    set(name, value, opts) {
      let wireValue = value
      if (opts?.signed) {
        // First secret signs; remaining secrets are verify-only (rotation).
        const secrets = requireSecrets()
        wireValue = `${value}.${sign(value, secrets[0]!)}`
      }
      appendSetCookie(ctx, serializeSetCookie(name, wireValue, opts ?? {}))
    },
    clear(name, opts) {
      // Max-Age=0 + an Expires in the distant past. Browsers only match on
      // (name, domain, path) when expiring, so mirror those from the caller.
      appendSetCookie(
        ctx,
        serializeSetCookie(name, '', {
          // exactOptionalPropertyTypes: only include `domain` when the caller
          // actually supplied one — an explicit `undefined` isn't assignable to
          // the optional `domain?: string` field.
          ...(opts?.domain !== undefined ? { domain: opts.domain } : {}),
          path: opts?.path ?? '/',
          maxAge: 0,
          expires: new Date(0),
        }),
      )
    },
  }
}
