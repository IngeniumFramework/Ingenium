import { describe, it, expect, vi } from 'vitest'
import { IngeniumContext } from '../src/context/context.ts'
import { rateLimit } from '../src/rate-limit/middleware.ts'
import { MemoryStore } from '../src/rate-limit/store.ts'
import type { HttpMethod } from '../src/router/types.ts'

// The default keyGenerator buckets by `ctx.ip` (the trust-proxy-aware peer),
// NOT by raw X-Forwarded-For / X-Real-IP — those are client-spoofable. With
// trustProxy off (the default here), distinct clients are distinct socket
// peers, so tests set `remoteAddress` to separate buckets.
function makeCtx(
  headers: Record<string, string> = {},
  remoteAddress = '127.0.0.1',
): IngeniumContext {
  const ctx = new IngeniumContext()
  ctx.method = 'GET' as HttpMethod
  ctx.path = '/'
  ctx.url = '/'
  ctx.headers = headers
  ctx.remoteAddress = remoteAddress
  return ctx
}

const noop = async () => {}

describe('rateLimit — basic accounting', () => {
  it('first request: stamps headers and calls next()', async () => {
    const mw = rateLimit({ max: 3, windowMs: 1000, store: new MemoryStore() })
    const ctx = makeCtx({ 'x-forwarded-for': '1.1.1.1' })
    const next = vi.fn(noop)

    await mw(ctx, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(ctx.getHeader('x-ratelimit-limit')).toBe('3')
    expect(ctx.getHeader('x-ratelimit-remaining')).toBe('2')
    expect(ctx.getHeader('x-ratelimit-reset')).toMatch(/^\d+$/)
    expect(ctx._written).toBe(false)
  })

  it('over-limit request returns 429 with Retry-After and JSON body', async () => {
    const store = new MemoryStore()
    const mw = rateLimit({ max: 2, windowMs: 1000, store })

    const k = { 'x-forwarded-for': '2.2.2.2' }
    await mw(makeCtx(k), vi.fn(noop)) // 1
    await mw(makeCtx(k), vi.fn(noop)) // 2

    const overCtx = makeCtx(k)
    const overNext = vi.fn(noop)
    await mw(overCtx, overNext)

    expect(overNext).not.toHaveBeenCalled()
    expect(overCtx._statusCode).toBe(429)
    expect(overCtx._written).toBe(true)
    expect(overCtx.getHeader('retry-after')).toMatch(/^\d+$/)

    const body = overCtx._body
    expect(body.kind).toBe('string')
    if (body.kind === 'string') {
      const parsed = JSON.parse(body.data) as {
        error: string
        code: string
        retryAfter: number
      }
      expect(parsed.error).toBe('Too Many Requests')
      expect(parsed.code).toBe('RATE_LIMITED')
      expect(typeof parsed.retryAfter).toBe('number')
      expect(parsed.retryAfter).toBeGreaterThanOrEqual(1)
    }
  })

  it('counter resets after windowMs elapses', async () => {
    const store = new MemoryStore()
    const mw = rateLimit({ max: 1, windowMs: 50, store })
    const k = { 'x-forwarded-for': '3.3.3.3' }

    // Burn the single allowance.
    const a = makeCtx(k)
    await mw(a, vi.fn(noop))
    expect(a._written).toBe(false)

    // Second request immediately = blocked.
    const b = makeCtx(k)
    const bNext = vi.fn(noop)
    await mw(b, bNext)
    expect(bNext).not.toHaveBeenCalled()
    expect(b._statusCode).toBe(429)

    // Wait for the window to roll over.
    await new Promise((r) => setTimeout(r, 70))

    const c = makeCtx(k)
    const cNext = vi.fn(noop)
    await mw(c, cNext)
    expect(cNext).toHaveBeenCalledTimes(1)
    expect(c._written).toBe(false)
    expect(c.getHeader('x-ratelimit-remaining')).toBe('0')
  })

  it('different keys are isolated', async () => {
    const store = new MemoryStore()
    const mw = rateLimit({ max: 1, windowMs: 1000, store })

    const a1 = makeCtx({}, '10.0.0.1')
    const a1Next = vi.fn(noop)
    await mw(a1, a1Next)
    expect(a1Next).toHaveBeenCalled()

    const b1 = makeCtx({}, '10.0.0.2')
    const b1Next = vi.fn(noop)
    await mw(b1, b1Next)
    expect(b1Next).toHaveBeenCalled() // b not throttled by a's hit

    // a's second request should be blocked
    const a2 = makeCtx({}, '10.0.0.1')
    const a2Next = vi.fn(noop)
    await mw(a2, a2Next)
    expect(a2Next).not.toHaveBeenCalled()
    expect(a2._statusCode).toBe(429)
  })
})

describe('rateLimit — options', () => {
  it('skip: () => true short-circuits — next() called, no headers set', async () => {
    const store = new MemoryStore()
    const mw = rateLimit({
      max: 1,
      windowMs: 1000,
      store,
      skip: () => true,
    })

    // Even after many calls, none should be limited — skip is unconditional.
    for (let i = 0; i < 5; i++) {
      const ctx = makeCtx({ 'x-forwarded-for': '9.9.9.9' })
      const next = vi.fn(noop)
      await mw(ctx, next)
      expect(next).toHaveBeenCalledTimes(1)
      expect(ctx._written).toBe(false)
      expect(ctx.getHeader('x-ratelimit-limit')).toBeUndefined()
      expect(ctx.getHeader('x-ratelimit-remaining')).toBeUndefined()
    }
  })

  it('keyGenerator override is used', async () => {
    const store = new MemoryStore()
    // Bucket every request into a single key, regardless of headers.
    const mw = rateLimit({
      max: 1,
      windowMs: 1000,
      store,
      keyGenerator: () => 'shared',
    })

    const a = makeCtx({ 'x-forwarded-for': '1' })
    await mw(a, vi.fn(noop))
    const b = makeCtx({ 'x-forwarded-for': '2' })
    const bNext = vi.fn(noop)
    await mw(b, bNext)

    expect(bNext).not.toHaveBeenCalled() // b uses same bucket as a
    expect(b._statusCode).toBe(429)
  })

  it('default keyGenerator: ignores spoofable X-Forwarded-For (buckets by ctx.ip)', async () => {
    const store = new MemoryStore()
    const mw = rateLimit({ max: 1, windowMs: 1000, store })

    // Same socket peer, attacker rotates X-Forwarded-For to try to dodge the
    // limit. With trustProxy off, ctx.ip is the peer, so both share a bucket.
    const a = makeCtx({ 'x-forwarded-for': '1.1.1.1' }, '203.0.113.7')
    await mw(a, vi.fn(noop))
    const b = makeCtx({ 'x-forwarded-for': '9.9.9.9' }, '203.0.113.7')
    const bNext = vi.fn(noop)
    await mw(b, bNext)
    expect(bNext).not.toHaveBeenCalled() // spoofed XFF did not buy a fresh bucket

    // A genuinely different peer is still isolated despite reusing the XFF.
    const c = makeCtx({ 'x-forwarded-for': '1.1.1.1' }, '203.0.113.8')
    const cNext = vi.fn(noop)
    await mw(c, cNext)
    expect(cNext).toHaveBeenCalled()
  })

  it('default keyGenerator: collapses to "unknown" when peer is unresolved', async () => {
    const store = new MemoryStore()
    const mw = rateLimit({ max: 1, windowMs: 1000, store })

    // Empty remoteAddress (and X-Real-IP is NOT trusted) → 'unknown' bucket.
    const u1 = makeCtx({ 'x-real-ip': 'real-1' }, '')
    await mw(u1, vi.fn(noop))
    const u2 = makeCtx({ 'x-real-ip': 'real-2' }, '')
    const u2Next = vi.fn(noop)
    await mw(u2, u2Next)
    expect(u2Next).not.toHaveBeenCalled() // both collapse onto 'unknown'
  })

  it('store.reset(key) clears the counter', async () => {
    const store = new MemoryStore()
    const mw = rateLimit({ max: 1, windowMs: 60_000, store })
    const peer = '198.51.100.1' // the key is ctx.ip, not a header value

    await mw(makeCtx({}, peer), vi.fn(noop))
    const blockedCtx = makeCtx({}, peer)
    const blockedNext = vi.fn(noop)
    await mw(blockedCtx, blockedNext)
    expect(blockedNext).not.toHaveBeenCalled()

    await store.reset(peer)

    const recoveredCtx = makeCtx({}, peer)
    const recoveredNext = vi.fn(noop)
    await mw(recoveredCtx, recoveredNext)
    expect(recoveredNext).toHaveBeenCalledTimes(1)
    expect(recoveredCtx._written).toBe(false)
  })

  it('windowMs <= 0 throws at construction time', () => {
    expect(() => rateLimit({ windowMs: 0 })).toThrow(/windowMs/)
    expect(() => rateLimit({ windowMs: -1 })).toThrow(/windowMs/)
  })

  it('max <= 0 throws at construction time', () => {
    expect(() => rateLimit({ max: 0 })).toThrow(/max/)
    expect(() => rateLimit({ max: -1 })).toThrow(/max/)
  })
})

describe('MemoryStore — internals', () => {
  it('cleanup interval is unref()d', async () => {
    const store = new MemoryStore()
    // Trigger the sweeper to be created.
    await store.hit('x', 1000)

    // Reach into the private field to verify the timer was unref'd. We
    // can't observe `unref()` directly, but we CAN observe that the
    // timer object has the unref method called: Node's Timeout exposes
    // `_destroyed` and `hasRef()` (>= Node 18).
    // Use bracket access to dodge `private` typing.
    const timer = (store as unknown as { sweeper: NodeJS.Timeout | null }).sweeper
    expect(timer).not.toBeNull()
    if (timer && typeof (timer as unknown as { hasRef?: () => boolean }).hasRef === 'function') {
      expect((timer as unknown as { hasRef: () => boolean }).hasRef()).toBe(false)
    }

    store.destroy()
  })

  it('destroy() stops the sweeper and clears the map', async () => {
    const store = new MemoryStore()
    await store.hit('a', 1000)
    await store.hit('b', 1000)
    store.destroy()

    // Subsequent hit recreates the entry from scratch.
    const result = await store.hit('a', 1000)
    expect(result.count).toBe(1)
    store.destroy()
  })
})
