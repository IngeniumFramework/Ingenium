import { describe, it, expect, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { IngeniumContext } from '../src/context/context.ts'
import {
  sessionMiddleware,
  parseCookieHeader,
  serializeCookie,
} from '../src/session/middleware.ts'
import { MemoryStore } from '../src/session/store-memory.ts'
import type { Session } from '../src/session/types.ts'

// ───── Helpers ──────────────────────────────────────────────────────────────

function makeCtx(headers: Record<string, string> = {}): IngeniumContext & { session: Session } {
  const ctx = new IngeniumContext()
  ctx.method = 'GET'
  ctx.path = '/'
  ctx.url = '/'
  ctx.headers = headers
  return ctx as IngeniumContext & { session: Session }
}

const noop = async () => {}

/** Pull the first (or only) Set-Cookie value emitted on the context. */
function getSetCookie(ctx: IngeniumContext): string | undefined {
  const v = ctx.getHeader('set-cookie')
  if (v === undefined) return undefined
  return Array.isArray(v) ? v[0] : v
}

/** Extract `name=value` from a Set-Cookie string, decoded. */
function readCookieValue(setCookie: string, name: string): string | null {
  const first = setCookie.split(';')[0]!.trim()
  const eq = first.indexOf('=')
  if (eq < 0) return null
  if (first.slice(0, eq) !== name) return null
  return decodeURIComponent(first.slice(eq + 1))
}

// ───── parseCookieHeader unit checks ────────────────────────────────────────

describe('parseCookieHeader', () => {
  it('handles multiple cookies', () => {
    expect(parseCookieHeader('a=1; b=2; c=3')).toEqual({ a: '1', b: '2', c: '3' })
  })
  it('strips surrounding quotes', () => {
    expect(parseCookieHeader('a="hello world"')).toEqual({ a: 'hello world' })
  })
  it('decodes percent-encoded values', () => {
    expect(parseCookieHeader('a=hello%20world')).toEqual({ a: 'hello world' })
  })
  it('first occurrence wins on duplicates', () => {
    expect(parseCookieHeader('a=1; a=2')).toEqual({ a: '1' })
  })
  it('skips malformed pairs', () => {
    expect(parseCookieHeader('garbage; a=1; ; =bad')).toEqual({ a: '1' })
  })
  it('returns empty object for undefined input', () => {
    expect(parseCookieHeader(undefined)).toEqual({})
  })
})

// ───── serializeCookie attribute output ─────────────────────────────────────

describe('serializeCookie', () => {
  it('emits HttpOnly + SameSite=Lax + Path=/ by default', () => {
    const out = serializeCookie('ingenium.sid', 'abc')
    expect(out).toContain('ingenium.sid=abc')
    expect(out).toContain('Path=/')
    expect(out).toContain('HttpOnly')
    expect(out).toContain('SameSite=Lax')
    expect(out).not.toContain('Secure')
  })
  it('emits Secure + SameSite=None when configured', () => {
    const out = serializeCookie('s', 'v', { secure: true, sameSite: 'none' })
    expect(out).toContain('Secure')
    expect(out).toContain('SameSite=None')
  })
  it('emits Max-Age and Expires together', () => {
    const out = serializeCookie('s', 'v', { maxAge: 60 })
    expect(out).toContain('Max-Age=60')
    expect(out).toMatch(/Expires=[^;]+GMT/)
  })
})

// ───── Middleware behaviour ─────────────────────────────────────────────────

describe('sessionMiddleware', () => {
  it('rejects empty/missing secret at construction', () => {
    expect(() => sessionMiddleware({ secret: '' })).toThrow(/secret/)
    expect(() => sessionMiddleware({ secret: [] })).toThrow(/secret/)
  })

  it('first request: no cookie → session created but NO Set-Cookie by default', async () => {
    const store = new MemoryStore(0)
    const mw = sessionMiddleware({ secret: 'k', store })
    const ctx = makeCtx()
    await mw(ctx, noop)
    expect(ctx.session).toBeDefined()
    expect(typeof ctx.session.id).toBe('string')
    // Default `saveUninitialized: false`: an empty, untouched session is NOT
    // persisted or cookied — this is what stops a cookieless-request flood from
    // filling the store (memory-DoS). A cookie is issued lazily on first write.
    expect(getSetCookie(ctx)).toBeUndefined()
    expect(store.size()).toBe(0)
  })

  it('first request with saveUninitialized:true → new session emits a signed Set-Cookie', async () => {
    const store = new MemoryStore(0)
    const mw = sessionMiddleware({ secret: 'k', store, saveUninitialized: true })
    const ctx = makeCtx()
    await mw(ctx, noop)
    const sc = getSetCookie(ctx)
    expect(sc).toBeDefined()
    const value = readCookieValue(sc!, 'ingenium.sid')!
    const dot = value.lastIndexOf('.')
    const id = value.slice(0, dot)
    const sig = value.slice(dot + 1)
    expect(id).toBe(ctx.session.id)
    expect(sig).toBe(createHmac('sha256', 'k').update(id).digest('base64url'))
  })

  it('first request: writing data persists + emits signed cookie', async () => {
    const store = new MemoryStore(0)
    const mw = sessionMiddleware({ secret: 'k', store })
    const ctx = makeCtx()
    await mw(ctx, async () => {
      ctx.session.set('user', { id: 7 })
    })
    const sc = getSetCookie(ctx)
    expect(sc).toBeDefined()
    const value = readCookieValue(sc!, 'ingenium.sid')
    expect(value).toBeTruthy()
    // Format: <id>.<sig>
    const dot = value!.lastIndexOf('.')
    expect(dot).toBeGreaterThan(0)
    const id = value!.slice(0, dot)
    const sig = value!.slice(dot + 1)
    expect(sig).toBe(createHmac('sha256', 'k').update(id).digest('base64url'))
    // Persisted
    expect(await store.get(id)).toEqual({ user: { id: 7 } })
    expect(sc!).toContain('HttpOnly')
    expect(sc!).toContain('SameSite=Lax')
  })

  it('second request: cookie loads same id, data preserved', async () => {
    const store = new MemoryStore(0)
    const mw = sessionMiddleware({ secret: 'k', store })

    // Round 1
    const ctx1 = makeCtx()
    await mw(ctx1, async () => {
      ctx1.session.set('count', 1)
    })
    const cookieValue = readCookieValue(getSetCookie(ctx1)!, 'ingenium.sid')!
    const firstId = ctx1.session.id

    // Round 2
    const ctx2 = makeCtx({ cookie: `ingenium.sid=${encodeURIComponent(cookieValue)}` })
    await mw(ctx2, noop)
    expect(ctx2.session.id).toBe(firstId)
    expect(ctx2.session.get('count')).toBe(1)
  })

  it('tampered cookie issues a fresh session (no error)', async () => {
    const store = new MemoryStore(0)
    const mw = sessionMiddleware({ secret: 'k', store })
    // Pre-populate a session and steal its id, then forge a bogus signature.
    await store.set('stolen-id', { admin: true }, 60)
    const ctx = makeCtx({ cookie: `ingenium.sid=${encodeURIComponent('stolen-id.notavalidsig')}` })
    await mw(ctx, noop)
    expect(ctx.session.id).not.toBe('stolen-id')
    expect(ctx.session.get('admin')).toBeUndefined()
  })

  it('unchanged session does NOT touch store', async () => {
    const store = new MemoryStore(0)
    const touchSpy = vi.spyOn(store, 'touch')
    const setSpy = vi.spyOn(store, 'set')

    const mw = sessionMiddleware({ secret: 'k', store })

    // Seed via a write request.
    const c1 = makeCtx()
    await mw(c1, async () => {
      c1.session.set('x', 1)
    })
    const cookieValue = readCookieValue(getSetCookie(c1)!, 'ingenium.sid')!
    setSpy.mockClear()
    touchSpy.mockClear()

    // Read-only request — should not write or touch.
    const c2 = makeCtx({ cookie: `ingenium.sid=${encodeURIComponent(cookieValue)}` })
    await mw(c2, noop)
    expect(setSpy).not.toHaveBeenCalled()
    expect(touchSpy).not.toHaveBeenCalled()
    expect(getSetCookie(c2)).toBeUndefined()
  })

  it('rolling: true → unchanged session refreshes cookie + touches store', async () => {
    const store = new MemoryStore(0)
    const touchSpy = vi.spyOn(store, 'touch')
    const mw = sessionMiddleware({ secret: 'k', store, rolling: true, maxAgeSeconds: 120 })

    const c1 = makeCtx()
    await mw(c1, async () => {
      c1.session.set('x', 1)
    })
    const cookieValue = readCookieValue(getSetCookie(c1)!, 'ingenium.sid')!
    touchSpy.mockClear()

    const c2 = makeCtx({ cookie: `ingenium.sid=${encodeURIComponent(cookieValue)}` })
    await mw(c2, noop)
    expect(touchSpy).toHaveBeenCalledTimes(1)
    const sc = getSetCookie(c2)
    expect(sc).toBeDefined()
    expect(sc!).toContain('Max-Age=120')
  })

  it('destroy() clears cookie (Max-Age=0) and removes from store', async () => {
    const store = new MemoryStore(0)
    const mw = sessionMiddleware({ secret: 'k', store })

    const c1 = makeCtx()
    await mw(c1, async () => {
      c1.session.set('user', 'alice')
    })
    const cookieValue = readCookieValue(getSetCookie(c1)!, 'ingenium.sid')!
    const id = ctxIdFromCookie(cookieValue)
    expect(await store.get(id)).not.toBeNull()

    const c2 = makeCtx({ cookie: `ingenium.sid=${encodeURIComponent(cookieValue)}` })
    await mw(c2, async () => {
      await c2.session.destroy()
    })
    const sc = getSetCookie(c2)!
    expect(sc).toContain('Max-Age=0')
    expect(await store.get(id)).toBeNull()
  })

  it('regenerate() issues new id, copies data, removes old id', async () => {
    const store = new MemoryStore(0)
    const mw = sessionMiddleware({ secret: 'k', store })

    const c1 = makeCtx()
    await mw(c1, async () => {
      c1.session.set('user', 'bob')
    })
    const cookieValue = readCookieValue(getSetCookie(c1)!, 'ingenium.sid')!
    const oldId = ctxIdFromCookie(cookieValue)

    const c2 = makeCtx({ cookie: `ingenium.sid=${encodeURIComponent(cookieValue)}` })
    let newId: string | undefined
    await mw(c2, async () => {
      await c2.session.regenerate()
      newId = c2.session.id
    })
    expect(newId).toBeDefined()
    expect(newId).not.toBe(oldId)
    // Old gone, new persisted with same data
    expect(await store.get(oldId)).toBeNull()
    expect(await store.get(newId!)).toEqual({ user: 'bob' })
    // Cookie now carries the new id
    const sc = getSetCookie(c2)!
    expect(readCookieValue(sc, 'ingenium.sid')!.startsWith(`${newId}.`)).toBe(true)
  })

  it('secret rotation: cookie signed with secret[1] verifies AND is re-signed with secret[0]', async () => {
    const store = new MemoryStore(0)
    // Phase 1 — sign with `oldkey`.
    const old = sessionMiddleware({ secret: 'oldkey', store })
    const c1 = makeCtx()
    await old(c1, async () => {
      c1.session.set('v', 1)
    })
    const oldCookie = readCookieValue(getSetCookie(c1)!, 'ingenium.sid')!
    const oldSig = oldCookie.slice(oldCookie.lastIndexOf('.') + 1)

    // Phase 2 — middleware now rotates: new key is primary, old still valid.
    const rotated = sessionMiddleware({ secret: ['newkey', 'oldkey'], store })
    const c2 = makeCtx({ cookie: `ingenium.sid=${encodeURIComponent(oldCookie)}` })
    await rotated(c2, noop)

    // Loaded the same session.
    expect(c2.session.get('v')).toBe(1)

    // Re-signed with new key on response (no data change, but secret moved).
    const sc = getSetCookie(c2)
    expect(sc).toBeDefined()
    const newCookie = readCookieValue(sc!, 'ingenium.sid')!
    const newSig = newCookie.slice(newCookie.lastIndexOf('.') + 1)
    expect(newSig).not.toBe(oldSig)
    const id = newCookie.slice(0, newCookie.lastIndexOf('.'))
    expect(newSig).toBe(createHmac('sha256', 'newkey').update(id).digest('base64url'))
  })

  it('secure: true + sameSite: none stamps both cookie attributes', async () => {
    const store = new MemoryStore(0)
    const mw = sessionMiddleware({
      secret: 'k',
      store,
      cookie: { secure: true, sameSite: 'none' },
    })
    const ctx = makeCtx()
    await mw(ctx, async () => {
      ctx.session.set('a', 1)
    })
    const sc = getSetCookie(ctx)!
    expect(sc).toContain('Secure')
    expect(sc).toContain('SameSite=None')
  })

  it('cookieName option overrides the default name', async () => {
    const store = new MemoryStore(0)
    const mw = sessionMiddleware({ secret: 'k', store, cookieName: 'app.sid' })
    const ctx = makeCtx()
    await mw(ctx, async () => {
      ctx.session.set('a', 1)
    })
    const sc = getSetCookie(ctx)!
    expect(sc.startsWith('app.sid=')).toBe(true)
  })
})

/** Pull the id portion (`<id>.<sig>` → `<id>`) from a cookie value. */
function ctxIdFromCookie(cookieValue: string): string {
  const dot = cookieValue.lastIndexOf('.')
  return cookieValue.slice(0, dot)
}
