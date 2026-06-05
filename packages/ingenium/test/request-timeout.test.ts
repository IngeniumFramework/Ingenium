import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { IngeniumApp } from '../src/app.ts'
import { IngeniumContext } from '../src/context/context.ts'
import { IngeniumTimeoutError } from '../src/errors.ts'
import type { ListeningServer } from '../src/transport/types.ts'

/**
 * `requestTimeoutMs` enforces a wall-clock ceiling on a single request's
 * dispatch. When exceeded, the framework rejects with `IngeniumTimeoutError`,
 * the default boundary writes a 503, and the orphaned handler — which
 * cannot be cancelled in JS — is detected via an AsyncLocalStorage-bound
 * epoch guard so its late writes never corrupt the next request bound to
 * the same pooled context.
 */

function url(server: ListeningServer, path: string): string {
  return `http://127.0.0.1:${server.port}${path}`
}

/** Tiny dispatch helper — populates the request side and runs `app.handle`. */
async function dispatch(
  app: IngeniumApp,
  method: string,
  path: string,
): Promise<IngeniumContext> {
  const ctx = new IngeniumContext()
  ctx.method = method as IngeniumContext['method']
  ctx.url = path
  ctx.path = path.split('?')[0] ?? '/'
  ctx.rawQuery = path.includes('?') ? (path.split('?')[1] ?? '') : ''
  await app.handle(ctx)
  return ctx
}

// ───────────────────────────────────────────────────────────────────────────
// Happy path
// ───────────────────────────────────────────────────────────────────────────

