import type { Readable } from 'node:stream'
import { Buffer } from 'node:buffer'
import { IngeniumBadRequestError, IngeniumPayloadTooLargeError, IngeniumValidationError } from '../errors.ts'
import { createByteLimit } from '../body/limit.ts'
import { parseMultipart } from '../body/multipart.ts'
import type { MultipartOptions, MultipartResult } from '../body/multipart-types.ts'
import {
  isStandardSchema,
  type StandardIssue,
  type StandardSchemaV1,
} from '../schema/standard.ts'

/**
 * Hard cap on the number of fields materialized by `urlencoded()`. A body like
 * `a=1&a=2&...` repeated thousands of times forces unbounded object growth in a
 * single request. `multipart()` already caps its field/file counts; this closes
 * the parity gap for the urlencoded parser. The cap runs inside the existing
 * walk (no extra pass) and only on the lazy `urlencoded()` path.
 */
const MAX_URLENCODED_FIELDS = 1000

/** Minimal duck-type for any validation library that accepts unknown and returns a typed value. */
export interface ParseSchema<T> {
  parse(input: unknown): T
}

/** Optional Zod-like schema: success/failure object output (used internally for friendlier errors). */
export interface SafeParseSchema<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: { issues: ZodLikeIssue[] } }
}

interface ZodLikeIssue {
  path: ReadonlyArray<string | number>
  message: string
}

/** Normalize a Standard Schema issue path into a dot-joined field key. */
function standardPathToField(path: StandardIssue['path']): string {
  if (!path || path.length === 0) return '_'
  const parts: string[] = []
  for (const seg of path) {
    if (seg !== null && typeof seg === 'object' && 'key' in seg) {
      parts.push(String(seg.key))
    } else {
      parts.push(String(seg))
    }
  }
  return parts.join('.') || '_'
}

/**
 * Default body size limit for `IngeniumBody.json/text/urlencoded/buffer`.
 * 100,000 bytes matches Express's `body-parser` default (`'100kb'`),
 * which is the convention every Express app implicitly relies on. Override
 * per-call (`ctx.body.json(undefined, 5_000_000)`) or set a different
 * default by configuring your `ingenium.json({ limit })` middleware (the
 * middleware is currently a stub — see `body/middleware.ts`).
 */
const DEFAULT_MAX_BYTES = 100_000

/**
 * Lazy body accessor. Bytes are not read until one of the consume methods
 * (`json`, `text`, `urlencoded`, `buffer`, `stream`) is called.
 *
 * One instance is allocated per `IngeniumContext` (pool-bound), so per-request
 * cost is just a `reset()`.
 */
export class IngeniumBody {
  /** @internal */ _source: Readable | null = null
  /** @internal */ _consumed = false
  /** @internal */ _contentType: string | undefined = undefined
  /** @internal */ _contentLength: number | undefined = undefined
  /**
   * @internal
   * Parse cache. Stores the raw body bytes after the first successful
   * `buffer()` (or `text()` / `json()` / `urlencoded()`, which all go
   * through `buffer()`). Subsequent buffer-producing consumers reuse
   * these bytes instead of throwing "already consumed".
   *
   * Caches the RAW Buffer (not parsed objects) so different callers can
   * apply different schemas / decoders against the same bytes — a
   * common pattern when an audit middleware reads the body before the
   * handler does. Re-parsing JSON from a cached buffer is cheap; mixing
   * schemas against a cached parsed object would be incorrect.
   *
   * `stream()` opts out (it hands the caller ownership of the raw
   * Readable) and `multipart()` opts out (its result is bespoke and
   * re-parsing with different options would be ambiguous).
   *
   * Checked with `!== null` rather than truthiness so an empty body
   * (`Buffer.alloc(0)`) still hits the cache on subsequent reads.
   */
  /** @internal */ _cached: Buffer | null = null

  /** @internal Adapter calls this on each request before dispatch. */
  _attach(source: Readable | null, contentType: string | undefined, contentLength: number | undefined): void {
    this._source = source
    this._consumed = false
    this._contentType = contentType
    this._contentLength = contentLength
    this._cached = null
  }

  /** @internal Pool reset. */
  _reset(): void {
    this._source = null
    this._consumed = false
    this._contentType = undefined
    this._contentLength = undefined
    this._cached = null
  }

  /**
   * Returns the raw request body stream. Throws if already consumed OR
   * if the body has already been buffered (cached) — once we hold the
   * bytes, we can't hand the caller back a fresh Readable to own.
   */
  stream(): Readable {
    if (this._cached !== null) throw new IngeniumBadRequestError('Request body already consumed')
    if (this._consumed) throw new IngeniumBadRequestError('Request body already consumed')
    if (!this._source) throw new IngeniumBadRequestError('Request has no body')
    this._consumed = true
    return this._source
  }

