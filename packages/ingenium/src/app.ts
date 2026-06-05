import { AsyncLocalStorage } from 'node:async_hooks'
import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'
import { IngeniumContext } from './context/context.ts'
import { IngeniumContextPool } from './context/pool.ts'
import {
  IngeniumError,
  IngeniumHaltError,
  IngeniumMethodNotAllowedError,
  IngeniumNotFoundError,
  IngeniumTimeoutError,
} from './errors.ts'
import { composeWithHandler } from './middleware/compose.ts'
import type { IngeniumHandler, IngeniumMiddleware } from './middleware/types.ts'
import { DecoratorRegistry } from './plugin/decorators.ts'
import { HooksRegistry } from './plugin/hooks.ts'
import type {
  EagerDecorator,
  Hooks,
  LazyDecorator,
  IngeniumPlugin,
  PluginTarget,
} from './plugin/types.ts'
import { RouteBuilder, Router, flattenRouter } from './router/router.ts'
import { ScopedApp } from './app/scope.ts'
import { registerAfter, registerBefore } from './sinatra/filters.ts'
import { EMPTY_PARAMS, RouterTrie, type MatchMiss } from './router/trie.ts'
import type { HttpMethod } from './router/types.ts'
import { NodeAdapter } from './transport/node.ts'
import type { ListeningServer, Transport } from './transport/types.ts'
import { descriptorKey, type RouteDescriptor } from './openapi/describe.ts'
import { isStandardSchema } from './schema/standard.ts'
import type { RequestBody, Response, Schema } from './openapi/types.ts'
import { QueueRegistry } from './jobs/registry.ts'
import type { JobHandle, QueueOptions, QueueWorker } from './jobs/types.ts'
import { CronRegistry } from './cron/registry.ts'
import type { CronHandler, CronOptions } from './cron/scheduler.ts'

/** Options accepted by `ingenium(...)` and `new IngeniumApp(...)`. */
export interface IngeniumAppOptions {
  /** Max number of pooled `IngeniumContext` instances kept in the free list. Default 1024. */
  poolSize?: number
  /** Inject a custom transport (e.g. for tests). Default: `NodeAdapter`. */
  transport?: Transport
  /**
   * Trust-proxy configuration — controls whether `X-Forwarded-For`,
   * `X-Forwarded-Proto`, `X-Forwarded-Host` are honored when computing
   * `ctx.ip`, `ctx.protocol`, `ctx.hostname`. Mirrors Express's
   * `app.set('trust proxy', ...)` semantics. Default `false` (never trust).
   * See `proxy/trust.ts` for the full type. Set to `true` only when running
   * behind a reverse proxy you control.
   */
  trustProxy?: import('./proxy/trust.ts').TrustProxy
  /**
   * Maximum wall-clock time (ms) for a single request to complete from
   * dispatch to response. When exceeded, throws `IngeniumTimeoutError(503)`
   * and the response becomes 503 Service Unavailable.
   *
   * The handler that timed out is NOT cancelled — JavaScript can't safely
   * cancel a Promise. The framework just stops waiting for it; the in-flight
   * work continues until it naturally completes or the process exits. This
   * means a slow handler can still leak compute (but not connections or
   * pool slots, since the response is sent and the context is released).
   *
   * Scoped to HTTP request handling only — does NOT apply to upgraded
   * connections (WebSocket, SSE) which are explicitly long-lived.
   *
   * Default: undefined (no timeout). Production deploys SHOULD set this.
   */
  requestTimeoutMs?: number
  /**
   * Hard ceiling (bytes) on the total request body, enforced at the
   * transport layer — applies regardless of which `ctx.body.*` consumer
   * reads the body, including `ctx.body.stream()`. Defaults to **2 MiB**
   * (2_097_152) — high enough for typical JSON / form payloads,
   * low enough that an unauthenticated attacker can't exhaust memory.
   *
   * Per-call limits on `ctx.body.json(schema, maxBytes)` etc. are still
   * honored and apply WITHIN this ceiling. To allow larger uploads on a
   * specific route, raise this AND use `ctx.body.stream()` with your own
   * size accounting.
   *
   * Set to `Infinity` to disable (NOT recommended outside controlled deploys).
   */
  maxRequestBytes?: number

  /**
   * Default queue-drain timeout (ms) used when the listener closes. Per-queue
   * timeouts can also be passed to `app.queues.drainAll(timeoutMs)`. Default
   * `10_000`ms — matches `gracefulShutdown`'s default `gracefulTimeoutMs`.
   */
  queueDrainTimeoutMs?: number

  /**
   * Secret(s) used to HMAC-sign cookies written via
   * `ctx.cookies.set(name, value, { signed: true })`.
   *
   * Accepts a single string or an array — the FIRST entry signs new cookies,
   * ALL entries verify reads (so rotating a secret is: prepend the new key,
   * keep the old key, deploy; remove the old key on the next deploy once all
   * outstanding signed cookies have expired).
   *
   * If omitted, calling `ctx.cookies.set(..., { signed: true })` or
   * `ctx.cookies.get(..., { signed: true })` throws
   * `IngeniumError(500, 'COOKIE_SECRET_MISSING')`. The unsigned cookie API
   * still works without any secrets configured.
   */
  cookieSecrets?: string | string[]
}

/** Default transport-layer body ceiling — see {@link IngeniumAppOptions.maxRequestBytes}. */
const DEFAULT_MAX_REQUEST_BYTES = 2_097_152

/** A user-supplied error handler. Return a non-error or call a `ctx` writer to recover. */
export type IngeniumErrorHandler = (err: unknown, ctx: IngeniumContext) => unknown | Promise<unknown>

/**
 * Options for {@link IngeniumApp.inject} — the in-process test client. Mirrors
 * the shape a real request would carry, minus a socket. `url` is the only
 * required field; everything else defaults to a bare GET.
 */
export interface InjectRequest {
  /** HTTP method. Defaults to `GET`. */
  method?: HttpMethod
  /** Request URL including any query string (e.g. `/users/42?expand=posts`). */
  url: string
  /**
   * Request headers. Names are lowercased before they reach the handler so
   * `ctx.headers['x-custom']` works regardless of the casing passed here
   * (matching node:http's lowercasing of inbound headers).
   */
  headers?: Record<string, string | string[]>
  /**
   * Request body. A `string` / `Buffer` / `Uint8Array` is sent verbatim; a
   * plain object is JSON-serialized and (unless the caller set a
   * `content-type`) tagged `application/json`.
   */
  body?: string | Buffer | Uint8Array | Record<string, unknown> | unknown[]
  /** Socket peer address surfaced as `ctx.remoteAddress`. Defaults to `127.0.0.1`. */
  remoteAddress?: string
}

/**
 * Result of {@link IngeniumApp.inject}. A fully-materialized snapshot of the
 * response — captured BEFORE the pooled context is released, so reading any
 * field is safe even though the underlying context has been recycled.
 */
export interface InjectResponse {
  /** Final HTTP status code. */
  status: number
  /**
   * Response headers, lowercased. A deep-ish copy of the context's header bag
   * (the array values are cloned) so sequential `inject()` calls never share
   * or bleed header state.
   */
  headers: Record<string, string | string[]>
  /**
   * Response body decoded as a UTF-8 string. Stream responses are drained to
   * completion first; a bodyless response (`{ kind: 'none' }`) yields `''`.
   */
  body: string
  /** Parse {@link InjectResponse.body} as JSON. Throws on invalid JSON, like `JSON.parse`. */
  json<T = unknown>(): T
}

/**
 * Per-route options object accepted as the second positional arg to a verb
 * registration (`app.get(path, { auth: ['admin'] }, handler)`). Each key must
 * match a registered declarator (see `app.declare(...)`); the value is passed
 * to the declarator's factory at REGISTRATION time and the resulting
 * middleware is prepended to the route's chain.
 */
export type RouteOptions = Record<string, unknown>

/**
 * Well-known route-options keys handled natively by the framework. Mixed with
 * user-defined declarator keys in the same options object — the framework
 * peels off the well-known ones at REGISTRATION time, hands them straight to
 * `app.describe(method, path, ...)`, and forwards everything else to
 * `translateRouteOptions()` for declarator resolution. Built-in keys never
 * trigger the "unknown declarator" error because they're removed from the
 * forwarded options before declarator lookup runs.
 *
 * Inline schema values for `response` / `requestBody` accept ONLY raw OpenAPI
 * Schema objects today. Passing a Standard Schema or Zod validator throws at
 * registration time — converting validators to JSON Schema is the OpenAPI
 * generator's job and isn't wired through this seam yet. Use
 * `app.describe(method, path, ...)` with a precomputed schema if you need
 * that today.
 */
const BUILTIN_ROUTE_OPTION_KEYS: ReadonlySet<string> = new Set([
  'response',
  'requestBody',
  'tags',
  'summary',
  'description',
  'parameters',
  'deprecated',
  'operationId',
  'security',
])

