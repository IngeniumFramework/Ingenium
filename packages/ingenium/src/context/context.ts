import type { IncomingHttpHeaders } from 'node:http'
import type { Readable } from 'node:stream'
import { Buffer } from 'node:buffer'
import { IngeniumBody, type ParseSchema, type SafeParseSchema } from './body.ts'
import { makeIngeniumCookies, type IngeniumCookies } from './cookies.ts'
import { isStandardSchema, type StandardIssue, type StandardSchemaV1 } from '../schema/standard.ts'
import type { HttpMethod } from '../router/types.ts'
import { resolveForwarded, type ForwardedInfo, type TrustProxy } from '../proxy/trust.ts'
import {
  accepts as acceptsFn,
  acceptsCharsets as acceptsCharsetsFn,
  acceptsLanguages as acceptsLanguagesFn,
  acceptsEncodings as acceptsEncodingsFn,
} from '../negotiation/negotiate.ts'
import { formatResponse, type FormatHandlers } from '../negotiation/format.ts'
import { isFresh } from '../negotiation/fresh.ts'
import { respondJsonWithEtag, type JsonEtagOptions } from '../negotiation/json-etag.ts'
import {
  IngeniumBadRequestError,
  IngeniumHaltError,
  IngeniumHeaderInjectionError,
  IngeniumUnserializableError,
  IngeniumValidationError,
} from '../errors.ts'

/**
 * Dev-mode gate. Captured ONCE at module load; in production V8 dead-code-
 * eliminates the branch bodies behind `if (IS_DEV)`. Every dev diagnostic
 * MUST check this first so it pays nothing on the hot path.
 */
const IS_DEV = process.env.NODE_ENV !== 'production'

/**
 * @internal Test-only flag for the trust-proxy / XFF mismatch warning. Once
 * per process — read-once UX. Exposed via `_resetFootgunWarnings()` for tests.
 */
let _trustProxyWarned = false

/**
 * @internal Test-only reset hook. Clears all module-scoped once-flags used by
 * the dev footgun warnings. Not part of the public API.
 */
export function _resetFootgunWarnings(): void {
  _trustProxyWarned = false
}

/** CR/LF detector for header-injection guard. Tested against names + values. */
const CRLF_RE = /[\r\n]/

/**
 * Reject header NAMES containing CR or LF. Empty/undefined names are
 * allowed through — the underlying header bag's own type system rejects
 * those naturally.
 */
function assertHeaderNameSafe(name: string): void {
  if (CRLF_RE.test(name)) {
    throw new IngeniumHeaderInjectionError(
      `Header name contains CR/LF (possible header injection): ${JSON.stringify(name)}`,
    )
  }
}

/**
 * Reject header VALUES containing CR or LF. Accepts a single string or an
 * array — the array form checks each element. `undefined` is allowed (some
 * call sites pass through optionals); empty string is allowed (legitimate).
 */
function assertHeaderValueSafe(name: string, value: string | string[]): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const v = value[i]
      if (typeof v === 'string' && CRLF_RE.test(v)) {
        throw new IngeniumHeaderInjectionError(
          `Header value contains CR/LF (possible header injection): ${name}[${i}]`,
        )
      }
    }
    return
  }
  if (typeof value === 'string' && CRLF_RE.test(value)) {
    throw new IngeniumHeaderInjectionError(
      `Header value contains CR/LF (possible header injection): ${name}`,
    )
  }
}

/**
 * Strict `JSON.stringify` wrapper used by the response helpers. Surfaces
 * `BigInt` / circular / other serialization failures as a
 * `IngeniumUnserializableError` so the framework error boundary can render
 * a clean 500 instead of a deep `TypeError` from V8.
 */
function strictStringify(body: unknown): string {
  try {
    return JSON.stringify(body) as string
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    let reason: string
    if (/circular/i.test(msg)) {
      reason = `circular structure (${msg})`
    } else if (/BigInt/i.test(msg)) {
      reason = `BigInt value (${msg})`
    } else {
      reason = msg
    }
    try {
      process.emitWarning(
        `IngeniumUnserializableError: ${reason}`,
        { type: 'IngeniumUnserializableError' },
      )
    } catch {
      // process.emitWarning can throw in unusual runtimes (workers); swallow.
    }
    throw new IngeniumUnserializableError(
      `Response body cannot be serialized: ${reason}`,
      err,
    )
  }
}

