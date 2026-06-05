/**
 * Finding #7: the `Idempotency-Key` header value was embedded verbatim in the
 * cache key and retained for the full TTL with no length cap → a single
 * oversized header becomes a memory-DoS lever. The middleware now rejects a
 * key longer than 256 chars with a 400 (IngeniumBadRequestError) BEFORE it
 * touches the store.
 */
import { describe, it, expect, vi } from 'vitest'
import { IngeniumContext } from '../src/context/context.ts'
import { idempotencyMiddleware } from '../src/idempotency/middleware.ts'
import { IdempotencyMemoryStore } from '../src/idempotency/store.ts'
import { IngeniumBadRequestError } from '../src/errors.ts'
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

describe('security: Idempotency-Key length cap', () => {
  it('rejects an over-long key with a 400 before touching the store', async () => {
    const store = new IdempotencyMemoryStore()
    const getSpy = vi.spyOn(store, 'get')
    const setSpy = vi.spyOn(store, 'set')
    const mw = idempotencyMiddleware({ store })

    // 257 chars — one over the 256 cap. Use an authenticated request so we get
    // past the anon-scope bypass and actually reach the length check.
    const longKey = 'k'.repeat(257)
    const ctx = makeCtx('POST', '/charges', {
      'idempotency-key': longKey,
      authorization: 'Bearer tok',
    })
    const handler = vi.fn(async () => { ctx.json({ ok: true }, 201) })

    let thrown: unknown
    try {
      await mw(ctx, handler)
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(IngeniumBadRequestError)
    expect((thrown as IngeniumBadRequestError).statusCode).toBe(400)
    expect((thrown as IngeniumBadRequestError).code).toBe('BAD_REQUEST')
    // The handler never ran and the store was never consulted/written.
    expect(handler).not.toHaveBeenCalled()
    expect(getSpy).not.toHaveBeenCalled()
    expect(setSpy).not.toHaveBeenCalled()
    store.destroy()
  })

  it('accepts a key exactly at the 256-char limit', async () => {
    const store = new IdempotencyMemoryStore()
    const mw = idempotencyMiddleware({ store })
    const key = 'k'.repeat(256)
    const ctx = makeCtx('POST', '/charges', {
      'idempotency-key': key,
      authorization: 'Bearer tok',
    })
    const handler = vi.fn(async () => { ctx.json({ ok: true }, 201) })

    await expect(mw(ctx, handler)).resolves.toBeUndefined()
    expect(handler).toHaveBeenCalledTimes(1)
    store.destroy()
  })

  it('accepts a normal short key', async () => {
    const store = new IdempotencyMemoryStore()
    const mw = idempotencyMiddleware({ store })
    const ctx = makeCtx('POST', '/charges', {
      'idempotency-key': 'idem_123',
      authorization: 'Bearer tok',
    })
    const handler = vi.fn(async () => { ctx.json({ ok: true }, 201) })

    await mw(ctx, handler)
    expect(handler).toHaveBeenCalledTimes(1)
    store.destroy()
  })
})