describe('requestTimeoutMs: handler resolves before timeout', () => {
  it('returns 200 with the handler body', async () => {
    const app = new IngeniumApp({ requestTimeoutMs: 200 })
    app.get('/', (ctx) => ctx.json({ ok: true }))
    const ctx = await dispatch(app, 'GET', '/')
    expect(ctx._statusCode).toBe(200)
    expect(ctx._body).toMatchObject({ kind: 'string', data: JSON.stringify({ ok: true }) })
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Timeout fires → 503
// ───────────────────────────────────────────────────────────────────────────

describe('requestTimeoutMs: handler hangs forever', () => {
  it('produces 503 REQUEST_TIMEOUT within ~100ms of the configured deadline', async () => {
    const app = new IngeniumApp({ requestTimeoutMs: 50 })
    app.get('/slow', () => new Promise<void>(() => {})) // never resolves
    const start = Date.now()
    const ctx = await dispatch(app, 'GET', '/slow')
    const elapsed = Date.now() - start
    expect(ctx._statusCode).toBe(503)
    expect(elapsed).toBeLessThan(150)
    const body = ctx._body as { kind: 'string'; data: string }
    const payload = JSON.parse(body.data) as { error: string; code: string }
    expect(payload.code).toBe('REQUEST_TIMEOUT')
    expect(payload.error).toMatch(/50ms/)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Default boundary serialization
// ───────────────────────────────────────────────────────────────────────────

describe('requestTimeoutMs: default error boundary serializes IngeniumTimeoutError', () => {
  it('writes { error, code: REQUEST_TIMEOUT } as JSON', async () => {
    const app = new IngeniumApp({ requestTimeoutMs: 25 })
    app.get('/x', () => new Promise<void>(() => {}))
    const ctx = await dispatch(app, 'GET', '/x')
    expect(ctx._statusCode).toBe(503)
    expect(ctx.getHeader('content-type')).toMatch(/application\/json/)
    const body = ctx._body as { kind: 'string'; data: string }
    const payload = JSON.parse(body.data) as Record<string, unknown>
    expect(payload).toMatchObject({ code: 'REQUEST_TIMEOUT' })
    expect(typeof payload.error).toBe('string')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Custom onError can override the timeout response
// ───────────────────────────────────────────────────────────────────────────

describe('requestTimeoutMs: onError can intercept the timeout', () => {
  it('user handler can rewrite the status / body', async () => {
    const app = new IngeniumApp({ requestTimeoutMs: 25 })
    app.get('/x', () => new Promise<void>(() => {}))
    app.onError((err, ctx) => {
      if (err instanceof IngeniumTimeoutError) {
        ctx.json({ degraded: true, retryAfter: 1 }, 504)
        return
      }
      throw err
    })
    const ctx = await dispatch(app, 'GET', '/x')
    expect(ctx._statusCode).toBe(504)
    const body = ctx._body as { kind: 'string'; data: string }
    expect(JSON.parse(body.data)).toEqual({ degraded: true, retryAfter: 1 })
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Late-write protection — load-bearing
// ───────────────────────────────────────────────────────────────────────────

describe('requestTimeoutMs: late writes from orphaned handler do NOT corrupt next request', () => {
  it('a timed-out context is poisoned and NOT reused; orphan header/body writes hit the discarded ctx only', async () => {
    // The robust guarantee: a context whose dispatch timed out is dropped by
    // the pool instead of being recycled, so the orphan can write whatever it
    // likes (including UN-guarded ctx.set/ctx.status) and it can never land on
    // a subsequent request — that request runs on a DIFFERENT context.
    const app = new IngeniumApp({ poolSize: 1, requestTimeoutMs: 25 })

    let orphanRelease: ((value: unknown) => void) | null = null
    const orphanPromise = new Promise<unknown>((resolve) => {
      orphanRelease = resolve
    })

    app.get('/slow', async (ctx) => {
      await orphanPromise
      // Header write is NOT epoch-guarded — pre-fix this could bleed onto the
      // next request. It must now hit the discarded ctx only.
      ctx.set('x-orphan-leak', 'from-orphan')
      // Body write IS epoch-guarded — must be swallowed (and warn).
      ctx.json({ orphan: 'leaked' }, 599)
    })
    app.get('/fast', (ctx) => ctx.json({ second: true }, 201))

    const warnings: string[] = []
    const warnHandler = (warn: Error & { name?: string }): void => {
      if (warn.name === 'IngeniumLateWriteWarning') warnings.push(warn.message)
    }
    process.on('warning', warnHandler)

    const pool = (app as unknown as { pool: { acquire(): IngeniumContext; release(c: IngeniumContext): void } }).pool

    try {
      const ctx1 = pool.acquire()
      ctx1.method = 'GET'
      ctx1.url = '/slow'
      ctx1.path = '/slow'
      ctx1.rawQuery = ''
      await app.handle(ctx1)
      expect(ctx1._statusCode).toBe(503)
      expect(ctx1._timedOut).toBe(true)
      pool.release(ctx1)

      const ctx2 = pool.acquire()
      // Poisoned context must NOT be recycled — a fresh instance is allocated.
      expect(ctx2).not.toBe(ctx1)
      ctx2.method = 'GET'
      ctx2.url = '/fast'
      ctx2.path = '/fast'
      ctx2.rawQuery = ''
      await app.handle(ctx2)
      expect(ctx2._statusCode).toBe(201)
      expect(JSON.parse((ctx2._body as { kind: 'string'; data: string }).data)).toEqual({ second: true })

      // Release the orphan; let its continuation run.
      if (orphanRelease) (orphanRelease as (v: unknown) => void)(undefined)
      await new Promise((r) => setTimeout(r, 10))

      // The next request's context is untouched by the orphan — header AND body.
      expect(ctx2._statusCode).toBe(201)
      expect(JSON.parse((ctx2._body as { kind: 'string'; data: string }).data)).toEqual({ second: true })
      expect(ctx2.getHeader('x-orphan-leak')).toBeUndefined()

      // The guarded body write still gets swallowed with a warning.
      expect(warnings.length).toBeGreaterThanOrEqual(1)
      expect(warnings[0]).toMatch(/Late response write after timeout/)
    } finally {
      process.off('warning', warnHandler)
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Default behavior (no timeout configured) — hangs forever
// ───────────────────────────────────────────────────────────────────────────

describe('requestTimeoutMs: undefined disables the race', () => {
  it('hangs as before — no auto-503 (regression sentinel)', async () => {
    const app = new IngeniumApp() // no requestTimeoutMs
    app.get('/x', () => new Promise<void>(() => {}))
    const ctx = new IngeniumContext()
    ctx.method = 'GET'
    ctx.url = '/x'
    ctx.path = '/x'
    // Race app.handle against a short timer — if the framework added a
    // surprise default timeout, app.handle would resolve and we'd see a
    // status code; if the race is correctly disabled, the timer wins.
    const result = await Promise.race([
      app.handle(ctx).then(() => 'handle-resolved' as const),
      new Promise<'timer'>((r) => setTimeout(() => r('timer'), 75)),
    ])
    expect(result).toBe('timer')
    expect(ctx._statusCode).toBe(200) // never written
    expect(ctx._written).toBe(false)
  }, 1000)
})

// ───────────────────────────────────────────────────────────────────────────
// Timer must `unref` so a fast handler doesn't keep the loop alive
// ───────────────────────────────────────────────────────────────────────────

describe('requestTimeoutMs: timer is unref()\'d', () => {
  it('the timeout setTimeout call returns a handle that gets .unref() invoked', async () => {
    // Spy on setTimeout. raceWithTimeout calls it ONCE per dispatch, and
    // immediately invokes .unref() on the returned timer handle — so a
    // fast-resolving handler with a long configured timeout doesn't keep
    // the event loop alive.
    const realSetTimeout = globalThis.setTimeout
    const unrefSpy = vi.fn()
    let timeoutHandleCount = 0
    globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
      const h = realSetTimeout(fn, ms, ...(rest as [])) as ReturnType<typeof setTimeout>
      // Wrap .unref to observe; only the FIRST setTimeout per app.handle
      // call is the one inside raceWithTimeout (the dispatched handler is
      // synchronous). Filter by the configured ms to be safe.
      if (ms === 5_000) {
        timeoutHandleCount++
        const origUnref = h.unref.bind(h)
        h.unref = (() => {
          unrefSpy()
          return origUnref()
        }) as typeof h.unref
      }
      return h
    }) as typeof setTimeout
    try {
      const app = new IngeniumApp({ requestTimeoutMs: 5_000 })
      app.get('/', (ctx) => ctx.json({ ok: true }))
      const ctx = new IngeniumContext()
      ctx.method = 'GET'
      ctx.url = '/'
      ctx.path = '/'
      await app.handle(ctx)
      expect(ctx._statusCode).toBe(200)
      expect(timeoutHandleCount).toBe(1)
      expect(unrefSpy).toHaveBeenCalledTimes(1)
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────
// e2e — verify the whole pipe over a real socket
// ───────────────────────────────────────────────────────────────────────────

describe('requestTimeoutMs: e2e over node:http', () => {
  let server: ListeningServer
  beforeAll(async () => {
    const app = new IngeniumApp({ requestTimeoutMs: 50 })
    app.get('/fast', (ctx) => ctx.json({ ok: true }))
    app.get('/slow', () => new Promise<void>(() => {}))
    server = await app.listen(0, '127.0.0.1')
  })
  afterAll(() => server.close())

  it('fast handler returns 200', async () => {
    const res = await fetch(url(server, '/fast'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('slow handler returns 503 with REQUEST_TIMEOUT code', async () => {
    const res = await fetch(url(server, '/slow'))
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string; code: string }
    expect(body.code).toBe('REQUEST_TIMEOUT')
  })
})