/**
 * Variadic arg shape accepted by `app.get/post/...` and `app.method(...)` after
 * the leading `(method?, path)`. The tail is always one handler; everything
 * before it is either positional middleware or the (optional) leading options
 * object. We type it as `unknown[]` at the implementation seam because TS
 * tuple-rest narrowing fights with the overload's union return type — the
 * runtime validates structure (handler-is-function tail, plain-object head
 * detection, function middleware) and the public overloads enforce the shape
 * the caller actually sees.
 */
export type VerbArgs = unknown[]

/**
 * The Ingenium application. Combines a `Router` (registration journal),
 * a `RouterTrie` (matched at request time), a context pool, and a
 * transport. Composition is lazy: the trie's composed handlers are built
 * on first request (or when `compose()` is called explicitly), and a dirty
 * bit triggers recomposition if registrations are added later.
 */
export class IngeniumApp implements PluginTarget {
  private readonly pool: IngeniumContextPool
  private readonly transport: Transport
  private readonly router: Router = new Router()
  private trie: RouterTrie = new RouterTrie()
  private dirty = true
  private errorHandler: IngeniumErrorHandler | null = null
  private readonly _hooks: HooksRegistry = new HooksRegistry()
  private readonly _decorators: DecoratorRegistry = new DecoratorRegistry()
  /** @internal Per-route OpenAPI metadata. Keyed by `${method} ${path}`. */
  private readonly _routeDescriptors: Map<string, RouteDescriptor> = new Map()
  /** @internal Bumped on every `describe()` call so the OpenAPI handler's cache invalidates. */
  private _routeDescriptorVersion = 0
  /** @internal Carried onto each `IngeniumContext` so its `ip`/`protocol`/`hostname` getters can resolve. */
  private readonly _trustProxy: import('./proxy/trust.ts').TrustProxy
  /** @internal Wall-clock per-request ceiling. `undefined` disables the race entirely. */
  private readonly _requestTimeoutMs: number | undefined
  /**
   * @internal Hard transport-layer ceiling on request body bytes. Passed to
   * the transport via `TransportHooks.maxRequestBytes`. `Infinity` disables.
   */
  private readonly _maxRequestBytes: number
  /** @internal Background job registry. Workers start at compose() / first request. */
  private readonly _queues: QueueRegistry = new QueueRegistry()
  /** @internal Cron job registry. Timers start at compose() / first request. */
  private readonly _crons: CronRegistry = new CronRegistry()
  /** @internal Default queue-drain timeout used when the listener closes. */
  private readonly _queueDrainTimeoutMs: number
  /**
   * @internal Frozen list of cookie-signing secrets, normalized from the
   * scalar/array input. Empty array when not configured. Stamped onto each
   * dispatched context only when non-empty (per-request field write avoided
   * for the common case of "no cookie secrets configured").
   */
  private readonly _cookieSecrets: readonly string[]
  /** @internal Whether `cookieSecrets` was configured — caches the truthy check. */
  private readonly _hasCookieSecrets: boolean

  /**
   * @internal Per-request dispatch booleans, recomputed at every `compose()`.
   * Cached because their underlying `.hasAny()` / `.hasOnXxx()` calls walk
   * arrays and we don't want to pay that on every request — the registries
   * are frozen between composes.
   *
   * `_handleFast` is the hot-path closure: when ALL of these are off
   * (`!_hasHooks && !_hasDecorators && !_hasTimeout && !_hasTrustProxy`)
   * we route through a stripped dispatch that skips every conditional.
   */
  private _hasHooks = false
  private _hasOnRequest = false
  private _hasOnResponse = false
  private _hasOnError = false
  private _hasDecorators = false
  private readonly _hasTimeout: boolean
  private readonly _hasTrustProxy: boolean
  private _useFastPath = false

  /**
   * @internal Whether `listen()` has bound a server that hasn't been closed
   * yet. Guards against the double-listen footgun: a second `listen()` on the
   * same app would silently bind a second server (two ports dispatching to one
   * pool), almost always a copy-paste mistake. Cleared when the returned
   * handle's `close()` resolves, so re-listening after a clean shutdown works.
   */
  private _listening = false

  constructor(options: IngeniumAppOptions = {}) {
    this.pool = new IngeniumContextPool(options.poolSize ?? 1024)
    this.transport = options.transport ?? new NodeAdapter()
    this._trustProxy = options.trustProxy ?? false
    this._requestTimeoutMs = options.requestTimeoutMs
    this._maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES
    this._queueDrainTimeoutMs = options.queueDrainTimeoutMs ?? 10_000
    // Normalize scalar/array secret input into a frozen list. Frozen because
    // the array reference is shared across every request — accidental mutation
    // anywhere would silently change the verify set for the whole app.
    const rawSecrets = options.cookieSecrets
    this._cookieSecrets = Object.freeze(
      rawSecrets === undefined
        ? []
        : Array.isArray(rawSecrets)
          ? rawSecrets.slice()
          : [rawSecrets],
    )
    this._hasCookieSecrets = this._cookieSecrets.length > 0
    // These two are stable for the lifetime of the app.
    this._hasTimeout = options.requestTimeoutMs !== undefined
    this._hasTrustProxy = (options.trustProxy ?? false) !== false

    // Wire `ctx.queue(name)` as a lazy decorator. Returns a per-call handle
    // that delegates straight to the registry. Lazy = zero overhead for
    // routes that don't enqueue background work.
    this._decorators.decorate('queue', (_ctx) => {
      return <TData = unknown>(name: string): JobHandle<TData> => {
        const q = this._queues.get<TData>(name)
        return { add: (data: TData) => q.add(data) }
      }
    })
  }

  /**
   * @internal Recompute the cached dispatch booleans. Called at the end of
   * `compose()` (and `composeAsync()`) so per-request reads are O(1) field
   * loads instead of `.hasAny()` array scans.
   *
   * The fast path is taken when an app uses zero opt-in features beyond the
   * router itself: no plugins, no decorators, no request timeout, no
   * trust-proxy. That's the typical "Sinatra-shape" / "Express-shape"
   * register-routes-and-go app — the case we want to be the absolute fastest.
   * Note `ctx.queue` registers a decorator at construction, so any app that
   * uses background jobs is OFF the fast path. That's the correct semantics:
   * if you want the queue ergonomic, you accept the per-request decorator
   * apply cost.
   */
  private _recomputeDispatchFlags(): void {
    this._hasHooks = this._hooks.hasAny()
    this._hasOnRequest = this._hasHooks && this._hooks.hasOnRequest()
    this._hasOnResponse = this._hasHooks && this._hooks.hasOnResponse()
    this._hasOnError = this._hasHooks && this._hooks.hasOnError()
    this._hasDecorators = this._decorators.hasAny()
    this._useFastPath =
      !this._hasHooks &&
      !this._hasDecorators &&
      !this._hasTimeout &&
      !this._hasTrustProxy
  }

  // ───── Plugin system ────────────────────────────────────────────────────

  /** Lifecycle hooks API — plugins call `app.hooks.onRequest(...)` etc. */
  get hooks(): Hooks { return this._hooks }

  /**
   * Register a plugin. Plugins are invoked immediately and may be async;
   * callers should `await app.register(...)` if the plugin returns a Promise.
   * Plugins must be registered BEFORE `compose()` runs (i.e. before the
   * first request); registering a plugin sets the dirty bit so the next
   * request will recompose.
   */
  register<O>(plugin: IngeniumPlugin<O>, opts: O): Promise<this>
  register(plugin: IngeniumPlugin<void>): Promise<this>
  async register<O>(plugin: IngeniumPlugin<O>, opts?: O): Promise<this> {
    await plugin(this, opts as O)
    this.dirty = true
    return this
  }

