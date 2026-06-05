import type { IngeniumContext } from 'ingenium'

/** Result of a custom API-key validator. */
export type ApiKeyValidator = (
  key: string,
  ctx: IngeniumContext,
) => boolean | Promise<boolean>

/** Optional logger for redacted failure reasons. */
export type ApiKeyLogger = (event: { reason: string }) => void

export interface ApiKeyOptions {
  /**
   * Either an allow-list of valid keys (compared with `timingSafeEqual`) or a
   * custom validator. Functions get the candidate key and the request ctx.
   */
  keys: readonly string[] | ApiKeyValidator
  /** Header to read the key from. Default `'x-api-key'`. */
  header?: string
  /**
   * Optional fallback query-string parameter, e.g. `'api_key'`. When set,
   * the middleware checks `?api_key=...` if no header / scheme key matched.
   */
  query?: string
  /**
   * Optional `Authorization` scheme to accept, e.g. `'ApiKey'`. When set,
   * the middleware accepts `Authorization: ApiKey <key>`.
   */
  scheme?: string
  /**
   * If `true` (default), missing keys raise `IngeniumUnauthorizedError`. If
   * `false`, missing keys just call `next()` with no `ctx.apiKey`.
   */
  required?: boolean
  /** Optional sink for redacted failure reasons. Defaults to `process.emitWarning`. */
  logger?: ApiKeyLogger
}
