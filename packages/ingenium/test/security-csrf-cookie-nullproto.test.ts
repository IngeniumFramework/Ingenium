import { describe, it, expect } from 'vitest'
import { IngeniumContext } from '../src/context/context.ts'
import { csrfMiddleware, IngeniumCsrfError } from '../src/csrf/middleware.ts'

const SECRET = 'nullproto-secret-1'

function ctx(
  method: string,
  headers: Record<string, string | string[]> = {},
  query = '',
): IngeniumContext {
  const c = new IngeniumContext()
  c.method = method as 'GET'
  c.headers = headers
  c.rawQuery = query
  return c
}

const next = (): Promise<void> => Promise.resolve()

function readSetCookie(c: IngeniumContext): string[] {
  const v = c._headers['set-cookie']
  return Array.isArray(v) ? v : v ? [v as string] : []
}

function tokenFromCookie(c: IngeniumContext, name = 'ingenium.csrf'): string | null {
  for (const ck of readSetCookie(c)) {
    const m = ck.match(new RegExp(`^${name}=([^;]+)`))
    if (m) return decodeURIComponent(m[1]!)
  }
  return null
}

describe('csrf cookie parser is null-prototype', () => {
  it('honors the real csrf cookie when a prototype-named cookie precedes it', async () => {
    const mw = csrfMiddleware({ secret: SECRET })

    // Mint a real token via a safe request.
    const mint = ctx('GET')
    await mw(mint, next)
    const token = tokenFromCookie(mint)!
    expect(token).toBeTruthy()

    // Unsafe request whose Cookie header carries prototype-member-named cookies
    // (`toString`, `constructor`, `__proto__`) BEFORE the real csrf cookie. On
    // an inherited-prototype object the `k in out` guard would see `toString`
    // etc. as already-present and could mis-handle parsing; the real cookie
    // must still be read as own-data and validation must pass.
    const post = ctx('POST', {
      cookie: [
        'toString=foo',
        'constructor=bar',
        '__proto__=baz',
        'hasOwnProperty=qux',
        `ingenium.csrf=${encodeURIComponent(token)}`,
      ].join('; '),
      'x-csrf-token': token,
    })
    await expect(mw(post, next)).resolves.toBeUndefined()
  })

  it('first-wins still applies for the csrf cookie alongside prototype names', async () => {
    const mw = csrfMiddleware({ secret: SECRET })
    const mint = ctx('GET')
    await mw(mint, next)
    const token = tokenFromCookie(mint)!

    // Real csrf cookie first, then a duplicate with a bogus value. First
    // occurrence must win, so validation against `token` succeeds even though
    // prototype-named cookies share the header.
    const post = ctx('POST', {
      cookie: [
        '__proto__=poison',
        `ingenium.csrf=${encodeURIComponent(token)}`,
        'ingenium.csrf=tampered',
        'toString=evil',
      ].join('; '),
      'x-csrf-token': token,
    })
    await expect(mw(post, next)).resolves.toBeUndefined()
  })

  it('a prototype-named cookie does not satisfy a missing csrf cookie', async () => {
    const mw = csrfMiddleware({ secret: SECRET })
    const mint = ctx('GET')
    await mw(mint, next)
    const token = tokenFromCookie(mint)!

    // No real csrf cookie present — only a prototype-named one. The submitted
    // header token cannot match a freshly-minted expected token, so the request
    // is rejected rather than the parser falling back to an inherited member.
    const post = ctx('POST', {
      cookie: 'toString=function () { [native code] }',
      'x-csrf-token': token,
    })
    await expect(mw(post, next)).rejects.toBeInstanceOf(IngeniumCsrfError)
  })
})