  /**
   * Open a registration scope rooted at `prefix`. Routes, middleware, and
   * sub-plugins registered through the `scope` parameter inside `registrar`
   * are automatically prefix-qualified, so a plugin's `use(mw)` only applies
   * to requests under `prefix` — not the whole app.
   *
   * This is the killer feature for sub-app affinity: today, plugins registered
   * via `app.register(...)` decorate the WHOLE app (their `app.use(mw)` calls
   * become global). Wrapping a `register(...)` call inside `app.scope(...)`
   * confines the plugin's middleware to the scope's subtree, without forcing
   * the user to manually prefix every route.
   *
   * The actual prefix-matching happens at compose time: scope translates
   * `s.use(mw)` into `app.use(prefix, mw)` on the underlying router, which
   * the existing `flattenRouter` / `RouterTrie` machinery already handles.
   * Per-request dispatch sees no new work.
   *
   * @example
   * app.scope('/api/v2', (s) => {
   *   s.use(authPlugin)          // only runs for /api/v2/*
   *   s.get('/users', listUsers) // registers at /api/v2/users
   * })
   *
   * Nested scopes compose:
   *
   * @example
   * app.scope('/api', (s) => {
   *   s.scope('/v2', (s2) => {
   *     s2.get('/users', listUsers) // /api/v2/users
   *   })
   * })
   *
   * # Caveat — decorators (V1)
   *
   * `scope.decorate(...)` decorates EVERY request, not just requests under
   * `prefix`. Decorators install onto the pooled context at request start,
   * before the route is matched. The first call from inside any scope emits
   * a `process.emitWarning` in non-production environments to surface this.
   * See `ScopedApp` for details.
   *
   * @returns `this` for chaining. If `registrar` is async, the returned
   * promise is NOT awaited — callers who need async plugin registration
   * inside a scope should await the `registrar` themselves (or use
   * `scope.register(asyncPlugin)`, which returns a Promise).
   */
  scope(
    prefix: string,
    registrar: (scope: PluginTarget) => void,
  ): this {
    const scoped = new ScopedApp(this, prefix)
    // Return is typed `void` so concise chainable arrows (`s => s.get(...)`)
    // and async registrars both satisfy the signature; we still thenable-check
    // the actual value to re-mark dirty if it resolves later.
    const ret: unknown = registrar(scoped as unknown as PluginTarget)
    // If the registrar is async, it's the caller's responsibility to await it
    // (e.g. by awaiting `scope.register(asyncPlugin)` inside the body). We
    // still mark dirty eagerly so synchronous registrations recompose next.
    // Async paths additionally re-mark dirty when they resolve, just in case.
    if (ret && typeof (ret as Promise<void>).then === 'function') {
      ;(ret as Promise<void>).then(() => {
        this.dirty = true
      })
    }
    this.dirty = true
    return this
  }

  /**
   * @internal Mark the compose-cache dirty. Used by `ScopedApp` to invalidate
   * after registering routes/middleware/plugins inside a scope. External
   * callers should not depend on this — it's a friend-access seam for the
   * scope facade.
   */
  _markDirty(): void {
    this.dirty = true
  }

  /**
   * Add a lazy decorator. The factory is invoked the first time `ctx[name]`
   * is read; the result is cached on the context for the rest of the request.
   *
   * @example
   * app.decorate('user', async (ctx) => loadUser(ctx.headers.authorization))
   */
  decorate<T>(name: string, factory: LazyDecorator<T>): this {
    this._decorators.decorate(name, factory)
    return this
  }

  /**
   * Add an eager decorator. The factory runs at the start of every request,
   * and the value is assigned directly to the context.
   *
   * @example
   * app.decorateRequest('startedAt', () => Date.now())
   */
  decorateRequest<T>(name: string, factory: EagerDecorator<T>): this {
    this._decorators.decorateRequest(name, factory)
    return this
  }

  // ───── Registration (delegates to the inner Router) ─────────────────────

  use(mw: IngeniumMiddleware): this
  use(prefix: string, mw: IngeniumMiddleware | Router): this
  use(arg1: string | IngeniumMiddleware, arg2?: IngeniumMiddleware | Router): this {
    if (typeof arg1 === 'string') {
      // Overload preserved by passing both args verbatim.
      this.router.use(arg1, arg2 as IngeniumMiddleware | Router)
    } else {
      this.router.use(arg1)
    }
    this.dirty = true
    return this
  }

  // ───── Verb registration ──────────────────────────────────────────────
  // Three accepted shapes per verb:
  //   1. (path, handler)                              — back-compat single arg
  //   2. (path, ...inlineMiddleware, handler)         — Express positional mw
  //   3. (path, optionsObject, ...inlineMw, handler)  — declarative middleware
  //                                                     (see app.declare())
  // Detection of shape (3) is by `isPlainOptionsObject(args[0])` — see the
  // helper for the exact prototype-check rule. Translation from declarative
  // options → middleware happens at REGISTRATION time, not request time, so
  // the per-request hot path has zero declarative-middleware overhead.

  get(path: string, handler: IngeniumHandler): this
  get(
    path: string,
    optsOrFirst: RouteOptions | IngeniumMiddleware,
    ...rest: [...IngeniumMiddleware[], IngeniumHandler]
  ): this
  get(path: string, ...args: VerbArgs): this {
    return (this.method as (m: HttpMethod, p: string, ...a: VerbArgs) => this)('GET', path, ...args)
  }

  post(path: string, handler: IngeniumHandler): this
  post(
    path: string,
    optsOrFirst: RouteOptions | IngeniumMiddleware,
    ...rest: [...IngeniumMiddleware[], IngeniumHandler]
  ): this
  post(path: string, ...args: VerbArgs): this {
    return (this.method as (m: HttpMethod, p: string, ...a: VerbArgs) => this)('POST', path, ...args)
  }

  put(path: string, handler: IngeniumHandler): this
  put(
    path: string,
    optsOrFirst: RouteOptions | IngeniumMiddleware,
    ...rest: [...IngeniumMiddleware[], IngeniumHandler]
  ): this
  put(path: string, ...args: VerbArgs): this {
    return (this.method as (m: HttpMethod, p: string, ...a: VerbArgs) => this)('PUT', path, ...args)
  }

  patch(path: string, handler: IngeniumHandler): this
  patch(
    path: string,
    optsOrFirst: RouteOptions | IngeniumMiddleware,
    ...rest: [...IngeniumMiddleware[], IngeniumHandler]
  ): this
  patch(path: string, ...args: VerbArgs): this {
    return (this.method as (m: HttpMethod, p: string, ...a: VerbArgs) => this)('PATCH', path, ...args)
  }

  delete(path: string, handler: IngeniumHandler): this
  delete(
    path: string,
    optsOrFirst: RouteOptions | IngeniumMiddleware,
    ...rest: [...IngeniumMiddleware[], IngeniumHandler]
  ): this
  delete(path: string, ...args: VerbArgs): this {
    return (this.method as (m: HttpMethod, p: string, ...a: VerbArgs) => this)('DELETE', path, ...args)
  }

  head(path: string, handler: IngeniumHandler): this
  head(
    path: string,
    optsOrFirst: RouteOptions | IngeniumMiddleware,
    ...rest: [...IngeniumMiddleware[], IngeniumHandler]
  ): this
  head(path: string, ...args: VerbArgs): this {
    return (this.method as (m: HttpMethod, p: string, ...a: VerbArgs) => this)('HEAD', path, ...args)
  }

  options(path: string, handler: IngeniumHandler): this
  options(
    path: string,
    optsOrFirst: RouteOptions | IngeniumMiddleware,
    ...rest: [...IngeniumMiddleware[], IngeniumHandler]
  ): this
  options(path: string, ...args: VerbArgs): this {
    return (this.method as (m: HttpMethod, p: string, ...a: VerbArgs) => this)('OPTIONS', path, ...args)
  }

  /**
   * Chainable per-path registration. Returns a `RouteBuilder` that stacks
   * verb registrations on the same path without retyping it:
   *
   * @example
   *   app
   *     .route('/users/:id')
   *     .get((ctx) => loadUser(ctx.params.id))
   *     .put(requireAdmin, (ctx) => updateUser(ctx))
   *     .delete(requireAdmin, (ctx) => deleteUser(ctx))
   *
   * Pure registration sugar — every call delegates to `app.method(...)`, so
   * declarative options, inline middleware, and typed params via
   * `ExtractParams<P>` work exactly as they do on the bare verb form.
   */
  route<P extends string>(path: P): RouteBuilder<P> {
    return new RouteBuilder<P>((method, args) =>
      (this.method as (m: HttpMethod, p: string, ...a: VerbArgs) => this)(method, path, ...(args as VerbArgs)),
    )
  }

  /**
   * Register a route under any HTTP method. Accepts the variadic shape with
   * an optional declarative-options object as the first arg (after `path`).
   */
  method(method: HttpMethod, path: string, handler: IngeniumHandler): this
  method(
    method: HttpMethod,
    path: string,
    optsOrFirst: RouteOptions | IngeniumMiddleware,
    ...rest: [...IngeniumMiddleware[], IngeniumHandler]
  ): this
  method(method: HttpMethod, path: string, ...args: VerbArgs): this {
    if (args.length === 0) {
      throw new TypeError(`IngeniumApp.${method.toLowerCase()}('${path}'): handler is required`)
    }
    // Translate the optional declarative-options object (when present in
    // position 0) into prepended middleware. The remaining args are passed
    // through to the inner Router as plain positional middleware + handler.
    let translatedHead: IngeniumMiddleware[] = []
    let tail: unknown[] = args
    if (isPlainOptionsObject(args[0])) {
      const opts = args[0] as RouteOptions
      // Peel off well-known OpenAPI keys → describe() at registration time.
      // Forward everything else through the declarator pipeline. Splitting
      // the bag in two means a single options object can legally mix
      // built-in keys (`tags`, `summary`, ...) with user declarator keys
      // (`auth`, `rateLimit`, ...) without the latter tripping over the
      // former or vice versa.
      const builtins: Record<string, unknown> = {}
      const userOpts: RouteOptions = {}
      let hasBuiltins = false
      let hasUser = false
      for (const key of Object.keys(opts)) {
        if (BUILTIN_ROUTE_OPTION_KEYS.has(key)) {
          builtins[key] = opts[key]
          hasBuiltins = true
        } else {
          userOpts[key] = opts[key]
          hasUser = true
        }
      }
      if (hasBuiltins) {
        const descriptor = buildDescriptorFromBuiltins(method, path, builtins)
        this.describe(method, path, descriptor)
      }
      if (hasUser) {
        translatedHead = this.translateRouteOptions(method, path, userOpts)
      }
      tail = args.slice(1)
    }
    if (tail.length === 0) {
      throw new TypeError(`IngeniumApp.${method.toLowerCase()}('${path}'): handler is required`)
    }
    // Pass through to Router. The Router validates handler-is-function and
    // each inline middleware-is-function — we don't duplicate those checks.
    this.router.method(
      method,
      path,
      ...(translatedHead.concat(tail as IngeniumMiddleware[]) as [...IngeniumMiddleware[], IngeniumHandler]),
    )
    this.dirty = true
    return this
  }

