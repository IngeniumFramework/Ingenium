import { describe, it, expect, vi, afterEach } from 'vitest'
import { IngeniumContext } from '../src/context/context.ts'
import type { Session } from '../src/session/types.ts'

/**
 * Regression: a session cookie issued over plaintext HTTP can be sniffed.
 *
 * `sessionMiddleware` must default the cookie `Secure` attribute ON in
 * production (`NODE_ENV==='production'`) while keeping it OFF in dev so
 * http://localhost development still works. An explicit `cookie.secure: false`
 * must still win (and warn in production).
 *
 * `IS_DEV` is read once at module load, so each scenario sets `NODE_ENV` and
 * re-imports the middleware via `vi.resetModules()` to exercise both branches.
 */

function makeCtx(headers: Record<string, string> = {}): IngeniumContext & { session: Session } {
  const ctx = new IngeniumContext()
  ctx.method = 'GET'
  ctx.path = '/'
  ctx.url = '/'
  ctx.headers = headers
  return ctx as IngeniumContext & { session: Session }
}

const noop = async () => {}

function getSetCookie(ctx: IngeniumContext): string | undefined {
  const v = ctx.getHeader('set-cookie')
  if (v === undefined) return undefined
  return Array.isArray(v) ? v[0] : v
}

async function loadMiddleware(nodeEnv: string | undefined) {
  vi.resetModules()
  const prev = process.env.NODE_ENV
  if (nodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = nodeEnv
  const mod = await import('../src/session/middleware.ts')
  // Restore so we don't leak NODE_ENV into other modules; the middleware has
  // already captured IS_DEV at import time.
  if (prev === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = prev
  return mod.sessionMiddleware
}

const ORIGINAL_ENV = process.env.NODE_ENV

afterEach(() => {
  vi.restoreAllMocks()
  if (ORIGINAL_ENV === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = ORIGINAL_ENV
})

describe('session cookie Secure default (security)', () => {
  it('emits Secure by default in production', async () => {
    const sessionMiddleware = await loadMiddleware('production')
    const mw = sessionMiddleware({ secret: 's3cret-key-value' })
    const ctx = makeCtx()
    await mw(ctx, noop)
    expect(getSetCookie(ctx)).toContain('Secure')
  })

  it('does NOT emit Secure by default in development', async () => {
    const sessionMiddleware = await loadMiddleware('development')
    const mw = sessionMiddleware({ secret: 's3cret-key-value' })
    const ctx = makeCtx()
    await mw(ctx, noop)
    expect(getSetCookie(ctx)).not.toContain('Secure')
  })

  it('explicit secure:false overrides the production default (escape hatch)', async () => {
    const sessionMiddleware = await loadMiddleware('production')
    const mw = sessionMiddleware({
      secret: 's3cret-key-value',
      cookie: { secure: false },
    })
    const ctx = makeCtx()
    await mw(ctx, noop)
    expect(getSetCookie(ctx)).not.toContain('Secure')
  })

  it('explicit secure:true forces Secure even in development', async () => {
    const sessionMiddleware = await loadMiddleware('development')
    const mw = sessionMiddleware({
      secret: 's3cret-key-value',
      cookie: { secure: true },
    })
    const ctx = makeCtx()
    await mw(ctx, noop)
    expect(getSetCookie(ctx)).toContain('Secure')
  })

  it('warns in production when secure:false is forced', async () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    const sessionMiddleware = await loadMiddleware('production')
    sessionMiddleware({ secret: 's3cret-key-value', cookie: { secure: false } })
    expect(warn).toHaveBeenCalledTimes(1)
    const [msg, opts] = warn.mock.calls[0] as [string, { type?: string }]
    expect(String(msg)).toContain('Secure')
    expect(opts?.type).toBe('IngeniumSessionInsecureCookieWarning')
  })

  it('does NOT warn in production when using the safe default', async () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    const sessionMiddleware = await loadMiddleware('production')
    sessionMiddleware({ secret: 's3cret-key-value' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('does NOT warn in development even with secure:false', async () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    const sessionMiddleware = await loadMiddleware('development')
    sessionMiddleware({ secret: 's3cret-key-value', cookie: { secure: false } })
    expect(warn).not.toHaveBeenCalled()
  })
})
