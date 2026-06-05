import { describe, it, expect, vi } from 'vitest'
import { IngeniumContext } from '../src/context/context.ts'
import { idempotencyMiddleware, buildIdempotencyCacheKey } from '../src/idempotency/middleware.ts'
import { IdempotencyMemoryStore } from '../src/idempotency/store.ts'
import type { HttpMethod } from '../src/router/types.ts'

function makeCtx(
  method: HttpMethod,
  path: string,
  headers: Record<string, string> = {},
): IngeniumContext {
  const ctx = new IngeniumContext()
  ctx.method = method
  ctx.path = path
  ctx.url = path
  ctx.headers = headers
  return ctx
}

function readJson(ctx: IngeniumContext): unknown {
  const b = ctx._body
  if (b.kind !== 'string') throw new Error(`expected string body, got ${b.kind}`)
  return JSON.parse(b.data)
}

describe('idempotency — method gating', () => {
  it('GET passes through without consulting the store', async () => {
    const store = new IdempotencyMemoryStore()
    const getSpy = vi.spyOn(store, 'get')
    const mw = idempotencyMiddleware({ store })

    const ctx = makeCtx('GET', '/x', { 'idempotency-key': 'abc' })
    const handler = vi.fn(async () => { ctx.json({ ok: 1 }) })
    await mw(ctx, handler)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(getSpy).not.toHaveBeenCalled()
    store.destroy()
  })

  it('POST without the header passes through', async () => {
    const store = new IdempotencyMemoryStore()
    const getSpy = vi.spyOn(store, 'get')
    const mw = idempotencyMiddleware({ store })

    const ctx = makeCtx('POST', '/x')
    const handler = vi.fn(async () => { ctx.json({ ok: 1 }) })
    await mw(ctx, handler)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(getSpy).not.toHaveBeenCalled()
    store.destroy()
  })
})

describe('idempotency — caching + replay', () => {
  it('POST with new key runs handler and caches the response', async () => {
    const store = new IdempotencyMemoryStore()
    const mw = idempotencyMiddleware({ store })

    const ctx = makeCtx('POST', '/charges', { 'idempotency-key': 'k1', authorization: 'Bearer A' })
    const handler = vi.fn(async () => { ctx.json({ id: 'ch_1' }, 201) })
    await mw(ctx, handler)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(ctx._statusCode).toBe(201)
    expect(readJson(ctx)).toEqual({ id: 'ch_1' })

    const cached = await store.get(buildIdempotencyCacheKey('Bearer A', 'POST', '/charges', 'k1'))
    expect(cached).not.toBeNull()
    expect(cached?.statusCode).toBe(201)
    store.destroy()
  })

  it('replays cached response on retry and sets Idempotent-Replayed: true', async () => {
    const store = new IdempotencyMemoryStore()
    const mw = idempotencyMiddleware({ store })

    const headers = { 'idempotency-key': 'k1', authorization: 'Bearer A' }

    const first = makeCtx('POST', '/charges', headers)
    const handler1 = vi.fn(async () => { first.json({ id: 'ch_1' }, 201) })
    await mw(first, handler1)
    expect(handler1).toHaveBeenCalledTimes(1)

    const second = makeCtx('POST', '/charges', headers)
    const handler2 = vi.fn(async () => { second.json({ id: 'WRONG' }, 500) })
    await mw(second, handler2)

    expect(handler2).not.toHaveBeenCalled()
    expect(second._statusCode).toBe(201)
    expect(readJson(second)).toEqual({ id: 'ch_1' })
    expect(second.getHeader('idempotent-replayed')).toBe('true')
    store.destroy()
  })

  it('different scope (different auth) does NOT replay', async () => {
    const store = new IdempotencyMemoryStore()
    const mw = idempotencyMiddleware({ store })

    const a = makeCtx('POST', '/charges', { 'idempotency-key': 'k1', authorization: 'Bearer A' })
    const h1 = vi.fn(async () => { a.json({ who: 'A' }, 201) })
    await mw(a, h1)

    const b = makeCtx('POST', '/charges', { 'idempotency-key': 'k1', authorization: 'Bearer B' })
    const h2 = vi.fn(async () => { b.json({ who: 'B' }, 201) })
    await mw(b, h2)

    expect(h1).toHaveBeenCalledTimes(1)
    expect(h2).toHaveBeenCalledTimes(1)
    expect(readJson(b)).toEqual({ who: 'B' })
    expect(b.getHeader('idempotent-replayed')).toBeUndefined()
    store.destroy()
  })

  it('custom scope function is used in the cache key namespace', async () => {
    const store = new IdempotencyMemoryStore()
    const setSpy = vi.spyOn(store, 'set')
    const mw = idempotencyMiddleware({ store, scope: () => 'tenant-42' })

    const ctx = makeCtx('POST', '/x', { 'idempotency-key': 'abc' })
    await mw(ctx, async () => { ctx.json({ ok: 1 }) })

    expect(setSpy).toHaveBeenCalledWith(
      buildIdempotencyCacheKey('tenant-42', 'POST', '/x', 'abc'),
      expect.any(Object),
      expect.any(Number),
    )
    store.destroy()
  })
})

