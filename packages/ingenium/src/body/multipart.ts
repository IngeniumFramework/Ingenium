import { Buffer } from 'node:buffer'
import { IngeniumBadRequestError, IngeniumPayloadTooLargeError } from '../errors.ts'
import type { MultipartFile, MultipartOptions, MultipartResult } from './multipart-types.ts'

/** Default per-file cap: 10 MiB. */
const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024
/** Default file-count cap. */
const DEFAULT_MAX_FILES = 20
/** Default field-count cap. */
const DEFAULT_MAX_FIELDS = 100

const CRLF = Buffer.from('\r\n')
const DOUBLE_CRLF = Buffer.from('\r\n\r\n')
const DASH_DASH = Buffer.from('--')

/**
 * Extract the `boundary` parameter from a `Content-Type` header.
 * Per RFC 7578 / RFC 2046 the boundary is required and case-insensitive
 * parameter name; the value may be quoted.
 */
function extractBoundary(contentType: string | undefined): string {
  if (!contentType) {
    throw new IngeniumBadRequestError('Content-Type header missing')
  }
  // The mime type itself is case-insensitive.
  const lower = contentType.toLowerCase()
  if (!lower.startsWith('multipart/form-data')) {
    throw new IngeniumBadRequestError('Content-Type is not multipart/form-data')
  }
  // Walk parameters: split on `;` but only after the type. We don't bother with
  // RFC 2231 continuations — boundaries are restricted to a 70-char ASCII subset.
  const params = contentType.slice(contentType.indexOf(';') + 1).split(';')
  for (const raw of params) {
    const eq = raw.indexOf('=')
    if (eq === -1) continue
    const name = raw.slice(0, eq).trim().toLowerCase()
    if (name !== 'boundary') continue
    let value = raw.slice(eq + 1).trim()
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1)
    }
    if (value.length === 0) {
      throw new IngeniumBadRequestError('multipart boundary is empty')
    }
    return value
  }
  throw new IngeniumBadRequestError('multipart boundary missing')
}

interface PartHeaders {
  /** form-data field name (`Content-Disposition: ...; name="..."`). */
  name: string
  /** filename, if present. Presence marks the part as a file. */
  filename: string | undefined
  /** Content-Type header, if present. */
  contentType: string | undefined
}

/**
 * Parse the headers of a single part from a header-block string (already
 * split off at the `\r\n\r\n` boundary). Header names are case-insensitive.
 */
function parsePartHeaders(block: string): PartHeaders {
  const lines = block.split('\r\n')
  let name: string | undefined
  let filename: string | undefined
  let contentType: string | undefined

  for (const line of lines) {
    if (line.length === 0) continue
    const colon = line.indexOf(':')
    if (colon === -1) {
      throw new IngeniumBadRequestError('Malformed multipart body: invalid header line')
    }
    const headerName = line.slice(0, colon).trim().toLowerCase()
    const headerValue = line.slice(colon + 1).trim()

    if (headerName === 'content-disposition') {
      // form-data; name="x"; filename="y"
      const params = headerValue.split(';')
      // First token is the disposition (`form-data`); we only accept that.
      const disposition = params[0]?.trim().toLowerCase()
      if (disposition !== 'form-data') {
        throw new IngeniumBadRequestError('Malformed multipart body: unsupported Content-Disposition')
      }
      for (let i = 1; i < params.length; i++) {
        const p = params[i]!
        const eq = p.indexOf('=')
        if (eq === -1) continue
        const k = p.slice(0, eq).trim().toLowerCase()
        let v = p.slice(eq + 1).trim()
        if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
        // Decode common escapes (\" and \\) — RFC 7578 references RFC 2183.
        v = v.replace(/\\(.)/g, '$1')
        if (k === 'name') name = v
        else if (k === 'filename') filename = v
      }
    } else if (headerName === 'content-type') {
      contentType = headerValue
    }
    // Other headers (Content-Transfer-Encoding etc.) are ignored.
  }

  if (name === undefined) {
    throw new IngeniumBadRequestError('Malformed multipart body: missing form-data name')
  }
  return { name, filename, contentType }
}

/**
 * Stash a parsed field into `fields` / `files`, collapsing repeated names
 * into arrays in arrival order. Mixing field+file under one name follows
 * arrival order too (rare; not specifically supported).
 */
function appendField(
  result: MultipartResult,
  headers: PartHeaders,
  body: Buffer,
): void {
  if (headers.filename !== undefined) {
    const file: MultipartFile = {
      filename: headers.filename,
      mimeType: headers.contentType ?? 'application/octet-stream',
      size: body.length,
      data: body,
    }
    const existing = result.files[headers.name]
    if (existing === undefined) {
      result.files[headers.name] = file
    } else if (Array.isArray(existing)) {
      existing.push(file)
    } else {
      result.files[headers.name] = [existing, file]
    }
  } else {
    const value = body.toString('utf8')
    const existing = result.fields[headers.name]
    if (existing === undefined) {
      result.fields[headers.name] = value
    } else if (Array.isArray(existing)) {
      existing.push(value)
    } else {
      result.fields[headers.name] = [existing, value]
    }
  }
}