/** Sentinel for routes with no params — frozen, so `ctx.params.foo` is safe. */
const EMPTY_PARAMS = Object.freeze(Object.create(null) as Record<string, string>)

/**
 * `URLSearchParams` augmented with a `parse(schema)` method that runs the
 * query through the same schema-detection pipeline as `ctx.body.json(schema)`.
 *
 * The shape passed to the schema is a **shallow array-aware** object:
 *
 *   `?id=42&tag=a&tag=b&active=true`
 *     → `{ id: '42', tag: ['a','b'], active: 'true' }`
 *
 * Single-occurrence keys → `string`. Repeated keys → `string[]`. Everything is
 * a string on the wire, so the user's schema is responsible for coercing
 * numbers/booleans (Zod: use `z.coerce.number()`; ArkType: use `'string.numeric.parse'`).
 *
 * Rationale for picking THIS coercion over alternatives:
 *   - "raw strings only" loses repeated-key fidelity (qs/Express-style arrays)
 *   - "pre-coerced booleans/numbers" surprises users when "12foo" silently
 *     becomes a string or "true" becomes a boolean against their schema
 *   - Shallow-array matches `Object.fromEntries` semantics PLUS the most
 *     common ergonomic ask (tag=a&tag=b → tag: string[])
 */
export interface IngeniumQuery extends URLSearchParams {
  parse<T = unknown>(
    schema: StandardSchemaV1<unknown, T> | SafeParseSchema<T> | ParseSchema<T>,
  ): T
}

/** Normalize a Standard Schema issue path into a dot-joined field key. */
function queryPathToField(path: StandardIssue['path']): string {
  if (!path || path.length === 0) return '_'
  const parts: string[] = []
  for (const seg of path) {
    if (seg !== null && typeof seg === 'object' && 'key' in seg) {
      parts.push(String(seg.key))
    } else {
      parts.push(String(seg))
    }
  }
  return parts.join('.') || '_'
}

/**
 * Hard cap on the number of query parameters materialized by `parse()`. An
 * attacker can send `?a=1&a=2&...` thousands of times to force unbounded
 * allocation (and, with array-promotion, unbounded array growth) in a single
 * request. Browsers and proxies never legitimately emit anywhere near this many
 * params, so the cap is a DoS guard, not a usability constraint.
 *
 * This is checked ONLY inside `toShallowArrayObject`, which runs lazily on
 * `ctx.query.parse(...)` — plain `ctx.query.get(...)` reads never touch it, so
 * the dispatch hot path pays nothing.
 */
const MAX_QUERY_PARAMS = 1000

/**
 * Build the `{ key: string | string[] }` input that gets fed to the schema.
 * Walks the URLSearchParams once; collisions promote a scalar to an array.
 *
 * Allocated lazily on `parse()` only — never paid by handlers that just read
 * `ctx.query.get(...)`. Iteration of URLSearchParams is iteration-order stable
 * and yields decoded values, so no manual percent-decoding here.
 *
 * Throws {@link IngeniumBadRequestError} once more than {@link MAX_QUERY_PARAMS}
 * params have been iterated — the count is incremented inside the existing walk,
 * so the bound adds no extra pass.
 */
function toShallowArrayObject(usp: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = Object.create(null)
  let count = 0
  for (const [k, v] of usp) {
    if (++count > MAX_QUERY_PARAMS) {
      throw new IngeniumBadRequestError(
        `Too many query parameters (limit ${MAX_QUERY_PARAMS})`,
      )
    }
    const existing = out[k]
    if (existing === undefined) {
      out[k] = v
    } else if (Array.isArray(existing)) {
      existing.push(v)
    } else {
      out[k] = [existing, v]
    }
  }
  return out
}

