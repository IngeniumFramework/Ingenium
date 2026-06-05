import { describe, it, expect } from 'vitest'
import { IngeniumContext } from '../src/context/context.ts'
import { IngeniumBadRequestError } from '../src/errors.ts'

const MAX_QUERY_PARAMS = 1000

function ctxWithQuery(raw: string): IngeniumContext {
  const ctx = new IngeniumContext()
  ctx.rawQuery = raw
  return ctx
}

/** Identity schema so the cap fires before any user validation runs. */
const identity = { parse: (i: unknown) => i }

describe('security: query param count cap', () => {
  it('throws IngeniumBadRequestError when param count exceeds the cap', () => {
    const raw = Array.from({ length: MAX_QUERY_PARAMS + 1 }, (_, i) => `k${i}=v`).join('&')
    const ctx = ctxWithQuery(raw)
    expect(() => ctx.query.parse(identity)).toThrow(IngeniumBadRequestError)
  })

  it('also caps repeated-key array promotion (a=1&a=2&...)', () => {
    const raw = Array.from({ length: MAX_QUERY_PARAMS + 5 }, () => 'a=v').join('&')
    const ctx = ctxWithQuery(raw)
    expect(() => ctx.query.parse(identity)).toThrow(IngeniumBadRequestError)
  })

  it('exactly at the cap still parses', () => {
    const raw = Array.from({ length: MAX_QUERY_PARAMS }, (_, i) => `k${i}=v`).join('&')
    const ctx = ctxWithQuery(raw)
    const out = ctx.query.parse(identity) as Record<string, string>
    expect(Object.keys(out).length).toBe(MAX_QUERY_PARAMS)
    expect(out.k0).toBe('v')
  })

  it('plain ctx.query.get() is unaffected by the cap (hot path untouched)', () => {
    const raw = Array.from({ length: MAX_QUERY_PARAMS + 50 }, (_, i) => `k${i}=v`).join('&')
    const ctx = ctxWithQuery(raw)
    // .get() never walks the full set into an object — no throw.
    expect(ctx.query.get('k0')).toBe('v')
    expect(ctx.query.get('k1042')).toBe('v')
  })
})