  // ───── Declarative middleware (per-route via options object) ───────────

  /**
   * @internal Registry of declarators. Looked up at REGISTRATION time, not
   * request time — so unknown-declarator errors fire eagerly and the per-
   * request hot path stays clean.
   */
  private readonly _declarators: Map<string, (opts: unknown) => IngeniumMiddleware> = new Map()

  /**
   * Register a declarator: a name → middleware-factory mapping. When a route
   * registration includes an options object with that name as a key, the value
   * is passed to the factory and the resulting middleware is composed into
   * the route's chain (in the same position as positional inline middleware,
   * but BEFORE any positional middleware on the same call).
   *
   * Declarators are global to the app and survive across all subsequent route
   * registrations until overridden by a second `declare(name, ...)` call.
   * Lookup is REGISTRATION-time: a route registered before the matching
   * `declare(...)` call throws at registration with a clear hint, not at
   * request time. This trades flexibility for debuggability — the error is
   * caught at boot, not under load.
   *
   * @example
   *   app.declare('auth', (roles: string[]) => requireRoles(roles))
   *   app.declare('rateLimit', (spec: string) => parseRateLimitSpec(spec))
   *   app.get('/admin', { auth: ['admin'], rateLimit: '10/min' }, handler)
   */
  declare<O>(name: string, factory: (opts: O) => IngeniumMiddleware): this {
    this._declarators.set(name, factory as (opts: unknown) => IngeniumMiddleware)
    return this
  }

  /**
   * @internal Resolve a route's options object into a list of middleware by
   * looking up each key in the declarator registry. Iterates keys in object
   * insertion order (ES2015+ guarantee for string keys). Throws at REG TIME
   * with a contextual message when a key has no registered declarator.
   */
  private translateRouteOptions(
    method: HttpMethod,
    path: string,
    opts: RouteOptions,
  ): IngeniumMiddleware[] {
    const out: IngeniumMiddleware[] = []
    for (const key of Object.keys(opts)) {
      const factory = this._declarators.get(key)
      if (!factory) {
        throw new Error(
          `app.${method.toLowerCase()}('${path}', { ${key}: ... }, ...): unknown declarator '${key}'. ` +
            `Did you forget to call app.declare('${key}', ...)?`,
        )
      }
      out.push(factory(opts[key]))
    }
    return out
  }

  /** Register a global error handler. Re-throw to delegate to the default boundary. */
  onError(handler: IngeniumErrorHandler): this {
    this.errorHandler = handler
    return this
  }

  // ───── Sinatra-style filters ───────────────────────────────────────────────

  /**
   * Register a `before` filter — runs BEFORE the route handler resolves.
   * The user writes only the body; `await next()` is called automatically
   * after it returns. If the body writes a response (e.g. `ctx.json(...)`)
   * the chain short-circuits and the route handler does not run.
   *
   * - `before(handler)` — runs for every request (global).
   * - `before(pattern, handler)` — boundary-respecting prefix match
   *   (`/admin/*` and `/admin` both match `/admin` and `/admin/x`, neither
   *   matches `/administrator`). See `sinatra/filters.ts` for details.
   */
  before(handler: IngeniumMiddleware): this
  before(pattern: string, handler: IngeniumMiddleware): this
  before(arg1: string | IngeniumMiddleware, arg2?: IngeniumMiddleware): this {
    if (typeof arg1 === 'string') registerBefore(this, arg1, arg2 as IngeniumMiddleware)
    else registerBefore(this, arg1)
    return this
  }

  /**
   * Register an `after` filter — runs AFTER the route handler resolves but
   * BEFORE the adapter writes the response to the wire. The filter sees the
   * final ctx state (status, headers, body buffer) and may inspect or
   * augment it. Errors thrown by the filter propagate to the error boundary.
   *
   * - `after(handler)` — runs for every request (global).
   * - `after(pattern, handler)` — same prefix semantics as `before`.
   */
  after(handler: IngeniumMiddleware): this
  after(pattern: string, handler: IngeniumMiddleware): this
  after(arg1: string | IngeniumMiddleware, arg2?: IngeniumMiddleware): this {
    if (typeof arg1 === 'string') registerAfter(this, arg1, arg2 as IngeniumMiddleware)
    else registerAfter(this, arg1)
    return this
  }

  /**
   * Attach OpenAPI metadata to a route. The route must be registered separately
   * via `app.get/post/...`. Multiple calls MERGE shallowly onto the existing
   * descriptor for the same `(method, path)` pair — later keys overwrite
   * earlier ones, but keys absent from `meta` are preserved. This is what lets
   * the inline-options form (`app.get(p, { tags: [...] }, h)`) coexist with a
   * later explicit `app.describe(method, p, { summary })` without one wiping
   * the other. Reads via `generateOpenApi(app)`.
   */
  describe(method: HttpMethod, path: string, meta: RouteDescriptor): this {
    const key = descriptorKey(method, path)
    const existing = this._routeDescriptors.get(key)
    const merged: RouteDescriptor = existing ? { ...existing, ...meta } : meta
    this._routeDescriptors.set(key, merged)
    this._routeDescriptorVersion++
    return this
  }

  /** @internal Read-only view of route descriptors — used by the OpenAPI generator. */
  get routeDescriptors(): ReadonlyMap<string, RouteDescriptor> {
    return this._routeDescriptors
  }

  /** @internal Bumps on every `describe()` call so the OpenAPI handler can cache-bust. */
  get routeDescriptorVersion(): number {
    return this._routeDescriptorVersion
  }

  /** @internal Read-only view of the registration journal — used by the OpenAPI generator. */
  get routerJournal(): Router {
    return this.router
  }

  // ───── Background jobs + cron ───────────────────────────────────────────

  /**
   * Register a background queue with a worker. The worker pool starts when
   * the app is composed (first request, `app.compose()`, or `app.listen()`).
   *
   * @example
   * app.queue<{ to: string; body: string }>('emails',
   *   { concurrency: 4, retries: 5 },
   *   async (job) => sendEmail(job.data),
   * )
   *
   * // From a route handler:
   * app.post('/signup', async (ctx) => {
   *   const u = await createUser(await ctx.body.json())
   *   await ctx.queue('emails').add({ to: u.email, body: 'Welcome!' })
   *   return { ok: true }
   * })
   */
  queue<TData>(name: string, opts: QueueOptions<TData>, worker: QueueWorker<TData>): this
  queue<TData>(name: string, worker: QueueWorker<TData>): this
  queue<TData>(
    name: string,
    optsOrWorker: QueueOptions<TData> | QueueWorker<TData>,
    maybeWorker?: QueueWorker<TData>,
  ): this {
    const opts: QueueOptions<TData> = typeof optsOrWorker === 'function' ? {} : optsOrWorker
    const worker: QueueWorker<TData> =
      typeof optsOrWorker === 'function' ? optsOrWorker : (maybeWorker as QueueWorker<TData>)
    if (typeof worker !== 'function') {
      throw new TypeError(`ingenium: app.queue("${name}", ...) requires a worker function`)
    }
    this._queues.register<TData>(name, opts, worker)
    this.dirty = true
    return this
  }

  /**
   * Register a cron job. Spec is a 5-field crontab string. See
   * `src/cron/parser.ts` for the supported grammar.
   *
   * @example
   * app.cron('0 *\/15 * * *', () => refreshCaches())   // every 15 min
   * app.cron('0 0 * * 0', { timezone: 'America/Los_Angeles' }, weeklyReport)
   */
  cron(spec: string, handler: CronHandler): this
  cron(spec: string, opts: CronOptions, handler: CronHandler): this
  cron(
    spec: string,
    optsOrHandler: CronOptions | CronHandler,
    maybeHandler?: CronHandler,
  ): this {
    const opts: CronOptions = typeof optsOrHandler === 'function' ? {} : optsOrHandler
    const handler: CronHandler =
      typeof optsOrHandler === 'function' ? optsOrHandler : (maybeHandler as CronHandler)
    if (typeof handler !== 'function') {
      throw new TypeError('ingenium: app.cron(spec, ..., handler) requires a handler function')
    }
    this._crons.register(spec, opts, handler)
    this.dirty = true
    return this
  }

