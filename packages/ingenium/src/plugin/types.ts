import type { IngeniumContext } from '../context/context.ts'
import type { IngeniumHandler, IngeniumMiddleware } from '../middleware/types.ts'
import type { RouteBuilder, Router } from '../router/router.ts'
import type { HttpMethod } from '../router/types.ts'

/**
 * Payload fired to `onRoute` hooks each time a route is registered into the
 * trie during composition. Plugins can observe — they MUST NOT mutate.
 */
export interface RegistrationEvent {
  /** HTTP method (uppercase). */
  readonly method: HttpMethod
  /** Final composed route path (after all prefixes). */
  readonly path: string
}

/**
 * The shape a plugin can rely on regardless of whether it's registered onto
 * the root `IngeniumApp` or onto a `ScopedApp` (via `app.scope(...).register(...)`).
 *
 * Both root and scoped registration targets implement this interface. Plugins
 * that previously took `(app: IngeniumApp, opts)` are source-compatible:
 * `IngeniumApp` implements every member of `PluginTarget`. The only practical
 * difference at the call site is that `target.scope(...)`, `target.use(mw)`,
 * and the verb methods become prefix-relative when `target` is a `ScopedApp`.
 *
 * # Scoping semantics for plugin authors
 *
 * - `target.use(mw)` / `target.use(subprefix, mw)` — middleware is scoped to
 *   the target's prefix at compose time. On the root, this is "global". In a
 *   scope, it's "applies only to paths under the scope's prefix".
 * - `target.get/post/...` and `target.method(...)` — paths are prefix-
 *   relative; the scope prepends its absolute prefix at registration time.
 * - `target.register(plugin, opts)` — runs the plugin against the SAME
 *   target. Nested scopes compose as expected.
 * - `target.hooks` — lifecycle hooks are GLOBAL even when called inside a
 *   scope. Hooks fire per request, before route dispatch; making them
 *   scope-aware would require runtime path-prefix checks on every request.
 *   If a plugin needs scope-aware behavior, it should inspect `ctx.path`
 *   inside the hook body.
 * - `target.decorate(...)` / `target.decorateRequest(...)` — decorators are
 *   GLOBAL even when called inside a scope (see {@link IngeniumPlugin} JSDoc
 *   for the rationale). `ScopedApp.decorate` emits a one-shot
 *   `process.emitWarning` in non-production environments to surface this
 *   footgun.
 */
export interface PluginTarget {
  /** Lifecycle hooks (global — see interface JSDoc). */
  readonly hooks: Hooks

  /** Add middleware that runs for every request below this target. */
  use(mw: IngeniumMiddleware): this
  /** Mount middleware or a sub-router at a path prefix (relative to this target). */
  use(prefix: string, mw: IngeniumMiddleware | Router): this

  /** Register a route under any HTTP method (path is relative to this target). */
  method(method: HttpMethod, path: string, handler: IngeniumHandler): this
  method(
    method: HttpMethod,
    path: string,
    ...args: [...IngeniumMiddleware[], IngeniumHandler]
  ): this

  /**
   * Chainable per-path builder. Same path-joining rules as the bare verbs —
   * inside a `ScopedApp`, the builder's emitted routes are prefix-relative.
   */
  route<P extends string>(path: P): RouteBuilder<P>

  /** Convenience verb shortcuts (paths are relative to this target). */
  get(path: string, handler: IngeniumHandler): this
  get(path: string, ...args: [...IngeniumMiddleware[], IngeniumHandler]): this
  post(path: string, handler: IngeniumHandler): this
  post(path: string, ...args: [...IngeniumMiddleware[], IngeniumHandler]): this
  put(path: string, handler: IngeniumHandler): this
  put(path: string, ...args: [...IngeniumMiddleware[], IngeniumHandler]): this
  patch(path: string, handler: IngeniumHandler): this
  patch(path: string, ...args: [...IngeniumMiddleware[], IngeniumHandler]): this
  delete(path: string, handler: IngeniumHandler): this
  delete(path: string, ...args: [...IngeniumMiddleware[], IngeniumHandler]): this
  head(path: string, handler: IngeniumHandler): this
  head(path: string, ...args: [...IngeniumMiddleware[], IngeniumHandler]): this
  options(path: string, handler: IngeniumHandler): this
  options(path: string, ...args: [...IngeniumMiddleware[], IngeniumHandler]): this

