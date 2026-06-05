/**
 * Ingenium — Express DX, Hono/Fastify throughput.
 *
 * @packageDocumentation
 */

import { makeIngeniumFactory, type IngeniumFactory } from './app.ts'
import { jsonMiddleware, urlencodedMiddleware } from './body/middleware.ts'
import { staticMiddleware } from './static/middleware.ts'
import { corsMiddleware } from './cors/middleware.ts'
import { sse } from './sse/sse.ts'
import { rateLimit } from './rate-limit/middleware.ts'
import { csrfMiddleware } from './csrf/middleware.ts'
import { problemDetailsMiddleware } from './problem/middleware.ts'
import { idempotencyMiddleware } from './idempotency/middleware.ts'
import { openapiHandler } from './openapi/handler.ts'

// ───── App + Router ────────────────────────────────────────────────────────
export {
  IngeniumApp,
  type IngeniumAppOptions,
  type IngeniumErrorHandler,
  type RouteOptions,
  type InjectRequest,
  type InjectResponse,
} from './app.ts'
export { Router, RouteBuilder } from './router/router.ts'

// ───── Context + Body ──────────────────────────────────────────────────────
export { IngeniumContext, type ResponseBody, type IngeniumQuery } from './context/context.ts'
export type {
  IngeniumCookies,
  CookieSetOptions,
  CookieGetOptions,
} from './context/cookies.ts'
export { IngeniumBody, type ParseSchema, type SafeParseSchema } from './context/body.ts'
export { IngeniumContextPool } from './context/pool.ts'
export type {
  MultipartFile,
  MultipartOptions,
  MultipartResult,
} from './body/multipart-types.ts'

// ───── Standard Schema (https://standardschema.dev) ────────────────────────
export {
  isStandardSchema,
  type StandardSchemaV1,
  type StandardResult,
  type StandardIssue,
  type StandardPathSegment,
  type StandardSuccessResult,
  type StandardFailureResult,
  type StandardSchemaV1Props,
} from './schema/standard.ts'

// ───── Middleware + Handler types ──────────────────────────────────────────
export type { IngeniumMiddleware, IngeniumHandler, ComposedHandler } from './middleware/types.ts'
export { compose, composeWithHandler } from './middleware/compose.ts'

// ───── Router types ────────────────────────────────────────────────────────
export type { HttpMethod, ExtractParams } from './router/types.ts'
export { HTTP_METHODS } from './router/types.ts'
export { RouterTrie, TrieNode, type MatchResult, type MatchMiss } from './router/trie.ts'

// ───── Static-file middleware ──────────────────────────────────────────────
export { staticMiddleware as static_ } from './static/middleware.ts'
export type { StaticOptions } from './static/types.ts'

// ───── CORS middleware ─────────────────────────────────────────────────────
export { corsMiddleware as cors_ } from './cors/middleware.ts'
export type { CorsOptions, CorsOrigin, CorsOriginFn } from './cors/types.ts'

// ───── Errors ──────────────────────────────────────────────────────────────
export {
  IngeniumError,
  IngeniumNotFoundError,
  IngeniumUnauthorizedError,
  IngeniumMethodNotAllowedError,
  IngeniumPayloadTooLargeError,
  IngeniumValidationError,
  IngeniumBadRequestError,
  IngeniumHeaderInjectionError,
  IngeniumUnserializableError,
  IngeniumTimeoutError,
  IngeniumHaltError,
} from './errors.ts'

// ───── JSON serialization helpers ──────────────────────────────────────────
export { safeJsonStringify, type SafeJsonStringifyOptions } from './util/safe-json.ts'

// ───── Transport (mainly for advanced users / tests) ───────────────────────
export type { Transport, TransportHooks, ListeningServer, CloseOptions } from './transport/types.ts'
export { NodeAdapter } from './transport/node.ts'
export { Http2Adapter, Http2cAdapter, type Http2AdapterOptions } from './transport/http2.ts'
export { gracefulShutdown, type ShutdownOptions } from './transport/shutdown.ts'