  /** @internal Read-only access to the queue registry for ops/test introspection. */
  get queues(): QueueRegistry { return this._queues }
  /** @internal Read-only access to the cron registry for ops/test introspection. */
  get crons(): CronRegistry { return this._crons }

  // ───── Composition ───────────────────────────────────────────────────────

  /**
   * Walk the registration journal and rebuild the trie with composed
   * handlers at every leaf. Auto-runs on first request; safe to call
   * explicitly to pre-warm.
   */
  /** Cached flat registrations — used to build the on-miss fallback chain. */
  private _flat: ReturnType<typeof flattenRouter> | null = null

  compose(): void {
    // Note: this entry is synchronous. Async `onCompose` hooks are awaited
    // by `composeAsync()` (the path used by `handle()` and `listen()`).
    // Calling `compose()` directly skips `onCompose` — pre-warm only.
    const flat = flattenRouter(this.router)
    const trie = new RouterTrie()
    const hasOnRoute = this._hooks.hasOnRoute()

    for (const route of flat.routes) {
      const node = trie.insert(route.path)

      // Determine which middleware applies to this route's path.
      const applicable: IngeniumMiddleware[] = [...flat.globalMiddleware]
      for (const scoped of flat.scopedMiddleware) {
        if (pathStartsWith(route.path, scoped.prefix)) {
          applicable.push(scoped.mw)
        }
      }

      // Splice inline middleware (positional + declarative-translated) AFTER
      // global + scoped middleware AND BEFORE the terminal handler. This
      // matches Express's positional-mw semantics and is the foundation
      // `app.declare()` builds on.
      if (route.inlineMiddleware && route.inlineMiddleware.length > 0) {
        for (const mw of route.inlineMiddleware) applicable.push(mw)
      }

      const composed = composeWithHandler(applicable, route.handler)
      node.handlers[route.method] = composed

      if (hasOnRoute) {
        this._hooks.runOnRoute({ method: route.method, path: route.path })
      }
    }

    this.trie = trie
    this._flat = flat
    this.dirty = false

    // Start cron timers + queue worker pools at compose time so they don't
    // process work before the app is wired up. Both `startAll` calls are
    // idempotent — safe to run on every recompose triggered by the dirty bit.
    this._crons.startAll()
    this._queues.startAll()

    // Cache dispatch booleans so handle() can branch on field reads instead
    // of `.hasAny()` calls. Re-runs on every recompose because plugins can
    // be `register()`'d after listen().
    this._recomputeDispatchFlags()
  }

  /**
   * Async composition entry — runs `onCompose` hooks first, then composes.
   * Used by `handle()` and `listen()` when there are async pre-compose
   * listeners. Sync-only composition still works via `compose()` above.
   */
  private async composeAsync(): Promise<void> {
    if (this._hooks.hasOnCompose()) {
      await this._hooks.runOnCompose()
    }
    this.compose()
  }

  // ───── Dispatch entry point (used by transports and tests) ───────────────

  /**
   * Dispatch a single context through the framework. Handles route lookup,
   * 404/405 generation, and the error boundary. The transport is responsible
   * for populating the request side of the context and writing the response
   * side after this resolves.
   */
  async handle(ctx: IngeniumContext): Promise<void> {
    if (this.dirty) await this.composeAsync()

    // Back-reference so app-aware handlers (e.g. openapiHandler) can reach
    // the app from inside a route handler. ctx.state is reset per request
    // by the pool, so this doesn't leak between requests.
    ctx.state._ingeniumApp = this

    // Stamp cookie secrets ONLY when configured. Same pattern as `_trustProxy`:
    // apps that don't use signed cookies pay zero (the field load on the ctx
    // returns the default empty-array initialised at class-field stamp time).
    // We don't reset this between requests because it's app-wide config — the
    // reassignment is idempotent against the same frozen array reference.
    if (this._hasCookieSecrets) ctx._cookieSecrets = this._cookieSecrets

    // ───── Fast path ─────────────────────────────────────────────────────
    // Apps with no plugins, no decorators, no timeout, and no trust-proxy
    // skip the entire branch ladder below. This is the typical Sinatra-shape
    // app — register routes, listen, done. Bench impact: meaningfully better
    // hello-rps because we don't pay for features the app doesn't use.
    if (this._useFastPath) {
      try {
        const match = this.trie.find(ctx.method, ctx.path)
        if ('handler' in match) {
          if (match.params !== EMPTY_PARAMS) ctx.params = match.params as never
          await match.handler(ctx)
          return
        }
        await this.runFallback(ctx, missToError(match))
      } catch (err) {
        await this.handleError(err, ctx)
      }
      return
    }

    // ───── Full path (plugins / decorators / timeout / trust-proxy on) ──
    // Stamp trust-proxy config so ctx.ip/protocol/hostname resolve correctly.
    if (this._hasTrustProxy) ctx._trustProxy = this._trustProxy

    // All booleans below are pre-computed at compose() time — no per-request
    // `.hasAny()` array scans. See `_recomputeDispatchFlags`.
    const hooks = this._hooks
    const decorators = this._decorators

    try {
      if (this._hasOnRequest) {
        await hooks.runOnRequest(ctx)
      }
      if (this._hasDecorators) {
        decorators.applyTo(ctx)
      }

      const match = this.trie.find(ctx.method, ctx.path)
      if ('handler' in match) {
        // Only assign params when the route actually has them — otherwise
        // ctx.params already points at the frozen empty sentinel from reset.
        if (match.params !== EMPTY_PARAMS) {
          ctx.params = match.params as never
        }
        // Wrap the dispatch in a wall-clock race AND a closure-bound
        // late-write guard on the response writers. The race is HTTP-
        // request-scoped only — WS / SSE upgrades bypass this path because
        // they're dispatched through their own adapters and never resolve
        // back to a normal HTTP response. See `withEpochGuard` for the
        // mechanism that prevents orphaned handlers from corrupting the
        // next request bound to this same pooled context instance.
        if (this._hasTimeout) {
          await withEpochGuard(ctx, this._requestTimeoutMs as number, () => match.handler(ctx))
        } else {
          await match.handler(ctx)
        }

        if (this._hasOnResponse) {
          await hooks.runOnResponse(ctx)
        }
        return
      }
      // Miss — but middleware that mounts a path-handler (e.g. `ingenium.static()`)
      // expects to run on requests that don't match a registered route. Build a
      // fall-through chain from any global + mount-prefix-matching middleware
      // and let it have a shot. If it writes the response, we're done; if it
      // calls next() or doesn't write, we surface the original 404/405.
      await this.runFallback(ctx, missToError(match))
      if (this._hasOnResponse) {
        await hooks.runOnResponse(ctx)
      }
    } catch (err) {
      // Observation hook fires BEFORE the error boundary writes a response.
      // The boundary still owns the actual response — these hooks cannot
      // swallow or replace the error.
      if (this._hasOnError) {
        await hooks.runOnError(err, ctx)
      }
      await this.handleError(err, ctx)
    }
  }

  /**
   * Run global + path-matching scoped middleware as a fallback chain when the
   * trie has no matching route. The terminal handler re-throws the original
   * trie miss so the error boundary still produces 404/405 if no middleware
   * wrote the response. Composed per-request — misses are exceptional.
   */
  private async runFallback(ctx: IngeniumContext, miss: IngeniumError): Promise<void> {
    const flat = this._flat
    if (!flat) {
      throw miss
    }
    const applicable: IngeniumMiddleware[] = [...flat.globalMiddleware]
    // Collapse runs of '/' before the prefix check so a non-normalized request
    // path (e.g. `//admin/x`) can't slip past a deny-by-default / audit / security
    // gate scoped to `/admin`: `pathStartsWith('//admin/x', '/admin')` is false.
    // Matched routes bake their chain at compose time, so this only matters on the
    // trie-miss fallback. Local-only — ctx.path is left untouched.
    const normalizedPath = ctx.path.includes('//') ? ctx.path.replace(/\/{2,}/g, '/') : ctx.path
    for (const scoped of flat.scopedMiddleware) {
      if (pathStartsWith(normalizedPath, scoped.prefix)) applicable.push(scoped.mw)
    }
    if (applicable.length === 0) {
      throw miss
    }
    // No-op terminal — let middleware finish completely (including post-next
    // hooks). If nothing wrote a response, surface the trie miss as a 404/405.
    const chain = composeWithHandler(applicable, () => {})
    await chain(ctx)
    if (!ctx._written) throw miss
  }

