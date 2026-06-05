import { describe, it, expect } from 'vitest'
import { IngeniumContext } from '../src/context/context.ts'
import { csrfMiddleware, IngeniumCsrfError } from '../src/csrf/middleware.ts'
import { IngeniumHeaderInjectionError } from '../src/errors.ts'

const SECRET = 'binding-secret-1'

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

describe('csrf session-binding (finding #4)', () => {
  it('rejects a token minted for a different session', async () => {
    const mw = csrfMiddleware({
      secret: SECRET,
      sessionBinding: (c) => (c.headers['x-session'] as string) || undefined,
    })

    // Mint a token bound to session "alice".
    const mint = ctx('GET', { 'x-session': 'alice' })
    await mw(mint, next)
    const aliceToken = tokenFromCookie(mint)!
    expect(aliceToken).toBeTruthy()

    // Replay alice's token (cookie + header) under session "bob" → rejected,
    // because the binding folded into the signature no longer matches.
    const attack = ctx('POST', {
      'x-session': 'bob',
      cookie: `ingenium.csrf=${encodeURIComponent(aliceToken)}`,
      'x-csrf-token': aliceToken,
    })
    await expect(mw(attack, next)).rejects.toBeInstanceOf(IngeniumCsrfError)
  })

  it('accepts a token replayed within the same session', async () => {
    const mw = csrfMiddleware({
      secret: SECRET,
      sessionBinding: (c) => (c.headers['x-session'] as string) || undefined,
    })
    const mint = ctx('GET', { 'x-session': 'alice' })
    await mw(mint, next)
    const token = tokenFromCookie(mint)!

    const post = ctx('POST', {
      'x-session': 'alice',
      cookie: `ingenium.csrf=${encodeURIComponent(token)}`,
      'x-csrf-token': token,
    })
    await expect(mw(post, next)).resolves.toBeUndefined()
  })
})

describe('csrf secure-by-default (finding #7)', () => {
  it('issues the cookie with Secure by default', async () => {
    const mw = csrfMiddleware({ secret: SECRET })
    const c = ctx('GET')
    await mw(c, next)
    expect(readSetCookie(c)[0]).toMatch(/;\s*Secure/)
  })

  it('omits Secure only when explicitly disabled', async () => {
    const mw = csrfMiddleware({ secret: SECRET, cookie: { secure: false } })
    const c = ctx('GET')
    await mw(c, next)
    expect(readSetCookie(c)[0]).not.toMatch(/;\s*Secure/)
  })
})

describe('csrf cookie-attr header injection (honorable mention)', () => {
  it('rejects CR/LF in cookie path', () => {
    expect(() => csrfMiddleware({ secret: SECRET, cookie: { path: '/a\r\nSet-Cookie: x=y' } })).toThrow(
      IngeniumHeaderInjectionError,
    )
  })

  it('rejects CR/LF in cookie domain', () => {
    expect(() => csrfMiddleware({ secret: SECRET, cookie: { domain: 'evil\nx' } })).toThrow(
      IngeniumHeaderInjectionError,
    )
  })

  it('rejects CR/LF in cookie name', () => {
    expect(() => csrfMiddleware({ secret: SECRET, cookie: { name: 'csrf\rx' } })).toThrow(
      IngeniumHeaderInjectionError,
    )
  })
})
