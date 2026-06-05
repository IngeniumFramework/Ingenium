/**
 * Tests for `app.scope(prefix, registrar)` — plugin scoping / sub-app affinity.
 *
 * Behavior under test:
 *  - Routes registered through the scope are prefix-qualified.
 *  - Middleware registered through the scope only runs for paths under the
 *    scope's prefix (compose-time scoping via the existing `use-prefix`
 *    machinery — no per-request changes).
 *  - Nested scopes compose correctly.
 *  - Plugins registered inside a scope receive a `PluginTarget` whose
 *    `use(...)` / `get(...)` are scoped to the scope's prefix.
 *  - The same plugin registered on root vs in a scope behaves correctly
 *    (global vs scoped).
 *  - Routes registered OUTSIDE the scope don't receive the scope's middleware.
 *  - `scope.decorate(...)` emits a one-shot warning in non-production
 *    environments. Decorators themselves remain GLOBAL (V1 limitation —
 *    see `ScopedApp` JSDoc for the reason: decorators install on the pooled
 *    `IngeniumContext` at request start, BEFORE the route is matched, so a
 *    per-scope decorator registry would force a runtime path check on every
 *    property access).
 *  - `scope.before` / `scope.after` fire only for paths under the scope's prefix.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ingenium } from '../src/index.ts'
import { IngeniumContext } from '../src/context/context.ts'
import { _resetDecoratorWarningLatch } from '../src/app/scope.ts'
import type { IngeniumPlugin } from '../src/plugin/types.ts'

/** Helper: build a context primed for `app.handle()`. */
function makeCtx(method = 'GET', path = '/'): IngeniumContext {
  const ctx = new IngeniumContext()
  ctx.method = method as IngeniumContext['method']
  ctx.path = path
  ctx.url = path
  return ctx
}

afterEach(() => {
  _resetDecoratorWarningLatch()
})

describe('app.scope() — basic registration', () => {
  it('routes registered through a scope are prefix-qualified', async () => {
    const app = ingenium()
    app.scope('/api', (s) => {
      s.get('/users', (ctx) => ctx.json({ ok: 'users' }))
      s.post('/items', (ctx) => ctx.json({ ok: 'items' }))
    })

    const r1 = makeCtx('GET', '/api/users')
    await app.handle(r1)
    expect(r1._statusCode).toBe(200)
    expect(r1._body).toEqual({ kind: 'string', data: JSON.stringify({ ok: 'users' }) })

    const r2 = makeCtx('POST', '/api/items')
    await app.handle(r2)
    expect(r2._statusCode).toBe(200)

    // Same paths without the prefix should 404.
    const miss = makeCtx('GET', '/users')
    await app.handle(miss)
    expect(miss._statusCode).toBe(404)
  })

  it('scope.method() routes under the scope prefix', async () => {
    const app = ingenium()
    app.scope('/admin', (s) => {
      s.method('GET', '/dash', (ctx) => ctx.text('dash'))
    })

    const ctx = makeCtx('GET', '/admin/dash')
    await app.handle(ctx)
    expect(ctx._statusCode).toBe(200)
    expect(ctx._body).toEqual({ kind: 'string', data: 'dash' })
  })

  it('scope.use(mw) only runs for paths under the prefix', async () => {
    const app = ingenium()
    const hits: string[] = []

    app.scope('/api', (s) => {
      s.use(async (ctx, next) => {
        hits.push(`mw:${ctx.path}`)
        await next()
      })
      s.get('/x', (ctx) => ctx.text('x'))
    })

    // Route OUTSIDE the scope — middleware must not fire.
    app.get('/other', (ctx) => ctx.text('other'))

    const inside = makeCtx('GET', '/api/x')
    await app.handle(inside)
    expect(inside._statusCode).toBe(200)
    expect(hits).toEqual(['mw:/api/x'])

    const outside = makeCtx('GET', '/other')
    await app.handle(outside)
    expect(outside._statusCode).toBe(200)
    // Middleware should NOT have fired for the out-of-scope route.
    expect(hits).toEqual(['mw:/api/x'])
  })

  it('scope.use(subprefix, mw) joins the subprefix to the scope prefix', async () => {
    const app = ingenium()
    const hits: string[] = []

    app.scope('/api', (s) => {
      s.use('/v2', async (ctx, next) => {
        hits.push(`v2:${ctx.path}`)
        await next()
      })
      s.get('/v1/ping', (ctx) => ctx.text('v1'))
      s.get('/v2/ping', (ctx) => ctx.text('v2'))
    })

    const v1 = makeCtx('GET', '/api/v1/ping')
    await app.handle(v1)
    expect(hits).toEqual([])

    const v2 = makeCtx('GET', '/api/v2/ping')
    await app.handle(v2)
    expect(hits).toEqual(['v2:/api/v2/ping'])
  })

  it('returns the app for chaining', () => {
    const app = ingenium()
    const r = app.scope('/x', () => {})
    expect(r).toBe(app)
  })

  it('chained app.scope().scope() works on the root app', () => {
    const app = ingenium()
    app
      .scope('/a', (s) => s.get('/x', (ctx) => ctx.text('a')))
      .scope('/b', (s) => s.get('/x', (ctx) => ctx.text('b')))

    return Promise.all([
      app.handle(makeCtx('GET', '/a/x')),
      app.handle(makeCtx('GET', '/b/x')),
    ])
  })
})

