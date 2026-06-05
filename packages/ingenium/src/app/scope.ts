/**
 * `ScopedApp` — registration facade returned to the callback of
 * `app.scope(prefix, registrar)`. Translates every registration call into a
 * prefix-qualified registration on the underlying `IngeniumApp`, leveraging
 * the existing Router scoping primitives (`use-prefix`, prefix-prepended
 * paths) so the COMPOSE-TIME machinery does all the heavy lifting and the
 * per-request hot path stays untouched.
 *
 * # Design
 *
 * - Holds a reference to the root `IngeniumApp` plus the ABSOLUTE prefix
 *   (already includes any outer scope prefix). Nested scopes just construct
 *   a new `ScopedApp` with `parent.prefix + sub`.
 * - `scope.use(mw)` becomes `app.use(absolutePrefix, mw)` — the existing
 *   `Router.use(prefix, mw)` plumbing produces a `use-prefix` registration,
 *   and `flattenRouter` emits a `scopedMiddleware` entry that `app.compose()`
 *   intersects against route paths via `pathStartsWith`.
 * - `scope.get(path, handler)` becomes `app.method('GET', absolutePrefix + path, handler)`.
 * - `scope.register(plugin, opts)` invokes the plugin with `this` as the
 *   target. Any `target.use(...)` inside the plugin body is therefore
 *   scope-prefixed; the plugin can't accidentally leak global middleware.
 * - `scope.scope(sub, fn)` constructs a child `ScopedApp` and runs `fn`
 *   against it.
 *
 * # Out of scope for V1 (documented footguns)
 *
 * - **Decorators**: `scope.decorate(...)` / `scope.decorateRequest(...)`
 *   forward to the root app and decorate EVERY request, not just requests
 *   under the scope's prefix. The reason is structural: decorators install
 *   onto pooled `IngeniumContext` instances at request start, BEFORE the
 *   route is matched — there's no path information available at that point
 *   without re-shaping the dispatch path. Per-scope decorators would require
 *   either (a) a runtime path check on every property access, or (b) a
 *   separate decorator registry per scope keyed by matched route — both of
 *   which move work onto the hot path and complicate the pool. For V1 we
 *   accept the footgun and emit a one-shot `process.emitWarning` in
 *   non-production environments to surface it.
 * - **Hooks**: `scope.hooks` returns the SAME registry the root app uses.
 *   Hook registration is global. A plugin that wants scope-aware hook
 *   behavior should inspect `ctx.path` inside the hook body.
 */

import type { IngeniumApp } from '../app.ts'
import type { IngeniumHandler, IngeniumMiddleware } from '../middleware/types.ts'
import { RouteBuilder, type Router } from '../router/router.ts'
import type { HttpMethod } from '../router/types.ts'
import type {
  EagerDecorator,
  Hooks,
  IngeniumPlugin,
  LazyDecorator,
  PluginTarget,
} from '../plugin/types.ts'
import { registerAfter, registerBefore } from '../sinatra/filters.ts'

/**
 * @internal Friend-access surface a `ScopedApp` needs from its parent
 * `IngeniumApp`. Kept narrow so refactors don't accidentally widen the
 * coupling. The methods are implemented on `IngeniumApp` itself.
 */
export interface ScopeHost {
  use(mw: IngeniumMiddleware): IngeniumApp
  use(prefix: string, mw: IngeniumMiddleware | Router): IngeniumApp
  method(method: HttpMethod, path: string, handler: IngeniumHandler): IngeniumApp
  method(
    method: HttpMethod,
    path: string,
    ...args: [...IngeniumMiddleware[], IngeniumHandler]
  ): IngeniumApp
  decorate<T>(name: string, factory: LazyDecorator<T>): IngeniumApp
  decorateRequest<T>(name: string, factory: EagerDecorator<T>): IngeniumApp
  readonly hooks: Hooks
  /** @internal Marks the app's compose-cache dirty. */
  _markDirty(): void
}

/**
 * Normalize an absolute-or-relative prefix piece so concatenation is clean.
 * Drops the trailing slash, ensures a leading slash. Empty string and `'/'`
 * collapse to `''` (no prefix).
 */
