import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'
import type { IngeniumMiddleware } from '../middleware/types.ts'
import type { IngeniumContext } from '../context/context.ts'
import { MemoryStore } from './store-memory.ts'
import type { Session, SessionCookieOptions, SessionOptions, SessionStore } from './types.ts'

// ───── Constants ────────────────────────────────────────────────────────────

/**
 * Read once at module load so the dev-only warning branch is dead-code
 * eliminated in production builds. See `context/context.ts` for the pattern.
 */
const IS_DEV = process.env.NODE_ENV !== 'production'

const DEFAULT_COOKIE_NAME = 'ingenium.sid'
const DEFAULT_MAX_AGE_SECONDS = 60 * 60 * 24 * 7 // 7 days
/** ID byte length — 18 bytes → 24 base64url chars, ~144 bits of entropy. */
const ID_BYTES = 18

// ───── Cookie helpers ───────────────────────────────────────────────────────
// TODO: migrate to ctx.cookies — kept inline for now because session has
// specific behaviours (rolling, secret-rotation re-signing, destroy-on-commit)
// that don't map 1:1 onto the generic cookie API.

/**
 * Parse a `Cookie` request header into a name→value map. Handles:
 * - Multiple cookies separated by `;` (with optional whitespace)
 * - Quoted values: `name="quoted value"`
 * - Percent-encoded characters via `decodeURIComponent`
 * - Duplicate names: first occurrence wins (matches RFC 6265 §5.4 typical behaviour)
 *
 * Malformed pairs are skipped silently — this is a defensive parser that
 * never throws on user input.
 */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
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
    // Strip surrounding double quotes.
    if (value.length >= 2 && value.charCodeAt(0) === 0x22 && value.charCodeAt(value.length - 1) === 0x22) {
      value = value.slice(1, -1)
    }
    try {
      out[name] = decodeURIComponent(value)
    } catch {
      // Bad percent-encoding — keep raw value rather than throwing.
      out[name] = value
    }
  }
  return out
}

/**
 * Serialize a single `Set-Cookie` value. We implement this inline to avoid
 * pulling in `cookie` as a dependency.
 *
 * `maxAge` is in seconds; when supplied we also emit an absolute `Expires`
 * for older clients that ignore `Max-Age`.
 */
export function serializeCookie(
  name: string,
  value: string,
  opts: SessionCookieOptions & { maxAge?: number } = {},
): string {
  // Encode the value so semicolons / whitespace cannot break the header.
  const segments: string[] = [`${name}=${encodeURIComponent(value)}`]
  if (opts.domain) segments.push(`Domain=${opts.domain}`)
  segments.push(`Path=${opts.path ?? '/'}`)

  if (typeof opts.maxAge === 'number') {
    // Floor — Max-Age must be an integer.
    const ma = Math.floor(opts.maxAge)
    segments.push(`Max-Age=${ma}`)
    const expires = new Date(Date.now() + ma * 1000)
    segments.push(`Expires=${expires.toUTCString()}`)
  }

  if (opts.httpOnly !== false) segments.push('HttpOnly')
  if (opts.secure) segments.push('Secure')
  const sameSite = opts.sameSite ?? 'lax'
  segments.push(`SameSite=${sameSite[0]!.toUpperCase()}${sameSite.slice(1)}`)

  return segments.join('; ')
}

/**
 * Append a `Set-Cookie` value to the response, preserving any existing
 * `Set-Cookie` header(s) from earlier middleware.
 */
function appendSetCookie(ctx: IngeniumContext, value: string): void {
  const existing = ctx.getHeader('set-cookie')
  if (!existing) {
    ctx.set('set-cookie', value)
  } else if (Array.isArray(existing)) {
    ctx.set('set-cookie', [...existing, value])
  } else {
    ctx.set('set-cookie', [existing, value])
  }
}

// ───── Signing ──────────────────────────────────────────────────────────────

/** HMAC-SHA-256 the id with `secret`, base64url-encoded. */
function signId(id: string, secret: string): string {
  return createHmac('sha256', secret).update(id).digest('base64url')
}

/**
 * Verify `cookieValue` (`<id>.<sig>`) against any of the supplied secrets.
 * Returns the id and the index of the matching secret, or `null`.
 *
 * Uses {@link timingSafeEqual} to defeat byte-wise timing oracles.
 */
function verifySigned(
  cookieValue: string,
  secrets: readonly string[],
): { id: string; secretIndex: number } | null {
  const dot = cookieValue.lastIndexOf('.')
  if (dot <= 0 || dot >= cookieValue.length - 1) return null
  const id = cookieValue.slice(0, dot)
  const sig = cookieValue.slice(dot + 1)
  const sigBuf = Buffer.from(sig, 'base64url')
  if (sigBuf.length === 0) return null

  for (let i = 0; i < secrets.length; i++) {
    const expected = Buffer.from(signId(id, secrets[i]!), 'base64url')
    if (expected.length !== sigBuf.length) continue
    if (timingSafeEqual(expected, sigBuf)) return { id, secretIndex: i }
  }
  return null
}

