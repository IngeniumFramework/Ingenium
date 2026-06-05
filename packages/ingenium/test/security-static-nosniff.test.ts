/**
 * Finding #9: static-file responses did not set `X-Content-Type-Options`.
 * Static roots commonly serve user-controlled uploads; without nosniff a
 * browser may MIME-sniff a .txt/.jpg upload as HTML and execute embedded
 * markup → stored XSS. The middleware now pins `x-content-type-options:
 * nosniff` alongside the content-type (unless already set).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { IngeniumContext } from '../src/context/context.ts'
import { staticMiddleware } from '../src/static/middleware.ts'

let ROOT: string

beforeAll(() => {
  ROOT = mkdtempSync(path.join(os.tmpdir(), 'ingenium-static-nosniff-'))
  writeFileSync(path.join(ROOT, 'upload.txt'), 'hello world')
  writeFileSync(path.join(ROOT, 'evil.txt'), '<script>alert(1)</script>')
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

describe('security: static middleware sets X-Content-Type-Options: nosniff', () => {
  it('serves a file with x-content-type-options: nosniff', async () => {
    const mw = staticMiddleware(ROOT)
    const ctx = makeCtx('/upload.txt')
    let nextCalled = false
    await mw(ctx, async () => { nextCalled = true })

    expect(nextCalled).toBe(false)
    expect(ctx._body.kind).toBe('stream')
    expect(ctx._headers['x-content-type-options']).toBe('nosniff')
    // Sanity: content-type is still present, so nosniff actually pins it.
    expect(ctx._headers['content-type']).toBe('text/plain; charset=utf-8')
  })

  it('sets nosniff on a HEAD request too', async () => {
    const mw = staticMiddleware(ROOT)
    const ctx = makeCtx('/upload.txt')
    ctx.method = 'HEAD'
    await mw(ctx, async () => {})
    expect(ctx._headers['x-content-type-options']).toBe('nosniff')
  })

  it('does not overwrite an upstream-set x-content-type-options', async () => {
    const mw = staticMiddleware(ROOT)
    const ctx = makeCtx('/evil.txt')
    // Simulate a middleware upstream having chosen a value already.
    ctx.set('x-content-type-options', 'nosniff, custom')
    await mw(ctx, async () => {})
    expect(ctx._headers['x-content-type-options']).toBe('nosniff, custom')
  })

  it('sets nosniff on a 304 Not Modified path as well', async () => {
    // Build the etag first, then re-request with If-None-Match. nosniff is set
    // before the conditional check, so even a 304 carries it.
    const warm = makeCtx('/upload.txt')
    await staticMiddleware(ROOT)(warm, async () => {})
    const etag = warm._headers['etag'] as string

    const ctx = makeCtx('/upload.txt')
    ctx.headers = { 'if-none-match': etag }
    await staticMiddleware(ROOT)(ctx, async () => {})
    expect(ctx._statusCode).toBe(304)
    expect(ctx._headers['x-content-type-options']).toBe('nosniff')
  })
})