describe('app.scope() — nested scopes', () => {
  it('nested scopes concatenate prefixes', async () => {
    const app = ingenium()
    app.scope('/api', (s) => {
      s.scope('/v2', (s2) => {
        s2.get('/users', (ctx) => ctx.json({ ok: true }))
      })
    })

    const ctx = makeCtx('GET', '/api/v2/users')
    await app.handle(ctx)
    expect(ctx._statusCode).toBe(200)
    expect(ctx._body).toEqual({ kind: 'string', data: JSON.stringify({ ok: true }) })
  })

  it('middleware in an outer scope still runs for routes in a nested scope', async () => {
    const app = ingenium()
    const hits: string[] = []
    app.scope('/api', (s) => {
      s.use(async (ctx, next) => {
        hits.push(`outer:${ctx.path}`)
        await next()
      })
      s.scope('/v2', (s2) => {
        s2.get('/x', (ctx) => ctx.text('x'))
      })
    })

    const ctx = makeCtx('GET', '/api/v2/x')
    await app.handle(ctx)
    expect(hits).toEqual(['outer:/api/v2/x'])
  })

  it('middleware in a nested scope does NOT run for routes outside the nested scope', async () => {
    const app = ingenium()
    const hits: string[] = []
    app.scope('/api', (s) => {
      s.scope('/v2', (s2) => {
        s2.use(async (ctx, next) => {
          hits.push(`inner:${ctx.path}`)
          await next()
        })
      })
      s.get('/v1/x', (ctx) => ctx.text('v1'))
      s.get('/v2/x', (ctx) => ctx.text('v2'))
    })

    await app.handle(makeCtx('GET', '/api/v1/x'))
    expect(hits).toEqual([])
    await app.handle(makeCtx('GET', '/api/v2/x'))
    expect(hits).toEqual(['inner:/api/v2/x'])
  })

  it('triply nested scope works', async () => {
    const app = ingenium()
    app.scope('/a', (s1) => {
      s1.scope('/b', (s2) => {
        s2.scope('/c', (s3) => {
          s3.get('/d', (ctx) => ctx.text('deep'))
        })
      })
    })

    const ctx = makeCtx('GET', '/a/b/c/d')
    await app.handle(ctx)
    expect(ctx._statusCode).toBe(200)
    expect(ctx._body).toEqual({ kind: 'string', data: 'deep' })
  })
})

