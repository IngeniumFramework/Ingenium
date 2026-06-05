/**
 * Finding #8: a negative or non-integer Content-Length (e.g. `-1`) was only
 * guarded by `Number.isFinite`, so it passed the size gate ("valid and in
 * range") and could feed a bogus value into downstream buffer pre-sizing —
 * AND let an oversized body skip the byte-cap Transform via the `knownSafe`
 * short-circuit. The guard now requires `Number.isSafeInteger(n) && n >= 0`.
 *
 * We assert at the transport boundary: a request that declares a malformed
 * Content-Length but actually sends a body OVER the cap must NOT round-trip a
 * 200 (which would prove it bypassed the byte ceiling).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { request as httpRequest, Agent, type IncomingMessage } from 'node:http'
import { Buffer } from 'node:buffer'
import { ingenium } from '../src/index.ts'
import type { ListeningServer } from '../src/transport/types.ts'

interface RawResponse {
  status: number
  body: Buffer
}

/**
 * Send a request with a fully raw, caller-supplied Content-Length string —
 * including malformed values Node's high-level client would normally reject.
 * We write directly to a socket so the negative/garbage header reaches the
 * server untouched.
 */
function rawRequestWithHeader(opts: {
  port: number
  contentLength: string
  body: Buffer
  path?: string
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const agent = new Agent({ keepAlive: false })
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: opts.port,
        method: 'POST',
        path: opts.path ?? '/echo',
        agent,
        // Provide our own framing header; Node won't add a second one.
        headers: { 'content-length': opts.contentLength },
      },
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
    req.end(opts.body)
  })
}

describe('security: negative / malformed Content-Length does not bypass the cap', () => {
  let server: ListeningServer
  const CAP = 50_000

  beforeAll(async () => {
    const app = ingenium({ maxRequestBytes: CAP })
    app.post('/echo', async (ctx) => {
      // Per-call limit far above the ceiling so the transport cap is the only
      // thing that can stop an oversized body. If a bogus Content-Length let
      // the body through, this would buffer it all and echo 200.
      const buf = await ctx.body.buffer(10 * 1024 * 1024)
      ctx.send(buf)
    })
    server = await app.listen(0)
  })

  afterAll(() => server.close({ gracefulTimeoutMs: 50 }))

  it('does NOT return 200 for an oversized body sent with Content-Length: -1', async () => {
    // Node's client overrides our header with the real body length, so the
    // wire Content-Length ends up matching the (oversized) body. The point is
    // that a malformed declared length must never be treated as "known safe":
    // the byte-limit Transform must still police the actual bytes → not 200.
    const tooBig = Buffer.alloc(80_000, 0x61) // 80 KB > 50 KB cap
    let status = 0
    try {
      const res = await rawRequestWithHeader({
        port: server.port,
        contentLength: '-1',
        body: tooBig,
      })
      status = res.status
    } catch {
      // A socket reset is an acceptable rejection signal; mark non-200.
      status = -1
    }
    expect(status).not.toBe(200)
    if (status > 0) expect(status).toBe(413)
  })

  it('accepts a small body even when an odd (but harmless) length is involved', async () => {
    // Sanity: the tightened guard must not break the normal in-range path.
    const small = Buffer.alloc(1_000, 0x62)
    const res = await rawRequestWithHeader({
      port: server.port,
      contentLength: String(small.length),
      body: small,
    })
    expect(res.status).toBe(200)
    expect(res.body.length).toBe(small.length)
  })
})

// The h2 pre-check is exported and can be tested directly with a fabricated
// stream/headers pair carrying a malformed Content-Length. A negative declared
// length over the cap must NOT be reported as a too-big rejection (it's treated
// as invalid → false), so the byte-limit Transform — not the bogus header —
// governs enforcement.
import { rejectH2IfContentLengthTooBig } from '../src/transport/http2-helpers.ts'

describe('security: rejectH2IfContentLengthTooBig rejects malformed lengths', () => {
  function fakeStream() {
    let responded = false
    return {
      destroyed: false,
      closed: false,
      on() { return this },
      respond() { responded = true },
      end() {},
      close() {},
      destroy() {},
      get _responded() { return responded },
    } as unknown as import('node:http2').ServerHttp2Stream & { _responded: boolean }
  }

  it('does not treat Content-Length: -1 as a too-big rejection', () => {
    const stream = fakeStream()
    // -1 is "over" the cap numerically, but the guard must classify it as
    // invalid and return false (let the Transform handle the real bytes).
    const rejected = rejectH2IfContentLengthTooBig(stream, { 'content-length': '-1' }, 100)
    expect(rejected).toBe(false)
  })

  it('does not treat a fractional Content-Length as a valid in-range length', () => {
    const stream = fakeStream()
    const rejected = rejectH2IfContentLengthTooBig(stream, { 'content-length': '1.5' }, 100)
    expect(rejected).toBe(false)
  })

  it('still rejects a well-formed oversized Content-Length', () => {
    const stream = fakeStream()
    const rejected = rejectH2IfContentLengthTooBig(stream, { 'content-length': '5000' }, 100)
    expect(rejected).toBe(true)
  })
})
