import type { ServerHttp2Stream, IncomingHttpHeaders as Http2IncomingHeaders } from 'node:http2'
import { constants as h2 } from 'node:http2'
import type { IncomingHttpHeaders } from 'node:http'
import type { IngeniumContext } from '../context/context.ts'
import type { HttpMethod } from '../router/types.ts'
import { createByteLimit } from '../body/limit.ts'

/**
 * HTTP/2 pseudo-headers (RFC 7540 §8.1.2.1). These appear as keys on the
 * `headers` object when reading an inbound stream and must NOT be passed to
 * any setHeader-style API on outbound responses (Node throws). Strip them
 * from `ctx.headers` so user middleware sees a Node-http-compatible shape.
 */
const PSEUDO_HEADERS = new Set<string>([':method', ':path', ':scheme', ':authority', ':status'])

/**
 * Some HTTP/1 hop-by-hop headers are forbidden in HTTP/2 (RFC 7540 §8.1.2.2).
 * Strip these from outbound responses if a handler set them — `Transfer-Encoding`
 * is the most common offender (Express habit) and `connection` is implicit.
 */
const FORBIDDEN_RESPONSE_HEADERS = new Set<string>([
  'transfer-encoding',
  'connection',
  'keep-alive',
  'proxy-connection',
  'upgrade',
])

/**
 * Populate a pooled `IngeniumContext` from an inbound HTTP/2 stream + headers map.
 * Mirrors `node.ts`'s `populateContext` but unpacks pseudo-headers and
 * uppercases the method (HTTP/2 sends it lowercase per node:http2 convention).
 */
export function populateFromH2(
  ctx: IngeniumContext,
  stream: ServerHttp2Stream,
  headers: Http2IncomingHeaders,
  maxRequestBytes: number,
): void {
  const rawMethod = headers[h2.HTTP2_HEADER_METHOD]
  ctx.method = (typeof rawMethod === 'string' ? rawMethod.toUpperCase() : 'GET') as HttpMethod

  const rawPath = headers[h2.HTTP2_HEADER_PATH]
  const url = typeof rawPath === 'string' ? rawPath : '/'
  ctx.url = url

  // Split path / query without allocating a URL object — same trick as NodeAdapter.
  const qIdx = url.indexOf('?')
  if (qIdx >= 0) {
    ctx.path = url.slice(0, qIdx)
    ctx.rawQuery = url.slice(qIdx + 1)
  } else {
    ctx.path = url
    ctx.rawQuery = ''
  }

  // Filter pseudo-headers out of the user-visible `ctx.headers` so middleware
  // sees an `IncomingHttpHeaders`-compatible bag.
  const userHeaders: Record<string, string | string[] | undefined> = Object.create(null)
  for (const name in headers) {
    if (PSEUDO_HEADERS.has(name)) continue
    userHeaders[name] = headers[name]
  }
  ctx.headers = userHeaders as IncomingHttpHeaders

  const cl = userHeaders['content-length']
  // Only treat a well-formed, non-negative integer as a known length. A
  // negative/fractional/NaN/unsafe value must NOT flow into the `knownSafe`
  // byte-cap short-circuit or into `_attach`'s pre-sizing hint — both would be
  // corrupted by a bogus declared length.
  const parsedCl = typeof cl === 'string' ? Number(cl) : undefined
  const contentLength =
    parsedCl !== undefined && Number.isSafeInteger(parsedCl) && parsedCl >= 0 ? parsedCl : undefined
  const ct = typeof userHeaders['content-type'] === 'string' ? (userHeaders['content-type'] as string) : undefined

  // The `ServerHttp2Stream` IS a Duplex with a Readable side — wrap it in the
  // byte-limit Transform so the cap applies to EVERY consumer, including
  // `ctx.body.stream()`. Three provably-safe skip conditions (mirror NodeAdapter):
  //   1. Body-less method or Content-Length: 0
  //   2. Cap disabled (Infinity)
  //   3. Content-Length declared and ≤ cap (pre-check enforced; protocol
  //      bounds the actual byte count to the declared length)
  const noBody =
    contentLength === 0 ||
    ctx.method === 'GET' ||
    ctx.method === 'HEAD' ||
    ctx.method === 'OPTIONS'
  const knownSafe =
    contentLength !== undefined &&
    Number.isFinite(contentLength) &&
    contentLength <= maxRequestBytes
  if (noBody || !Number.isFinite(maxRequestBytes) || knownSafe) {
    ctx.body._attach(stream, ct, Number.isFinite(contentLength) ? contentLength : undefined)
    return
  }

  // Cap unknown-length (chunked) bodies with a byte-limit Transform that
  // becomes `ctx.body`'s source. Two failure modes have to be defended here,
  // both rooted in `Stream.prototype.pipe` NOT forwarding `'error'` events:
  //
  //  1. Unhandled-error crash. When the cap trips, the Transform emits
  //     `'error'`. The `body.stream()` consumer attaches its own listener, but
  //     the chunked path in `IngeniumBody.buffer` re-pipes THIS Transform into
  //     a second limiter and only listens on the DOWNSTREAM pipe — so this
  //     Transform's `'error'` has no listener and becomes a process-killing
  //     unhandled error (h2c has no socket-level teardown to swallow it).
  //
  //  2. Hung request. Because `pipe()` drops errors, that re-piped downstream
  //     limiter never sees the overrun: it stops receiving data but never
  //     `end`s or `error`s, so `body.buffer()`'s promise never settles and the
  //     request hangs until the test/clien­t timeout.
  //
  // Fix both by (a) attaching a guard `'error'` listener so the event is always
  // handled, and (b) forwarding the cap error to every stream this Transform
  // was piped into, so re-piping consumers reject promptly. We deliberately do
  // NOT touch the underlying h2 `stream` here: the 413 is produced by the body
  // consumer's `IngeniumPayloadTooLargeError`, which the error boundary
  // serializes and `writeH2Response` must flush on the still-open stream.
  const limited = createByteLimit(maxRequestBytes)
  const downstream = new Set<{ destroy(err?: Error): void; destroyed: boolean }>()
  const origPipe = limited.pipe.bind(limited) as typeof limited.pipe
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  limited.pipe = function pipe(dest: any, ...rest: any[]) {
    downstream.add(dest)
    return origPipe(dest, ...rest)
  } as typeof limited.pipe
  limited.on('error', (err: Error) => {
    for (const dest of downstream) {
      if (!dest.destroyed) dest.destroy(err)
    }
    // Drain whatever inbound bytes the client is still sending. We stopped
    // reading at the cap, so the raw h2 stream's readable side is left with
    // unconsumed (and incoming) DATA frames. The response (413) flushes on the
    // WRITABLE side, but a half-closed stream whose readable side never ends
    // keeps the h2 SESSION's stream count > 0 — so a later graceful
    // `client.close()` / `server.close()` hangs waiting for it. Unpipe the dead
    // Transform and resume the raw stream to discard the rest, letting it reach
    // `end` and the session close cleanly. `stream.on('error')` below absorbs
    // any RST that arrives while draining.
    stream.unpipe(limited)
    stream.on('error', () => {})
    stream.resume()
  })
  stream.pipe(limited)
  ctx.body._attach(limited, ct, Number.isFinite(contentLength) ? contentLength : undefined)
}

