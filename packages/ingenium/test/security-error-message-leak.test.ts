import { describe, it, expect, afterEach, vi } from 'vitest'

/**
 * Regression: the DEFAULT error boundary must not reflect raw internal
 * exception messages to clients in production. A thrown non-IngeniumError leaks
 * DB DSNs, file paths, and driver internals via its `.message`. The boundary
 * should send a generic message in production and only surface the real message
 * in dev. `IS_DEV` is captured once at app.ts import, so each branch is
 * exercised by setting NODE_ENV and re-importing via vi.resetModules().
 */

const SECRET = 'connect ECONNREFUSED 10.0.3.12:5432 postgres://app:s3cr3t@db.internal/prod'

async function loadApp(nodeEnv: string | undefined) {
  vi.resetModules()
  const prev = process.env.NODE_ENV
  if (nodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = nodeEnv
  const mod = await import('../src/app.ts')
  if (prev === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = prev
  return mod.IngeniumApp
}

const ORIGINAL_ENV = process.env.NODE_ENV
afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = ORIGINAL_ENV
})

describe('default error boundary: internal message leakage', () => {
  it('production: returns a generic 500 message, never the raw exception text', async () => {
    const App = await loadApp('production')
    const app = new App()
    app.get('/boom', () => {
      throw new Error(SECRET)
    })

    const res = await app.inject({ method: 'GET', url: '/boom' })
    expect(res.status).toBe(500)
    const body = res.json<{ error: string; code: string }>()
    expect(body.code).toBe('INTERNAL_ERROR')
    expect(body.error).toBe('Internal Server Error')
    // The DSN/host/credentials must NOT appear anywhere in the response.
    expect(res.body).not.toContain('ECONNREFUSED')
    expect(res.body).not.toContain('db.internal')
    expect(res.body).not.toContain('s3cr3t')
  })

  it('development: surfaces the real message to aid local debugging', async () => {
    const App = await loadApp('development')
    const app = new App()
    app.get('/boom', () => {
      throw new Error(SECRET)
    })

    const res = await app.inject({ method: 'GET', url: '/boom' })
    expect(res.status).toBe(500)
    const body = res.json<{ error: string; code: string }>()
    expect(body.code).toBe('INTERNAL_ERROR')
    expect(body.error).toBe(SECRET)
  })

  it('production: IngeniumError messages are still surfaced (developer-authored, safe)', async () => {
    const App = await loadApp('production')
    const errsMod = await import('../src/errors.ts')
    const app = new App()
    app.get('/bad', () => {
      throw new errsMod.IngeniumBadRequestError('missing field: email')
    })

    const res = await app.inject({ method: 'GET', url: '/bad' })
    expect(res.status).toBe(400)
    const body = res.json<{ error: string; code: string }>()
    expect(body.error).toBe('missing field: email')
  })
})
