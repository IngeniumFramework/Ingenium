import { describe, it, expect, vi } from 'vitest'
import { IngeniumContext } from '../src/context/context.ts'
import { idempotencyMiddleware } from '../src/idempotency/middleware.ts'
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

describe('security: idempotency cache-key collision-safety', () => {
  it('does NOT collide two distinct (path, key) tuples whose ":"-joined keys are identical', async () => {
    const store = new IdempotencyMemoryStore()
    const setSpy = vi.spyOn(store, 'set')
    // Same scope + method so only path/key shift the ambiguous ":" boundary.
    const mw = idempotencyMiddleware({ store, scope: () => 'tenant-1' })

    // Naive `${scope}:${method}:${path}:${key}` for BOTH requests below is:
    //   tenant-1:POST:/p:x:y
    // …yet the genuine tuples differ — only the path/key ":" boundary moved.
    // A: path="/p:x", key="y"
    const a = makeCtx('POST', '/p:x', { 'idempotency-key': 'y' })
    const handlerA = vi.fn(async () => {
      a._headers['set-cookie'] = 'session=AAA; HttpOnly'
      a.json({ id: 'order_A' }, 201)
    })
    await mw(a, handlerA)

    // B: path="/p", key="x:y"
    const b = makeCtx('POST', '/p', { 'idempotency-key': 'x:y' })
    const handlerB = vi.fn(async () => {
      b.json({ id: 'order_B' }, 201)
    })
    await mw(b, handlerB)

    // Both handlers ran — the length-prefixed hash kept the tuples distinct,
    // so B was NOT served A's cached response.
    expect(handlerA).toHaveBeenCalledTimes(1)
    expect(handlerB).toHaveBeenCalledTimes(1)
    expect(readJson(a)).toEqual({ id: 'order_A' })
    expect(readJson(b)).toEqual({ id: 'order_B' })
    // B must not inherit A's replayed marker or A's session cookie.
    expect(b._headers['idempotent-replayed']).toBeUndefined()
    expect(b._headers['set-cookie']).toBeUndefined()

    // Two distinct cache entries were persisted (not one shared slot).
    expect(setSpy).toHaveBeenCalledTimes(2)
    const keys = setSpy.mock.calls.map((c) => c[0] as string)
    expect(keys[0]).not.toBe(keys[1])
    store.destroy()
  })

  it('does NOT collide two distinct (scope, path) tuples whose ":"-joined keys are identical', async () => {
    const store = new IdempotencyMemoryStore()
    const setSpy = vi.spyOn(store, 'set')

    // Scope is request-controlled here; shift the scope/path ":" boundary.
    // Naive `${scope}:${method}:${path}:${key}` collapses both to:
    //   a:b:POST:/p:k   (method+key held constant)
    const mw = idempotencyMiddleware({
      store,
      scope: (ctx) => ctx.headers['x-scope'] as string,
    })

    // A: scope="a:b", path="/p"
    const a = makeCtx('POST', '/p', { 'idempotency-key': 'k', 'x-scope': 'a:b' })
    const handlerA = vi.fn(async () => { a.json({ id: 'order_A' }, 201) })
    await mw(a, handlerA)

    // B: scope="a", path="b:POST:/p" — genuinely different scope+path.
    const b = makeCtx('POST', 'b:POST:/p', { 'idempotency-key': 'k', 'x-scope': 'a' })
    const handlerB = vi.fn(async () => { b.json({ id: 'order_B' }, 201) })
    await mw(b, handlerB)

    expect(handlerA).toHaveBeenCalledTimes(1)
    expect(handlerB).toHaveBeenCalledTimes(1)
    expect(readJson(a)).toEqual({ id: 'order_A' })
    expect(readJson(b)).toEqual({ id: 'order_B' })
    expect(b._headers['idempotent-replayed']).toBeUndefined()
    expect(setSpy).toHaveBeenCalledTimes(2)
    const keys = setSpy.mock.calls.map((c) => c[0] as string)
    expect(keys[0]).not.toBe(keys[1])
    store.destroy()
  })

  it('still replays the cached response for an identical (scope, method, path, key) tuple', async () => {
    const store = new IdempotencyMemoryStore()
    const mw = idempotencyMiddleware({
      store,
      scope: (ctx) => ctx.headers['x-scope'] as string,
    })

    const first = makeCtx('POST', '/p:x', { 'idempotency-key': 'x:y', 'x-scope': 'a:b' })
    const h1 = vi.fn(async () => { first.json({ id: 'order_1' }, 201) })
    await mw(first, h1)

    // Byte-for-byte identical tuple → must replay, handler must not re-run.
    const second = makeCtx('POST', '/p:x', { 'idempotency-key': 'x:y', 'x-scope': 'a:b' })
    const h2 = vi.fn(async () => { second.json({ id: 'WRONG' }, 201) })
    await mw(second, h2)

    expect(h1).toHaveBeenCalledTimes(1)
    expect(h2).not.toHaveBeenCalled()
    expect(readJson(second)).toEqual({ id: 'order_1' })
    expect(second._headers['idempotent-replayed']).toBe('true')
    store.destroy()
  })
})