describe('app.scope() — plugin registration inside a scope', () => {
  it('plugin registered in a scope: its target.use(mw) only applies under the scope prefix', async () => {
    const app = ingenium()
    const hits: string[] = []

    const tracerPlugin: IngeniumPlugin = (target) => {
      target.use(async (ctx, next) => {
        hits.push(`plugin:${ctx.path}`)
        await next()
      })
    }

    await new Promise<void>((resolve) => {
      app.scope('/api', async (s) => {
        await s.register(tracerPlugin)
        s.get('/x', (ctx) => ctx.text('x'))
        resolve()
      })
    })

    app.get('/other', (ctx) => ctx.text('other'))

    await app.handle(makeCtx('GET', '/api/x'))
    expect(hits).toEqual(['plugin:/api/x'])

    await app.handle(makeCtx('GET', '/other'))
    // Plugin middleware did NOT fire for the out-of-scope route.
    expect(hits).toEqual(['plugin:/api/x'])
  })

  it('plugin registered in a scope: its target.get(path, h) is prefix-relative', async () => {
    const app = ingenium()

    const routesPlugin: IngeniumPlugin = (target) => {
      target.get('/hello', (ctx) => ctx.text('hello'))
      target.post('/bye', (ctx) => ctx.text('bye'))
    }

    await new Promise<void>((resolve) => {
      app.scope('/api/v2', async (s) => {
        await s.register(routesPlugin)
        resolve()
      })
    })

    const r1 = makeCtx('GET', '/api/v2/hello')
    await app.handle(r1)
    expect(r1._statusCode).toBe(200)
    expect(r1._body).toEqual({ kind: 'string', data: 'hello' })

    const r2 = makeCtx('POST', '/api/v2/bye')
    await app.handle(r2)
    expect(r2._statusCode).toBe(200)

    // Same paths without the prefix are 404.
    const miss = makeCtx('GET', '/hello')
    await app.handle(miss)
    expect(miss._statusCode).toBe(404)
  })

  it('same plugin: registered on root applies globally; in a scope only applies under prefix', async () => {
    // V1 deliberate-design note: this test demonstrates the killer feature —
    // a single plugin behaves differently based on the registration target.
    // It's also the test that would have failed before scope() existed.
    const counters = { global: 0, scoped: 0 }

    const auth: IngeniumPlugin<{ key: 'global' | 'scoped' }> = (target, opts) => {
      target.use(async (_ctx, next) => {
        counters[opts.key]++
        await next()
      })
    }

    // App 1 — registered on root. Should fire for every request.
    const appGlobal = ingenium()
    await appGlobal.register(auth, { key: 'global' })
    appGlobal.get('/foo', (ctx) => ctx.text('foo'))
    appGlobal.get('/bar', (ctx) => ctx.text('bar'))

    await appGlobal.handle(makeCtx('GET', '/foo'))
    await appGlobal.handle(makeCtx('GET', '/bar'))
    expect(counters.global).toBe(2)

    // App 2 — registered inside a scope. Should fire ONLY for /api/*.
    const appScoped = ingenium()
    await new Promise<void>((resolve) => {
      appScoped.scope('/api', async (s) => {
        await s.register(auth, { key: 'scoped' })
        s.get('/foo', (ctx) => ctx.text('foo'))
        resolve()
      })
    })
    appScoped.get('/bar', (ctx) => ctx.text('bar'))

    await appScoped.handle(makeCtx('GET', '/api/foo'))
    await appScoped.handle(makeCtx('GET', '/bar'))
    expect(counters.scoped).toBe(1)
  })

  it('plugin registered inside a scope can register a nested sub-scope', async () => {
    const app = ingenium()
    const hits: string[] = []

    const nestedPlugin: IngeniumPlugin = (target) => {
      target.scope('/sub', (s) => {
        s.use(async (ctx, next) => {
          hits.push(`sub:${ctx.path}`)
          await next()
        })
        s.get('/x', (ctx) => ctx.text('sub-x'))
      })
    }

    await new Promise<void>((resolve) => {
      app.scope('/api', async (s) => {
        await s.register(nestedPlugin)
        resolve()
      })
    })

    const ctx = makeCtx('GET', '/api/sub/x')
    await app.handle(ctx)
    expect(ctx._statusCode).toBe(200)
    expect(hits).toEqual(['sub:/api/sub/x'])
  })
})

describe('app.scope() — out-of-scope isolation', () => {
  it('global middleware on root still runs for routes inside a scope', async () => {
    const app = ingenium()
    const hits: string[] = []

    app.use(async (ctx, next) => {
      hits.push(`global:${ctx.path}`)
      await next()
    })
    app.scope('/api', (s) => {
      s.get('/x', (ctx) => ctx.text('x'))
    })

    await app.handle(makeCtx('GET', '/api/x'))
    expect(hits).toEqual(['global:/api/x'])
  })

  it('boundary check: /api scope does not match /apiary', async () => {
    const app = ingenium()
    const hits: string[] = []

    app.scope('/api', (s) => {
      s.use(async (ctx, next) => {
        hits.push(`api:${ctx.path}`)
        await next()
      })
    })

    // Register a sibling route under a path that prefix-string-matches but
    // is NOT inside the scope. The compose-time check uses `pathStartsWith`
    // which enforces a `/` boundary, so `/apiary` must NOT trip the scope's
    // middleware.
    app.get('/apiary', (ctx) => ctx.text('bees'))

    await app.handle(makeCtx('GET', '/apiary'))
    expect(hits).toEqual([])
  })
})