  /**
   * Pre-handler / post-handler middleware (paths are relative to this target).
   * Inside a `ScopedApp` these are confined to the scope prefix — `s.before(h)`
   * only fires for requests under the scope, mirroring `s.use`.
   */
  before(handler: IngeniumMiddleware): this
  before(pattern: string, handler: IngeniumMiddleware): this
  after(handler: IngeniumMiddleware): this
  after(pattern: string, handler: IngeniumMiddleware): this

  /** Decorator registration. NOTE: GLOBAL even when called inside a scope. */
  decorate<T>(name: string, factory: LazyDecorator<T>): this
  decorateRequest<T>(name: string, factory: EagerDecorator<T>): this

  /**
   * Register a plugin against this target. Plugins may be async and the
   * caller should `await` the returned promise.
   */
  register<O>(plugin: IngeniumPlugin<O>, opts: O): Promise<this>
  register(plugin: IngeniumPlugin<void>): Promise<this>

  /**
   * Open a nested registration scope. All registrations inside `registrar`
   * are prefix-relative to `prefix` (and inherit any outer scope prefix).
   */
  scope(prefix: string, registrar: (scope: PluginTarget) => void): this | Promise<this>
}

/**
 * A plugin is a function that mutates a registration target: it can register
 * routes, middleware, decorators, and hook handlers. Plugins are registered
 * before `compose()` runs; they may be async.
 *
 * The `target` parameter is `PluginTarget` — implemented by both `IngeniumApp`
 * (the root) and `ScopedApp` (created by `app.scope(prefix, ...)`). When a
 * plugin is registered inside a scope, its `target.use(...)` / `target.get(...)`
 * are automatically prefix-scoped at compose time.
 *
 * # Scoped-decorator caveat (V1)
 *
 * Decorators (`target.decorate`, `target.decorateRequest`) install onto the
 * pooled `IngeniumContext` at request start; the registry is per-app, not
 * per-path. That means a plugin registered inside `app.scope('/api', ...)`
 * that calls `target.decorate('user', ...)` will decorate EVERY request,
 * not just `/api/*` requests. The first such call inside a scope emits a
 * `process.emitWarning` in non-production environments. Plugin authors who
 * want per-scope decorator behavior should make the decorator's factory
 * inspect `ctx.path` and return a sentinel for out-of-scope requests.
 *
 * @example
 * const myPlugin: IngeniumPlugin<{ secret: string }> = async (target, opts) => {
 *   target.hooks.onRequest((ctx) => { ... })
 *   target.use((ctx, next) => next())          // scoped if target is a ScopedApp
 *   target.get('/whoami', (ctx) => ...)        // path is relative to scope
 * }
 *
 * await app.register(myPlugin, { secret: 'shh' })
 * app.scope('/api', (s) => s.register(myPlugin, { secret: 'shh' }))
 */
export type IngeniumPlugin<O = void> = (
  target: PluginTarget,
  opts: O,
) => void | Promise<void>

/** Fires once per route as the trie is built (during `compose()`). */
export type OnRouteHook = (registration: RegistrationEvent) => void

/** Fires before composition runs. May be async. */
export type OnComposeHook = () => void | Promise<void>

/** Fires at the start of every request, before middleware dispatch. */
export type OnRequestHook = (ctx: IngeniumContext) => void | Promise<void>

/** Fires after the handler resolves successfully. */
export type OnResponseHook = (ctx: IngeniumContext) => void | Promise<void>

/**
 * Fires when the handler chain throws. OBSERVATION ONLY — the framework's
 * error boundary still owns the response. Throwing inside an `onError` hook
 * is swallowed; this is by design so observers can't mask the original error.
 */
export type OnErrorHook = (err: unknown, ctx: IngeniumContext) => void | Promise<void>

/**
 * Public hooks API exposed on `app.hooks`. Each method appends a listener;
 * listeners are invoked in registration order, sequentially (`await`-ed in
 * a loop) for predictable ordering.
 */
export interface Hooks {
  onRoute(fn: OnRouteHook): void
  onCompose(fn: OnComposeHook): void
  onRequest(fn: OnRequestHook): void
  onResponse(fn: OnResponseHook): void
  onError(fn: OnErrorHook): void
}

/** Lazy decorator — computed on first access, then cached on the ctx. */
export type LazyDecorator<T = unknown> = (ctx: IngeniumContext) => T

/** Eager decorator — evaluated at request start, value assigned directly. */
export type EagerDecorator<T = unknown> = (ctx: IngeniumContext) => T

/** Generic decorator factory shape (covers both lazy and eager). */
export type Decorator<T = unknown> = (ctx: IngeniumContext) => T
