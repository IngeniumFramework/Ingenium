import type { Buffer } from 'node:buffer'

/**
 * Options for `IngeniumBody.multipart()`.
 *
 * All limits are validated mid-parse — exceeding any of them throws before
 * the full body is fully decoded so memory usage stays bounded.
 */
export interface MultipartOptions {
  /** Total request body cap. Default 100,000 bytes (matches Express's body-parser default). */
  maxBytes?: number
  /** Per-file size cap. Default 10 * 1024 * 1024 (10 MiB). */
  maxFileSize?: number
  /** Maximum number of file parts in one request. Default 20. */
  maxFiles?: number
  /** Maximum number of plain (non-file) field parts. Default 100. */
  maxFields?: number
  /** Allowed MIME prefixes (e.g. ['image/']). File rejected if no prefix matches. Default: any. */
  allowedMimePrefixes?: string[]
}

/** A single uploaded file part, fully buffered. */
export interface MultipartFile {
  /**
   * Original filename as supplied by the client — UNTRUSTED. It is preserved
   * verbatim (the parser does not sanitize it) and may contain path separators,
   * `..`, or NUL bytes. NEVER pass it directly to `fs`/`path.join` when writing
   * uploads: derive your own name or `path.basename()` + allowlist it first,
   * otherwise an attacker can traverse out of the upload directory.
   */
  filename: string
  /** MIME type from the part's `Content-Type` header (defaults to `application/octet-stream`). */
  mimeType: string
  /** Byte length of `data`. */
  size: number
  /** Raw file bytes — fully buffered. For very large uploads, prefer `ctx.body.stream()`. */
  data: Buffer
}

/** Result of parsing a `multipart/form-data` body. */
export interface MultipartResult {
  /** Plain-text form fields keyed by name. Repeated names collapse into an array. */
  fields: Record<string, string | string[]>
  /** File parts keyed by name. Repeated names collapse into an array. */
  files: Record<string, MultipartFile | MultipartFile[]>
}
