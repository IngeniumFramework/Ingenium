import { describe, it, expect, vi } from 'vitest'
import { IngeniumContext } from '../src/context/context.ts'
import { corsMiddleware } from '../src/cors/middleware.ts'
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

describe('cors security — wildcard origin suppresses credentials', () => {
  it("omits ACAC when a function origin returns '*' with credentials: true", async () => {
    // A function origin can return '*' at runtime even though `credentials: true`
    // is set — the construction guard only blocks the literal `origin: '*'`.
    // Browsers reject `ACAO: *` + `ACAC: true`, so the middleware must suppress
    // the credentials header in that case.
    const mw = corsMiddleware({ origin: () => '*', credentials: true })
    const ctx = makeCtx('GET', { origin: 'https://app.com' })
    const next = vi.fn(noop)

    await mw(ctx, next)

    expect(ctx.getHeader('access-control-allow-origin')).toBe('*')
    expect(ctx.getHeader('access-control-allow-credentials')).toBeUndefined()
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('still sets ACAC when a function origin returns a specific origin', async () => {
    // Sanity check the inverse: a concrete (non-wildcard) reflected origin with
    // credentials enabled SHOULD carry Access-Control-Allow-Credentials.
    const mw = corsMiddleware({
      origin: (o) => o,
      credentials: true,
    })
    const ctx = makeCtx('GET', { origin: 'https://app.com' })

    await mw(ctx, vi.fn(noop))

    expect(ctx.getHeader('access-control-allow-origin')).toBe('https://app.com')
    expect(ctx.getHeader('access-control-allow-credentials')).toBe('true')
  })
})