  private async handleError(err: unknown, ctx: IngeniumContext): Promise<void> {
    // Reset response state in case a partial helper had been called.
    if (this.errorHandler) {
      try {
        await this.errorHandler(err, ctx)
        return
      } catch (rethrow) {
        err = rethrow
      }
    }
    writeDefaultError(err, ctx)
  }

  // ───── In-process test client ──────────────────────────────────────────

  /**
   * Dispatch a synthetic request through the SAME path as the wire — no
   * socket, no transport. Acquires a pooled context, populates it exactly as
   * the Node adapter would from an `IncomingMessage`, runs `handle()` (so
   * routing, 404/405, middleware, hooks, and the error boundary all behave
   * identically), then materializes the response into a plain {@link InjectResponse}.
   *
   * Crucially the context is extracted FULLY and only THEN released back to
   * the pool: releasing bumps `_epoch` and reassigns `_headers`/`_body`, so
   * reading them after release would surface the next request's state (or
   * empty). The returned object holds copies, so it survives the recycle and
   * sequential `inject()` calls never bleed header/body state into each other.
   *
   * @example
   *   const res = await app.inject({ method: 'POST', url: '/users', body: { name: 'a' } })
   *   expect(res.status).toBe(201)
   *   expect(res.json<{ id: string }>().id).toBeDefined()
   */
  async inject(opts: InjectRequest): Promise<InjectResponse> {
    if (this.dirty) await this.composeAsync()

    const ctx = this.pool.acquire()
    try {
      populateInjectContext(ctx, opts)
      await this.handle(ctx)
      // Extract EVERYTHING before release — see the doc comment above.
      return await extractInjectResponse(ctx)
    } finally {
      this.pool.release(ctx)
    }
  }

  // ───── Transport ─────────────────────────────────────────────────────────

  /** Bind a port and accept requests. Returns a handle for graceful shutdown. */
  async listen(port: number, host?: string): Promise<ListeningServer> {
    // Double-listen guard. Binding a second server to the same app means two
    // ports feeding one context pool — almost always a copy-paste bug. Throw a
    // clear TypeError instead of silently double-binding. Re-listening after a
    // clean `close()` is allowed (the flag is cleared there).
    if (this._listening) {
      throw new TypeError(
        'ingenium: app.listen() called while already listening. Call close() on the ' +
          'returned server handle before listening again, or create a separate app.',
      )
    }
    if (this.dirty) await this.composeAsync()
    this.transport.attach({
      acquire: () => this.pool.acquire(),
      release: (ctx) => this.pool.release(ctx),
      dispatch: (ctx) => this.handle(ctx),
      maxRequestBytes: this._maxRequestBytes,
    })
    const handle = host !== undefined
      ? await this.transport.listen(port, host)
      : await this.transport.listen(port)

    // Mark listening only AFTER the bind succeeds — a failed bind (e.g. port
    // in use) leaves the app re-listenable.
    this._listening = true

    // Wrap the underlying close so cron timers + queue worker pools are torn
    // down as part of graceful shutdown. Sockets and queues drain in parallel
    // (wall-clock bounded by max(socket-drain, queue-drain), not their sum).
    const drainTimeout = this._queueDrainTimeoutMs
    const queues = this._queues
    const crons = this._crons
    const wrappedClose: ListeningServer['close'] = async (closeOpts) => {
      // Allow a fresh listen() once shutdown begins. Cleared before the await
      // so a re-listen racing the drain still binds (the old server is already
      // refusing new connections via server.close()).
      this._listening = false
      // Stop cron tickers FIRST so they don't enqueue new work mid-shutdown.
      crons.stopAll()
      const queueDrain = queues.drainAll(drainTimeout)
      const socketClose = handle.close(closeOpts)
      const [, drainResult] = await Promise.all([socketClose, queueDrain])
      if (drainResult.timedOut.length > 0) {
        try {
          process.emitWarning(
            `ingenium: queues did not drain within ${drainTimeout}ms: ${drainResult.timedOut.join(', ')}`,
            { type: 'IngeniumQueueDrainWarning' },
          )
        } catch {
          /* worker contexts may throw on emitWarning */
        }
      }
    }
    return { ...handle, close: wrappedClose }
  }
}

function missToError(miss: MatchMiss): IngeniumError {
  if (miss.kind === 'not-found') return new IngeniumNotFoundError()
  return new IngeniumMethodNotAllowedError(miss.allowed)
}

function writeDefaultError(err: unknown, ctx: IngeniumContext): void {
  if (err instanceof IngeniumHaltError) {
    // Halt body shape was decided at the call site (`ctx.halt`):
    //   - 'text'  → body is a string, write as text/plain verbatim
    //   - 'json'  → body is an object, write as application/json verbatim
    //   - 'none'  → no body provided, fall through to default JSON shape
    if (err.bodyShape === 'text') {
      ctx.text(err.body as string, err.statusCode)
      return
    }
    if (err.bodyShape === 'json') {
      ctx.json(err.body as Record<string, unknown>, err.statusCode)
      return
    }
    ctx.json({ error: err.message, code: err.code }, err.statusCode)
    return
  }
  if (err instanceof IngeniumError) {
    if (err instanceof IngeniumMethodNotAllowedError) {
      ctx.set('allow', err.allowed.join(', '))
    }
    const payload: Record<string, unknown> = { error: err.message, code: err.code }
    if ('fields' in err && err.fields) payload.fields = err.fields
    ctx.json(payload, err.statusCode)
    return
  }
  // Unknown error → 500
  const message = (err as Error)?.message ?? 'Internal Server Error'
  ctx.json({ error: message, code: 'INTERNAL_ERROR' }, 500)
}

/**
 * Populate a pooled context from {@link InjectRequest}, mirroring the Node
 * adapter's `populateContext`. Splits path / query, lowercases header names,
 * normalizes the body into a `Readable` (so `ctx.body.*` consumers behave
 * exactly as they do on the wire), and tags JSON bodies with a content-type
 * unless the caller set one.
 */
function populateInjectContext(ctx: IngeniumContext, opts: InjectRequest): void {
  ctx.method = opts.method ?? 'GET'
  ctx.url = opts.url
  const qIdx = opts.url.indexOf('?')
  if (qIdx >= 0) {
    ctx.path = opts.url.slice(0, qIdx)
    ctx.rawQuery = opts.url.slice(qIdx + 1)
  } else {
    ctx.path = opts.url
    ctx.rawQuery = ''
  }

  // Lowercase header names (node:http convention). Collect into the bag the
  // handler reads via ctx.headers[...].
  const headers: Record<string, string | string[]> = {}
  if (opts.headers) {
    for (const name of Object.keys(opts.headers)) {
      headers[name.toLowerCase()] = opts.headers[name] as string | string[]
    }
  }

  ctx.remoteAddress = opts.remoteAddress ?? '127.0.0.1'
  ctx.baseProtocol = 'http'

  // Normalize the body into raw bytes. Objects → JSON (+ default content-type
  // unless the caller already set one). Strings/Buffers/Uint8Arrays pass
  // through verbatim. `undefined` → no body.
  let bodyBuf: Buffer | null = null
  const body = opts.body
  if (body !== undefined) {
    if (typeof body === 'string') {
      bodyBuf = Buffer.from(body, 'utf8')
    } else if (Buffer.isBuffer(body)) {
      bodyBuf = body
    } else if (body instanceof Uint8Array) {
      bodyBuf = Buffer.from(body)
    } else {
      // Plain object / array → JSON. Auto-tag content-type unless explicit.
      bodyBuf = Buffer.from(JSON.stringify(body), 'utf8')
      if (headers['content-type'] === undefined) {
        headers['content-type'] = 'application/json'
      }
    }
  }

  ctx.headers = headers

  if (bodyBuf !== null) {
    const ct = headers['content-type']
    ctx.body._attach(
      Readable.from(bodyBuf),
      Array.isArray(ct) ? ct[0] : ct,
      bodyBuf.length,
    )
  } else {
    ctx.body._attach(null, undefined, undefined)
  }
}

/**
 * Materialize a dispatched context's response into a plain {@link InjectResponse}.
 * Clones the header bag (array values copied) so callers never alias the
 * pooled context's `_headers`, and drains a stream body to a UTF-8 string.
 * MUST be called before the context is released back to the pool.
 */
async function extractInjectResponse(ctx: IngeniumContext): Promise<InjectResponse> {
  const status = ctx._statusCode

  // Deep-ish copy of headers — array values cloned so a later inject() can't
  // mutate this snapshot (and vice versa).
  const headers: Record<string, string | string[]> = {}
  for (const key of Object.keys(ctx._headers)) {
    const v = ctx._headers[key]
    if (v === undefined) continue
    headers[key] = Array.isArray(v) ? v.slice() : v
  }

  let body = ''
  const rb = ctx._body
  switch (rb.kind) {
    case 'string':
      body = rb.data
      break
    case 'buffer':
      body = rb.data.toString('utf8')
      break
    case 'stream': {
      const chunks: Buffer[] = []
      for await (const chunk of rb.data) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer))
      }
      body = Buffer.concat(chunks).toString('utf8')
      break
    }
    case 'none':
      body = ''
      break
  }

  return {
    status,
    headers,
    body,
    json<T = unknown>(): T {
      return JSON.parse(body) as T
    },
  }
}

