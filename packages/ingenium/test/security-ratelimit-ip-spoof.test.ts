import { describe, it, expect, vi } from 'vitest'
import { IngeniumContext } from '../src/context/context.ts'
import { rateLimit } from '../src/rate-limit/middleware.ts'
import { MemoryStore } from '../src/rate-limit/store.ts'
import type { HttpMethod } from '../src/router/types.ts'

// ─────────────────────────────────────────────────────────────────────────────
// Rate-limit key spoofing (rate-limit/middleware.ts `defaultKeyGenerator`).
//
// The default key generator must bucket by the trust-proxy-aware `ctx.ip`, NOT
// by the raw client-controlled `x-forwarded-for` / `x-real-ip` headers. With
// trustProxy OFF (the default), `ctx.ip` is the socket peer (`remoteAddress`)
// and forged XFF headers MUST be ignored — otherwise a single peer can rotate
// a fake first hop on every request and slip the limit, or pin a victim's IP
// into the bucket to frame them.
// ─────────────────────────────────────────────────────────────────────────────

const noop = async () => {}

/**
 * Build a context for a single underlying peer (`remoteAddress`), optionally
 * carrying a spoofed proxy header. trustProxy is left at its default (false),
 * so `ctx.ip` resolves to `remoteAddress` regardless of the header.
 */
function makeCtx(remoteAddress: string, headers: Record<string, string> = {}): IngeniumContext {
  const ctx = new IngeniumContext()
  ctx.method = 'GET' as HttpMethod
  ctx.path = '/'
  ctx.url = '/'
  ctx.headers = headers
  ctx.remoteAddress = remoteAddress
  return ctx
}

describe('rateLimit — X-Forwarded-For spoofing is ignored when trustProxy is off', () => {
  it('two requests from the same peer with different spoofed XFF share one bucket', async () => {
    const store = new MemoryStore()
    const mw = rateLimit({ max: 1, windowMs: 60_000, store })

    // Same underlying socket peer; attacker rotates the forged first hop.
    const first = makeCtx('203.0.113.7', { 'x-forwarded-for': '1.1.1.1' })
    const firstNext = vi.fn(noop)
    await mw(first, firstNext)
    expect(firstNext).toHaveBeenCalledTimes(1)
    expect(first._written).toBe(false)

    // Different spoofed XFF — but it's the SAME peer, so it must hit the same
    // bucket and be throttled. If the limiter trusted the header, this would
    // wrongly land in a fresh bucket and pass.
    const second = makeCtx('203.0.113.7', { 'x-forwarded-for': '2.2.2.2' })
    const secondNext = vi.fn(noop)
    await mw(second, secondNext)
    expect(secondNext).not.toHaveBeenCalled()
    expect(second._statusCode).toBe(429)
    expect(second._written).toBe(true)
  })

  it('a forged x-real-ip does not change the bucket either', async () => {
    const store = new MemoryStore()
    const mw = rateLimit({ max: 1, windowMs: 60_000, store })

    const a = makeCtx('198.51.100.4', { 'x-real-ip': 'victim-ip' })
    const aNext = vi.fn(noop)
    await mw(a, aNext)
    expect(aNext).toHaveBeenCalledTimes(1)

    const b = makeCtx('198.51.100.4', { 'x-real-ip': 'some-other-ip' })
    const bNext = vi.fn(noop)
    await mw(b, bNext)
    expect(bNext).not.toHaveBeenCalled()
    expect(b._statusCode).toBe(429)
  })

  it('genuinely different peers remain isolated', async () => {
    const store = new MemoryStore()
    const mw = rateLimit({ max: 1, windowMs: 60_000, store })

    // Both spoof the SAME XFF, but they are different real peers — they must
    // NOT collide (proof we key on the peer, not the header).
    const a = makeCtx('203.0.113.1', { 'x-forwarded-for': '9.9.9.9' })
    const aNext = vi.fn(noop)
    await mw(a, aNext)
    expect(aNext).toHaveBeenCalledTimes(1)

    const b = makeCtx('203.0.113.2', { 'x-forwarded-for': '9.9.9.9' })
    const bNext = vi.fn(noop)
    await mw(b, bNext)
    expect(bNext).toHaveBeenCalledTimes(1)
    expect(b._written).toBe(false)
  })
})