function normalizePrefix(p: string): string {
  if (p === '' || p === '/') return ''
  let out = p
  if (out[0] !== '/') out = '/' + out
  if (out.length > 1 && out[out.length - 1] === '/') out = out.slice(0, -1)
  return out
}

/**
 * Normalize a route path so `'users'` and `'/users'` both end up `/users` and
 * `''` resolves to `'/'`. Mirrors `Router.normalizePath`.
 */
function normalizePath(p: string): string {
  if (!p) return '/'
  if (p[0] !== '/') return '/' + p
  return p
}

/**
 * Join the scope's absolute prefix with a relative path. The result is what
 * goes onto the underlying `Router` (so it's the absolute path inside the
 * trie at compose time).
 */
function joinScopePath(prefix: string, path: string): string {
  const np = normalizePath(path)
  if (prefix === '') return np
  if (np === '/') return prefix
  return prefix + np
}

/**
 * Process-wide flag — true once we've emitted the "decorators are global"
 * warning. Gated on `NODE_ENV !== 'production'` so production deploys aren't
 * spammed. We accept the once-per-process granularity (rather than once per
 * scope) because the message is the same regardless of which scope tripped it.
 */
let _decoratorWarningEmitted = false

function maybeEmitDecoratorWarning(name: string): void {
  if (_decoratorWarningEmitted) return
  if (typeof process === 'undefined') return
  if (process.env?.NODE_ENV === 'production') return
  _decoratorWarningEmitted = true
  try {
    process.emitWarning(
      `ingenium: scope.decorate('${name}', ...) is GLOBAL — decorators apply to every request regardless of scope prefix. ` +
        `Make the decorator's resolver path-aware (read ctx.path) if you want scoped behavior. ` +
        `This warning fires once per process.`,
      { type: 'IngeniumScopedDecoratorWarning' },
    )
  } catch {
    // process.emitWarning may throw in unusual runtimes (workers); swallow.
  }
}

/** @internal Test-only — reset the one-shot decorator warning latch. */
export function _resetDecoratorWarningLatch(): void {
  _decoratorWarningEmitted = false
}

/**
 * A `ScopedApp` is the registration target passed to the `app.scope(prefix, registrar)`
 * callback. It exposes the registration surface a plugin needs (`use`, verbs,
 * `register`, `decorate`, `before`/`after`, nested `scope`) but NOT the
 * dispatch surface (`compose`, `handle`, `listen`) — those still belong to
 * the root app.
 *
 * Instances are cheap: a couple of fields and method-call forwarding. Do not
 * cache them across recompose boundaries — they hold a reference to the
 * `IngeniumApp` and rely on its mutable router journal.
 */
export class ScopedApp implements PluginTarget {
  /** @internal The root app this scope translates registrations onto. */
  private readonly _app: ScopeHost
  /** @internal Absolute prefix (already includes any outer scope's prefix). */
  private readonly _prefix: string

  /** @internal Construct via `app.scope(...)`; not meant to be `new`'d directly. */
  constructor(app: ScopeHost, prefix: string) {
    this._app = app
    this._prefix = normalizePrefix(prefix)
  }

  /** Absolute prefix this scope rewrites against (for debugging / introspection). */
  get prefix(): string {
    return this._prefix
  }

  /** Lifecycle hooks. SHARED with the root app — hooks are global by design. */
  get hooks(): Hooks {
    return this._app.hooks
  }

  // ───── Middleware ──────────────────────────────────────────────────────

  use(mw: IngeniumMiddleware): this
  use(subPrefix: string, mw: IngeniumMiddleware | Router): this
  use(arg1: string | IngeniumMiddleware, arg2?: IngeniumMiddleware | Router): this {
    if (typeof arg1 === 'string') {
      // Subprefix is relative to this scope's prefix.
      const joined = this._prefix + normalizePrefix(arg1)
      // If both prefix and subPrefix were empty, fall through to global.
      if (joined === '') {
        this._app.use(arg2 as IngeniumMiddleware)
      } else {
        this._app.use(joined, arg2 as IngeniumMiddleware | Router)
      }
    } else {
      // No prefix arg — scope.use(mw) means "scoped to this scope's prefix".
      if (this._prefix === '') {
        this._app.use(arg1)
      } else {
        this._app.use(this._prefix, arg1)
      }
    }
    this._app._markDirty()
    return this
  }

