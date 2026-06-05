import type { IngeniumContext } from '../context/context.ts'
import {
  IngeniumError,
  IngeniumMethodNotAllowedError,
  IngeniumValidationError,
} from '../errors.ts'
import type { ProblemDetails, ResolvedProblemDetailsOptions } from './types.ts'

/**
 * Read once at module load so V8 dead-code-eliminates the dev-only branch in
 * production builds. See CLAUDE.md "Dev-mode diagnostics" rule.
 */
const IS_DEV = process.env.NODE_ENV !== 'production'

/**
 * Maps known framework error codes to short, human-readable titles. Falls
 * back to the standard HTTP reason phrase, then to the error's own message.
 */
const TITLES: Readonly<Record<string, string>> = Object.freeze({
  NOT_FOUND: 'Not Found',
  UNAUTHORIZED: 'Unauthorized',
  METHOD_NOT_ALLOWED: 'Method Not Allowed',
  PAYLOAD_TOO_LARGE: 'Payload Too Large',
  VALIDATION_FAILED: 'Validation Failed',
  BAD_REQUEST: 'Bad Request',
  RATE_LIMITED: 'Too Many Requests',
  INTERNAL_ERROR: 'Internal Server Error',
})

/** Generic HTTP status reason phrases for common codes (fallback for unknown errors). */
const STATUS_REASON: Readonly<Record<number, string>> = Object.freeze({
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
})

/** UPPER_SNAKE_CASE → kebab-case path segment for `type` URIs. */
function codeToSlug(code: string): string {
  return code.toLowerCase().replace(/_/g, '-')
}

/**
 * Build the `type` field. Returns `'about:blank'` (RFC 7807 default) when
 * no `typeBaseUrl` is configured, otherwise prefixes the slugified code.
 */
function buildType(code: string, baseUrl: string): string {
  if (baseUrl === 'about:blank' || baseUrl === '') return 'about:blank'
  // Avoid double-slash when caller forgot the trailing slash.
  return baseUrl.endsWith('/')
    ? `${baseUrl}${codeToSlug(code)}`
    : `${baseUrl}/${codeToSlug(code)}`
}

/**
 * Convert a thrown value into an RFC 7807 ProblemDetails object. Handles
 * `IngeniumError` and its subclasses with rich extensions; unknown errors are
 * reported as a generic 500 with `type: 'about:blank'`.
 *
 * Side effect: for `IngeniumMethodNotAllowedError`, the `Allow` header is set
 * on the response so it matches the framework's default boundary behavior.
 */
export function toProblemDetails(
  err: unknown,
  opts: ResolvedProblemDetailsOptions,
  ctx: IngeniumContext,
): ProblemDetails {
  if (err instanceof IngeniumError) {
    const title = TITLES[err.code] ?? STATUS_REASON[err.statusCode] ?? err.message
    const problem: ProblemDetails = {
      type: buildType(err.code, opts.typeBaseUrl),
      title,
      status: err.statusCode,
      detail: err.message,
    }

    const instance = opts.instance(ctx)
    if (instance !== undefined) problem.instance = instance

    // Carry the framework error code as a non-standard extension so clients
    // can program against it without parsing the `type` URI.
    problem.code = err.code

    if (err instanceof IngeniumValidationError) {
      problem.fields = err.fields
    }

    if (err instanceof IngeniumMethodNotAllowedError) {
      problem.allowed = err.allowed
      ctx.set('allow', err.allowed.join(', '))
    }

    if (opts.includeStack && typeof err.stack === 'string') {
      problem.stack = err.stack
    }

    return problem
  }

  // Unknown error — generic 500. Unlike IngeniumError (whose `message` is
  // developer-authored and safe to surface), an arbitrary thrown value's
  // message can leak internal infrastructure detail (DB DSNs with hostnames /
  // credentials, file paths, driver internals). In production we therefore
  // replace it with a generic phrase and only expose the raw message in dev or
  // when the explicit `includeStack` debug opt-in is enabled.
  const exposeMessage = IS_DEV || opts.includeStack
  const message = (err as Error)?.message
  const detail =
    exposeMessage && typeof message === 'string' && message.length > 0
      ? message
      : 'Internal Server Error'
  const problem: ProblemDetails = {
    type: 'about:blank',
    title: STATUS_REASON[500]!,
    status: 500,
    detail,
  }

  const instance = opts.instance(ctx)
  if (instance !== undefined) problem.instance = instance

  if (opts.includeStack && err instanceof Error && typeof err.stack === 'string') {
    problem.stack = err.stack
  }

  return problem
}
