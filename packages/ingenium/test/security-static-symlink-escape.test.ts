import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { IngeniumContext } from '../src/context/context.ts'
import { staticMiddleware } from '../src/static/middleware.ts'

// A symlink INSIDE the static root pointing OUTSIDE it defeats the lexical
// confinement check: the joined path stays under root, but the bytes served
// come from elsewhere. The default `symlinks: 'deny'` resolves the real target
// and must block it; `symlinks: 'allow'` opts back into lexical-only behavior.

let base = ''
let ROOT = ''
let canSymlink = false

try {
  base = mkdtempSync(path.join(os.tmpdir(), 'ingenium-static-symlink-'))
  ROOT = path.join(base, 'public')
  const outside = path.join(base, 'outside')
  mkdirSync(ROOT)
  mkdirSync(outside)
  writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET')
  // 'junction' lets Windows create a directory link without admin / developer
  // mode; the type argument is ignored on POSIX (a normal symlink is made).
  symlinkSync(outside, path.join(ROOT, 'escape'), 'junction')
  canSymlink = true
} catch {
  canSymlink = false // sandbox without symlink privileges — skip below.
}

afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true })
})

function makeCtx(p: string): IngeniumContext {
  const ctx = new IngeniumContext()
  ctx.method = 'GET'
  ctx.path = p
  ctx.url = p
  ctx.headers = {}
  return ctx
}

describe.skipIf(!canSymlink)('static middleware: symlink escape', () => {
  it('blocks a symlink whose real target escapes root (default deny)', async () => {
    const mw = staticMiddleware(ROOT)
    const ctx = makeCtx('/escape/secret.txt')
    let nextCalled = false
    await mw(ctx, async () => { nextCalled = true })
    expect(ctx._body.kind).not.toBe('stream')
    expect(ctx._statusCode).toBe(403)
    expect(nextCalled).toBe(false)
  })

  it('serves through the symlink when symlinks: "allow"', async () => {
    const mw = staticMiddleware(ROOT, { symlinks: 'allow' })
    const ctx = makeCtx('/escape/secret.txt')
    await mw(ctx, async () => {})
    expect(ctx._body.kind).toBe('stream')
    // Fully consume the lazily-opened ReadStream while the file still exists —
    // both to prove the escape actually served the out-of-root bytes and to
    // avoid the deferred open racing afterAll()'s rmSync into an unhandled ENOENT.
    if (ctx._body.kind === 'stream') {
      const chunks: Buffer[] = []
      for await (const c of ctx._body.data) chunks.push(c as Buffer)
      expect(Buffer.concat(chunks).toString()).toBe('TOP SECRET')
    }
  })
})
