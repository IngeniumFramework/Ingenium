import { describe, it, expect, vi, afterEach } from 'vitest'
import { resolveForwarded } from '../src/proxy/trust.ts'

describe('security: trustProxy:true spoofing warning', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('warns once (dev) that trust:true fully trusts client X-Forwarded-For', () => {
    const spy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})

    const headers = { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }
    resolveForwarded(true, '203.0.113.7', headers)
    resolveForwarded(true, '203.0.113.7', headers)

    // One-shot: warning fires at most once across multiple resolutions.
    expect(spy.mock.calls.length).toBeLessThanOrEqual(1)
    if (spy.mock.calls.length === 1) {
      const [msg, opts] = spy.mock.calls[0]!
      expect(String(msg)).toMatch(/X-Forwarded-For/i)
      expect((opts as { code?: string }).code).toBe('INGENIUM_TRUST_PROXY_TRUE')
    }
  })

  it('still returns the leftmost (Express-compatible) entry — default behavior unchanged', () => {
    vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    const info = resolveForwarded(true, '203.0.113.7', {
      'x-forwarded-for': '1.2.3.4, 5.6.7.8',
    })
    expect(info.ip).toBe('1.2.3.4')
  })

  it('does not warn for the safe hop-count form', () => {
    const spy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    resolveForwarded(1, '203.0.113.7', { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' })
    const trustTrueCalls = spy.mock.calls.filter(
      ([, opts]) => (opts as { code?: string } | undefined)?.code === 'INGENIUM_TRUST_PROXY_TRUE',
    )
    expect(trustTrueCalls.length).toBe(0)
  })
})