function makeIngeniumQuery(raw: string): IngeniumQuery {
  const usp = new URLSearchParams(raw) as IngeniumQuery
  Object.defineProperty(usp, 'parse', {
    configurable: true,
    enumerable: false,
    writable: false,
    value: function parse<T>(
      this: URLSearchParams,
      schema: StandardSchemaV1<unknown, T> | SafeParseSchema<T> | ParseSchema<T>,
    ): T {
      const input = toShallowArrayObject(this)
      // 1. Standard Schema v1 takes precedence.
      if (isStandardSchema(schema)) {
        const maybe = schema['~standard'].validate(input)
        // Query parsing is synchronous — async validators are still accepted
        // but throw a clearer error than awaiting at the wire would.
        if (maybe instanceof Promise) {
          throw new IngeniumValidationError({
            _: 'async Standard Schema validators are not supported on ctx.query.parse (use ctx.body.json for async)',
          })
        }
        if (maybe.issues) {
          const fields: Record<string, string> = {}
          for (const issue of maybe.issues) {
            fields[queryPathToField(issue.path)] = issue.message
          }
          throw new IngeniumValidationError(fields)
        }
        return maybe.value as T
      }
      // 2. Zod-like safeParse.
      if (
        'safeParse' in schema &&
        typeof (schema as SafeParseSchema<T>).safeParse === 'function'
      ) {
        const result = (schema as SafeParseSchema<T>).safeParse(input)
        if (!result.success) {
          const fields: Record<string, string> = {}
          for (const issue of result.error.issues) {
            fields[issue.path.join('.') || '_'] = issue.message
          }
          throw new IngeniumValidationError(fields)
        }
        return result.data
      }
      // 3. Plain parse.
      try {
        return (schema as ParseSchema<T>).parse(input)
      } catch (err) {
        throw new IngeniumValidationError({ _: (err as Error).message ?? 'validation failed' })
      }
    },
  })
  return usp
}

/** Internal response body shape — adapter writes one of these to the wire. */
export type ResponseBody =
  | { kind: 'none' }
  | { kind: 'buffer'; data: Buffer }
  | { kind: 'string'; data: string }
  | { kind: 'stream'; data: Readable }

/**
 * Per-request context. Pool-bound: one instance per pool slot, reused
 * across thousands of requests. All mutable fields are reset between uses.
 *
 * The `Params` generic is a phantom — it narrows `ctx.params` for typed
 * route handlers but is `Record<string, string>` at runtime.
 */
export class IngeniumContext<Params = Record<string, string>> {
  // ───── Request ─────────────────────────────────────────────────────────
  /** HTTP method, uppercase. */
  method: HttpMethod = 'GET'
  /** Full request URL including query string (e.g. `/users/42?expand=posts`). */
  url = '/'
  /** Path portion of the URL (no query string). Set by the adapter. */
  path = '/'
  /** Raw query string (no leading `?`). Use `query` for parsed access. */
  rawQuery = ''
  /** Route params, written at trie-match time. */
  params: Params = EMPTY_PARAMS as unknown as Params
  /** Lowercased request headers (Node convention). */
  headers: IncomingHttpHeaders = {}
  /** Lazy body accessor. */
  readonly body: IngeniumBody = new IngeniumBody()
  /** Free-form per-request state for plugins/middleware (e.g. `ctx.user = ...`). */
  state: Record<string, unknown> = Object.create(null) as Record<string, unknown>

  /**
   * Per-request handle to enqueue background jobs onto a registered queue.
   * Wired by `IngeniumApp` as a lazy decorator (declared with `!` because the
   * runtime value is installed by the decorator registry, not the class
   * initializer). Throws if the named queue isn't registered.
   *
   * @example
   *   await ctx.queue<{ to: string }>('emails').add({ to: 'a@b.com' })
   */
  queue!: <TData = unknown>(name: string) => import('../jobs/types.ts').JobHandle<TData>

  /** Lazy-parsed query. First access caches the URLSearchParams. */
  private _query: IngeniumQuery | null = null
  get query(): IngeniumQuery {
    if (!this._query) this._query = makeIngeniumQuery(this.rawQuery)
    return this._query
  }

  /**
   * @internal Lazy cookie holder. `null` until first read of `ctx.cookies`.
   * Reset to `null` in `reset()` so a context returned to the pool drops the
   * parsed-cookie cache (and any closed-over write state — though writes go
   * straight to `_headers`, which is itself reset by reassignment).
   */
  _cookies: IngeniumCookies | null = null
  /**
   * First-class cookie API. Lazy: the holder is allocated on first access so
   * apps that never touch cookies pay zero per-request overhead. See
   * `cookies.ts` for the read/write contract and signing rules.
   *
   * @example
   *   const sid = ctx.cookies.get('sid', { signed: true })
   *   ctx.cookies.set('theme', 'dark', { httpOnly: true, sameSite: 'lax' })
   *   ctx.cookies.clear('legacy')
   */
  get cookies(): IngeniumCookies {
    if (!this._cookies) this._cookies = makeIngeniumCookies(this)
    return this._cookies
  }

