import { describe, it, expect, beforeAll } from 'vitest'
import { ingenium } from '../src/index.ts'
import { enableWebSockets } from '../src/ws/index.ts'

// Probe for the optional `ws` peer dep at module load. Like the sibling WS
// suites, this whole file is skipped when `ws` is not installed.
let hasWs = false
try {
  await import('ws')
  hasWs = true
} catch {
  hasWs = false
}

// Minimal subset of the `ws.WebSocket` client API we touch here. The `ws`
// client accepts an options bag where we can set request headers (Origin,
// X-Forwarded-For) to simulate the various upgrade scenarios.
interface WsClient {
  on(event: 'open', listener: () => void): void
  on(event: 'error', listener: (err: Error) => void): void
  on(event: 'close', listener: (code: number) => void): void
  on(event: 'message', listener: (data: unknown) => void): void
  close(): void
}
interface WsModuleLike {
  WebSocket: new (url: string, opts?: { headers?: Record<string, string> }) => WsClient
}

let WS: WsModuleLike

beforeAll(async () => {
  if (!hasWs) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import('ws')
  WS = { WebSocket: mod.WebSocket ?? mod.default ?? mod }
})

interface Captured {
  remoteAddress: string
  ip: string
}

/**
 * Connect to a WS route whose handler echoes back the context info it captured,
 * then resolve with that info. The server handler does `ws.send(JSON)` on the
 * connection; the client reads the first message and settles. A short bounded
 * timeout keeps the test deterministic if the handshake/message never arrives.
 */
function captureContext(url: string, headers?: Record<string, string>): Promise<Captured> {
  return new Promise((resolve, reject) => {
    const c = new WS.WebSocket(url, headers ? { headers } : undefined)
    const timer = setTimeout(() => reject(new Error('timed out waiting for ws message')), 2000)
    c.on('message', (data) => {
      clearTimeout(timer)
      const text = typeof data === 'string' ? data : String(data)
      resolve(JSON.parse(text) as Captured)
      c.close()
    })
    c.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

describe.skipIf(!hasWs)('security: ws minimal context surfaces remoteAddress + trustProxy', () => {
  it('sets ctx.remoteAddress to the loopback peer and resolves a non-empty ctx.ip', async () => {
    const app = ingenium()
    enableWebSockets(app)
    // origin: false => allow all (we are exercising context wiring, not CSWSH).
    app.ws(
      '/probe',
      (ws, ctx) => {
        ws.send(JSON.stringify({ remoteAddress: ctx.remoteAddress, ip: ctx.ip }))
      },
      { origin: false },
    )

    const server = await app.listen(0)
    try {
      const info = await captureContext(`ws://127.0.0.1:${server.port}/probe`)
      // The peer is the loopback client. node surfaces this as 127.0.0.1 or ::1
      // (or ::ffff:127.0.0.1) depending on the resolved family. It must be a
      // real loopback value, not the empty string.
      expect(info.remoteAddress).toBeTruthy()
      expect(
        info.remoteAddress === '127.0.0.1' ||
          info.remoteAddress === '::1' ||
          info.remoteAddress === '::ffff:127.0.0.1',
      ).toBe(true)
      // ctx.ip must resolve to something (defaults to the socket peer when no
      // trust-proxy chain applies). The pre-fix bug returned the pool default
      // in a way that ignored the real socket — this asserts ip is populated.
      expect(info.ip).toBeTruthy()
    } finally {
      await server.close({ gracefulTimeoutMs: 100 })
    }
  })

  it('honors the app trust-proxy config so ctx.ip resolves the X-Forwarded-For chain', async () => {
    // trustProxy: true is threaded into the registrar by enableWebSockets and
    // carried onto ctx via the fix (ctx._trustProxy). If _trustProxy were NOT
    // wired, ctx.ip would fall back to the socket peer and ignore XFF entirely.
    const app = ingenium({ trustProxy: true })
    enableWebSockets(app)
    app.ws(
      '/probe',
      (ws, ctx) => {
        ws.send(JSON.stringify({ remoteAddress: ctx.remoteAddress, ip: ctx.ip }))
      },
      { origin: false },
    )

    const server = await app.listen(0)
    try {
      const info = await captureContext(`ws://127.0.0.1:${server.port}/probe`, {
        'X-Forwarded-For': '203.0.113.7',
      })
      // With trust-proxy on, the forwarded client IP wins over the socket peer.
      expect(info.ip).toBe('203.0.113.7')
      // remoteAddress still reflects the real loopback socket, distinct from
      // the spoofable forwarded value.
      expect(info.remoteAddress).not.toBe('203.0.113.7')
      expect(info.remoteAddress).toBeTruthy()
    } finally {
      await server.close({ gracefulTimeoutMs: 100 })
    }
  })
})
