/**
 * WebSocket-aware variant of `NodeAdapter`. Mirrors the behavior of
 * `transport/node.ts` (request handling, socket tracking, graceful close)
 * but exposes the underlying `http.Server` via an `onServerReady` callback
 * so the WS registrar can `.on('upgrade', …)` it.
 *
 * We did not modify the core `NodeAdapter` because the core has no awareness
 * of WebSockets; this adapter is opt-in via `enableWebSockets()`.
 */

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { Buffer } from 'node:buffer'
import type { IngeniumContext } from '../context/context.ts'
import type { HttpMethod } from '../router/types.ts'
import { attachBodyWithLimit, rejectIfContentLengthTooBig } from '../transport/body-limit.ts'
import type {
  CloseOptions,
  ListeningServer,
  Transport,
  TransportHooks,
} from '../transport/types.ts'

export type OnServerReady = (httpServer: HttpServer) => void

export class WsNodeAdapter implements Transport {
  private hooks: TransportHooks | null = null
  private readonly onServerReady: OnServerReady

  constructor(onServerReady: OnServerReady) {
    this.onServerReady = onServerReady
  }

  attach(hooks: TransportHooks): void {
    this.hooks = hooks
  }

  async listen(port: number, host = '127.0.0.1'): Promise<ListeningServer> {
    if (!this.hooks) throw new Error('WsNodeAdapter.listen() called before attach()')
    const hooks = this.hooks

    const server = createServer((req, res) => {
      handleRequest(req, res, hooks).catch((err) => {
        if (!res.headersSent) {
          res.statusCode = 500
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'Internal Server Error', code: 'INTERNAL_ERROR' }))
        } else {
          res.end()
        }
        process.emitWarning(`ingenium: dispatch leaked: ${(err as Error).message ?? String(err)}`)
      })
    })

    // Hand the http.Server to the WS registrar BEFORE listen() resolves —
    // this guarantees upgrade listeners are wired before any client can
    // connect.
    this.onServerReady(server)

    const sockets = new Set<Socket>()
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })

    return new Promise<ListeningServer>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        const addr = server.address()
        if (!addr || typeof addr === 'string') {
          reject(new Error('Failed to determine bound address'))
          return
        }
        resolve({
          port: addr.port,
          host: addr.address,
          close: (opts?: CloseOptions) =>
            new Promise<void>((res, rej) => {
              let settled = false
              let timer: NodeJS.Timeout | null = null

              server.close((err) => {
                if (timer) clearTimeout(timer)
                if (settled) return
                settled = true
                err ? rej(err) : res()
              })

              const timeoutMs = opts?.gracefulTimeoutMs
              if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)) {
                timer = setTimeout(() => {
                  for (const socket of sockets) socket.destroy()
                }, Math.max(0, timeoutMs))
                if (typeof timer.unref === 'function') timer.unref()
              }
            }),
        })
      })
    })
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, hooks: TransportHooks): Promise<void> {
  // Mirror the core NodeAdapter's body-size enforcement — without this, enabling
  // WebSockets silently dropped the transport-level cap that protects
  // `ctx.body.stream()` consumers from unbounded chunked/large bodies.
  const maxBytes = hooks.maxRequestBytes ?? Number.POSITIVE_INFINITY
  if (rejectIfContentLengthTooBig(req, res, maxBytes)) return

  const ctx = hooks.acquire()
  try {
    populateContext(ctx, req, maxBytes)
    await hooks.dispatch(ctx)
    writeResponse(ctx, res)
  } finally {
    hooks.release(ctx)
  }
}

function populateContext(ctx: IngeniumContext, req: IncomingMessage, maxRequestBytes: number): void {
  ctx.method = (req.method ?? 'GET') as HttpMethod
  ctx.url = req.url ?? '/'
  const url = ctx.url
  const qIdx = url.indexOf('?')
  if (qIdx >= 0) {
    ctx.path = url.slice(0, qIdx)
    ctx.rawQuery = url.slice(qIdx + 1)
  } else {
    ctx.path = url
    ctx.rawQuery = ''
  }
  ctx.headers = req.headers
  ctx.remoteAddress = req.socket?.remoteAddress ?? '127.0.0.1'
  ctx.baseProtocol = (req.socket as { encrypted?: boolean })?.encrypted ? 'https' : 'http'

  attachBodyWithLimit(ctx, req, maxRequestBytes)
}

function writeResponse(ctx: IngeniumContext, res: ServerResponse): void {
  res.statusCode = ctx._statusCode

  for (const name in ctx._headers) {
    const value = ctx._headers[name]
    if (value !== undefined) res.setHeader(name, value)
  }

  const body = ctx._body
  switch (body.kind) {
    case 'none':
      res.end()
      break
    case 'string':
      if (!res.hasHeader('content-length')) {
        res.setHeader('content-length', Buffer.byteLength(body.data))
      }
      res.end(body.data)
      break
    case 'buffer':
      if (!res.hasHeader('content-length')) {
        res.setHeader('content-length', body.data.length)
      }
      res.end(body.data)
      break
    case 'stream':
      body.data.pipe(res)
      break
  }
}
