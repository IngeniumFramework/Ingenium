import { describe, it, expect } from 'vitest'
import { IngeniumContext, IngeniumUnauthorizedError } from 'ingenium'
import { apiKeyMiddleware } from '../src/api-key/middleware.ts'

function ctxWith(headers: Record<string, string | string[]> = {}, query = ''): IngeniumContext {
  const c = new IngeniumContext()
  c.method = 'GET'
  c.headers = headers
  c.rawQuery = query
  return c
}

function next(): Promise<void> {
  return Promise.resolve()
}

describe('apiKeyMiddleware', () => {
  it('accepts a valid key in the default x-api-key header and sets ctx.apiKey', async () => {
    const mw = apiKeyMiddleware({ keys: ['k1-secret', 'k2-secret'], logger: () => {} })
    const c = ctxWith({ 'x-api-key': 'k1-secret' })
    let nextCalled = false
    await mw(c, async () => {
      nextCalled = true
    })
    expect(nextCalled).toBe(true)
    expect((c as IngeniumContext & { apiKey?: string }).apiKey).toBe('k1-secret')
  })

  it('rejects an invalid key with 401 IngeniumUnauthorizedError', async () => {
    const mw = apiKeyMiddleware({ keys: ['k1'], logger: () => {} })
    const c = ctxWith({ 'x-api-key': 'wrong' })
    await expect(mw(c, next)).rejects.toBeInstanceOf(IngeniumUnauthorizedError)
    await expect(mw(c, next)).rejects.toThrow('Invalid API key')
  })

  it('throws on missing key when required=true (default)', async () => {
    const mw = apiKeyMiddleware({ keys: ['k1'], logger: () => {} })
    const c = ctxWith({})
    await expect(mw(c, next)).rejects.toBeInstanceOf(IngeniumUnauthorizedError)
  })

  it('calls next without setting ctx.apiKey when missing + required=false', async () => {
    const mw = apiKeyMiddleware({ keys: ['k1'], required: false, logger: () => {} })
    const c = ctxWith({})
    let nextCalled = false
    await mw(c, async () => {
      nextCalled = true
    })
    expect(nextCalled).toBe(true)
    expect((c as IngeniumContext & { apiKey?: string }).apiKey).toBeUndefined()
  })

  it('accepts a synchronous validator function', async () => {
    const mw = apiKeyMiddleware({
      keys: (k) => k.startsWith('valid-'),
      logger: () => {},
    })
    const ok = ctxWith({ 'x-api-key': 'valid-abc' })
    const bad = ctxWith({ 'x-api-key': 'invalid-abc' })
    await expect(mw(ok, next)).resolves.toBeUndefined()
    expect((ok as IngeniumContext & { apiKey?: string }).apiKey).toBe('valid-abc')
    await expect(mw(bad, next)).rejects.toBeInstanceOf(IngeniumUnauthorizedError)
  })

  it('accepts an async validator function', async () => {
    const mw = apiKeyMiddleware({
      keys: async (k) => {
        await Promise.resolve()
        return k === 'async-valid'
      },
      logger: () => {},
    })
    const ok = ctxWith({ 'x-api-key': 'async-valid' })
    const bad = ctxWith({ 'x-api-key': 'nope' })
    await expect(mw(ok, next)).resolves.toBeUndefined()
    await expect(mw(bad, next)).rejects.toBeInstanceOf(IngeniumUnauthorizedError)
  })

  it('honors a custom header name', async () => {
    const mw = apiKeyMiddleware({ keys: ['k1'], header: 'x-custom-auth', logger: () => {} })
    const c = ctxWith({ 'x-custom-auth': 'k1' })
    await expect(mw(c, next)).resolves.toBeUndefined()
    expect((c as IngeniumContext & { apiKey?: string }).apiKey).toBe('k1')
  })

  it('reads the key from Authorization: ApiKey <key> when scheme is set', async () => {
    const mw = apiKeyMiddleware({ keys: ['k1'], scheme: 'ApiKey', logger: () => {} })
    const c = ctxWith({ authorization: 'ApiKey k1' })
    await expect(mw(c, next)).resolves.toBeUndefined()
    expect((c as IngeniumContext & { apiKey?: string }).apiKey).toBe('k1')
  })

  it('Authorization scheme matching is case-insensitive', async () => {
    const mw = apiKeyMiddleware({ keys: ['k1'], scheme: 'ApiKey', logger: () => {} })
    const c = ctxWith({ authorization: 'apikey k1' })
    await expect(mw(c, next)).resolves.toBeUndefined()
  })

  it('falls back to the configured query parameter when no header is present', async () => {
    const mw = apiKeyMiddleware({ keys: ['k1'], query: 'api_key', logger: () => {} })
    const c = ctxWith({}, 'api_key=k1')
    await expect(mw(c, next)).resolves.toBeUndefined()
    expect((c as IngeniumContext & { apiKey?: string }).apiKey).toBe('k1')
  })

  it('header takes priority over scheme over query', async () => {
    const mw = apiKeyMiddleware({
      keys: ['header-key', 'scheme-key', 'query-key'],
      scheme: 'ApiKey',
      query: 'api_key',
      logger: () => {},
    })
    const c = ctxWith(
      { 'x-api-key': 'header-key', authorization: 'ApiKey scheme-key' },
      'api_key=query-key',
    )
    await expect(mw(c, next)).resolves.toBeUndefined()
    expect((c as IngeniumContext & { apiKey?: string }).apiKey).toBe('header-key')
  })

  it('rejects length-mismatched keys without throwing (no length oracle)', async () => {
    // Key list contains a 5-char key. Submitting a 4-char key must NOT throw
    // synchronously from inside timingSafeEqual (which would happen if we
    // skipped the equal-length guard).
    const mw = apiKeyMiddleware({ keys: ['abcde'], logger: () => {} })
    const c = ctxWith({ 'x-api-key': 'abcd' })
    await expect(mw(c, next)).rejects.toBeInstanceOf(IngeniumUnauthorizedError)
    // Confirm we got the authorization error, not a TypeError from crypto.
    await expect(mw(c, next)).rejects.toThrow('Invalid API key')
  })

  it('does not leak which surface or which list entry failed', async () => {
    const mw = apiKeyMiddleware({
      keys: ['k1', 'k2', 'k3'],
      scheme: 'ApiKey',
      query: 'api_key',
      logger: () => {},
    })
    // Wrong key in each surface.
    for (const c of [
      ctxWith({ 'x-api-key': 'wrong' }),
      ctxWith({ authorization: 'ApiKey wrong' }),
      ctxWith({}, 'api_key=wrong'),
    ]) {
      await expect(mw(c, next)).rejects.toThrow(/^Invalid API key$/)
    }
  })

  it('throws at construction when keys is missing or empty', () => {
    // @ts-expect-error - missing keys
    expect(() => apiKeyMiddleware({})).toThrow()
    expect(() => apiKeyMiddleware({ keys: [] })).toThrow()
    expect(() => apiKeyMiddleware({ keys: [''] })).toThrow()
  })
})
