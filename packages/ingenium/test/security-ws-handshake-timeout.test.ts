/**
 * Slowloris defense: the WS upgrade handshake must not be allowed to stall
 * indefinitely. A client can open the TCP socket, send an upgrade that Node
 * accepts (so `'upgrade'` fires) but never drives the handshake to completion,
 * pinning the file descriptor forever.
 *
 * The registrar arms an ABSOLUTE `setTimeout(handshakeTimeoutMs)` deadline at
 * the TOP of its upgrade listener (not an idle `socket.setTimeout`, which an
 * active byte-trickle could keep resetting) and destroys the socket when it
 * fires, clearing it the instant `handleUpgrade` completes or the socket
 * closes. We exercise this with a REAL
 * `http.Server` and a REAL `net.Socket`: we mock `ws` so its `handleUpgrade`
 * never resolves the handshake (the callback is never invoked) — this is the
 * "stalled handshake" the deadline exists to defend against. We then assert the
 * pinned socket is destroyed shortly after the (tiny, 50ms) deadline.
 *
 * Mocking `ws` keeps the test independent of whether the optional peer dep is
 * installed AND lets us hold the handshake pending deterministically (a real
 * `ws.handleUpgrade` resolves synchronously, so it never reaches the deadline).
 */
import { describe, it, expect, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { Socket } from 'node:net'

// A `ws` mock whose WebSocketServer.handleUpgrade NEVER calls its callback, so
// the handshake stays pending and the armed handshake deadline is what closes
// the socket.
vi.mock('ws', () => {
  class StalledWebSocketServer {
    clients = new Set<unknown>()
    constructor(_options: Record<string, unknown>) {}
    handleUpgrade(
      _req: unknown,
      _socket: unknown,
      _head: unknown,
      _cb: (ws: unknown) => void,
    ): void {
      // Intentionally never invoke `_cb` — the handshake hangs forever. The
      // registrar's `socket.setTimeout(...)` deadline must reclaim the socket.
    }
    close(cb?: () => void): void {
      cb?.()
    }
  }
  return { WebSocketServer: StalledWebSocketServer, WebSocket: class {} }
})

import { createWebSocketRegistrar } from '../src/ws/middleware.ts'

/** Resolve once the server is listening; return the bound port. */
function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr === null || typeof addr === 'string') throw new Error('no port')
      resolve(addr.port)
    })
  })
}

function closeServer(server: Server): Promise<void> {
  // Force-drop any lingering connections (e.g. a still-pending upgrade socket
  // in the opt-out case) so `close` resolves promptly during teardown. An
  // upgraded socket is detached from the server's connection bookkeeping, so
  // `close()`'s callback may never fire — resolve on a short grace timer too so
  // teardown can't hang the suite.
  server.closeAllConnections?.()
  return new Promise((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolve()
    }
    server.close(done)
    setTimeout(done, 100).unref()
  })
}

/** A structurally-complete upgrade request so Node emits 'upgrade'. */
function upgradeRequest(port: number): string {
  return (
    'GET /ws HTTP/1.1\r\n' +
    `Host: 127.0.0.1:${port}\r\n` +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
    'Sec-WebSocket-Version: 13\r\n' +
    '\r\n'
  )
}

describe('security: ws handshake timeout (slowloris)', () => {
  it('destroys a stalled upgrade socket after handshakeTimeoutMs', async () => {
    const HANDSHAKE_TIMEOUT_MS = 50

    const registrar = createWebSocketRegistrar({ handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS })
    registrar.add('/ws', () => {}, { origin: false })

    const server = createServer()
    registrar.attach(server)
    const port = await listen(server)

    try {
      const t0 = Date.now()
      const elapsed = await new Promise<number>((resolve) => {
        const socket = new Socket()
        let settled = false
        const finish = (value: number) => {
          if (settled) return
          settled = true
          resolve(value)
        }

        // Hard ceiling so a regression (deadline never fires) fails fast rather
        // than hanging the suite. Well above the 50ms deadline.
        const guard = setTimeout(() => {
          socket.destroy()
          finish(Number.POSITIVE_INFINITY)
        }, 2000)

        // The server destroying our socket surfaces as 'close' (and possibly an
        // ECONNRESET 'error' on some platforms) — both mean the FD was reclaimed.
        const onGone = () => {
          clearTimeout(guard)
          finish(Date.now() - t0)
        }
        socket.on('close', onGone)
        socket.on('error', onGone)

        socket.connect(port, '127.0.0.1', () => {
          // Send a complete upgrade so Node emits 'upgrade' and the registrar
          // arms the deadline; the mocked handshake then hangs forever.
          socket.write(upgradeRequest(port))
        })
      })

      // Closed by the deadline, not by the 2s guard.
      expect(elapsed).toBeLessThan(2000)
      // And not closed instantly for some unrelated reason — it lived at least
      // until roughly the deadline. (Allow slack for timer/scheduling jitter.)
      expect(elapsed).toBeGreaterThanOrEqual(30)
    } finally {
      await registrar.close()
      await closeServer(server)
    }
  })

  it('does not arm a deadline when handshakeTimeoutMs is 0 (opt-out)', async () => {
    // With the deadline disabled, the stalled handshake stays open. We assert
    // the socket is STILL open well past when a 50ms deadline would have closed
    // it, guarding the `handshakeTimeoutMs > 0` gate around setTimeout.
    const registrar = createWebSocketRegistrar({ handshakeTimeoutMs: 0 })
    registrar.add('/ws', () => {}, { origin: false })

    const server = createServer()
    registrar.attach(server)
    const port = await listen(server)

    const socket = new Socket()
    try {
      const stayedOpen = await new Promise<boolean>((resolve) => {
        let closedEarly = false
        const onGone = () => {
          closedEarly = true
        }
        socket.on('close', onGone)
        socket.on('error', onGone)
        socket.connect(port, '127.0.0.1', () => {
          socket.write(upgradeRequest(port))
        })
        // Wait well past the 50ms a deadline would have used; expect no close.
        setTimeout(() => resolve(!closedEarly), 300)
      })

      expect(stayedOpen).toBe(true)
    } finally {
      socket.destroy()
      await registrar.close()
      await closeServer(server)
    }
  })
})