/**
 * Detect whether a value is a "plain options object" — i.e. the declarative
 * route-options shape (`{ auth: [...], rateLimit: '...' }`) — vs anything
 * else that might be in argument-position 0 (a middleware function, a
 * handler function, a class instance, a Buffer, an Array, etc).
 *
 * Rule: must be non-null, `typeof === 'object'`, NOT a function, NOT an
 * Array, and `Object.getPrototypeOf(v)` is either `Object.prototype` or
 * `null` (covers `Object.create(null)` bags). Class instances have a
 * non-Object prototype and are correctly rejected. This is a stricter check
 * than `typeof === 'object'` alone — we want false positives to be near-
 * impossible because misclassifying a middleware as options would bury the
 * mistake under "unknown declarator" errors.
 */
function isPlainOptionsObject(v: unknown): v is RouteOptions {
  if (v === null || typeof v !== 'object') return false
  if (typeof v === 'function') return false
  if (Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v) as object | null
  return proto === null || proto === Object.prototype
}

/**
 * Translate the peeled-off built-in slice of a route-options object into the
 * shape `app.describe()` expects. Pass-through for plain OpenAPI keys
 * (`summary`, `description`, `operationId`, `tags`, `deprecated`, `security`,
 * `parameters`); normalization for `response` / `requestBody` which the user
 * may write in compact form (a bare Schema). See `normalizeResponse` /
 * `normalizeRequestBody` for the rules. Throws at REGISTRATION time on any
 * inline value that looks like a live validator (Standard Schema or Zod-style
 * `safeParse`) — we don't try to convert validators to JSON Schema from this
 * code path; callers can precompute and use `app.describe()` directly.
 */
function buildDescriptorFromBuiltins(
  method: HttpMethod,
  path: string,
  builtins: Record<string, unknown>,
): RouteDescriptor {
  const desc: RouteDescriptor = {}
  if ('summary' in builtins) desc.summary = builtins.summary as string
  if ('description' in builtins) desc.description = builtins.description as string
  if ('operationId' in builtins) desc.operationId = builtins.operationId as string
  if ('tags' in builtins) desc.tags = builtins.tags as string[]
  if ('deprecated' in builtins) desc.deprecated = builtins.deprecated as boolean
  if ('security' in builtins) desc.security = builtins.security as NonNullable<RouteDescriptor['security']>
  if ('parameters' in builtins) desc.parameters = builtins.parameters as NonNullable<RouteDescriptor['parameters']>
  if ('response' in builtins) {
    desc.responses = normalizeResponse(method, path, builtins.response)
  }
  if ('requestBody' in builtins) {
    desc.requestBody = normalizeRequestBody(method, path, builtins.requestBody)
  }
  return desc
}

/**
 * Reject inline schema values that need conversion we don't perform at this
 * seam. We accept ONLY raw OpenAPI Schema objects (plain JSON Schema literals,
 * including the wrappers Zod 3.24+/ArkType/Effect emit when the caller has
 * already called `.toJsonSchema()`). Anything that still carries a live
 * `~standard` or `safeParse` is a precondition violation: it's the caller's
 * job to convert. The OpenAPI generator's runtime conversion path handles
 * validators passed through the long-form `app.describe()` API; this inline
 * convenience form intentionally stays conversion-free so the failure mode
 * is at registration, not at spec-generation time inside a healthcheck.
 */
function validateInlineSchema(
  method: HttpMethod,
  path: string,
  location: 'response' | 'requestBody',
  value: unknown,
): void {
  if (value === null || typeof value !== 'object') return
  if (isStandardSchema(value)) {
    throw new TypeError(
      `app.${method.toLowerCase()}('${path}', { ${location}: ... }, handler): inline schema conversion isn't supported yet. ` +
        `Pass a plain OpenAPI Schema object, or use app.describe() with a precomputed schema.`,
    )
  }
  const maybeZod = value as { safeParse?: unknown }
  if (typeof maybeZod.safeParse === 'function') {
    throw new TypeError(
      `app.${method.toLowerCase()}('${path}', { ${location}: ... }, handler): inline schema conversion isn't supported yet. ` +
        `Pass a plain OpenAPI Schema object, or use app.describe() with a precomputed schema.`,
    )
  }
}

/**
 * Three-digit status-code key heuristic — `200`, `404`, `4XX` are all
 * accepted. Used to distinguish "status-keyed response map" from "bare
 * schema with `200`-shaped property names." Keys longer than 3 chars, with
 * non-digit/non-X content, or starting with `0` are NOT status codes.
 */
function isStatusKey(k: string): boolean {
  if (k.length !== 3) return false
  if (k[0] === '0') return false
  for (let i = 0; i < 3; i++) {
    const c = k.charCodeAt(i)
    // 0-9 or X / x
    if (!((c >= 48 && c <= 57) || c === 88 || c === 120)) return false
  }
  return true
}

/**
 * Heuristic: does this look like a JSON Schema literal? Detects the common
 * top-level keywords. Used to choose between `{ response: SchemaLiteral }`
 * (wrap as 200) and `{ response: { '200': {...}, '404': {...} } }`
 * (status-keyed map). The two shapes are unambiguous in practice because a
 * status-keyed map's keys are all 3-char digits and JSON Schema keywords
 * never are.
 */
function looksLikeSchemaLiteral(v: object): boolean {
  const obj = v as Record<string, unknown>
  return (
    'type' in obj ||
    'properties' in obj ||
    '$ref' in obj ||
    'oneOf' in obj ||
    'anyOf' in obj ||
    'allOf' in obj ||
    'enum' in obj ||
    'const' in obj ||
    'items' in obj
  )
}

/**
 * Normalize the inline `response` option into the descriptor's `responses`
 * map. Three accepted shapes:
 *   1. A bare OpenAPI Schema → wrapped as `200 application/json` content.
 *   2. A status-keyed map (`{ '200': {...}, '404': {...} }`) where each entry
 *      is either a full `Response` object or a bare Schema.
 *   3. An already-shaped `Response` (has `description` and/or `content`) for
 *      the 200 slot.
 *
 * Picks (1) vs (2) by inspecting the object's keys: if any key is a 3-digit
 * status code (`200`, `4XX`), it's (2); if the object looks like a JSON
 * Schema literal (`type`/`properties`/`$ref`/...), it's (1); otherwise we
 * fall back to (3) — wrap the value as the 200 Response.
 */