  // ───── Verbs ───────────────────────────────────────────────────────────

  get(path: string, handler: IngeniumHandler): this
  get(path: string, ...args: [...IngeniumMiddleware[], IngeniumHandler]): this
  get(path: string, ...args: unknown[]): this {
    return this.method('GET', path, ...(args as [...IngeniumMiddleware[], IngeniumHandler]))
  }

  post(path: string, handler: IngeniumHandler): this
  post(path: string, ...args: [...IngeniumMiddleware[], IngeniumHandler]): this
  post(path: string, ...args: unknown[]): this {
    return this.method('POST', path, ...(args as [...IngeniumMiddleware[], IngeniumHandler]))
  }

  put(path: string, handler: IngeniumHandler): this
  put(path: string, ...args: [...IngeniumMiddleware[], IngeniumHandler]): this
  put(path: string, ...args: unknown[]): this {
    return this.method('PUT', path, ...(args as [...IngeniumMiddleware[], IngeniumHandler]))
  }

  patch(path: string, handler: IngeniumHandler): this
  patch(path: string, ...args: [...IngeniumMiddleware[], IngeniumHandler]): this
  patch(path: string, ...args: unknown[]): this {
    return this.method('PATCH', path, ...(args as [...IngeniumMiddleware[], IngeniumHandler]))
  }

  delete(path: string, handler: IngeniumHandler): this
  delete(path: string, ...args: [...IngeniumMiddleware[], IngeniumHandler]): this
  delete(path: string, ...args: unknown[]): this {
    return this.method('DELETE', path, ...(args as [...IngeniumMiddleware[], IngeniumHandler]))
  }

  head(path: string, handler: IngeniumHandler): this
  head(path: string, ...args: [...IngeniumMiddleware[], IngeniumHandler]): this
  head(path: string, ...args: unknown[]): this {
    return this.method('HEAD', path, ...(args as [...IngeniumMiddleware[], IngeniumHandler]))
  }

  options(path: string, handler: IngeniumHandler): this
  options(path: string, ...args: [...IngeniumMiddleware[], IngeniumHandler]): this
  options(path: string, ...args: unknown[]): this {
    return this.method('OPTIONS', path, ...(args as [...IngeniumMiddleware[], IngeniumHandler]))
  }

  method(method: HttpMethod, path: string, handler: IngeniumHandler): this
  method(
    method: HttpMethod,
    path: string,
    ...args: [...IngeniumMiddleware[], IngeniumHandler]
  ): this
  method(method: HttpMethod, path: string, ...args: unknown[]): this {
    const absolute = joinScopePath(this._prefix, path)
    // Delegate to the underlying app — which already validates handler-is-
    // function and middleware-is-function (via Router), and sets dirty.
    ;(this._app.method as (m: HttpMethod, p: string, ...a: unknown[]) => IngeniumApp)(
      method,
      absolute,
      ...args,
    )
    return this
  }

  /**
   * Chainable per-path builder. The builder closes over `this.method`, which
   * already does the scope-prefix join — so the same builder works identically
   * on the root app and inside a scope. Typed params via `ExtractParams<P>`
   * narrow against the RELATIVE path the user wrote, matching what the bare
   * verb form does.
   */
  route<P extends string>(path: P): RouteBuilder<P> {
    return new RouteBuilder<P>((method, args) =>
      (this.method as (m: HttpMethod, p: string, ...a: unknown[]) => unknown)(method, path, ...args),
    )
  }

  // ───── Decorators (GLOBAL — see file header) ───────────────────────────

  /**
   * Register a lazy decorator. **WARNING:** decorators are GLOBAL even when
   * registered inside a scope — they apply to every request regardless of
   * the scope's prefix. The first call from inside any scope in a process
   * emits a `process.emitWarning` (non-production only). See file header.
   */
  decorate<T>(name: string, factory: LazyDecorator<T>): this {
    maybeEmitDecoratorWarning(name)
    this._app.decorate(name, factory)
    // Decorators don't affect routing, but they DO affect the per-request
    // dispatch flags (`_hasDecorators`), which are cached at compose time.
    // Mark dirty so a recompose picks up the new decorator if registration
    // happens after the first request.
    this._app._markDirty()
    return this
  }