/**
 * Returns `true` (and writes a 413 response) if the inbound h2 stream's
 * Content-Length exceeds the cap. Mirrors the Node adapter pre-check —
 * called BEFORE `populateFromH2` so we don't even acquire a context for
 * a request we're going to reject. Missing / invalid Content-Length →
 * `false` (chunked-style framing, where the byte-limit catches the overrun).
 */
export function rejectH2IfContentLengthTooBig(
  stream: ServerHttp2Stream,
  headers: Http2IncomingHeaders,
  maxRequestBytes: number,
): boolean {
  if (!Number.isFinite(maxRequestBytes)) return false
  const raw = headers['content-length']
  const cl = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : undefined
  if (typeof cl !== 'string' || cl.length === 0) return false
  const n = Number(cl)
  // Reject only on a well-formed, non-negative integer over the cap. A
  // negative/fractional/NaN/unsafe Content-Length is malformed and must not be
  // accepted as "valid and in-range" (which would let a bogus length reach the
  // body-sizing path) — treat it as missing here and let the byte-limit
  // Transform police the actual bytes.
  if (!Number.isSafeInteger(n) || n < 0) return false
  if (n <= maxRequestBytes) return false

  if (stream.destroyed || stream.closed) return true

  // A client that declared an oversized Content-Length is, by definition,
  // about to send (or has half-sent) body frames we will never read. When we
  // respond + end early, the peer's continued DATA — or its own Content-Length
  // bookkeeping if it later sends fewer bytes than declared — makes node:http2
  // emit `ERR_HTTP2_STREAM_ERROR` on this stream. With no listener that is an
  // unhandled-error crash. Absorb it: the 413 has already been delivered (or
  // the stream is being torn down anyway), so there is nothing left to do.
  stream.on('error', () => {
    /* absorb late RST/protocol error from the rejected, never-read body */
  })

  try {
    stream.respond({
      [h2.HTTP2_HEADER_STATUS]: 413,
      'content-type': 'application/json; charset=utf-8',
    })
    stream.end(
      JSON.stringify({
        error: `Request body exceeded ${maxRequestBytes} bytes`,
        code: 'PAYLOAD_TOO_LARGE',
      }),
    )
  } catch {
    try {
      stream.close(h2.NGHTTP2_INTERNAL_ERROR)
    } catch {
      stream.destroy()
    }
  }
  return true
}

/**
 * Write the `IngeniumContext` response state to an HTTP/2 stream. Handles all four
 * `_body.kind` variants. HTTP/2 has no `Transfer-Encoding: chunked` (framing
 * is implicit) and no hop-by-hop headers, so we strip those before responding.
 */
export function writeH2Response(ctx: IngeniumContext, stream: ServerHttp2Stream): void {
  if (stream.destroyed || stream.closed) return

  const responseHeaders: Record<string, string | string[] | number> = Object.create(null)
  responseHeaders[h2.HTTP2_HEADER_STATUS] = ctx._statusCode

  for (const name in ctx._headers) {
    const lc = name.toLowerCase()
    if (FORBIDDEN_RESPONSE_HEADERS.has(lc)) continue
    if (PSEUDO_HEADERS.has(lc)) continue // defensive — shouldn't ever happen
    const value = ctx._headers[name]
    if (value !== undefined) responseHeaders[lc] = value
  }

  const body = ctx._body
  switch (body.kind) {
    case 'none':
      stream.respond(responseHeaders, { endStream: true })
      return
    case 'string': {
      if (responseHeaders['content-length'] === undefined) {
        responseHeaders['content-length'] = Buffer.byteLength(body.data)
      }
      stream.respond(responseHeaders)
      stream.end(body.data)
      return
    }
    case 'buffer': {
      if (responseHeaders['content-length'] === undefined) {
        responseHeaders['content-length'] = body.data.length
      }
      stream.respond(responseHeaders)
      stream.end(body.data)
      return
    }
    case 'stream': {
      stream.respond(responseHeaders)
      body.data.pipe(stream)
      return
    }
  }
}