  /**
   * Buffers the entire body into a `Buffer`. Honors `maxBytes` (default 100KB).
   *
   * If the body has already been buffered once (by any prior `buffer()`,
   * `text()`, `json()`, or `urlencoded()` call), returns the cached bytes
   * — `maxBytes` is still enforced against `cached.length`, so a caller
   * passing a tighter cap than the original still gets a 413.
   */
  async buffer(maxBytes: number = DEFAULT_MAX_BYTES): Promise<Buffer> {
    // Cached path: reuse bytes, but honor the caller's ceiling.
    if (this._cached !== null) {
      if (this._cached.length > maxBytes) {
        throw new IngeniumPayloadTooLargeError(
          `Request body exceeded ${maxBytes} bytes`,
        )
      }
      return this._cached
    }
    if (this._consumed) throw new IngeniumBadRequestError('Request body already consumed')
    if (!this._source) {
      // Empty body — cache the empty buffer so subsequent consumers
      // also hit the cached path (consistent semantics).
      this._cached = Buffer.alloc(0)
      return this._cached
    }
    this._consumed = true

    const cl = this._contentLength
    if (cl !== undefined && cl > maxBytes) {
      // Drain source so the connection can be reused.
      this._source.resume()
      throw new IngeniumPayloadTooLargeError(
        `Request body exceeded ${maxBytes} bytes`,
      )
    }

    const source = this._source

    // Fast path: Content-Length is known and within cap. Pre-allocate exactly
    // one Buffer and copy chunks directly into it — eliminates the chunks[]
    // array, the per-chunk push, and the final Buffer.concat copy. Same
    // observable behavior, ~2-3 fewer allocations per request, and a single
    // contiguous write instead of a copy-then-walk.
    //
    // The transport-layer Transform may already be installed; that's fine —
    // it just no-ops for in-bounds bodies. We do not install a second one
    // here when we know the length (the transport already enforced).
    if (cl !== undefined && cl >= 0) {
      const buf = Buffer.allocUnsafe(cl)
      let offset = 0
      return new Promise<Buffer>((resolve, reject) => {
        source.on('data', (chunk: Buffer) => {
          // Defensive: clamp to declared length so a misbehaving stream
          // can't write past our pre-allocated buffer. (`node:http` itself
          // already enforces Content-Length, so this is belt + suspenders.)
          const remaining = cl - offset
          if (remaining <= 0) return
          const n = chunk.length <= remaining ? chunk.length : remaining
          chunk.copy(buf, offset, 0, n)
          offset += n
        })
        source.on('end', () => {
          // If the client truncated, return the partial buffer (matches the
          // chunks-then-concat path's behavior pre-optimization).
          const result = offset === cl ? buf : buf.subarray(0, offset)
          // Cache before resolving so a follow-up consumer that awaits this
          // same promise can read `_cached` immediately after.
          this._cached = result
          resolve(result)
        })
        source.on('error', reject)
      })
    }

    // Unknown length (chunked encoding, no Content-Length) — fall back to
    // the chunks + Buffer.concat path with the byte-limit Transform on top.
    const limited = source.pipe(createByteLimit(maxBytes))
    const chunks: Buffer[] = []
    return new Promise<Buffer>((resolve, reject) => {
      limited.on('data', (chunk: Buffer) => chunks.push(chunk))
      limited.on('end', () => {
        const result = Buffer.concat(chunks)
        this._cached = result
        resolve(result)
      })
      limited.on('error', reject)
    })
  }

  /** Buffers the body and decodes as UTF-8 text. */
  async text(maxBytes?: number): Promise<string> {
    const buf = await this.buffer(maxBytes)
    return buf.length === 0 ? '' : buf.toString('utf8')
  }

