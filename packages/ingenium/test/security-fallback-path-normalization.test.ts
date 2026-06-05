/**
 * Regression: scoped/fallback middleware must not be skippable via a
 * non-normalized request path on the trie-miss fallback branch.
 *
 * A deny-by-default / audit / security gate registered with `use('/admin', mw)`
 * is meant to run even on requests that don't match any route under `/admin`
 * (so it can 403, log, or attach security headers on the miss). The fallback
 * applicability check used the RAW request path, and `pathStartsWith('//admin/x',
 * '/admin')` is false — letting a duplicated-slash path slip past the gate.
 *
 * The fix collapses runs of '/' into a local path used only for the
 * applicability check in `runFallback` (ctx.path is left untouched).
 */
import { describe, it, expect } from 'vitest'
import { IngeniumApp } from '../src/app.ts'

describe('security: fallback middleware path normalization', () => {
  it('runs /admin-scoped gate on a miss reached via a duplicated-slash path', async () => {
    const app = new IngeniumApp()
    let gateRan = false

    app.use('/admin', async (ctx) => {
      gateRan = true
      ctx.status(403).json({ error: 'forbidden' })
    })

    // No route is registered under /admin, so this is a trie miss that goes
    // through runFallback. The leading double slash must not bypass the gate.
    const res = await app.inject({ method: 'GET', url: '//admin/secret' })

    expect(gateRan).toBe(true)
    expect(res.status).toBe(403)
  })

  it('still runs the gate on the normal single-slash miss path', async () => {
    const app = new IngeniumApp()
    let gateRan = false

    app.use('/admin', async (ctx) => {
      gateRan = true
      ctx.status(403).json({ error: 'forbidden' })
    })

    const res = await app.inject({ method: 'GET', url: '/admin/secret' })

    expect(gateRan).toBe(true)
    expect(res.status).toBe(403)
  })

  it('does not apply an /admin gate to an unrelated duplicated-slash miss', async () => {
    const app = new IngeniumApp()
    let gateRan = false

    app.use('/admin', async (ctx) => {
      gateRan = true
      ctx.status(403).json({ error: 'forbidden' })
    })

    const res = await app.inject({ method: 'GET', url: '//public/thing' })

    expect(gateRan).toBe(false)
    expect(res.status).toBe(404)
  })
})
