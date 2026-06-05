import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { request as httpRequest, Agent, type IncomingMessage } from 'node:http'
import { Buffer } from 'node:buffer'
import { ingenium } from '../src/index.ts'
import { enableWebSockets } from '../src/ws/index.ts'
import type { ListeningServer } from '../src/transport/types.ts'

/**
 * Regression: enabling WebSockets swaps in WsNodeAdapter, which previously
 * dropped the transport-level `maxRequestBytes` enforcement — leaving
 * `ctx.body.stream()` consumers uncapped on WS-enabled apps. The WS adapter
 * must enforce the cap identically to the core NodeAdapter.
 */

let hasWs = false
try {
  await import('ws')
  hasWs = true
} catch {
  hasWs = false
}

interface RawResponse {
  status: number
  body: Buffer
}

function rawRequest(opts: {
  port: number
  path: string
  body?: Buffer
  headers?: Record<string, string>
  forceChunked?: boolean
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) }
    if (opts.forceChunked) {
      delete headers['content-length']
      headers['transfer-encoding'] = 'chunked'
    }
    const agent = new Agent({ keepAlive: false })
    const req = httpRequest(
      { host: '127.0.0.1', port: opts.port, method: 'POST', path: opts.path, headers, agent },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          agent.destroy()
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) })
        })
        res.on('error', (err) => {
          agent.destroy()
          reject(err)
        })
      },
    )
    req.on('error', (err) => {
      agent.destroy()
      reject(err)
    })
    req.end(opts.body ?? Buffer.alloc(0))
  })
}

describe.skipIf(!hasWs)('WsNodeAdapter — maxRequestBytes', () => {
  let server: ListeningServer
  beforeAll(async () => {
    const app = ingenium({ maxRequestBytes: 50_000 })
    enableWebSockets(app)
    app.post('/echo', async (ctx) => {
      const buf = await ctx.body.buffer(10 * 1024 * 1024)
      ctx.send(buf)
    })
    // Raw-stream consumer: the exact path the transport cap is supposed to protect.
    app.post('/drain', async (ctx) => {
      const stream = ctx.body.stream()
      await new Promise<void>((resolve, reject) => {
        stream.on('data', () => {})
        stream.on('end', () => resolve())
        stream.on('error', reject)
      })
      ctx.text('ok')
    })
    server = await app.listen(0, '127.0.0.1')
  })
  afterAll(() => server.close({ gracefulTimeoutMs: 100 }))

  it('rejects an oversized Content-Length with 413 before buffering', async () => {
    const res = await rawRequest({
      port: server.port,
      path: '/echo',
      body: Buffer.from('x'),
      headers: { 'content-length': String(5 * 1024 * 1024) },
    })
    expect(res.status).toBe(413)
    expect(JSON.parse(res.body.toString('utf8')).code).toBe('PAYLOAD_TOO_LARGE')
  })

  it('caps a chunked overrun on a ctx.body.stream() route (no Content-Length)', async () => {
    let status = 0
    try {
      const res = await rawRequest({
        port: server.port,
        path: '/drain',
        body: Buffer.alloc(80_000, 0x64),
        forceChunked: true,
      })
      status = res.status
    } catch {
      status = -1 // socket reset is an acceptable abort signal
    }
    expect(status).not.toBe(200)
    if (status > 0) expect(status).toBe(413)
  })

  it('accepts a body within the cap', async () => {
    const payload = Buffer.alloc(10_000, 0x61)
    const res = await rawRequest({ port: server.port, path: '/echo', body: payload })
    expect(res.status).toBe(200)
    expect(res.body.length).toBe(payload.length)
  })
})