  /**
   * @internal App-wide cookie-signing secrets. Stamped by `IngeniumApp.handle`
   * on dispatch entry when configured (mirrors `_trustProxy`). First secret
   * signs new cookies; all entries verify reads (supports rotation). Empty
   * means signed cookies will throw `IngeniumError(500, 'COOKIE_SECRET_MISSING')`.
   *
   * NOT cleared in `reset()` — this is app-wide config, not per-request state,
   * and the cost of re-stamping every request is wasteful when the value is
   * stable across the app's lifetime. The first call to `handle()` after a
   * compose sets it; subsequent requests reuse the same array reference.
   */
  _cookieSecrets: readonly string[] = []

  // ───── Network info (trust-proxy aware) ────────────────────────────────
  /** Immediate socket peer address — populated by the adapter. */
  remoteAddress = '127.0.0.1'
  /** Underlying transport protocol — populated by the adapter (http for node:http, https for TLS). */
  baseProtocol: 'http' | 'https' = 'http'
  /** @internal `trustProxy` config carried in from the app. */ _trustProxy: TrustProxy = false
  /** @internal Cached forwarded resolution; computed lazily from headers. */
  private _forwarded: ForwardedInfo | null = null

  private resolveForwarded(): ForwardedInfo {
    if (!this._forwarded) {
      this._forwarded = resolveForwarded(
        this._trustProxy,
        this.remoteAddress,
        this.headers as Record<string, string | string[] | undefined>,
        this.baseProtocol,
      )
      // Dev-only — warn once per process when the user reads forwarded info
      // with trustProxy disabled BUT the request carries X-Forwarded-For.
      // Almost always means the user is behind a proxy and forgot to enable
      // trustProxy, so `ctx.ip` is silently returning the proxy's address.
      if (IS_DEV && !_trustProxyWarned && this._trustProxy === false) {
        if (this.headers['x-forwarded-for'] !== undefined) {
          _trustProxyWarned = true
          try {
            process.emitWarning(
              "Read ctx.ip with trustProxy disabled, but request has X-Forwarded-For. Set 'trustProxy' on the app if behind a reverse proxy.",
              { type: 'IngeniumTrustProxyWarning' },
            )
          } catch {
            // process.emitWarning can throw in unusual runtimes (workers); swallow.
          }
        }
      }
    }
    return this._forwarded
  }

  /**
   * Best-effort client IP. With `trustProxy: false` this is the immediate
   * socket peer; with trust-proxy enabled the X-Forwarded-For chain is
   * walked according to the configured trust policy.
   */
  get ip(): string { return this.resolveForwarded().ip }
  /** Full forwarded chain (left-to-right, immediate peer last). */
  get ips(): readonly string[] { return this.resolveForwarded().ips }
  /** Best-effort protocol — honors `X-Forwarded-Proto` when trust-proxy is enabled. */
  get protocol(): 'http' | 'https' { return this.resolveForwarded().protocol }
  /** Convenience: `protocol === 'https'`. */
  get secure(): boolean { return this.protocol === 'https' }
  /** Best-effort hostname (no port) — honors `X-Forwarded-Host` when trust-proxy is enabled. */
  get hostname(): string { return this.resolveForwarded().hostname }

  // ───── Response ────────────────────────────────────────────────────────
  /** @internal */ _statusCode = 200
  /** @internal */ _headers: Record<string, string | string[]> = Object.create(null) as Record<string, string | string[]>
  /** @internal */ _body: ResponseBody = { kind: 'none' }
  /** @internal Whether a response helper has been called. */
  _written = false

  /**
   * @internal Per-request generation counter. Incremented every time the
   * pool resets this context (and also bumped by `IngeniumApp.handle` when a
   * request times out, so writes from the orphaned handler can be detected
   * as stale). Compared against `_dispatchEpoch` by every response writer.
   */
  _epoch = 0

  /**
   * @internal Last `_epoch` value captured by `IngeniumApp.withEpochGuard`.
   * Set on dispatch entry; the per-dispatch wrappers installed around the
   * response writers close over this value to detect late writes from an
   * orphaned (timed-out) handler. The wrappers compare `_epoch` against
   * the captured value at call time — mismatch ⇒ orphan ⇒ swallow.
   *
   * `0` means no guard is active (no `requestTimeoutMs` configured, or
   * the dispatch already resolved naturally).
   */
  _dispatchEpoch = 0

  // ───── Response helpers ────────────────────────────────────────────────

