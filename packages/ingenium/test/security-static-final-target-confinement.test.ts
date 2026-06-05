import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { IngeniumContext } from '../src/context/context.ts'
import { staticMiddleware } from '../src/static/middleware.ts'

// Finding #6: the extensions/index retry loops mutate `target` (appending an
// extension or joining a user-configurable index name) but the up-front
// confinement + dotfile checks only ran on the decoded request path. A
// malicious/misconfigured `index` containing `..`, or an `index`/`extensions`
// value resolving to a dotfile, would be streamed without re-checking policy.

let ROOT: string
let SECRET_DIR: string

beforeAll(() => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'ingenium-static-sec-'))
  ROOT = path.join(base, 'public')
  SECRET_DIR = path.join(base, 'secret')
  mkdirSync(ROOT)
  mkdirSync(SECRET_DIR)
  // A file OUTSIDE root that a `..` index would try to reach.
  writeFileSync(path.join(SECRET_DIR, 'passwd'), 'root:x:0:0')
  // A subdirectory inside root that a directory request resolves into.
  mkdirSync(path.join(ROOT, 'sub'))
  // A dotfile that an extension/index resolution could land on.
  writeFileSync(path.join(ROOT, 'about.env'), 'SECRET=1')
  writeFileSync(path.join(ROOT, '.env'), 'SECRET=2')
})

afterAll(() => {
  rmSync(path.dirname(ROOT), { recursive: true, force: true })
})

function makeCtx(p: string): IngeniumContext {
  const ctx = new IngeniumContext()
  ctx.method = 'GET'
  ctx.path = p
  ctx.url = p
  ctx.headers = {}
  return ctx
}

describe('static middleware: final-target confinement', () => {
  it('rejects an index value that escapes root via ..', async () => {
    // The directory request resolves to ROOT/sub, then the index join would
    // escape to SECRET_DIR/passwd. Must 403, not stream the escaped file.
    const mw = staticMiddleware(ROOT, { index: '../../secret/passwd' })
    const ctx = makeCtx('/sub/')
    let nextCalled = false
    await mw(ctx, async () => { nextCalled = true })
    expect(ctx._body.kind).not.toBe('stream')
    expect(ctx._statusCode).toBe(403)
    expect(nextCalled).toBe(false)
  })

  it('applies dotfile policy when extensions resolve to a dotfile', async () => {
    // `/about` + extensions ['env'] resolves to about.env — not a dotfile, so
    // it serves. Sanity check the loop still works for the non-dot case.
    const ok = staticMiddleware(ROOT, { extensions: ['env'] })
    const ctxOk = makeCtx('/about')
    await ok(ctxOk, async () => {})
    expect(ctxOk._body.kind).toBe('stream')
  })

  it('applies dotfile policy (deny) on a final target resolved to a dotfile', async () => {
    // index: '.env' makes the directory index resolve to a dotfile. With the
    // up-front check passing (the request path has no dot), the FINAL-target
    // check must enforce the dotfile policy.
    const mw = staticMiddleware(ROOT, { index: '.env', dotfiles: 'deny' })
    const ctx = makeCtx('/')
    let nextCalled = false
    await mw(ctx, async () => { nextCalled = true })
    expect(ctx._body.kind).not.toBe('stream')
    expect(ctx._statusCode).toBe(403)
    expect(nextCalled).toBe(false)
  })

  it('applies dotfile policy (ignore) on a final dotfile target by calling next', async () => {
    const mw = staticMiddleware(ROOT, { index: '.env', dotfiles: 'ignore' })
    const ctx = makeCtx('/')
    let nextCalled = false
    await mw(ctx, async () => { nextCalled = true })
    expect(ctx._body.kind).not.toBe('stream')
    expect(nextCalled).toBe(true)
  })
})
