import { describe, it, expect, vi } from 'vitest'
import { IngeniumContext } from '../src/context/context.ts'
import { corsMiddleware } from '../src/cors/middleware.ts'
import { IngeniumError } from '../src/errors.ts'
import type { HttpMethod } from '../src/router/types.ts'

function makeCtx(
  method: HttpMethod = 'GET',
  headers: Record<string, string> = {},
): IngeniumContext {
  const ctx = new IngeniumContext()
  ctx.method = method
  ctx.path = '/'
  ctx.url = '/'
  ctx.headers = headers
  return ctx
}

const noop = async () => {}

describe('cors security — credentialed reflection', () => {
  it('rejects `origin: true` + `credentials: true` at construction', () => {
    let err: unknown
    try {
      corsMiddleware({ origin: true, credentials: true })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(IngeniumError)
    expect((err as IngeniumError).code).toBe('CORS_CREDENTIALS_WILDCARD')
  })

  it("still rejects `origin: '*'` + `credentials: true` (existing guard) as IngeniumError", () => {
    let err: unknown
    try {
      corsMiddleware({ origin: '*', credentials: true })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(IngeniumError)
    expect((err as IngeniumError).code).toBe('CORS_CREDENTIALS_WILDCARD')
  })

  it('`origin: true` without credentials still reflects arbitrary origins', async () => {
    const mw = corsMiddleware({ origin: true })
    const ctx = makeCtx('GET', { origin: 'https://evil.example' })
    await mw(ctx, vi.fn(noop))
    expect(ctx.getHeader('access-control-allow-origin')).toBe('https://evil.example')
    expect(ctx.getHeader('vary')).toBe('Origin')
  })
})

describe('cors security — literal "null" origin', () => {
  it('`origin: true` never reflects the literal "null" origin', async () => {
    const mw = corsMiddleware({ origin: true })
    const ctx = makeCtx('GET', { origin: 'null' })
    const next = vi.fn(noop)
    await mw(ctx, next)
    expect(ctx.getHeader('access-control-allow-origin')).toBeUndefined()
    // Still varies on Origin — the decision depended on the request.
    expect(ctx.getHeader('vary')).toBe('Origin')
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('an explicit allowlist array may opt into "null"', async () => {
    const mw = corsMiddleware({ origin: ['null', 'https://app.com'] })
    const ctx = makeCtx('GET', { origin: 'null' })
    await mw(ctx, vi.fn(noop))
    expect(ctx.getHeader('access-control-allow-origin')).toBe('null')
  })
})

describe('cors security — function origin forces Vary (cache poisoning)', () => {
  it('always appends Vary: Origin when origin is a function, even when denied', async () => {
    const mw = corsMiddleware({ origin: () => false })
    const ctx = makeCtx('GET', { origin: 'https://app.com' })
    await mw(ctx, vi.fn(noop))
    expect(ctx.getHeader('access-control-allow-origin')).toBeUndefined()
    expect(ctx.getHeader('vary')).toBe('Origin')
  })

  it("appends Vary: Origin when a function origin returns '*'", async () => {
    const mw = corsMiddleware({ origin: () => '*' })
    const ctx = makeCtx('GET', { origin: 'https://app.com' })
    await mw(ctx, vi.fn(noop))
    expect(ctx.getHeader('access-control-allow-origin')).toBe('*')
    expect(ctx.getHeader('vary')).toBe('Origin')
  })
})
