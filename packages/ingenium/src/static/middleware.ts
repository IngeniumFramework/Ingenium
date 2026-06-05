import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import * as path from 'node:path'
import type { Stats } from 'node:fs'
import type { IngeniumMiddleware } from '../middleware/types.ts'
import type { StaticOptions } from './types.ts'

/**
 * Minimal MIME table — extension (lowercase, without dot) → content-type.
 * Unknown extensions fall back to `application/octet-stream`.
 */
const MIME_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8',
  woff: 'font/woff',
  woff2: 'font/woff2',
}

const DEFAULT_INDEX = 'index.html'

function mimeFor(file: string): string {
  const ext = path.extname(file).slice(1).toLowerCase()
  return MIME_TYPES[ext] ?? 'application/octet-stream'
}

/**
 * Root confinement: `target` must be `absRoot` itself or a descendant of it.
 * Factored out because it must run on the FINAL resolved target — after the
 * `extensions` and `index` retry loops mutate `target` — not just the decoded
 * request path. A user-configurable `index`/`extensions` value containing `..`
 * (or any join that escapes) would otherwise slip past the up-front check.
 */
function isUnderRoot(absRoot: string, target: string): boolean {
  return target === absRoot || target.startsWith(absRoot + path.sep)
}

/**
 * True if any path segment of `target` below `absRoot` begins with a dot.
 * Re-checked on the final target so an `index`/`extensions` value that resolves
 * to a dotfile (e.g. `index: '.env'`) is still subject to the dotfile policy.
 */
function hasDotfileSegment(absRoot: string, target: string): boolean {
  const rel = path.relative(absRoot, target)
  if (rel.length === 0) return false
  return rel.split(/[/\\]/).some((s) => s.length > 0 && s.startsWith('.'))
}

function makeEtag(stats: Stats): string {
  // Express-style weak etag: W/"<size>-<mtimeMs-as-hex>"
  return `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`
}

/**
 * Parse a `Range: bytes=N-M` header against a known total size.
 * Returns `{ start, end }` (inclusive), `'invalid'` if the header is malformed
 * or unsatisfiable (caller should respond 416), or `null` if no/multi range
 * (caller should serve the full body).
 */
function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'invalid' | null {
  if (!header) return null
  if (!header.startsWith('bytes=')) return null
  const spec = header.slice(6)
  // Multiple ranges: not supported — fall back to full body.
  if (spec.includes(',')) return null
  const dash = spec.indexOf('-')
  if (dash === -1) return 'invalid'
  const startStr = spec.slice(0, dash)
  const endStr = spec.slice(dash + 1)
  let start: number
  let end: number
  if (startStr === '') {
    // Suffix range: bytes=-N → last N bytes
    const suffix = Number(endStr)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(startStr)
    end = endStr === '' ? size - 1 : Number(endStr)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid'
    if (start < 0 || end < start) return 'invalid'
    if (start >= size) return 'invalid'
    if (end >= size) end = size - 1
  }
  return { start, end }
}

/**
 * Static-file middleware. Serves files from `root`, supporting directory
 * indexes, weak ETags, `If-None-Match`, byte-range requests, and basic
 * dotfile policy. Misses (file not found) call `next()` — they do NOT
 * write 404 themselves, so downstream routes still get a chance.
 *
 * @example
 *   app.use(ingenium.static('./public', { maxAge: 60_000 }))
 */