  /**
   * @internal Dev-only — emit `IngeniumDoubleWriteWarning` when a writer is
   * called after `_written` is already true. No-op in production: V8
   * eliminates the branch body behind the `IS_DEV` gate.
   */
  private _warnDoubleWrite(method: string): void {
    if (!IS_DEV) return
    if (!this._written) return
    try {
      process.emitWarning(
        `ctx.${method}() called after response was already written. Second call overrides the first; use 'return' to short-circuit.`,
        { type: 'IngeniumDoubleWriteWarning' },
      )
    } catch {
      // process.emitWarning can throw in unusual runtimes (workers); swallow.
    }
  }

  /** Set the HTTP status code. Returns `this` for chaining. */
  status(code: number): this {
    this._statusCode = code
    return this
  }

  /**
   * Set a response header (case-insensitive). Returns `this` for chaining.
   *
   * Throws `IngeniumHeaderInjectionError` if `name` or `value` contains CR
   * or LF — these would otherwise enable header-injection / response-
   * splitting attacks if a caller forwards untrusted user input directly.
   */
  set(name: string, value: string | string[]): this {
    assertHeaderNameSafe(name)
    assertHeaderValueSafe(name, value)
    this._headers[name.toLowerCase()] = value
    return this
  }
  /** Alias for `set` — matches Express's `res.setHeader`. */
  setHeader(name: string, value: string | string[]): this {
    return this.set(name, value)
  }

  /** Get a previously-set response header (lowercase lookup). */
  getHeader(name: string): string | string[] | undefined {
    return this._headers[name.toLowerCase()]
  }

  /**
   * Send a JSON response.
   *
   * Throws `IngeniumUnserializableError` if `body` cannot be encoded
   * (circular structure, `BigInt`, etc.) — surfaces a clean 500 from the
   * framework error boundary instead of a deep `TypeError`.
   */
  json(body: unknown, status?: number): void {
    this._warnDoubleWrite('json')
    const data = strictStringify(body)
    if (status !== undefined) this._statusCode = status
    if (!this._headers['content-type']) this._headers['content-type'] = 'application/json; charset=utf-8'
    this._body = { kind: 'string', data }
    this._written = true
  }

  /** Send a `text/plain` response. */
  text(body: string, status?: number): void {
    this._warnDoubleWrite('text')
    if (status !== undefined) this._statusCode = status
    if (!this._headers['content-type']) this._headers['content-type'] = 'text/plain; charset=utf-8'
    this._body = { kind: 'string', data: body }
    this._written = true
  }

  /** Send a `text/html` response. */
  html(body: string, status?: number): void {
    this._warnDoubleWrite('html')
    if (status !== undefined) this._statusCode = status
    if (!this._headers['content-type']) this._headers['content-type'] = 'text/html; charset=utf-8'
    this._body = { kind: 'string', data: body }
    this._written = true
  }

  /** Send a redirect (default 302). */
  redirect(location: string, status = 302): void {
    this._warnDoubleWrite('redirect')
    this._statusCode = status
    this._headers.location = location
    this._body = { kind: 'none' }
    this._written = true
  }

  /** Stream a `Readable` to the client. Sets content-type if not already set. */
  stream(readable: Readable, contentType?: string): void {
    this._warnDoubleWrite('stream')
    if (contentType && !this._headers['content-type']) this._headers['content-type'] = contentType
    this._body = { kind: 'stream', data: readable }
    this._written = true
  }

  /**
   * Sinatra-style short-circuit. Throws `IngeniumHaltError(status, body?)`
   * — the framework error boundary catches it and serializes per `bodyShape`:
   *
   * - `ctx.halt(401)` → 401 with default JSON `{ error, code: 'HALT' }`.
   * - `ctx.halt(404, 'Not Found')` → 404 `text/plain` body verbatim.
   * - `ctx.halt(422, { fields })` → 422 `application/json` body verbatim.
   *
   * The TypeScript `never` return type lets `if (!found) ctx.halt(404)`
   * narrow the rest of the function — code after the call is unreachable.
   *
   * To bypass the error boundary entirely (write the response without
   * throwing) call `ctx.json(body, status)` and `return` from the handler.
   *
   * @example
   *   if (!authorized(ctx)) ctx.halt(401, 'Unauthorized')
   *   if (!user)            ctx.halt(404, { error: 'Not Found', id })
   */
  halt(status: number, body?: string | Record<string, unknown>): never {
    throw new IngeniumHaltError(status, body)
  }