// ───── Trust-proxy ─────────────────────────────────────────────────────────
export { resolveForwarded, type TrustProxy, type ForwardedInfo } from './proxy/trust.ts'

// ───── Server-Sent Events helper ───────────────────────────────────────────
export { sse, type SseStream, type SseEvent } from './sse/sse.ts'
export { startKeepAlive } from './sse/keep-alive.ts'

// ───── Rate-limit middleware ───────────────────────────────────────────────
export { rateLimit } from './rate-limit/middleware.ts'
export { MemoryStore as RateLimitMemoryStore } from './rate-limit/store.ts'
export type { RateLimitOptions, RateLimitStore } from './rate-limit/types.ts'

// ───── CSRF middleware ─────────────────────────────────────────────────────
export { csrfMiddleware, IngeniumCsrfError } from './csrf/middleware.ts'
export type { CsrfOptions, CsrfStorage, CsrfCookieOptions, CsrfValueReader } from './csrf/types.ts'

// ───── Content negotiation ─────────────────────────────────────────────────
export {
  parseAcceptHeader,
  selectBest,
  expandShorthand,
  sortByPreference,
  type ParsedAccept,
} from './negotiation/accept.ts'
export {
  accepts,
  acceptsCharsets,
  acceptsLanguages,
  acceptsEncodings,
  type NegotiableCtx,
} from './negotiation/negotiate.ts'
export {
  formatResponse,
  type FormatHandlers,
  type FormattableCtx,
} from './negotiation/format.ts'
export { isFresh, type HeaderBag } from './negotiation/fresh.ts'
export { computeEtag } from './negotiation/etag.ts'
export {
  respondJsonWithEtag,
  type JsonEtagOptions,
  type JsonEtagCtx,
} from './negotiation/json-etag.ts'

// ───── RFC 7807 Problem Details middleware ─────────────────────────────────
export { problemDetailsMiddleware } from './problem/middleware.ts'
export { toProblemDetails } from './problem/serialize.ts'
export type { ProblemDetails, ProblemDetailsOptions } from './problem/types.ts'

// ───── Idempotency-Key middleware ──────────────────────────────────────────
export { idempotencyMiddleware } from './idempotency/middleware.ts'
export { IdempotencyMemoryStore } from './idempotency/store.ts'
export type {
  CachedResponse,
  IdempotencyOptions,
  IdempotencyStore,
} from './idempotency/types.ts'

// ───── JWT + API-key middleware ────────────────────────────────────────────
// Moved to the `ingenium-auth` package (v0.0.5) so apps that don't
// authenticate don't carry the JWT/JWKS stack. Import from there:
//   import { jwtMiddleware, apiKeyMiddleware } from 'ingenium-auth'

// ───── OpenAPI 3.1 spec generation ─────────────────────────────────────────
export { generateOpenApi } from './openapi/generate.ts'
export type { GenerateOpenApiOptions } from './openapi/generate.ts'
export { openapiHandler } from './openapi/handler.ts'
export type { RouteDescriptor } from './openapi/describe.ts'
export type {
  OpenApiSpec,
  PathItem,
  Operation,
  Parameter,
  RequestBody,
  Response as OpenApiResponse,
  Schema as OpenApiSchema,
  Info as OpenApiInfo,
  Server as OpenApiServer,
  Tag as OpenApiTag,
  Components as OpenApiComponents,
  SecurityScheme as OpenApiSecurityScheme,
  SecurityRequirement as OpenApiSecurityRequirement,
} from './openapi/types.ts'

// ───── Background jobs ─────────────────────────────────────────────────────
export { IngeniumQueue } from './jobs/queue.ts'
export { QueueRegistry } from './jobs/registry.ts'
export { MemoryQueueStore } from './jobs/store-memory.ts'
export type {
  QueueOptions,
  QueueWorker,
  QueueStore,
  RetryPolicy,
  FailedJob,
  JobHandle,
  RegisteredQueue,
} from './jobs/types.ts'