/** Generate a fresh, opaque session id. */
function newId(): string {
  return randomBytes(ID_BYTES).toString('base64url')
}

// ───── Session implementation ───────────────────────────────────────────────

/**
 * @internal Mutable-by-design implementation of {@link Session}. The public
 * `data` field is exposed via `Object.freeze` to keep callers from mutating
 * around the dirty-tracking surface.
 */
class SessionImpl implements Session {
  /** Tracks whether the session needs to be persisted on response. */
  dirty: boolean
  /** True when no record existed in the store at request start. */
  readonly isNew: boolean
  /** True after `destroy()` — middleware will clear cookie + store. */
  destroyed = false

  private _id: string
  private _data: Record<string, unknown>

  constructor(
    id: string,
    data: Record<string, unknown>,
    isNew: boolean,
    private readonly store: SessionStore,
    /** Set to `true` when secret rotation requires re-signing on response. */
    public needsResign: boolean,
  ) {
    this._id = id
    this._data = data
    this.isNew = isNew
    // A brand-new session with no data is NOT dirty — we don't want to
    // create empty rows or cookies for every anonymous request.
    this.dirty = false
  }

  get id(): string {
    return this._id
  }

  get data(): Readonly<Record<string, unknown>> {
    return Object.freeze({ ...this._data })
  }

  get<T = unknown>(key: string): T | undefined {
    return this._data[key] as T | undefined
  }

  set(key: string, value: unknown): void {
    this._data[key] = value
    this.dirty = true
  }

  delete(key: string): void {
    if (key in this._data) {
      delete this._data[key]
      this.dirty = true
    }
  }

  async destroy(): Promise<void> {
    await this.store.destroy(this._id)
    this._data = Object.create(null) as Record<string, unknown>
    this.destroyed = true
    this.dirty = false
  }

  async regenerate(): Promise<void> {
    const oldId = this._id
    this._id = newId()
    // Old id must die so a stolen cookie cannot resurrect the session.
    await this.store.destroy(oldId)
    this.dirty = true
    this.needsResign = true
  }

  /** @internal Snapshot for persistence; cheap shallow clone. */
  snapshot(): Record<string, unknown> {
    return { ...this._data }
  }
}

// ───── Middleware factory ───────────────────────────────────────────────────

/**
 * Cookie-backed session middleware.
 *
 * The middleware attaches a {@link Session} instance at `ctx.session`. To
 * make this typesafe in user code, augment the `IngeniumContext` interface in
 * your own project:
 *
 * @example
 * ```ts
 * declare module 'ingenium' {
 *   interface IngeniumContext { session: import('ingenium').Session }
 * }
 *
 * import { ingenium, sessionMiddleware } from 'ingenium'
 * const app = ingenium()
 * app.use(sessionMiddleware({ secret: process.env.SESSION_SECRET! }))
 *
 * app.get('/me', (ctx) => ({ user: ctx.session.get('user') }))
 * app.post('/login', async (ctx) => {
 *   ctx.session.set('user', { id: 1 })
 *   await ctx.session.regenerate() // mitigate session fixation
 * })
 * ```
 *
 * Security choices:
 * - HMAC-SHA-256 over the session id, base64url-encoded; verified with
 *   `timingSafeEqual`.
 * - 144-bit (18-byte) random ids.
 * - Defaults: `HttpOnly`, `SameSite=Lax`, `Path=/`. `Secure` defaults ON in
 *   production (`NODE_ENV==='production'`) and OFF in dev so http://localhost
 *   keeps working; set `cookie.secure: false` to force it off in production
 *   (a dev warning fires), or `true` to force it on everywhere.
 * - Tampered or unknown cookies silently issue a fresh session — never an
 *   error response, since this is an attacker-influenced surface.
 */