describe('idempotency — concurrency', () => {
  it('concurrent requests with the same key: only one runs the handler', async () => {
    const store = new IdempotencyMemoryStore()
    const mw = idempotencyMiddleware({ store })

    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })

    const handler = vi.fn(async () => {
      await gate
    })

    const headers = { 'idempotency-key': 'race', authorization: 'Bearer A' }
    const a = makeCtx('POST', '/charges', headers)
    const b = makeCtx('POST', '/charges', headers)

    // Hand-rolled handler that writes via the captured ctx — vi.fn shares
    // the same body for both calls, so wrap with ctx-specific writers.
    const runA = mw(a, async () => { await handler(); a.json({ id: 'ch_1' }, 201) })
    const runB = mw(b, async () => { await handler(); b.json({ id: 'ch_1_dup' }, 201) })

    // Yield so both middleware invocations have a chance to register in
    // the inflight map before we release the gate.
    await new Promise<void>((r) => setImmediate(r))
    release()

    await Promise.all([runA, runB])

    expect(handler).toHaveBeenCalledTimes(1)
    expect(a._statusCode).toBe(201)
    expect(b._statusCode).toBe(201)
    expect(readJson(a)).toEqual({ id: 'ch_1' })
    // B got the replayed body from A, not its own (which never ran).
    expect(readJson(b)).toEqual({ id: 'ch_1' })
    expect(b.getHeader('idempotent-replayed')).toBe('true')
    store.destroy()
  })
})

