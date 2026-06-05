import { PassThrough } from 'node:stream'
import type { IngeniumContext } from '../context/context.ts'

/**
 * Strip CR and LF from a single-line SSE field value (`event`, `id`, comment).
 *
 * WHY: SSE frames are newline-delimited text. A `\n` (or a lone `\r`, which
 * spec-compliant EventSource clients also treat as a line terminator) embedded
 * in a field value would close the current field and let an attacker inject
 * additional SSE lines — a spoofed `event:`, a forged `id:`, or a `\n\n` that
 * terminates the frame and starts a whole fake event. This is the EventSource
 * analog of HTTP response splitting. The spec forbids newlines in field values,
 * so stripping them is both safe and correct. `data` is handled separately
 * (newlines there are legal and re-emitted as multiple `data:` lines).
 */
function stripNewlines(value: string): string {
  return value.replace(/[\r\n]/g, '')
}

/**
 * A single Server-Sent Event. The `data` field is required; if you pass an
 * object, it's `JSON.stringify`'d before being written. All other fields are
 * optional and serialized per the EventSource specification.
 *
 * @see https://html.spec.whatwg.org/multipage/server-sent-events.html
 */
export interface SseEvent {
  /** Payload. Strings are written verbatim; objects are JSON-encoded. */
  data: string | object
  /** Optional event name — populates `event:` field. */
  event?: string
  /** Optional event id — populates `id:` field. */
  id?: string
  /** Optional retry hint in milliseconds — populates `retry:` field. */
  retry?: number
}

/**
 * Handle for an open SSE connection. Returned by {@link sse}. Use `send()`
 * to push events, `comment()` for keep-alive frames, and `close()` to end
 * the response stream cleanly.
 */
export interface SseStream {
  /**
   * Send a single event. A bare string is treated as `{ data: <string> }`.
   */
  send(event: SseEvent | string): void
  /** Write a comment line (`: <text>`). Useful for heartbeats / keep-alive. */
  comment(text: string): void
  /** End the response stream. Subsequent calls are no-ops. */
  close(): void
  /** Whether the underlying stream has been closed (locally or by the client). */
  readonly closed: boolean
}

/**
 * Open a Server-Sent Events response on the given context. Sets the
 * appropriate headers (`Content-Type: text/event-stream`, no caching, no
 * proxy buffering) and wires a `PassThrough` into `ctx.stream()`.
 *
 * @example
 *   app.get('/events', (ctx) => {
 *     const stream = sse(ctx)
 *     stream.send({ event: 'hello', data: { msg: 'world' } })
 *     setTimeout(() => stream.close(), 1000)
 *   })
 */
export function sse(ctx: IngeniumContext): SseStream {
  const passthrough = new PassThrough()

  // SSE headers — set BEFORE ctx.stream() so the adapter can flush them.
  ctx.set('cache-control', 'no-cache')
  ctx.set('connection', 'keep-alive')
  // Disable proxy buffering (nginx-specific but harmless elsewhere).
  ctx.set('x-accel-buffering', 'no')

  ctx.stream(passthrough, 'text/event-stream; charset=utf-8')

  let closed = false
  passthrough.on('close', () => {
    closed = true
  })

  function write(chunk: string): void {
    if (closed) return
    if (!passthrough.writable) {
      closed = true
      return
    }
    passthrough.write(chunk)
  }

  return {
    get closed(): boolean {
      return closed
    },

    send(eventOrString: SseEvent | string): void {
      if (closed) return
      const evt: SseEvent =
        typeof eventOrString === 'string' ? { data: eventOrString } : eventOrString

      let frame = ''
      // event/id are single-line fields — strip injected CR/LF (see stripNewlines).
      if (evt.event !== undefined) frame += `event: ${stripNewlines(evt.event)}\n`
      if (evt.id !== undefined) frame += `id: ${stripNewlines(evt.id)}\n`
      // retry must be a finite number; ignore anything else so a non-numeric
      // value (untyped JS callers) can't be concatenated into the frame.
      if (typeof evt.retry === 'number' && Number.isFinite(evt.retry)) {
        frame += `retry: ${Math.floor(evt.retry)}\n`
      }

      const dataStr =
        typeof evt.data === 'string' ? evt.data : JSON.stringify(evt.data)
      // Spec: split on newlines, emit one `data:` line per chunk. Normalize CRLF
      // and lone CR to LF first so an embedded `\r` can't act as a frame
      // terminator on spec-compliant clients.
      const lines = dataStr.replace(/\r\n?/g, '\n').split('\n')
      for (const line of lines) {
        frame += `data: ${line}\n`
      }
      frame += '\n'
      write(frame)
    },

    comment(text: string): void {
      if (closed) return
      // Comment lines start with ':'. Strip CR/LF so attacker-supplied comment
      // text can't break out of the comment and inject event fields. Use \n\n
      // terminator to flush.
      write(`: ${stripNewlines(text)}\n\n`)
    },

    close(): void {
      if (closed) return
      closed = true
      passthrough.end()
    },
  }
}