describe('app.scope() — decorate emits warning', () => {
  it('scope.decorate(...) emits process.emitWarning (non-production)', () => {
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    try {
      const spy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
      const app = ingenium()
      app.scope('/api', (s) => {
        s.decorate('user', () => ({ id: 1 }))
      })
      expect(spy).toHaveBeenCalledTimes(1)
      const args = spy.mock.calls[0]!
      expect(String(args[0])).toMatch(/scope\.decorate.*GLOBAL/)
      spy.mockRestore()
    } finally {
      process.env.NODE_ENV = prev
    }
  })

  it('scope.decorate(...) warning fires only once per process', () => {
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    try {
      const spy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
      const app = ingenium()
      app.scope('/a', (s) => {
        s.decorate('one', () => 1)
        s.decorate('two', () => 2)
      })
      app.scope('/b', (s) => {
        s.decorate('three', () => 3)
      })
      expect(spy).toHaveBeenCalledTimes(1)
      spy.mockRestore()
    } finally {
      process.env.NODE_ENV = prev
    }
  })

  it('scope.decorate(...) does NOT emit warning when NODE_ENV=production', () => {
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const spy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
      const app = ingenium()
      app.scope('/api', (s) => {
        s.decorate('user', () => ({ id: 1 }))
      })
      expect(spy).not.toHaveBeenCalled()
      spy.mockRestore()
    } finally {
      process.env.NODE_ENV = prev
    }
  })

  it('scope.decorate(...) STILL registers globally (decorator works for out-of-scope routes too)', async () => {
    // The warning is exactly because of this behavior — decorate is global.
    // The test asserts the documented V1 limitation so a future refactor that
    // changes the semantics will explicitly break this test and force a docs
    // update.
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = 'production' // suppress warning noise
    try {
      const app = ingenium()
      app.scope('/api', (s) => {
        s.decorate('marker', () => 'decorated')
      })
      app.get('/outside', (ctx) => {
        ctx.json({ m: (ctx as unknown as { marker: string }).marker })
      })

      const ctx = makeCtx('GET', '/outside')
      await app.handle(ctx)
      expect(ctx._body).toEqual({
        kind: 'string',
        data: JSON.stringify({ m: 'decorated' }),
      })
    } finally {
      process.env.NODE_ENV = prev
    }
  })
})

describe('app.scope() — sinatra filters', () => {
  it('scope.before(handler) only fires for paths under the scope prefix', async () => {
    const app = ingenium()
    const hits: string[] = []

    app.scope('/api', (s) => {
      s.before((ctx) => {
        hits.push(`before:${ctx.path}`)
      })
      s.get('/x', (ctx) => ctx.text('x'))
    })
    app.get('/other', (ctx) => ctx.text('other'))

    await app.handle(makeCtx('GET', '/api/x'))
    expect(hits).toEqual(['before:/api/x'])

    await app.handle(makeCtx('GET', '/other'))
    expect(hits).toEqual(['before:/api/x'])
  })

  it('scope.after(handler) fires after the handler for paths under the scope prefix', async () => {
    const app = ingenium()
    const order: string[] = []

    app.scope('/api', (s) => {
      s.after((ctx) => {
        order.push(`after:${ctx.path}`)
      })
      s.get('/x', (ctx) => {
        order.push('handler')
        ctx.text('x')
      })
    })

    await app.handle(makeCtx('GET', '/api/x'))
    expect(order).toEqual(['handler', 'after:/api/x'])
  })

  it('scope.before(pattern, handler) joins the pattern to the scope prefix', async () => {
    const app = ingenium()
    const hits: string[] = []

    app.scope('/api', (s) => {
      s.before('/admin', (ctx) => {
        hits.push(`admin-before:${ctx.path}`)
      })
      s.get('/users', (ctx) => ctx.text('users'))
      s.get('/admin/dashboard', (ctx) => ctx.text('dash'))
    })

    await app.handle(makeCtx('GET', '/api/users'))
    expect(hits).toEqual([])

    await app.handle(makeCtx('GET', '/api/admin/dashboard'))
    expect(hits).toEqual(['admin-before:/api/admin/dashboard'])
  })
})

describe('app.scope() — dirty bit', () => {
  it('scope() registration triggers recompose on next handle', async () => {
    const app = ingenium()
    app.get('/before', (ctx) => ctx.text('before'))

    // First request composes.
    await app.handle(makeCtx('GET', '/before'))

    // Register a new scoped route AFTER first compose. Must recompose on next request.
    app.scope('/api', (s) => {
      s.get('/late', (ctx) => ctx.text('late'))
    })

    const ctx = makeCtx('GET', '/api/late')
    await app.handle(ctx)
    expect(ctx._statusCode).toBe(200)
    expect(ctx._body).toEqual({ kind: 'string', data: 'late' })
  })

  it('plugin registered inside a scope after first compose still recomposes', async () => {
    const app = ingenium()
    app.get('/before', (ctx) => ctx.text('before'))
    await app.handle(makeCtx('GET', '/before'))

    const plugin: IngeniumPlugin = (target) => {
      target.get('/added', (ctx) => ctx.text('added'))
    }

    await new Promise<void>((resolve) => {
      app.scope('/api', async (s) => {
        await s.register(plugin)
        resolve()
      })
    })

    const ctx = makeCtx('GET', '/api/added')
    await app.handle(ctx)
    expect(ctx._statusCode).toBe(200)
  })
})