describe('idempotency — TTL expiry', () => {
  it('after TTL elapses, the same key runs the handler again', async () => {
    vi.useFakeTimers()
    try {
      const store = new IdempotencyMemoryStore()
      const mw = idempotencyMiddleware({ store, ttlSeconds: 1 })
      const headers = { 'idempotency-key': 'k1', authorization: 'Bearer A' }

      const a = makeCtx('POST', '/charges', headers)
      const h1 = vi.fn(async () => { a.json({ run: 1 }, 201) })
      await mw(a, h1)
      expect(h1).toHaveBeenCalledTimes(1)

      // Advance well past the TTL.
      vi.advanceTimersByTime(2_000)

      const b = makeCtx('POST', '/charges', headers)
      const h2 = vi.fn(async () => { b.json({ run: 2 }, 201) })
      await mw(b, h2)

      expect(h2).toHaveBeenCalledTimes(1)
      expect(readJson(b)).toEqual({ run: 2 })
      expect(b.getHeader('idempotent-replayed')).toBeUndefined()
      store.destroy()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('idempotency — cacheable predicate (5xx skipped by default)', () => {
  it('200 response is cached → second request replays', async () => {
    const store = new IdempotencyMemoryStore()
    const mw = idempotencyMiddleware({ store })
    const headers = { 'idempotency-key': 'k200', authorization: 'Bearer A' }

    const a = makeCtx('POST', '/x', headers)
    const h1 = vi.fn(async () => { a.json({ run: 1 }, 200) })
    await mw(a, h1)

    const b = makeCtx('POST', '/x', headers)
    const h2 = vi.fn(async () => { b.json({ run: 2 }, 200) })
    await mw(b, h2)

    expect(h1).toHaveBeenCalledTimes(1)
    expect(h2).not.toHaveBeenCalled()
    expect(readJson(b)).toEqual({ run: 1 })
    expect(b.getHeader('idempotent-replayed')).toBe('true')
    store.destroy()
  })

  it('4xx response IS cached by default → validation errors are deterministic', async () => {
    const store = new IdempotencyMemoryStore()
    const mw = idempotencyMiddleware({ store })
    const headers = { 'idempotency-key': 'k4xx', authorization: 'Bearer A' }

    const a = makeCtx('POST', '/x', headers)
    const h1 = vi.fn(async () => { a.json({ error: 'bad' }, 422) })
    await mw(a, h1)

    const b = makeCtx('POST', '/x', headers)
    const h2 = vi.fn(async () => { b.json({ error: 'WRONG' }, 422) })
    await mw(b, h2)

    expect(h1).toHaveBeenCalledTimes(1)
    expect(h2).not.toHaveBeenCalled()
    expect(b._statusCode).toBe(422)
    expect(readJson(b)).toEqual({ error: 'bad' })
    expect(b.getHeader('idempotent-replayed')).toBe('true')
    store.destroy()
  })

  it('500 response is NOT cached by default → second request re-runs handler', async () => {
    const store = new IdempotencyMemoryStore()
    const mw = idempotencyMiddleware({ store })
    const headers = { 'idempotency-key': 'k500', authorization: 'Bearer A' }

    const a = makeCtx('POST', '/x', headers)
    const h1 = vi.fn(async () => { a.json({ err: 'transient' }, 500) })
    await mw(a, h1)
    expect(h1).toHaveBeenCalledTimes(1)

    // Cache should be empty for this key.
    expect(await store.get(buildIdempotencyCacheKey('Bearer A', 'POST', '/x', 'k500'))).toBeNull()

    const b = makeCtx('POST', '/x', headers)
    const h2 = vi.fn(async () => { b.json({ ok: true }, 200) })
    await mw(b, h2)

    expect(h2).toHaveBeenCalledTimes(1)
    expect(b._statusCode).toBe(200)
    expect(readJson(b)).toEqual({ ok: true })
    expect(b.getHeader('idempotent-replayed')).toBeUndefined()
    store.destroy()
  })

  it('custom cacheable: () => true → 500 IS cached', async () => {
    const store = new IdempotencyMemoryStore()
    const mw = idempotencyMiddleware({ store, cacheable: () => true })
    const headers = { 'idempotency-key': 'k500-forced', authorization: 'Bearer A' }

    const a = makeCtx('POST', '/x', headers)
    const h1 = vi.fn(async () => { a.json({ err: 'boom' }, 500) })
    await mw(a, h1)

    const b = makeCtx('POST', '/x', headers)
    const h2 = vi.fn(async () => { b.json({ never: true }, 200) })
    await mw(b, h2)

    expect(h2).not.toHaveBeenCalled()
    expect(b._statusCode).toBe(500)
    expect(readJson(b)).toEqual({ err: 'boom' })
    expect(b.getHeader('idempotent-replayed')).toBe('true')
    store.destroy()
  })

  it('custom cacheable: (s) => s === 200 → 4xx is NOT cached', async () => {
    const store = new IdempotencyMemoryStore()
    const mw = idempotencyMiddleware({ store, cacheable: (s) => s === 200 })
    const headers = { 'idempotency-key': 'k-strict', authorization: 'Bearer A' }

    const a = makeCtx('POST', '/x', headers)
    const h1 = vi.fn(async () => { a.json({ error: 'bad' }, 422) })
    await mw(a, h1)
    expect(h1).toHaveBeenCalledTimes(1)
    expect(await store.get(buildIdempotencyCacheKey('Bearer A', 'POST', '/x', 'k-strict'))).toBeNull()

    const b = makeCtx('POST', '/x', headers)
    const h2 = vi.fn(async () => { b.json({ run: 2 }, 200) })
    await mw(b, h2)

    expect(h2).toHaveBeenCalledTimes(1)
    expect(readJson(b)).toEqual({ run: 2 })
    expect(b.getHeader('idempotent-replayed')).toBeUndefined()
    store.destroy()
  })
})

describe('IdempotencyMemoryStore', () => {
  it('destroy() clears the cleanup interval and the map', async () => {
    const store = new IdempotencyMemoryStore()
    await store.set('k', { statusCode: 200, headers: {}, body: 'x' }, 60_000)
    expect(await store.get('k')).not.toBeNull()

    store.destroy()

    expect(await store.get('k')).toBeNull()
    // Calling destroy twice is safe.
    store.destroy()
  })
})