export function staticMiddleware(root: string, opts: StaticOptions = {}): IngeniumMiddleware {
  const absRoot = path.resolve(root)
  const indexFile = opts.index === undefined ? DEFAULT_INDEX : opts.index
  const maxAgeMs = opts.maxAge ?? 0
  const cacheControl = `public, max-age=${Math.floor(maxAgeMs / 1000)}`
  const extensions = opts.extensions ?? []
  const dotfiles = opts.dotfiles ?? 'ignore'

  return async (ctx, next) => {
    // Only GET / HEAD make sense for static.
    if (ctx.method !== 'GET' && ctx.method !== 'HEAD') {
      return next()
    }

    // Decode percent-escapes; reject malformed URLs.
    let urlPath: string
    try {
      urlPath = decodeURIComponent(ctx.path)
    } catch {
      ctx.status(400).text('Bad Request')
      return
    }

    // Path-traversal protection: resolve, then ensure it stays under root.
    const joined = path.join(absRoot, urlPath)
    const resolved = path.resolve(joined)
    if (!isUnderRoot(absRoot, resolved)) {
      ctx.status(403).text('Forbidden')
      return
    }

    // Dotfile policy: check every segment of the path BELOW root.
    if (hasDotfileSegment(absRoot, resolved)) {
      if (dotfiles === 'deny') {
        ctx.status(403).text('Forbidden')
        return
      }
      if (dotfiles === 'ignore') {
        return next()
      }
      // 'allow' falls through.
    }

    // Try to stat the resolved path. Fall through on ENOENT / not-a-file.
    let target = resolved
    let stats: Stats | null = null
    try {
      stats = await stat(target)
    } catch {
      stats = null
    }

    // Try `extensions` if the bare path didn't exist.
    if (!stats && extensions.length > 0) {
      for (const ext of extensions) {
        const withExt = `${target}.${ext.replace(/^\./, '')}`
        try {
          const s = await stat(withExt)
          if (s.isFile()) {
            target = withExt
            stats = s
            break
          }
        } catch {
          // try next
        }
      }
    }

    // Directory → optional index file.
    if (stats && stats.isDirectory()) {
      if (!indexFile) return next()
      const idx = path.join(target, indexFile)
      try {
        const s = await stat(idx)
        if (s.isFile()) {
          target = idx
          stats = s
        } else {
          return next()
        }
      } catch {
        return next()
      }
    }

    if (!stats || !stats.isFile()) {
      return next()
    }

    // Re-run confinement + dotfile policy on the FINAL target. The extensions
    // and index retry loops above mutate `target` (appending `.ext` or joining
    // a user-configurable index name), so the up-front checks on `resolved` are
    // not authoritative for what we are about to stream.
    if (!isUnderRoot(absRoot, target)) {
      ctx.status(403).text('Forbidden')
      return
    }
    if (hasDotfileSegment(absRoot, target)) {
      if (dotfiles === 'deny') {
        ctx.status(403).text('Forbidden')
        return
      }
      if (dotfiles === 'ignore') {
        return next()
      }
      // 'allow' falls through.
    }

    // ───── Cacheable response headers ─────
    const etag = makeEtag(stats)
    const lastModified = new Date(stats.mtimeMs).toUTCString()
    ctx.set('etag', etag)
    ctx.set('last-modified', lastModified)
    ctx.set('cache-control', cacheControl)
    ctx.set('content-type', mimeFor(target))
    ctx.set('accept-ranges', 'bytes')

    // Conditional GET via If-None-Match (preferred) or If-Modified-Since
    // (fallback per RFC 7232 §6). If-None-Match wins when both are present.
    const ifNoneMatch = ctx.headers['if-none-match']
    let notModified = typeof ifNoneMatch === 'string' && ifNoneMatch === etag

    if (!notModified && !ifNoneMatch) {
      const ifModifiedSince = ctx.headers['if-modified-since']
      if (typeof ifModifiedSince === 'string') {
        const sinceMs = Date.parse(ifModifiedSince)
        // mtime is compared at second-resolution because HTTP-dates have no
        // sub-second precision — Math.floor matches both sides.
        const lastMs = Math.floor(stats.mtimeMs / 1000) * 1000
        if (Number.isFinite(sinceMs) && lastMs <= sinceMs) notModified = true
      }
    }

    if (notModified) {
      ctx.status(304)
      // 304 must not have a body.
      ctx._body = { kind: 'none' }
      ctx._written = true
      return
    }

    const size = stats.size
    const rangeHeader = ctx.headers.range
    const range = parseRange(typeof rangeHeader === 'string' ? rangeHeader : undefined, size)

    if (range === 'invalid') {
      ctx.status(416)
      ctx.set('content-range', `bytes */${size}`)
      ctx._body = { kind: 'none' }
      ctx._written = true
      return
    }

    if (range) {
      const { start, end } = range
      const chunk = end - start + 1
      ctx.status(206)
      ctx.set('content-range', `bytes ${start}-${end}/${size}`)
      ctx.set('content-length', String(chunk))
      if (ctx.method === 'HEAD') {
        ctx._body = { kind: 'none' }
        ctx._written = true
        return
      }
      ctx.stream(createReadStream(target, { start, end }))
      return
    }

    // Full body.
    ctx.set('content-length', String(size))
    if (ctx.method === 'HEAD') {
      ctx._body = { kind: 'none' }
      ctx._written = true
      return
    }
    ctx.stream(createReadStream(target))
  }
}
