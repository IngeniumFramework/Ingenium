import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { IngeniumContext } from '../context/context.ts'
import type { HttpMethod } from '../router/types.ts'
import { attachBodyWithLimit, rejectIfContentLengthTooBig } from './body-limit.ts'
import type { CloseOptions, ListeningServer, Transport, TransportHooks } from './types.ts'

/**
 * Node.js `node:http` transport. Owns a single `http.Server`; on each
 * request, populates a pooled `IngeniumContext` directly from the
 * `IncomingMessage` (no WinterCG translation), awaits dispatch, then writes
 * the context's response state to the `ServerResponse`.
 */
export class NodeAdapter implements Transport {
  private hooks: TransportHooks | null = null

  attach(hooks: TransportHooks): void {
    this.hooks = hooks
  }

  async listen(port: number, host = '127.0.0.1'): Promise<ListeningServer> {
    if (!this.hooks) throw new Error('NodeAdapter.listen() called before attach()')
    const hooks = this.hooks

    const server = createServer((req, res) => {
      handleRequest(req, res, hooks).catch((err) => {
        // Last-resort safety net — the dispatch loop should have caught everything.
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

    // Track every open socket so close() can drain (and, if asked, force-kill)
    // idle keep-alive connections that `server.close()` alone would leave open.
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
                  // Force-close any sockets still hanging around (idle
                  // keep-alives or slow handlers). server.close()'s callback
                  // will fire once they're destroyed.
                  for (const socket of sockets) socket.destroy()
                }, Math.max(0, timeoutMs))
                // Don't keep the event loop alive just for the force-close timer.
                if (typeof timer.unref === 'function') timer.unref()
              }
            }),
        })
      })
    })
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, hooks: TransportHooks): Promise<void> {
  // Normalize once: TransportHooks types maxRequestBytes as optional for
  // backward-compat; framework dispatch always sets it. Older fixtures may
  // not — treat undefined as "no cap" (Infinity).
  const maxBytes = hooks.maxRequestBytes ?? Number.POSITIVE_INFINITY

  // Content-Length pre-check: if the client declares a body larger than the
  // ceiling, reject IMMEDIATELY without acquiring a context or buffering
  // anything. Chunked requests (no Content-Length) and Content-Length: 0
  // fall through to the byte-limit Transform below, which catches
  // mid-stream overruns.
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
  // Split path / query without allocating a URL object.
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
  // Detect TLS via the socket's `encrypted` flag (set by tls.TLSSocket).
  ctx.baseProtocol = (req.socket as { encrypted?: boolean })?.encrypted ? 'https' : 'http'

  // Wire body lazily with the transport byte-cap (shared with the WS adapter).
  attachBodyWithLimit(ctx, req, maxRequestBytes)
}

function writeResponse(ctx: IngeniumContext, res: ServerResponse): void {
  const body = ctx._body
  const headers = ctx._headers

  // Compute content-length where we know it. Mutating ctx._headers is safe
  // because the context is being released to the pool right after this call.
  switch (body.kind) {
    case 'string':
      if (headers['content-length'] === undefined) {
        headers['content-length'] = String(Buffer.byteLength(body.data))
      }
      break
    case 'buffer':
      if (headers['content-length'] === undefined) {
        headers['content-length'] = String(body.data.length)
      }
      break
    case 'none':
    case 'stream':
      break
  }

  // Single writeHead call instead of `statusCode = ...; setHeader × N`.
  // node:http has a fast path that flushes status line + headers in one
  // serialization pass — measurably faster than the per-header setHeader
  // sequence on hot endpoints.
  if (body.kind === 'stream') {
    res.writeHead(ctx._statusCode, headers)
    body.data.pipe(res)
    return
  }
  res.writeHead(ctx._statusCode, headers)
  if (body.kind === 'none') {
    res.end()
  } else {
    res.end(body.data)
  }
}
