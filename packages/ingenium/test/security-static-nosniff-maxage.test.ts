/**
 * Static-file hardening: the middleware now (a) FORCES
 * `x-content-type-options: nosniff` when an upstream middleware set a weaker
 * value (it only skips when the existing value already carries a `nosniff`
 * token, e.g. "nosniff" or "nosniff, custom"), and (b) clamps `Cache-Control`
 * `max-age` to >= 0 so a negative `opts.maxAge`
 * does not emit `max-age=-N` (which some intermediaries treat as
 * "cache indefinitely" on a public root).
 *
 * See packages/ingenium/src/static/middleware.ts (nosniff force + Math.max(0,…)).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { IngeniumContext } from '../src/context/context.ts'
import { staticMiddleware } from '../src/static/middleware.ts'

let ROOT: string

beforeAll(() => {
  ROOT = mkdtempSync(path.join(os.tmpdir(), 'ingenium-static-nosniff-maxage-'))
  writeFileSync(path.join(ROOT, 'upload.txt'), 'hello world')
})

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

function makeCtx(p: string): IngeniumContext {
  const ctx = new IngeniumContext()
  ctx.method = 'GET'
  ctx.path = p
  ctx.url = p
  ctx.headers = {}
  return ctx
}

describe('security: static forces nosniff over a weaker upstream value', () => {
  it('overrides an upstream x-content-type-options of "" with nosniff', async () => {
    const mw = staticMiddleware(ROOT)
    const ctx = makeCtx('/upload.txt')
    // An upstream middleware set a weaker (empty) value — sniffing protection
    // would be effectively disabled. Static must reassert nosniff.
    ctx.set('x-content-type-options', '')
    let nextCalled = false
    await mw(ctx, async () => { nextCalled = true })

    expect(nextCalled).toBe(false)
    expect(ctx._body.kind).toBe('stream')
    expect(ctx._headers['x-content-type-options']).toBe('nosniff')
    // Close the lazily-consumed read stream so nothing dangles past afterAll.
    if (ctx._body.kind === 'stream') ctx._body.data.destroy()
  })

  it('leaves an exact "nosniff" upstream value untouched (no redundant set)', async () => {
    const mw = staticMiddleware(ROOT)
    const ctx = makeCtx('/upload.txt')
    ctx.method = 'HEAD'
    ctx.set('x-content-type-options', 'nosniff')
    await mw(ctx, async () => {})
    expect(ctx._headers['x-content-type-options']).toBe('nosniff')
  })
})

describe('security: static clamps a negative maxAge to max-age=0', () => {
  it('emits max-age=0 (not a negative max-age) for maxAge: -1000', async () => {
    const mw = staticMiddleware(ROOT, { maxAge: -1000 })
    // HEAD: headers are set but no readable stream is opened, so nothing
    // dangles past afterAll's rmSync.
    const ctx = makeCtx('/upload.txt')
    ctx.method = 'HEAD'
    await mw(ctx, async () => {})

    expect(ctx._headers['cache-control']).toBe('public, max-age=0')
    expect(String(ctx._headers['cache-control'])).not.toMatch(/max-age=-/)
  })

  it('still emits a positive max-age for a positive maxAge', async () => {
    const mw = staticMiddleware(ROOT, { maxAge: 60_000 })
    const ctx = makeCtx('/upload.txt')
    ctx.method = 'HEAD'
    await mw(ctx, async () => {})
    expect(ctx._headers['cache-control']).toBe('public, max-age=60')
  })
})
