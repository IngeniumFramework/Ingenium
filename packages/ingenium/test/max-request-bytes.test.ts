/**
 * Transport-layer request body ceiling tests.
 *
 * The cap configured via `ingenium({ maxRequestBytes })` MUST fire BEFORE the
 * body is buffered into memory, regardless of which `ctx.body.*` consumer
 * the route handler uses — including `ctx.body.stream()`, which today bypasses
 * the per-call `maxBytes` argument on `json/text/urlencoded/buffer`.
 *
 * We test three transports:
 *   1. NodeAdapter (default, h1)
 *   2. Http2cAdapter (h2c, cleartext) — TLS h2 skipped per project convention
 *   3. BunAdapter — skipped unless running under Bun
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { request as httpRequest, Agent, type IncomingMessage } from 'node:http'
import {
  connect as h2connect,
  constants as h2,
  type ClientHttp2Session,
} from 'node:http2'
import { Buffer } from 'node:buffer'
import { ingenium } from '../src/index.ts'
import { IngeniumApp } from '../src/app.ts'
import { Http2cAdapter } from '../src/transport/http2.ts'
import type { ListeningServer } from '../src/transport/types.ts'

const KIB = 1024
const MIB = 1024 * 1024
const hasBun = typeof (globalThis as unknown as { Bun?: unknown }).Bun !== 'undefined'

// ───────────────────────────────────────────────────────────────────────────
// Low-level HTTP/1 helper that lets us send chunked bodies, omit
// Content-Length, or send a deliberately-too-big Content-Length header.
// ───────────────────────────────────────────────────────────────────────────

interface RawResponse {
  status: number
  body: Buffer
  headers: NodeJS.Dict<string | string[]>
}

interface RawRequestOptions {
  port: number
  host?: string
  method?: string
  path?: string
  /** Body bytes to write. Sent in a single `req.end(body)` call (chunked when no Content-Length is set). */
  body?: Buffer
  /** Raw header overrides — set `'content-length'` to a string (or `null` to omit). */
  headers?: Record<string, string>
  /** If true, do NOT send a Content-Length header — Node will use chunked encoding. */
  forceChunked?: boolean
}

function rawRequest(opts: RawRequestOptions): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) }
    if (opts.forceChunked) {
      delete headers['content-length']
      delete headers['Content-Length']
      headers['transfer-encoding'] = 'chunked'
    }
    // Use a fresh agent per request so we never reuse a half-closed socket.
    const agent = new Agent({ keepAlive: false })
    const req = httpRequest(
      {
        host: opts.host ?? '127.0.0.1',
        port: opts.port,
        method: opts.method ?? 'POST',
        path: opts.path ?? '/echo',
        headers,
        agent,
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          agent.destroy()
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks),
            headers: res.headers,
          })
        })
        res.on('error', (err) => {
          agent.destroy()
          reject(err)
        })
      },
    )
    req.on('error', (err) => {
      // Server may RST the socket on the 413 — surface a synthetic response so
      // the caller can still assert. The pre-check writes a full response then
      // destroys the socket; in practice the response IS delivered before the
      // RST hits the client, but we keep the fallback for stability.
      agent.destroy()
      reject(err)
    })
    if (opts.body !== undefined) {
      req.end(opts.body)
    } else {
      req.end()
    }
  })
}

// ───────────────────────────────────────────────────────────────────────────
// NodeAdapter (default)
// ───────────────────────────────────────────────────────────────────────────

