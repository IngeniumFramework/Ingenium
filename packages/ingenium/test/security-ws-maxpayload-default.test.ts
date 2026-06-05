/**
 * Finding #6: `new WebSocketServer({ maxPayload: route.options.maxPayload })`
 * passed `undefined` straight through when no option was set, falling back to
 * the `ws` library default of 100 MiB/frame — a per-message memory-DoS lever.
 * The registrar now defaults to 1 MiB when `maxPayload` is unset.
 *
 * We observe this by mocking the `ws` module so the `WebSocketServer`
 * constructor records the options it was built with, then driving a single
 * upgrade through the registrar (the handshake itself is stubbed — we only
 * care about how the server was constructed).
 */
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Buffer } from 'node:buffer'
import type { IncomingMessage, Server as HttpServer } from 'node:http'
import type { Socket } from 'node:net'

// Capture every WebSocketServer construction option here.
const constructed: Array<Record<string, unknown>> = []

vi.mock('ws', () => {
  class FakeWebSocketServer {
    options: Record<string, unknown>
    clients = new Set<unknown>()
    constructor(options: Record<string, unknown>) {
      this.options = options
      constructed.push(options)
    }
    // The registrar calls handleUpgrade after construction; complete it by
    // invoking the callback with a minimal fake socket so the handler path
    // runs without a real handshake.
    handleUpgrade(
      _req: unknown,
      _socket: unknown,
      _head: unknown,
      cb: (ws: unknown) => void,
    ): void {
      cb({ on() {}, close() {}, terminate() {} })
    }
    close(cb?: () => void): void {
      cb?.()
    }
  }
  return { WebSocketServer: FakeWebSocketServer, WebSocket: class {} }
})

import { createWebSocketRegistrar } from '../src/ws/middleware.ts'
import type { WebSocketHandlerOptions } from '../src/ws/types.ts'

/** A fake http.Server that lets us emit a synthetic 'upgrade' event. */
function fakeHttpServer(): HttpServer & EventEmitter {
  return new EventEmitter() as unknown as HttpServer & EventEmitter
}

function fakeSocket(): Socket {
  const s = new EventEmitter() as unknown as Socket & EventEmitter
  ;(s as unknown as { write: () => boolean }).write = () => true
  ;(s as unknown as { destroy: () => void }).destroy = () => {}
  return s
}

/**
 * Register a route with the given options, attach to a fake server, emit one
 * upgrade for it, and resolve once the WebSocketServer has been constructed.
 */
async function driveUpgrade(options: WebSocketHandlerOptions): Promise<Record<string, unknown>> {
  const before = constructed.length
  const registrar = createWebSocketRegistrar()
  registrar.add('/ws', () => {}, options)
  const server = fakeHttpServer()
  registrar.attach(server)

  const req = { url: '/ws', headers: { origin: 'http://localhost' }, method: 'GET' } as unknown as IncomingMessage
  server.emit('upgrade', req, fakeSocket(), Buffer.alloc(0))

  // The upgrade handler does `await import('ws')` inside a microtask chain;
  // poll until THIS call's constructor has run (constructed grew past `before`).
  // Use a real-time (setTimeout) poll rather than setImmediate so a busy event
  // loop under full-suite parallelism can't starve the wait and flake the test.
  for (let i = 0; i < 2000 && constructed.length === before; i++) {
    await new Promise((r) => setTimeout(r, 1))
  }
  await registrar.close()
  const last = constructed[constructed.length - 1]
  if (constructed.length === before || last === undefined) {
    throw new Error('WebSocketServer was never constructed')
  }
  return last
}

describe('security: ws maxPayload default cap', () => {
  it('defaults maxPayload to 1 MiB when the route sets no option', async () => {
    const opts = await driveUpgrade({ origin: false })
    expect(opts.maxPayload).toBe(1024 * 1024)
  })

  it('honors an explicit maxPayload override', async () => {
    const opts = await driveUpgrade({ origin: false, maxPayload: 4 * 1024 * 1024 })
    expect(opts.maxPayload).toBe(4 * 1024 * 1024)
  })

  it('allows an explicit 0 to be passed through unchanged (caller opts out)', async () => {
    // `?? 1024*1024` only substitutes for null/undefined, so an explicit 0
    // (ws treats 0 as "no limit") is the caller's deliberate choice.
    const opts = await driveUpgrade({ origin: false, maxPayload: 0 })
    expect(opts.maxPayload).toBe(0)
  })
})