export function sessionMiddleware(opts: SessionOptions): IngeniumMiddleware {
  // ── Construction-time validation ─────────────────────────────────────────
  const secrets: readonly string[] = Array.isArray(opts.secret)
    ? opts.secret.slice()
    : [opts.secret]
  if (secrets.length === 0 || secrets.some((s) => typeof s !== 'string' || s.length === 0)) {
    throw new Error('sessionMiddleware: `secret` must be a non-empty string or non-empty string[]')
  }

  const cookieName = opts.cookieName ?? DEFAULT_COOKIE_NAME
  const maxAgeSeconds = opts.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS
  const rolling = opts.rolling ?? false
  const saveUninitialized = opts.saveUninitialized ?? false
  const baseCookieOpts: SessionCookieOptions = opts.cookie ?? {}
  const store: SessionStore = opts.store ?? new MemoryStore()

  // Safe-by-default `Secure`: when the caller didn't say either way, enable it
  // outside dev so a session cookie can't ride a plaintext-HTTP request and be
  // sniffed. An explicit `secure: false` still wins — that's the escape hatch
  // for serving over http in local/dev environments. We resolve this once and
  // bake it into the cookie options so every Set-Cookie below is consistent.
  const resolvedSecure = baseCookieOpts.secure ?? !IS_DEV
  const cookieOpts: SessionCookieOptions = { ...baseCookieOpts, secure: resolvedSecure }

  // In production, a session cookie without `Secure` is a real exposure; surface
  // it loudly but exactly once. The IS_DEV gate is inverted here on purpose —
  // we only care about the missing flag when NOT in dev.
  if (!IS_DEV && resolvedSecure === false) {
    try {
      process.emitWarning(
        'ingenium: sessionMiddleware is issuing a session cookie WITHOUT the Secure ' +
          'attribute in production (cookie.secure === false). The cookie can be sent ' +
          'over plaintext HTTP and intercepted. Remove `cookie.secure: false` to use ' +
          'the safe production default, or terminate TLS in front of the app.',
        { type: 'IngeniumSessionInsecureCookieWarning' },
      )
    } catch {
      /* worker contexts may throw on emitWarning */
    }
  }

  return async (ctx, next) => {
    const cookies = parseCookieHeader(ctx.headers.cookie as string | undefined)
    const raw = cookies[cookieName]

    let id: string
    let data: Record<string, unknown>
    let isNew: boolean
    let needsResign = false

    if (raw) {
      const verified = verifySigned(raw, secrets)
      if (verified) {
        const loaded = await store.get(verified.id)
        if (loaded) {
          id = verified.id
          data = { ...loaded }
          isNew = false
          // If verified by anything other than the active key, re-sign.
          if (verified.secretIndex !== 0) needsResign = true
        } else {
          // Cookie validly signed but store has nothing — treat as new.
          id = newId()
          data = Object.create(null) as Record<string, unknown>
          isNew = true
        }
      } else {
        // Bad signature → silently issue a new session.
        id = newId()
        data = Object.create(null) as Record<string, unknown>
        isNew = true
      }
    } else {
      id = newId()
      data = Object.create(null) as Record<string, unknown>
      isNew = true
    }

    const session = new SessionImpl(id, data, isNew, store, needsResign)
    // Decorator-by-assignment. Type augmentation (see JSDoc above) keeps
    // this typesafe in user code without polluting the shared prototype.
    ;(ctx as unknown as { session: Session }).session = session

    try {
      await next()
    } finally {
      await commit(ctx, session, secrets[0]!, cookieName, maxAgeSeconds, rolling, cookieOpts, store, saveUninitialized)
    }
  }
}

/**
 * Persist session changes and write the appropriate `Set-Cookie` header.
 * Runs in `finally` so we still clean up after handler errors.
 */
async function commit(
  ctx: IngeniumContext,
  session: SessionImpl,
  signingSecret: string,
  cookieName: string,
  maxAgeSeconds: number,
  rolling: boolean,
  cookieOpts: SessionCookieOptions,
  store: SessionStore,
  saveUninitialized: boolean,
): Promise<void> {
  if (session.destroyed) {
    // Clear cookie. Max-Age=0 is the cross-browser way to expire immediately.
    appendSetCookie(
      ctx,
      serializeCookie(cookieName, '', { ...cookieOpts, maxAge: 0 }),
    )
    return
  }

  // Persist + cookie when the session was written to (dirty), or when it's new
  // AND the app opted into `saveUninitialized`. Persisting EMPTY new sessions by
  // default is a memory-DoS vector: an unauthenticated cookieless request flood
  // would create one full-TTL store entry per request. Defaulting off means anon
  // sessions are persisted lazily on first write; set `saveUninitialized: true`
  // to restore stable-anon-id behavior (CSRF tokens, A/B buckets).
  const shouldPersist = session.dirty || (session.isNew && saveUninitialized)

  if (shouldPersist) {
    await store.set(session.id, session.snapshot(), maxAgeSeconds)
    const signed = `${session.id}.${signId(session.id, signingSecret)}`
    appendSetCookie(
      ctx,
      serializeCookie(cookieName, signed, { ...cookieOpts, maxAge: maxAgeSeconds }),
    )
    return
  }

  // Re-sign without re-persisting (e.g. secret rotation on a clean read).
  if (session.needsResign && !session.isNew) {
    const signed = `${session.id}.${signId(session.id, signingSecret)}`
    appendSetCookie(
      ctx,
      serializeCookie(cookieName, signed, { ...cookieOpts, maxAge: maxAgeSeconds }),
    )
    if (rolling && store.touch) await store.touch(session.id, maxAgeSeconds)
    return
  }

  // Rolling: refresh TTL + cookie even when nothing changed.
  if (rolling && !session.isNew) {
    if (store.touch) await store.touch(session.id, maxAgeSeconds)
    const signed = `${session.id}.${signId(session.id, signingSecret)}`
    appendSetCookie(
      ctx,
      serializeCookie(cookieName, signed, { ...cookieOpts, maxAge: maxAgeSeconds }),
    )
  }
}
