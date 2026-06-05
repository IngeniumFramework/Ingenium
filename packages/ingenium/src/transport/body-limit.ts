import type { IncomingMessage, ServerResponse } from 'node:http'
import type { IngeniumContext } from '../context/context.ts'
import { createByteLimit } from '../body/limit.ts'

/**
 * Shared request-body size enforcement for the Node-family transports.
 *
 * Factored out of `transport/node.ts` so the WebSocket adapter
 * (`ws/ws-node-adapter.ts`) enforces `maxRequestBytes` identically and cannot
 * silently drift — a drop here previously left `ctx.body.stream()` uncapped on
 * WS-enabled apps (a DoS regression).
 */

/**
 * Returns `true` (and writes a 413 response) if the request advertises a
 * Content-Length greater than `maxRequestBytes`. Returns `false` for missing,
 * invalid, or in-range Content-Length values — those cases are handled by
 * {@link attachBodyWithLimit}'s byte-limit Transform downstream.
 */
export function rejectIfContentLengthTooBig(
  req: IncomingMessage,
  res: ServerResponse,
  maxRequestBytes: number,
): boolean {
  if (!Number.isFinite(maxRequestBytes)) return false
  const raw = req.headers['content-length']
  if (typeof raw !== 'string' || raw.length === 0) return false
  const n = Number(raw)
  // Reject only on a well-formed, non-negative integer over the cap. A
  // negative, fractional, NaN, or > 2^53 Content-Length is malformed: it must
  // NOT slip past as "valid and in-range" (which would then feed a bogus value
  // into downstream buffer pre-sizing). Treat it as missing/invalid → false
  // here, letting the byte-limit Transform enforce the real cap on the actual
  // bytes received.
  if (!Number.isSafeInteger(n) || n < 0) return false
  if (n <= maxRequestBytes) return false

  res.statusCode = 413
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('connection', 'close')
  res.end(
    JSON.stringify({
      error: `Request body exceeded ${maxRequestBytes} bytes`,
      code: 'PAYLOAD_TOO_LARGE',
    }),
  )
  // Hint the kernel to drop any pending body bytes; we never read them.
  req.socket?.destroy()
  return true
}

/**
 * Wire the request body onto `ctx`, wrapping unknown-length (chunked) bodies in
 * a transport-level byte-limit so the cap applies to EVERY consumer — including
 * `ctx.body.stream()`, which the per-call body cap can't protect. `ctx.method`
 * must already be set. We skip the wrap in three provably-safe cases:
 *
 *   1. Structurally body-less request (GET/HEAD/OPTIONS or Content-Length: 0).
 *   2. The cap is disabled (Number.POSITIVE_INFINITY).
 *   3. Content-Length is declared AND ≤ cap — node:http itself stops reading at
 *      the declared length, so the body cannot exceed the cap.
 */
export function attachBodyWithLimit(
  ctx: IngeniumContext,
  req: IncomingMessage,
  maxRequestBytes: number,
): void {
  const cl = req.headers['content-length']
  // Only a well-formed, non-negative integer counts as a known length; a
  // negative/fractional/NaN/unsafe value must not flow into the `knownSafe`
  // short-circuit nor into `_attach`'s pre-sizing hint.
  const parsedCl = cl ? Number(cl) : undefined
  const contentLength =
    parsedCl !== undefined && Number.isSafeInteger(parsedCl) && parsedCl >= 0 ? parsedCl : undefined
  const ct = req.headers['content-type']

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
    ctx.body._attach(req, ct, Number.isFinite(contentLength) ? contentLength : undefined)
    return
  }

  // Cap unknown-length (chunked) bodies with a byte-limit Transform. `pipe()`
  // does NOT forward `'error'` events, so when the chunked path in
  // `IngeniumBody.buffer` re-pipes this Transform into a SECOND limiter and only
  // listens on the downstream pipe, the cap error here would (a) be an
  // unhandled-error crash and (b) never reach that downstream — so the
  // consumer's promise would hang. Attach a guard `'error'` listener and
  // forward the error to every stream this Transform was piped into. We leave
  // `req`/its socket alone so the response (413) can still flush.
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
    // Discard the rest of the inbound body so the socket can be reused/closed.
    req.unpipe(limited)
    req.on('error', () => {})
    req.resume()
  })
  req.pipe(limited)
  ctx.body._attach(limited, ct, Number.isFinite(contentLength) ? contentLength : undefined)
}
