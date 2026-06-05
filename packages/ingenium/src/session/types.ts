/**
 * Session middleware types.
 *
 * @see ./middleware.ts for the {@link sessionMiddleware} factory and the
 * module-augmentation pattern users opt into for typed `ctx.session`.
 */

/** Cookie attribute overrides. */
export interface SessionCookieOptions {
  /** Cookie `Domain` attribute. Omitted when undefined. */
  domain?: string
  /** Cookie `Path` attribute. @default '/' */
  path?: string
  /** Cookie `HttpOnly` attribute. @default true */
  httpOnly?: boolean
  /** Cookie `SameSite` attribute. @default 'lax' */
  sameSite?: 'lax' | 'strict' | 'none'
  /**
   * Cookie `Secure` attribute.
   *
   * When left undefined, {@link sessionMiddleware} resolves it safely: ON in
   * production (`NODE_ENV==='production'`) so the cookie cannot ride plaintext
   * HTTP, OFF in dev so `http://localhost` keeps working. Set `false`
   * explicitly to opt out in production (emits a dev warning), or `true` to
   * force it on in every environment.
   *
   * Note: the raw {@link serializeCookie} helper still treats `undefined` as
   * off — only the middleware applies the environment-aware default.
   *
   * @default undefined (production → Secure, dev → not Secure)
   */
  secure?: boolean
}

/** Options accepted by {@link sessionMiddleware}. */
export interface SessionOptions {
  /**
   * HMAC secret(s) for signing the session-id cookie.
   *
   * - Single string: used for both signing and verification.
   * - Array: index `0` is the active signing key; ALL entries are accepted
   *   for verification, enabling key rotation. Cookies signed with an older
   *   key are re-signed with the active key on the next response.
   */
  secret: string | string[]
  /** Name of the session cookie. @default 'ingenium.sid' */
  cookieName?: string
  /** Cookie / store TTL in seconds. @default 604800 (7 days) */
  maxAgeSeconds?: number
  /**
   * If true, the cookie expiry and store TTL are refreshed on every request,
   * even when the session data did not change. @default false
   */
  rolling?: boolean
  /**
   * If true, brand-new sessions are persisted (and a `Set-Cookie` issued) even
   * when the handler never wrote to them. This gives anonymous flows a stable id
   * across requests (CSRF tokens, A/B buckets) but means an unauthenticated,
   * cookieless request flood creates one store entry each — a memory-DoS against
   * the default in-process {@link MemoryStore}. Leave it off (the secure default)
   * and sessions are persisted lazily on first write. Mirrors express-session's
   * `saveUninitialized`. @default false
   */
  saveUninitialized?: boolean
  /** Cookie attribute overrides. */
  cookie?: SessionCookieOptions
  /**
   * Backing store. Defaults to an in-process {@link MemoryStore} which is
   * NOT suitable for clustered deployments — supply your own for Redis,
   * Postgres, etc.
   */
  store?: SessionStore
}

/**
 * Per-request session handle attached as `ctx.session`.
 *
 * Mutations (`set`, `delete`, `destroy`, `regenerate`) mark the session as
 * dirty so the middleware persists changes after the handler returns.
 */
export interface Session {
  /** Stable, opaque session id (rotated by {@link Session.regenerate}). */
  readonly id: string
  /** Frozen view of the session data. */
  readonly data: Readonly<Record<string, unknown>>
  /** Read a value from the session. */
  get<T = unknown>(key: string): T | undefined
  /** Write a value into the session. Marks the session dirty. */
  set(key: string, value: unknown): void
  /** Remove a key from the session. Marks the session dirty. */
  delete(key: string): void
  /** Drop the session: remove from store + clear the cookie. */
  destroy(): Promise<void>
  /**
   * Issue a new session id while preserving the current data. The old id is
   * removed from the store. Use after privilege changes (e.g. login) to
   * mitigate session-fixation attacks.
   */
  regenerate(): Promise<void>
}

/**
 * Pluggable session storage. Implementations must be safe to call
 * concurrently for distinct ids; per-id ordering is the caller's concern.
 */
export interface SessionStore {
  /** Look up a session by id. Returns `null` for unknown / expired ids. */
  get(id: string): Promise<Record<string, unknown> | null>
  /** Persist `data` under `id` with the given TTL (seconds). */
  set(id: string, data: Record<string, unknown>, ttlSeconds: number): Promise<void>
  /** Remove a session entirely. No-op if it does not exist. */
  destroy(id: string): Promise<void>
  /**
   * OPTIONAL: extend an existing session's TTL without rewriting its data.
   * Used by `rolling` sessions on requests that did not mutate state.
   */
  touch?(id: string, ttlSeconds: number): Promise<void>
}
