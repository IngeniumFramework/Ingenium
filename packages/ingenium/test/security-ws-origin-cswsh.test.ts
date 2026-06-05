import { describe, it, expect, beforeAll } from 'vitest'
import { ingenium } from '../src/index.ts'
import { enableWebSockets } from '../src/ws/index.ts'

// Probe for the optional `ws` peer dep at module load. Like ws.test.ts, the
// suite is skipped when `ws` is not installed.
let hasWs = false
try {
  await import('ws')
  hasWs = true
} catch {
  hasWs = false
}

// Minimal subset of the `ws.WebSocket` client API we touch here. The `ws`
// client (unlike the browser WebSocket) accepts an options bag where we can
// set request headers — including `Origin` — to simulate a cross-site upgrade.
interface WsModuleLike {
  WebSocket: new (url: string, opts?: { headers?: Record<string, string> }) => {
    on(event: 'open', listener: () => void): void
    on(event: 'error', listener: (err: Error) => void): void
    on(event: 'close', listener: (code: number) => void): void
    on(event: 'unexpected-response', listener: (req: unknown, res: { statusCode?: number }) => void): void
    close(): void
  }
}

let WS: WsModuleLike

beforeAll(async () => {
  if (!hasWs) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import('ws')
  WS = { WebSocket: mod.WebSocket ?? mod.default ?? mod }
})

/**
 * Attempt an upgrade with the given Origin header and report the outcome.
 * Returns `'opened'` if the handshake completed, or `'rejected'` (with the
 * HTTP status, when surfaced) if the server refused the upgrade.
 */
function attempt(
  url: string,
  origin?: string,
): Promise<{ outcome: 'opened' | 'rejected'; status?: number }> {
  return new Promise((resolve) => {
    const headers = origin !== undefined ? { Origin: origin } : undefined
    const c = new WS.WebSocket(url, headers ? { headers } : undefined)
    let status: number | undefined
    // Registering an 'unexpected-response' listener suppresses ws's automatic
    // 'error'/'close' on a rejected upgrade, so we must settle here ourselves.
    c.on('unexpected-response', (_req, res) => {
      status = res.statusCode
      resolve(status !== undefined ? { outcome: 'rejected', status } : { outcome: 'rejected' })
    })
    c.on('open', () => {
      resolve({ outcome: 'opened' })
      c.close()
    })
    const reject = () =>
      resolve(status !== undefined ? { outcome: 'rejected', status } : { outcome: 'rejected' })
    c.on('error', reject)
    c.on('close', reject)
  })
}

describe.skipIf(!hasWs)('security: ws Origin / CSWSH', () => {
  it('rejects a cross-origin upgrade with origin: true (same-origin policy)', async () => {
    const app = ingenium()
    enableWebSockets(app)
    app.ws('/echo', () => { /* should never be reached cross-origin */ }, { origin: true })

    const server = await app.listen(0)
    try {
      const res = await attempt(`ws://127.0.0.1:${server.port}/echo`, 'http://evil.example')
      expect(res.outcome).toBe('rejected')
      expect(res.status).toBe(403)
    } finally {
      await server.close({ gracefulTimeoutMs: 100 })
    }
  })

  it('allows a same-origin upgrade with origin: true', async () => {
    const app = ingenium()
    enableWebSockets(app)
    app.ws('/echo', () => { /* upgrade only */ }, { origin: true })

    const server = await app.listen(0)
    try {
      const host = `127.0.0.1:${server.port}`
      const res = await attempt(`ws://${host}/echo`, `http://${host}`)
      expect(res.outcome).toBe('opened')
    } finally {
      await server.close({ gracefulTimeoutMs: 100 })
    }
  })

  it('enforces an exact string allowlist', async () => {
    const app = ingenium()
    enableWebSockets(app)
    app.ws('/echo', () => { /* upgrade only */ }, { origin: 'https://trusted.example' })

    const server = await app.listen(0)
    try {
      const ok = await attempt(`ws://127.0.0.1:${server.port}/echo`, 'https://trusted.example')
      expect(ok.outcome).toBe('opened')

      const bad = await attempt(`ws://127.0.0.1:${server.port}/echo`, 'https://attacker.example')
      expect(bad.outcome).toBe('rejected')
      expect(bad.status).toBe(403)
    } finally {
      await server.close({ gracefulTimeoutMs: 100 })
    }
  })

  it('enforces an array allowlist', async () => {
    const app = ingenium()
    enableWebSockets(app)
    app.ws('/echo', () => { /* upgrade only */ }, {
      origin: ['https://a.example', 'https://b.example'],
    })

    const server = await app.listen(0)
    try {
      const ok = await attempt(`ws://127.0.0.1:${server.port}/echo`, 'https://b.example')
      expect(ok.outcome).toBe('opened')

      const bad = await attempt(`ws://127.0.0.1:${server.port}/echo`, 'https://c.example')
      expect(bad.outcome).toBe('rejected')
    } finally {
      await server.close({ gracefulTimeoutMs: 100 })
    }
  })

  it('delegates to a custom verifier function', async () => {
    const app = ingenium()
    enableWebSockets(app)
    app.ws('/echo', () => { /* upgrade only */ }, {
      origin: (origin) => origin === 'https://allowed.example',
    })

    const server = await app.listen(0)
    try {
      const ok = await attempt(`ws://127.0.0.1:${server.port}/echo`, 'https://allowed.example')
      expect(ok.outcome).toBe('opened')

      const bad = await attempt(`ws://127.0.0.1:${server.port}/echo`, 'https://denied.example')
      expect(bad.outcome).toBe('rejected')
    } finally {
      await server.close({ gracefulTimeoutMs: 100 })
    }
  })

  it('preserves backward compat: no origin option => upgrade allowed', async () => {
    const app = ingenium()
    enableWebSockets(app)
    app.ws('/echo', () => { /* upgrade only */ })

    const server = await app.listen(0)
    try {
      const res = await attempt(`ws://127.0.0.1:${server.port}/echo`, 'http://anywhere.example')
      expect(res.outcome).toBe('opened')
    } finally {
      await server.close({ gracefulTimeoutMs: 100 })
    }
  })
})
