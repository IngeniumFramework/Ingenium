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

describe('security: idempotency anonymous-scope cross-client replay', () => {
  it('does NOT serve client A cached response to anonymous client B (default scope)', async () => {
    const store = new IdempotencyMemoryStore()
    const setSpy = vi.spyOn(store, 'set')
    const getSpy = vi.spyOn(store, 'get')
    const mw = idempotencyMiddleware({ store })

    // Anonymous client A — no Authorization header.
    const a = makeCtx('POST', '/checkout', { 'idempotency-key': 'shared' })
    const handlerA = vi.fn(async () => {
      a._headers['set-cookie'] = 'session=AAA; HttpOnly'
      a.json({ id: 'order_A' }, 201)
    })
    await mw(a, handlerA)

    // Anonymous client B reuses the same key on the same method+path.
    const b = makeCtx('POST', '/checkout', { 'idempotency-key': 'shared' })
    const handlerB = vi.fn(async () => {
      b.json({ id: 'order_B' }, 201)
    })
    await mw(b, handlerB)

    // Both handlers ran — no cross-client replay occurred.
    expect(handlerA).toHaveBeenCalledTimes(1)
    expect(handlerB).toHaveBeenCalledTimes(1)
    expect(readJson(b)).toEqual({ id: 'order_B' })
    // B must NOT receive A's session cookie or the replayed marker.
    expect(b._headers['set-cookie']).toBeUndefined()
    expect(b._headers['idempotent-replayed']).toBeUndefined()

    // Nothing was stored or fetched for the anonymous requests (bypass).
    expect(setSpy).not.toHaveBeenCalled()
    expect(getSpy).not.toHaveBeenCalled()
    store.destroy()
  })

  it('still caches + replays per-client when an explicit scope is configured', async () => {
    const store = new IdempotencyMemoryStore()
    const mw = idempotencyMiddleware({
      store,
      // Custom scope keyed off a request-isolating discriminator.
      scope: (ctx) => `tenant:${ctx.headers['x-tenant'] as string}`,
    })

    const first = makeCtx('POST', '/checkout', { 'idempotency-key': 'k', 'x-tenant': 't1' })
    const h1 = vi.fn(async () => { first.json({ id: 'order_1' }, 201) })
    await mw(first, h1)

    const second = makeCtx('POST', '/checkout', { 'idempotency-key': 'k', 'x-tenant': 't1' })
    const h2 = vi.fn(async () => { second.json({ id: 'WRONG' }, 201) })
    await mw(second, h2)

    // Same tenant + key → replayed, handler not re-run.
    expect(h2).not.toHaveBeenCalled()
    expect(readJson(second)).toEqual({ id: 'order_1' })
    expect(second._headers['idempotent-replayed']).toBe('true')
    store.destroy()
  })

  it('strips Set-Cookie / Authorization-class headers when replaying a cached entry', async () => {
    const store = new IdempotencyMemoryStore()
    const mw = idempotencyMiddleware({ store })
    const headers = { 'idempotency-key': 'k1', authorization: 'Bearer A' }

    const first = makeCtx('POST', '/charges', headers)
    const h1 = vi.fn(async () => {
      first._headers['set-cookie'] = 'session=secret; HttpOnly'
      first._headers['authorization'] = 'Bearer leaked-token'
      first._headers['x-custom'] = 'keep-me'
      first.json({ id: 'ch_1' }, 201)
    })
    await mw(first, h1)

    const second = makeCtx('POST', '/charges', headers)
    const h2 = vi.fn(async () => { second.json({ id: 'WRONG' }, 201) })
    await mw(second, h2)

    // Replayed (same auth-derived scope) but sensitive headers stripped.
    expect(h2).not.toHaveBeenCalled()
    expect(second._headers['idempotent-replayed']).toBe('true')
    expect(second._headers['set-cookie']).toBeUndefined()
    expect(second._headers['authorization']).toBeUndefined()
    // Non-sensitive headers still replay.
    expect(second._headers['x-custom']).toBe('keep-me')
    store.destroy()
  })
})