// ───── Cron scheduling ─────────────────────────────────────────────────────
export { IngeniumCronJob } from './cron/scheduler.ts'
export type { CronHandler, CronOptions } from './cron/scheduler.ts'
export { CronRegistry } from './cron/registry.ts'
export { parseCronSpec, nextFireFrom } from './cron/parser.ts'
export type { CronMatch } from './cron/parser.ts'

// ───── Session middleware ──────────────────────────────────────────────────
export { sessionMiddleware } from './session/middleware.ts'
export { MemoryStore as SessionMemoryStore } from './session/store-memory.ts'
export type {
  Session,
  SessionOptions,
  SessionStore,
  SessionCookieOptions,
} from './session/types.ts'

// ───── WebSocket adapter (optional `ws` peer dep) ──────────────────────────
export {
  enableWebSockets,
  createWebSocketRegistrar,
  peerHasWs,
  WsNodeAdapter,
  type EnableWebSocketsOptions,
  type WebSocketHandler,
  type WebSocketHandlerOptions,
  type WsIntegrator,
  type WsRegistrar,
  type WebSocket,
} from './ws/index.ts'

// ───── Plugin system ───────────────────────────────────────────────────────
export type {
  IngeniumPlugin,
  PluginTarget,
  Hooks,
  RegistrationEvent,
  Decorator,
  LazyDecorator,
  EagerDecorator,
  OnRouteHook,
  OnComposeHook,
  OnRequestHook,
  OnResponseHook,
  OnErrorHook,
} from './plugin/types.ts'
export { HooksRegistry } from './plugin/hooks.ts'
export { DecoratorRegistry } from './plugin/decorators.ts'
export { ScopedApp } from './app/scope.ts'

// ───── Default factory + body parsers ──────────────────────────────────────

/**
 * Create a new Ingenium application.
 *
 * @example
 * import { ingenium } from 'ingenium'
 *
 * const app = ingenium()
 * app.get('/', (ctx) => ({ hello: 'world' }))
 * await app.listen(3000)
 */
const ingeniumCore: IngeniumFactory = makeIngeniumFactory()

/**
 * The `ingenium` export is callable AND has static helpers attached:
 *
 * - `ingenium(opts?)` — create an app
 * - `ingenium.Router()` — create a mountable router
 * - `ingenium.json(opts?)` — Express-compat body-parser shim (no-op; parsing is lazy)
 * - `ingenium.urlencoded(opts?)` — same, for `application/x-www-form-urlencoded`
 * - `ingenium.static(root, opts?)` — serve files from a directory
 * - `ingenium.cors(opts?)` — CORS middleware (simple + preflight)
 */
// ───── Sinatra-style top-level ──────────────────────────────────────────────
//
// Lets users skip the app object entirely:
//
//   import { get, listen } from 'ingenium'
//   get('/', () => 'hi')
//   await listen(3000)
//
// Every verb routes to a lazy singleton `IngeniumApp` (see `defaultApp()`).
// `_resetDefaultApp` is test-only and throws under NODE_ENV=production.
export {
  defaultApp,
  _resetDefaultApp,
  get,
  post,
  put,
  patch,
  del as delete,
  head,
  options,
  use,
  onError,
  listen,
  before,
  after,
} from './sinatra/top-level.ts'

export const ingenium = Object.assign(ingeniumCore, {
  json: jsonMiddleware,
  urlencoded: urlencodedMiddleware,
  static: staticMiddleware,
  cors: corsMiddleware,
  csrf: csrfMiddleware,
  sse,
  rateLimit,
  problemDetails: problemDetailsMiddleware,
  idempotency: idempotencyMiddleware,
  openapiHandler,
})

export default ingenium