function normalizeResponse(
  method: HttpMethod,
  path: string,
  value: unknown,
): Record<string, Response> {
  validateInlineSchema(method, path, 'response', value)
  if (value === null || typeof value !== 'object') {
    // A non-object is not a meaningful response shape. Wrap as an opaque
    // 200 schema so the caller at least sees something in the spec.
    return {
      '200': {
        description: 'OK',
        content: { 'application/json': { schema: value as Schema } },
      },
    }
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
  const allStatus = keys.length > 0 && keys.every(isStatusKey)

  if (allStatus) {
    const out: Record<string, Response> = {}
    for (const k of keys) {
      out[k] = coerceResponseEntry(method, path, obj[k])
    }
    return out
  }

  // Single 200 entry. If it already looks like a Response (has description
  // and/or content), pass it through; otherwise wrap as JSON content.
  if ('content' in obj || ('description' in obj && !looksLikeSchemaLiteral(obj))) {
    return { '200': obj as unknown as Response }
  }
  return {
    '200': {
      description: 'OK',
      content: { 'application/json': { schema: obj as Schema } },
    },
  }
}

/**
 * Coerce a single value from a status-keyed `response` map into a `Response`.
 * Accepts either a full `Response` (passed through) or a bare schema (wrapped
 * as `application/json` content with a default description).
 */
function coerceResponseEntry(method: HttpMethod, path: string, value: unknown): Response {
  validateInlineSchema(method, path, 'response', value)
  if (value === null || typeof value !== 'object') {
    return {
      description: 'Response',
      content: { 'application/json': { schema: value as Schema } },
    }
  }
  const obj = value as Record<string, unknown>
  if ('content' in obj || ('description' in obj && !looksLikeSchemaLiteral(obj))) {
    return obj as unknown as Response
  }
  return {
    description: 'Response',
    content: { 'application/json': { schema: obj as Schema } },
  }
}

/**
 * Normalize the inline `requestBody` option into a full `RequestBody` shape.
 * If the value already has a `content` field (an OpenAPI RequestBody),
 * pass it through; otherwise wrap as `application/json` content.
 */
function normalizeRequestBody(
  method: HttpMethod,
  path: string,
  value: unknown,
): RequestBody {
  validateInlineSchema(method, path, 'requestBody', value)
  if (value === null || typeof value !== 'object') {
    return { content: { 'application/json': { schema: value as Schema } } }
  }
  const obj = value as Record<string, unknown>
  if ('content' in obj) return obj as unknown as RequestBody
  return { content: { 'application/json': { schema: obj as Schema } } }
}

/**
 * Race a dispatched handler against a wall-clock deadline. Resolves when
 * the handler does, or rejects with `IngeniumTimeoutError` if the deadline
 * fires first. The handler promise is NOT cancelled (JS can't) — it's just
 * orphaned. We bump `ctx._epoch` at timeout so any subsequent writes from
 * the orphaned handler hit the epoch-guard installed around the dispatch
 * and get swallowed instead of corrupting the next request.
 *
 * The timer is `unref`'d so a fast handler that resolves naturally doesn't
 * keep the event loop alive waiting for the timeout to fire.
 */
function raceWithTimeout(
  dispatch: Promise<unknown> | unknown,
  timeoutMs: number,
  ctx: IngeniumContext,
  capturedEpoch: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      // Bump the epoch so the orphaned handler's late writes are detected
      // by the guard wrappers as stale and discarded. This is what
      // prevents cross-request response corruption when the ctx is
      // recycled and rebound to a new request.
      if (ctx._epoch === capturedEpoch) ctx._epoch++
      reject(new IngeniumTimeoutError(timeoutMs))
    }, timeoutMs)
    // Crucially, never keep the event loop alive. A handler that resolves
    // in 5ms with a 30s timeout configured should not block process exit.
    timer.unref?.()
    Promise.resolve(dispatch).then(
      (v) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(v as void)
      },
      (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/**
 * Per-dispatch async-context store. Carries the epoch captured at dispatch
 * entry through every `await` in the handler chain. The orphaned handler
 * of a timed-out dispatch keeps running inside its OWN ALS frame even
 * after `Promise.race` rejects in `handle()`, so its `als.getStore()`
 * still returns the original captured epoch. The next request runs in a
 * different ALS frame (because `als.run(...)` was called fresh), so its
 * store is its own captured epoch. This is the ONLY reliable way to
 * distinguish "the orphan calling `ctx.json`" from "the legitimate next
 * request calling `ctx.json`" — ctx state alone cannot.
 */
const dispatchEpochStore: AsyncLocalStorage<number> = new AsyncLocalStorage()

/**
 * Run `fn()` under both the wall-clock race AND a per-dispatch late-write
 * guard. The guard installs closure-bound wrappers around `ctx`'s response
 * writers; each wrapper checks `dispatchEpochStore.getStore()` (carried by
 * `AsyncLocalStorage` through every `await` in the handler chain) against
 * the epoch captured at dispatch entry. When they diverge — because the
 * timeout path bumped `ctx._epoch` and we're now executing inside a stale
 * orphan continuation — the wrapper swallows the write and emits a single
 * `IngeniumLateWriteWarning` so leaks remain observable in production.
 *
 * Behavior:
 * - Dispatch resolves naturally → restore originals (no orphan possible).
 * - Dispatch times out → bump `_epoch` (so any check against the captured
 *   value fails), `Promise.race` rejects with `IngeniumTimeoutError`, the
 *   error boundary writes the 503. The orphaned handler keeps running in
 *   its own ALS frame; its eventual `ctx.json(...)` is detected as stale
 *   either by (a) the still-installed wrapper (if no new request has
 *   re-wrapped) — store mismatch → swallow; or (b) the next request's
 *   wrapper, which compares the orphan's ALS-store epoch against its own
 *   captured value → mismatch → swallow.
 *
 * The error boundary itself runs OUTSIDE the orphan's ALS frame (it
 * executes synchronously after the `await` in `handle()`), so its
 * `als.getStore()` returns `undefined`, which the wrapper treats as "no
 * guard active for this caller" and lets through.
 *
 * The timer is `unref`'d so a fast handler that resolves naturally doesn't
 * keep the event loop alive waiting for the timeout to fire.
 */
async function withEpochGuard(
  ctx: IngeniumContext,
  timeoutMs: number,
  fn: () => Promise<unknown> | unknown,
): Promise<void> {
  const capturedEpoch = ctx._epoch
  ctx._dispatchEpoch = capturedEpoch

  // Snapshot originals — un-wrapped methods we restore on dispatch end.
  const originals = {
    json: ctx.json,
    text: ctx.text,
    html: ctx.html,
    send: ctx.send,
    redirect: ctx.redirect,
    stream: ctx.stream,
  }

  // The closure + ALS combined check. `capturedEpoch` is the per-dispatch
  // identity. We swallow ONLY when this wrapper's own orphan is calling:
  // the ALS store still says "you're inside dispatch N" (because the
  // orphan kept running its async chain past the timeout) BUT the live
  // `_epoch` has moved on (because the timeout path bumped it). For every
  // other caller — the legitimate handler under THIS dispatch, the error
  // boundary (no store), the next dispatch's handler (different store) —
  // we pass through to the underlying writer. With wrappers stacked
  // across recycled contexts, each layer detects only its own orphan and
  // forwards everything else; the deepest layer is the original writer.
  const guarded = (orig: (...args: never[]) => unknown) =>
    function guardedWriter(this: IngeniumContext, ...args: unknown[]): unknown {
      const callerEpoch = dispatchEpochStore.getStore()
      // Only my-own-orphan path swallows: caller is in the same ALS frame
      // I installed, but the live epoch has been bumped past my captured
      // value (timeout fired or the ctx was recycled).
      if (callerEpoch === capturedEpoch && ctx._epoch !== capturedEpoch) {
        try {
          process.emitWarning(
            'Late response write after timeout — handler may be leaking',
            { type: 'IngeniumLateWriteWarning' },
          )
        } catch {
          // process.emitWarning can throw in unusual runtimes (workers); swallow.
        }
        return undefined
      }
      return (orig as (...a: unknown[]) => unknown).apply(ctx, args)
    }

  ctx.json = guarded(originals.json) as typeof ctx.json
  ctx.text = guarded(originals.text) as typeof ctx.text
  ctx.html = guarded(originals.html) as typeof ctx.html
  ctx.send = guarded(originals.send) as typeof ctx.send
  ctx.redirect = guarded(originals.redirect) as typeof ctx.redirect
  ctx.stream = guarded(originals.stream) as typeof ctx.stream

  const restore = (): void => {
    ctx.json = originals.json
    ctx.text = originals.text
    ctx.html = originals.html
    ctx.send = originals.send
    ctx.redirect = originals.redirect
    ctx.stream = originals.stream
    ctx._dispatchEpoch = 0
  }

  try {
    await dispatchEpochStore.run(capturedEpoch, () =>
      raceWithTimeout(fn(), timeoutMs, ctx, capturedEpoch),
    )
    // Success path: no orphan can exist. Restore originals so we don't
    // accumulate dead wrappers on the pooled context across thousands of
    // successful requests.
    restore()
  } catch (err) {
    // Failure path. If it's a timeout, the orphaned handler is still alive
    // and may eventually call ctx.json/text/...; we KEEP the wrapper
    // installed so its ALS-store check can detect and swallow those late
    // writes. The error boundary itself runs outside the orphan's ALS
    // frame, so its writes pass through (no store ⇒ no swallow).
    //
    // For non-timeout errors (handler threw synchronously, etc.) there's
    // no orphan to defend against, so restore for hygiene.
    if (err instanceof IngeniumTimeoutError) {
      ctx._dispatchEpoch = 0 // Stop advertising "active dispatch"; wrapper still inspects ALS store.
    } else {
      restore()
    }
    throw err
  }
}

function pathStartsWith(path: string, prefix: string): boolean {
  if (prefix === '') return true
  if (!path.startsWith(prefix)) return false
  // Boundary check: '/api' must not match '/apiary'.
  const after = path.charCodeAt(prefix.length)
  return Number.isNaN(after) || after === 47 // '/'
}

/**
 * Factory function. Mirrors the `express()` ergonomics — `ingenium(...)` returns
 * a new app, and the function carries the body-parser middleware factories
 * plus a `Router` constructor as static properties.
 */
export interface IngeniumFactory {
  (options?: IngeniumAppOptions): IngeniumApp
  Router: () => Router
}

/** Match: `void` for error-handler that delegates. (Used by the type tests.) */
export type IngeniumErrorReturn = unknown | Promise<unknown>

/** Function-with-properties factory created and exported by `index.ts`. */
export function makeIngeniumFactory(): IngeniumFactory {
  const fn = ((options?: IngeniumAppOptions) => new IngeniumApp(options)) as IngeniumFactory
  fn.Router = () => new Router()
  return fn
}

/** Match path-with-prefix exported for tests. */
export const _internal_pathStartsWith = pathStartsWith