/**
 * Parse a `multipart/form-data` request body. Operates on raw bytes — boundary
 * sequences can legally appear inside binary file payloads, so we never
 * convert the payload to a string before splitting.
 *
 * @param buffer Full body bytes (already buffered & length-checked by caller).
 * @param contentType Raw `Content-Type` header — boundary is extracted from it.
 * @param opts Limits and filters.
 */
export function parseMultipart(
  buffer: Buffer,
  contentType: string | undefined,
  opts: MultipartOptions = {},
): MultipartResult {
  const maxFileSize = opts.maxFileSize ?? DEFAULT_MAX_FILE_SIZE
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES
  const maxFields = opts.maxFields ?? DEFAULT_MAX_FIELDS
  const allowed = opts.allowedMimePrefixes

  const boundary = extractBoundary(contentType)
  // Use null-prototype maps so an attacker-chosen part name (`__proto__`,
  // `constructor`, `prototype`) is stored as plain own-data instead of tripping
  // the `__proto__` setter — which would otherwise reparent the maps' prototype
  // and corrupt the membership/lookup logic in `appendField`. Mirrors the query
  // parser's `toShallowArrayObject` in context.ts.
  const result: MultipartResult = {
    fields: Object.create(null),
    files: Object.create(null),
  }

  // Empty body → empty result. (No boundary delimiter at all.)
  if (buffer.length === 0) return result

  // RFC 7578: each part is preceded by `--<boundary>`. The first occurrence
  // may not be at byte 0 (a "preamble" is permitted but must be ignored).
  const dashBoundary = Buffer.concat([DASH_DASH, Buffer.from(boundary)])

  let cursor = buffer.indexOf(dashBoundary)
  if (cursor === -1) {
    throw new IngeniumBadRequestError('Malformed multipart body: opening boundary not found')
  }
  cursor += dashBoundary.length

  let fileCount = 0
  let fieldCount = 0

  // Loop over parts. After each `--<boundary>` we expect either:
  //   `--`     → final close delimiter (end of stream)
  //   `\r\n`   → start of a part (headers follow)
  // anything else is malformed.
  for (;;) {
    if (cursor + 2 > buffer.length) {
      throw new IngeniumBadRequestError('Malformed multipart body: truncated after boundary')
    }
    // Final delimiter: `--<boundary>--`
    if (buffer[cursor] === 0x2d && buffer[cursor + 1] === 0x2d) {
      // Close delimiter — done. We deliberately accept any trailing epilogue.
      return result
    }
    // Otherwise expect CRLF before headers.
    if (buffer[cursor] !== 0x0d || buffer[cursor + 1] !== 0x0a) {
      throw new IngeniumBadRequestError('Malformed multipart body: expected CRLF after boundary')
    }
    cursor += 2

    // Header block ends at the first `\r\n\r\n`.
    const headerEnd = buffer.indexOf(DOUBLE_CRLF, cursor)
    if (headerEnd === -1) {
      throw new IngeniumBadRequestError('Malformed multipart body: missing header terminator')
    }
    const headerBlock = buffer.slice(cursor, headerEnd).toString('utf8')
    const headers = parsePartHeaders(headerBlock)
    cursor = headerEnd + DOUBLE_CRLF.length

    // Body bytes run until the next `\r\n--<boundary>`. Boundaries may appear
    // inside binary payloads so we MUST scan bytes, not strings.
    const delimiter = Buffer.concat([CRLF, dashBoundary])
    const partEnd = buffer.indexOf(delimiter, cursor)
    if (partEnd === -1) {
      throw new IngeniumBadRequestError('Malformed multipart body: missing closing boundary')
    }

    const partBody = buffer.slice(cursor, partEnd)

    if (headers.filename !== undefined) {
      // File part — apply size + count + mime checks.
      if (partBody.length > maxFileSize) {
        throw new IngeniumPayloadTooLargeError(
          `File "${headers.filename}" exceeded ${maxFileSize} bytes`,
        )
      }
      if (allowed && allowed.length > 0) {
        const mime = (headers.contentType ?? 'application/octet-stream').toLowerCase()
        const ok = allowed.some((prefix) => mime.startsWith(prefix.toLowerCase()))
        if (!ok) {
          throw new IngeniumBadRequestError('Disallowed mime type')
        }
      }
      fileCount++
      if (fileCount > maxFiles) {
        throw new IngeniumBadRequestError('Too many files')
      }
    } else {
      fieldCount++
      if (fieldCount > maxFields) {
        throw new IngeniumBadRequestError('Too many fields')
      }
    }

    appendField(result, headers, partBody)

    cursor = partEnd + delimiter.length
    // Next iteration will check for `--` (close) or `\r\n` (next part).
  }
}
