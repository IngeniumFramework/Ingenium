import { describe, it, expect } from 'vitest'
import { IngeniumContext } from '../src/context/context.ts'

const MAX_COOKIES = 150

function ctxWithCookie(cookieHeader: string): IngeniumContext {
  const c = new IngeniumContext()
  c.headers = { cookie: cookieHeader }
  return c
}

describe('security: cookie count cap', () => {
  it('retains at most MAX_COOKIES and never throws on a flood', () => {
    const header = Array.from({ length: 5000 }, (_, i) => `c${i}=v`).join('; ')
    const ctx = ctxWithCookie(header)
    let all: Record<string, string> = {}
    expect(() => {
      all = ctx.cookies.all()
    }).not.toThrow()
    expect(Object.keys(all).length).toBe(MAX_COOKIES)
    // First-seen cookies win and are retained.
    expect(ctx.cookies.get('c0')).toBe('v')
    expect(ctx.cookies.get(`c${MAX_COOKIES - 1}`)).toBe('v')
    // Cookies past the cap are dropped.
    expect(ctx.cookies.get(`c${MAX_COOKIES}`)).toBeNull()
    expect(ctx.cookies.get('c4999')).toBeNull()
  })

  it('a normal-sized header parses fully', () => {
    const ctx = ctxWithCookie('sid=abc; theme=dark; lang=en')
    expect(ctx.cookies.all()).toEqual({ sid: 'abc', theme: 'dark', lang: 'en' })
  })

  it('completes quickly under a large flood (no hang)', () => {
    const header = Array.from({ length: 50000 }, (_, i) => `c${i}=v`).join('; ')
    const ctx = ctxWithCookie(header)
    const start = Date.now()
    const all = ctx.cookies.all()
    expect(Date.now() - start).toBeLessThan(1000)
    expect(Object.keys(all).length).toBe(MAX_COOKIES)
  })
})