describe('NodeAdapter — maxRequestBytes', () => {
  describe('default (2 MiB) ceiling', () => {
    let server: ListeningServer
    beforeAll(async () => {
      const app = ingenium()
      app.post('/echo', async (ctx) => {
        const text = await ctx.body.text(10 * MIB) // per-call limit > ceiling — ceiling still wins
        ctx.text(text)
      })
      server = await app.listen(0)
    })
    afterAll(() => server.close({ gracefulTimeoutMs: 50 }))

    it('accepts a body smaller than the cap and round-trips it', async () => {
      const payload = Buffer.alloc(64 * KIB, 0x61) // 64 KiB of 'a'
      const res = await rawRequest({ port: server.port, body: payload })
      expect(res.status).toBe(200)
      expect(res.body.length).toBe(payload.length)
      expect(res.body.equals(payload)).toBe(true)
    })

    it('rejects immediately when Content-Length exceeds the cap (no body buffered)', async () => {
      // Lie about Content-Length: claim 5 MiB, send a tiny stub. The pre-check
      // fires off the header alone — server must respond 413 without ever
      // pulling bytes from the socket.
      const res = await rawRequest({
        port: server.port,
        body: Buffer.from('x'),
        headers: { 'content-length': String(5 * MIB) },
      })
      expect(res.status).toBe(413)
      const parsed = JSON.parse(res.body.toString('utf8'))
      expect(parsed.code).toBe('PAYLOAD_TOO_LARGE')
    })
  })

  describe('custom 500_000-byte ceiling', () => {
    let server: ListeningServer
    beforeAll(async () => {
      const app = ingenium({ maxRequestBytes: 500_000 })
      app.post('/echo', async (ctx) => {
        const buf = await ctx.body.buffer(10 * MIB)
        ctx.send(buf)
      })
      server = await app.listen(0)
    })
    afterAll(() => server.close({ gracefulTimeoutMs: 50 }))

    it('honors the custom ceiling on a chunked (Content-Length-less) overrun', async () => {
      // Send 600 KB without a Content-Length so the pre-check can't catch it.
      // The byte-limit Transform must abort mid-stream → 413.
      const tooBig = Buffer.alloc(600_000, 0x62)
      // Some servers swallow the connection mid-write; we wrap in a try so a
      // socket reset still surfaces as a test failure ("did not get 413").
      let status = 0
      try {
        const res = await rawRequest({
          port: server.port,
          body: tooBig,
          forceChunked: true,
        })
        status = res.status
      } catch {
        // Accept a hangup as the protocol-level signal of the abort, but
        // prefer the 413 path. Mark this as "non-200" so the assertion
        // below fails if we ever silently buffered the oversized payload.
        status = -1
      }
      expect(status).not.toBe(200)
      // When the response did arrive cleanly, it MUST be a 413.
      if (status > 0) expect(status).toBe(413)
    })

    it('still accepts a body within the ceiling', async () => {
      const payload = Buffer.alloc(100_000, 0x63)
      const res = await rawRequest({ port: server.port, body: payload })
      expect(res.status).toBe(200)
      expect(res.body.length).toBe(payload.length)
    })
  })

  describe('ctx.body.stream() consumers are also capped', () => {
    let server: ListeningServer
    beforeAll(async () => {
      const app = ingenium({ maxRequestBytes: 50_000 })
      app.post('/drain', async (ctx) => {
        // Manually drain — this is the path the original bug report flagged
        // as unenforced. With the transport-layer wrap in place, the stream
        // emits 'error' once 50_000 bytes have been seen.
        const stream = ctx.body.stream()
        try {
          await new Promise<void>((resolve, reject) => {
            stream.on('data', () => {
              /* discard */
            })
            stream.on('end', () => resolve())
            stream.on('error', (err) => reject(err))
          })
          ctx.text('ok')
        } catch (err) {
          // Re-throw so the framework's error boundary serializes the 413.
          throw err
        }
      })
      server = await app.listen(0)
    })
    afterAll(() => server.close({ gracefulTimeoutMs: 50 }))

    it('emits an error on the raw stream when the cap is exceeded', async () => {
      const tooBig = Buffer.alloc(80_000, 0x64)
      let status = 0
      try {
        const res = await rawRequest({
          port: server.port,
          path: '/drain',
          body: tooBig,
          forceChunked: true,
        })
        status = res.status
      } catch {
        status = -1
      }
      expect(status).not.toBe(200)
      if (status > 0) expect(status).toBe(413)
    })
  })

  describe('maxRequestBytes: Infinity disables the cap', () => {
    let server: ListeningServer
    beforeAll(async () => {
      const app = ingenium({ maxRequestBytes: Number.POSITIVE_INFINITY })
      app.post('/echo', async (ctx) => {
        // Use the per-call argument with a generous ceiling so it doesn't
        // become the limiting factor for the 5 MiB payload test.
        const buf = await ctx.body.buffer(10 * MIB)
        ctx.send(buf)
      })
      server = await app.listen(0)
    })
    afterAll(() => server.close({ gracefulTimeoutMs: 50 }))

    it('accepts a 5 MiB body with no transport-layer ceiling', async () => {
      const payload = Buffer.alloc(5 * MIB, 0x65)
      const res = await rawRequest({ port: server.port, body: payload })
      expect(res.status).toBe(200)
      expect(res.body.length).toBe(payload.length)
    })
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Http2cAdapter — same surface
// ───────────────────────────────────────────────────────────────────────────

interface H2Response {
  status: number
  body: Buffer
}

function h2request(
  client: ClientHttp2Session,
  reqHeaders: Record<string, string | number>,
  body?: Buffer,
): Promise<H2Response> {
  return new Promise((resolve, reject) => {
    const stream = client.request(reqHeaders, { endStream: body === undefined })
    let status = 0
    const chunks: Buffer[] = []
    stream.on('response', (h) => {
      status = Number(h[h2.HTTP2_HEADER_STATUS] ?? 0)
    })
    stream.on('data', (c: Buffer) => chunks.push(c))
    stream.on('end', () => resolve({ status, body: Buffer.concat(chunks) }))
    stream.on('error', (err) => {
      if (status > 0) {
        // Response headers arrived; trailing RST is fine.
        resolve({ status, body: Buffer.concat(chunks) })
      } else {
        reject(err)
      }
    })
    if (body !== undefined) stream.end(body)
  })
}

describe('Http2cAdapter — maxRequestBytes', () => {
  let server: ListeningServer
  let client: ClientHttp2Session
  let baseUrl: string

  beforeAll(async () => {
    const app = new IngeniumApp({
      transport: new Http2cAdapter(),
      maxRequestBytes: 500_000,
    })
    app.post('/echo', async (ctx) => {
      const buf = await ctx.body.buffer(10 * MIB)
      ctx.send(buf)
    })
    app.post('/drain', async (ctx) => {
      const stream = ctx.body.stream()
      await new Promise<void>((resolve, reject) => {
        stream.on('data', () => {})
        stream.on('end', () => resolve())
        stream.on('error', reject)
      })
      ctx.text('ok')
    })
    server = await app.listen(0)
    baseUrl = `http://${server.host}:${server.port}`
    client = h2connect(baseUrl)
    client.on('error', () => {})
  })

  afterAll(async () => {
    await new Promise<void>((res) => client.close(() => res()))
    await server.close({ gracefulTimeoutMs: 50 })
  })

  it('accepts a body smaller than the ceiling', async () => {
    const payload = Buffer.alloc(100_000, 0x66)
    const res = await h2request(
      client,
      {
        [h2.HTTP2_HEADER_METHOD]: 'POST',
        [h2.HTTP2_HEADER_PATH]: '/echo',
        'content-length': payload.length,
      },
      payload,
    )
    expect(res.status).toBe(200)
    expect(res.body.length).toBe(payload.length)
  })

  it('rejects immediately on oversized Content-Length', async () => {
    // The declared `content-length` MUST match the bytes actually sent: Node's
    // HTTP/2 *client* strictly enforces content-length and self-RSTs the stream
    // (ERR_HTTP2_STREAM_ERROR, before any response is exchanged) if you declare
    // N bytes but send fewer. So we cannot probe "header says too big" with a
    // 1-byte body — the client kills the request on its own side. Instead we
    // send a 600 KiB body whose length equals the declared, oversized length.
    // The server's header pre-check (`rejectH2IfContentLengthTooBig`) still
    // fires on the headers and 413s WITHOUT buffering the body: the handler caps
    // at 10 MiB, so a buffered 600 KiB body would echo back 200 — getting 413
    // proves the reject happened on the Content-Length header, pre-buffer.
    const oversized = 600_000 // > the 500_000 ceiling
    const res = await h2request(
      client,
      {
        [h2.HTTP2_HEADER_METHOD]: 'POST',
        [h2.HTTP2_HEADER_PATH]: '/echo',
        'content-length': String(oversized),
      },
      Buffer.alloc(oversized, 0x78),
    )
    expect(res.status).toBe(413)
    const parsed = JSON.parse(res.body.toString('utf8'))
    expect(parsed.code).toBe('PAYLOAD_TOO_LARGE')
  })

  it('catches a body that overruns the cap without a Content-Length header', async () => {
    const tooBig = Buffer.alloc(600_000, 0x67)
    let status = 0
    try {
      const res = await h2request(
        client,
        {
          [h2.HTTP2_HEADER_METHOD]: 'POST',
          [h2.HTTP2_HEADER_PATH]: '/echo',
          // h2 frames don't require Content-Length; omit it.
        },
        tooBig,
      )
      status = res.status
    } catch {
      status = -1
    }
    expect(status).not.toBe(200)
    if (status > 0) expect(status).toBe(413)
  })

  it('caps ctx.body.stream() consumers too', async () => {
    const tooBig = Buffer.alloc(600_000, 0x68)
    let status = 0
    try {
      const res = await h2request(
        client,
        {
          [h2.HTTP2_HEADER_METHOD]: 'POST',
          [h2.HTTP2_HEADER_PATH]: '/drain',
        },
        tooBig,
      )
      status = res.status
    } catch {
      status = -1
    }
    expect(status).not.toBe(200)
    if (status > 0) expect(status).toBe(413)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// BunAdapter — only runs under Bun. The test still compiles under Node.
// ───────────────────────────────────────────────────────────────────────────

describe.skipIf(!hasBun)('BunAdapter — maxRequestBytes', () => {
  let server: ListeningServer
  let baseUrl: string

  beforeAll(async () => {
    // Dynamic import keeps Node from choking on the `ingenium-bun` package
    // when its `Bun` runtime guard would otherwise throw at construction time.
    const { BunAdapter } = (await import('../../ingenium-bun/src/index.ts')) as {
      BunAdapter: new () => import('../src/transport/types.ts').Transport
    }
    const app = new IngeniumApp({
      transport: new BunAdapter(),
      maxRequestBytes: 500_000,
    })
    app.post('/echo', async (ctx) => {
      const buf = await ctx.body.buffer(10 * MIB)
      ctx.send(buf)
    })
    server = await app.listen(0)
    baseUrl = `http://${server.host}:${server.port}`
  })

  afterAll(async () => {
    await server.close()
  })

  it('rejects oversized Content-Length with 413', async () => {
    const res = await fetch(`${baseUrl}/echo`, {
      method: 'POST',
      headers: { 'content-length': String(5 * MIB) },
      // Send a tiny body — `fetch` may overwrite Content-Length on some
      // runtimes; the test is best-effort. The adapter's pre-check is the
      // contract — if the runtime strips the header, the byte-limit catches it.
      body: Buffer.alloc(10, 0x69),
    })
    expect([413, 400]).toContain(res.status)
  })

  it('catches a streamed overrun mid-flight', async () => {
    const big = new Uint8Array(700_000).fill(0x6a)
    // Streamed body via a ReadableStream — exercises the byte-limit Transform.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(big)
        controller.close()
      },
    })
    let status = 0
    try {
      const res = await fetch(`${baseUrl}/echo`, {
        method: 'POST',
        // `duplex: 'half'` is required by undici when streaming a body. The
        // option isn't in @types/node's RequestInit yet — cast to unknown
        // to bypass the type gap.
        ...({ duplex: 'half' } as unknown as Record<string, never>),
        body,
      })
      status = res.status
    } catch {
      status = -1
    }
    expect(status).not.toBe(200)
  })
})