  /**
   * Register an eager decorator. **WARNING:** see {@link ScopedApp.decorate}.
   */
  decorateRequest<T>(name: string, factory: EagerDecorator<T>): this {
    maybeEmitDecoratorWarning(name)
    this._app.decorateRequest(name, factory)
    this._app._markDirty()
    return this
  }

  // ───── Plugin registration ─────────────────────────────────────────────

  /**
   * Register a plugin against THIS scope. The plugin receives the `ScopedApp`
   * as its `target`, so any `target.use(...)` inside the plugin body is
   * automatically prefix-scoped.
   */
  register<O>(plugin: IngeniumPlugin<O>, opts: O): Promise<this>
  register(plugin: IngeniumPlugin<void>): Promise<this>
  async register<O>(plugin: IngeniumPlugin<O>, opts?: O): Promise<this> {
    await plugin(this, opts as O)
    this._app._markDirty()
    return this
  }

  // ───── Nested scope ────────────────────────────────────────────────────

  /**
   * Open a nested scope. `subPrefix` is relative to this scope's prefix.
   * The registrar may be async; the call returns a Promise that resolves
   * once the registrar finishes if it returned one, otherwise resolves
   * synchronously to `this`. We type-erase to `this` to match the
   * `PluginTarget` interface, which can't express the sync-or-async return
   * without polluting every caller.
   */
  scope(
    subPrefix: string,
    registrar: (scope: PluginTarget) => void,
  ): this {
    const child = new ScopedApp(this._app, this._prefix + normalizePrefix(subPrefix))
    const ret: unknown = registrar(child)
    if (ret && typeof (ret as Promise<void>).then === 'function') {
      // Best-effort: surface async failures via the returned promise. We can't
      // wait synchronously, so we annotate the chain to mark dirty after the
      // registrar settles. Tests should `await app.scope(..., async (s) => {})`
      // by chaining via the parent app or by awaiting the registrar themselves.
      ;(ret as Promise<void>).then(() => this._app._markDirty())
    } else {
      this._app._markDirty()
    }
    return this
  }

  // ───── Sinatra filters ─────────────────────────────────────────────────

  /**
   * Register a `before` filter scoped to this scope's prefix. If a pattern
   * is given it's appended to the scope's prefix (so `scope('/api').before('/users', h)`
   * matches `/api/users` and below). If omitted, the filter applies to the
   * scope's full subtree.
   */
  before(handler: IngeniumMiddleware): this
  before(pattern: string, handler: IngeniumMiddleware): this
  before(arg1: string | IngeniumMiddleware, arg2?: IngeniumMiddleware): this {
    // We delegate to the existing Sinatra filter implementation, but with the
    // scope's prefix folded in. `registerBefore` takes `(app, pattern, fn)`
    // and uses `app.use(prefix, wrapped)` under the hood — so passing the
    // root app + a prefixed pattern yields exactly the desired scoping.
    const root = this._app as unknown as IngeniumApp
    if (typeof arg1 === 'function') {
      if (this._prefix === '') registerBefore(root, arg1)
      else registerBefore(root, this._prefix, arg1)
    } else {
      const joined = this._prefix + normalizePrefix(arg1)
      if (joined === '') registerBefore(root, arg2 as IngeniumMiddleware)
      else registerBefore(root, joined, arg2 as IngeniumMiddleware)
    }
    this._app._markDirty()
    return this
  }

  /** Register an `after` filter scoped to this scope's prefix. See {@link ScopedApp.before}. */
  after(handler: IngeniumMiddleware): this
  after(pattern: string, handler: IngeniumMiddleware): this
  after(arg1: string | IngeniumMiddleware, arg2?: IngeniumMiddleware): this {
    const root = this._app as unknown as IngeniumApp
    if (typeof arg1 === 'function') {
      if (this._prefix === '') registerAfter(root, arg1)
      else registerAfter(root, this._prefix, arg1)
    } else {
      const joined = this._prefix + normalizePrefix(arg1)
      if (joined === '') registerAfter(root, arg2 as IngeniumMiddleware)
      else registerAfter(root, joined, arg2 as IngeniumMiddleware)
    }
    this._app._markDirty()
    return this
  }
}
