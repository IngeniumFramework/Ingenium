import type { IngeniumContext } from '../context/context.ts'

/**
 * Function form of the `origin` option. Receives the request's `Origin`
 * header value (always a string — never called when no `Origin` is present)
 * and the active `IngeniumContext`. May return:
 *
 * - `true`  — allow the request, reflect the request's `Origin` back.
 * - `false` — deny the request (no `Access-Control-Allow-Origin` header set).
 * - `string` — allow the request, use this exact value as the
 *   `Access-Control-Allow-Origin` header (use `'*'` for the wildcard).
 *
 * May be sync or async.
 */
export type CorsOriginFn = (
  origin: string,
  ctx: IngeniumContext,
) => boolean | string | Promise<boolean | string>

/**
 * Spec for the `origin` option.
 *
 * - `boolean` — `true` reflects any request `Origin` (but never the literal
 *   `"null"`, and rejected at construction when `credentials: true`); `false`
 *   disables CORS.
 * - `'*'` — wildcard: `Access-Control-Allow-Origin: *`.
 * - any other `string` — exact match against the request's `Origin`.
 * - `string[]` — allowlist; matched exactly.
 * - `RegExp` — tested against the request's `Origin`.
 * - `CorsOriginFn` — fully custom predicate (see above).
 */
export type CorsOrigin =
  | boolean
  | string
  | string[]
  | RegExp
  | CorsOriginFn

/**
 * Options for `ingenium.cors`. All fields are optional. See README for details.
 */
export interface CorsOptions {
  /** Origin policy. Default: `'*'`. */
  origin?: CorsOrigin

  /**
   * Methods advertised on `Access-Control-Allow-Methods` for preflight.
   * Default: `['GET','HEAD','PUT','PATCH','POST','DELETE']`.
   */
  methods?: string[]

  /**
   * Headers advertised on `Access-Control-Allow-Headers` for preflight.
   * If `undefined`, the value of `Access-Control-Request-Headers` from the
   * preflight request is mirrored back. Default: `undefined`.
   */
  allowedHeaders?: string[]

  /**
   * Headers advertised on `Access-Control-Expose-Headers` for simple
   * responses. Default: `undefined` (header omitted).
   */
  exposedHeaders?: string[]

  /**
   * If `true`, sets `Access-Control-Allow-Credentials: true`.
   * Incompatible with `origin: '*'` and `origin: true` — both throw at
   * construction time, because reflecting credentials to an unrestricted set of
   * origins lets any site read authenticated responses. Default: `false`.
   */
  credentials?: boolean

  /**
   * `Access-Control-Max-Age` (seconds). Default: `undefined` (header omitted).
   */
  maxAge?: number

  /**
   * Status code for successful preflight responses. Default: `204`.
   */
  optionsSuccessStatus?: number
}