  /** Send a `Buffer` body verbatim. */
  send(body: Buffer | string, status?: number): void {
    this._warnDoubleWrite('send')
    if (status !== undefined) this._statusCode = status
    if (typeof body === 'string') {
      if (!this._headers['content-type']) this._headers['content-type'] = 'text/plain; charset=utf-8'
      this._body = { kind: 'string', data: body }
    } else {
      if (!this._headers['content-type']) this._headers['content-type'] = 'application/octet-stream'
      this._body = { kind: 'buffer', data: body }
    }
    this._written = true
  }

  // ───── Content negotiation (request side) ──────────────────────────────

  /**
   * Return the best mime type the client accepts from the offered list, or
   * `false` if none are acceptable. With no arguments, returns the parsed
   * preference-ordered list of accepted types from `Accept`.
   *
   * Each `type` may be a shorthand (`'json'`, `'html'`, `'csv'`, …) or a full
   * mime (`'application/json'`). Quality factors are honored.
   *
   * @example
   *   if (ctx.accepts('json')) ctx.json({ ok: true })
   *   else ctx.status(406).text('Not Acceptable')
   */
  accepts(): string[]
  accepts(...types: string[]): string | false
  accepts(...types: string[]): string | false | string[] {
    return types.length === 0 ? acceptsFn(this) : acceptsFn(this, ...types)
  }

  /** Best matching charset from the offered list against `Accept-Charset`. */
  acceptsCharsets(): string[]
  acceptsCharsets(...charsets: string[]): string | false
  acceptsCharsets(...charsets: string[]): string | false | string[] {
    return charsets.length === 0 ? acceptsCharsetsFn(this) : acceptsCharsetsFn(this, ...charsets)
  }

  /** Best matching language against `Accept-Language` (exact-tag match only). */
  acceptsLanguages(): string[]
  acceptsLanguages(...langs: string[]): string | false
  acceptsLanguages(...langs: string[]): string | false | string[] {
    return langs.length === 0 ? acceptsLanguagesFn(this) : acceptsLanguagesFn(this, ...langs)
  }

  /** Best matching encoding against `Accept-Encoding` (first offered when header absent). */
  acceptsEncodings(): string[]
  acceptsEncodings(...encodings: string[]): string | false
  acceptsEncodings(...encodings: string[]): string | false | string[] {
    return encodings.length === 0 ? acceptsEncodingsFn(this) : acceptsEncodingsFn(this, ...encodings)
  }

  // ───── Content negotiation (response side) ─────────────────────────────

  /**
   * Run the handler whose key best matches the request `Accept` header. The
   * matched key is set as `Content-Type`. If no key matches and no `default`
   * handler is provided, throws `IngeniumError(406, 'NOT_ACCEPTABLE')`.
   */
  format(handlers: FormatHandlers): Promise<void> {
    return formatResponse(this, handlers)
  }

  /**
   * `true` when the client's `If-None-Match` matches the response `ETag`,
   * or `If-Modified-Since` is at-or-after the response `Last-Modified`.
   * Reads from `_headers` so handlers can set ETag / Last-Modified before checking.
   */
  get fresh(): boolean {
    return isFresh(
      this.headers as Record<string, string | string[] | undefined>,
      this._headers as Record<string, string | string[] | undefined>,
    )
  }

  /** `!fresh`. */
  get stale(): boolean {
    return !this.fresh
  }

  /**
   * Send a JSON body with an auto-computed weak ETag. If the request's
   * `If-None-Match` matches the computed tag, short-circuits to 304.
   */
  jsonWithEtag(body: unknown, opts?: JsonEtagOptions): void {
    respondJsonWithEtag(this, body, opts)
  }

  // ───── Pool lifecycle ──────────────────────────────────────────────────

  /**
   * Reset all per-request state. Called by the pool before returning the
   * context to the free list. Reassignments preserve the V8 hidden class
   * so subsequent allocations stay monomorphic.
   */
  reset(): void {
    this.method = 'GET'
    this.url = '/'
    this.path = '/'
    this.rawQuery = ''
    this.params = EMPTY_PARAMS as unknown as Params
    this.headers = {}
    this._query = null
    this._cookies = null
    this.state = Object.create(null) as Record<string, unknown>
    this.remoteAddress = '127.0.0.1'
    this.baseProtocol = 'http'
    this._trustProxy = false
    this._forwarded = null
    this._statusCode = 200
    this._headers = Object.create(null) as Record<string, string | string[]>
    this._body = { kind: 'none' }
    this._written = false
    this._dispatchEpoch = 0
    this._epoch++
    this.body._reset()
  }
}