  /**
   * Parses the body as JSON. If a schema is provided, the parsed value is
   * validated. Detection order:
   *
   *   1. Standard Schema v1 (`["~standard"]`) — async-aware, multi-issue
   *   2. Zod-like `safeParse(input)` — multi-issue
   *   3. Plain `parse(input): T` — throws on failure
   *
   * Validation failures are normalized into `IngeniumValidationError` with a
   * field-level `fields` map (dot-joined paths; empty path → `_`).
   */
  async json<T = unknown>(
    schema?: StandardSchemaV1<unknown, T> | SafeParseSchema<T> | ParseSchema<T>,
    maxBytes?: number,
  ): Promise<T> {
    // Inline `text()` to skip one async indirection (one microtask saved
    // per ctx.body.json() call). Same observable behavior.
    const buf = await this.buffer(maxBytes)
    const text = buf.length === 0 ? '' : buf.toString('utf8')
    let parsed: unknown
    try {
      parsed = text.length === 0 ? null : JSON.parse(text)
    } catch (err) {
      throw new IngeniumBadRequestError('Invalid JSON', err)
    }
    if (schema) {
      // 1. Standard Schema v1 — most modern, takes precedence.
      if (isStandardSchema(schema)) {
        const maybe = schema['~standard'].validate(parsed)
        const result = maybe instanceof Promise ? await maybe : maybe
        if (result.issues) {
          const fields: Record<string, string> = {}
          for (const issue of result.issues) {
            fields[standardPathToField(issue.path)] = issue.message
          }
          throw new IngeniumValidationError(fields)
        }
        return result.value as T
      }
      // 2. Zod-like safeParse.
      if ('safeParse' in schema && typeof (schema as SafeParseSchema<T>).safeParse === 'function') {
        const result = (schema as SafeParseSchema<T>).safeParse(parsed)
        if (!result.success) {
          const fields: Record<string, string> = {}
          for (const issue of result.error.issues) {
            fields[issue.path.join('.') || '_'] = issue.message
          }
          throw new IngeniumValidationError(fields)
        }
        return result.data
      }
      // 3. Plain parse.
      try {
        return (schema as ParseSchema<T>).parse(parsed)
      } catch (err) {
        throw new IngeniumValidationError({ _: (err as Error).message ?? 'validation failed' })
      }
    }
    return parsed as T
  }

  /**
   * Parses the body as `application/x-www-form-urlencoded`.
   *
   * Rejects with {@link IngeniumBadRequestError} when the body carries more
   * than `maxFields` distinct field entries (default
   * {@link MAX_URLENCODED_FIELDS}). Without this cap an attacker could send an
   * arbitrarily long `a=1&b=2&...` body to force unbounded object growth — the
   * multipart parser already enforces an equivalent field cap.
   */
  async urlencoded(maxBytes?: number, maxFields: number = MAX_URLENCODED_FIELDS): Promise<Record<string, string>> {
    const text = await this.text(maxBytes)
    const params = new URLSearchParams(text)
    const out: Record<string, string> = {}
    let count = 0
    for (const [k, v] of params) {
      if (++count > maxFields) {
        throw new IngeniumBadRequestError(`Too many form fields (limit ${maxFields})`)
      }
      out[k] = v
    }
    return out
  }

  /**
   * Parses the body as `multipart/form-data` (RFC 7578).
   *
   * Returns plain-text fields and fully buffered file parts. For very large
   * uploads prefer `stream()` and parse manually — this method holds every
   * file in memory.
   *
   * Failure modes:
   * - Body exceeds `maxBytes` → `IngeniumPayloadTooLargeError`
   * - Single file exceeds `maxFileSize` → `IngeniumPayloadTooLargeError`
   * - Too many files / fields → `IngeniumBadRequestError`
   * - Disallowed mime type → `IngeniumBadRequestError`
   * - Content-Type isn't `multipart/form-data` or boundary missing → `IngeniumBadRequestError`
   * - Malformed body → `IngeniumBadRequestError`
   */
  async multipart(opts: MultipartOptions = {}): Promise<MultipartResult> {
    // Multipart opts out of the buffer cache. Unlike json/text/urlencoded —
    // which all return idempotent decodings of the same bytes — multipart's
    // result is bespoke (file parts, field limits, mime allow-lists), and
    // re-parsing the same bytes under different `opts` would silently return
    // a different shape. Safer to treat multipart as a terminal consumer:
    // it runs once, then any further body access throws.
    //
    // To enforce that, we either consume the live stream (first call) or
    // read the cached buffer (someone called .text()/.json() first), then
    // immediately invalidate both — clearing `_cached` and setting
    // `_consumed = true` so subsequent .json()/.text()/.multipart()/.stream()
    // calls throw "already consumed".
    const contentType = this._contentType
    const buf = await this.buffer(opts.maxBytes ?? DEFAULT_MAX_BYTES)
    this._cached = null
    this._consumed = true
    try {
      return parseMultipart(buf, contentType, opts)
    } catch (err) {
      // Preserve framework errors (415/413/400) as-is.
      if (err instanceof IngeniumPayloadTooLargeError || err instanceof IngeniumBadRequestError) {
        throw err
      }
      throw new IngeniumBadRequestError('Malformed multipart body', err)
    }
  }
}
