# Ingenium Public API Contract (v0.0.1)

This is the locked public API for downstream code (tests, compat shim, examples, benchmarks, docs). If you find a gap in this spec while implementing, **stop and ask**, do not invent an API.

## Imports

```ts
import {
  ingenium,                       // function: creates IngeniumApp
  Router,                         // function: creates a mountable Router
  ScopedApp,                      // returned by app.scope() — facade for scoped registration
  IngeniumContext,                // class
  IngeniumBody,                   // class (on ctx.body)
  IngeniumError,
  IngeniumNotFoundError,
  IngeniumUnauthorizedError,
  IngeniumMethodNotAllowedError,
  IngeniumPayloadTooLargeError,
  IngeniumValidationError,
  IngeniumBadRequestError,
  type IngeniumHandler,
  type IngeniumMiddleware,
  type ExtractParams,
  type HttpMethod,
  type PluginTarget,              // structural type implemented by IngeniumApp + ScopedApp
  type InjectRequest,             // synthetic request for app.inject()
  type InjectResponse,            // captured response from app.inject()
} from 'ingenium'
```

## App

```ts
const app = ingenium({ poolSize?: number })

app.use(mw: IngeniumMiddleware): this
app.use(mountPath: string, mw: IngeniumMiddleware | Router): this

app.get(path, handler)
app.post(path, handler)
app.put(path, handler)
app.patch(path, handler)
app.delete(path, handler)
app.head(path, handler)
app.options(path, handler)
app.route(path)            // chainable: .get(h).put(h).delete(h).all(h)

// Inline OpenAPI options (peeled to describe() at registration):
//   response, requestBody, tags, summary, description,
//   parameters, deprecated, operationId, security
// app.get('/users/:id', { tags: ['users'], summary: '...', response: UserSchema }, handler)
app.route(path)            // chainable: .get(h).put(h).delete(h).all(h)

app.onError((err: unknown, ctx: IngeniumContext) => unknown | Promise<unknown>): this
app.compose(): void                       // explicit pre-warm; auto-runs lazily on first request
app.handle(ctx: IngeniumContext): Promise<void>  // dispatch entry, used by adapters
app.listen(port: number, host?: string): Promise<{ port: number; close: () => Promise<void> }>
app.inject(req: InjectRequest): Promise<InjectResponse>  // in-process test client (no socket)
app.scope(prefix: string, register: (scope: ScopedApp) => void): this  // plugin/middleware scoping (before/after/use/routes confined to prefix)

// Built-in middleware (no install required):
ingenium.json(opts?:    { limit?: number }): IngeniumMiddleware     // sets ctx.body parsing default
ingenium.urlencoded(opts?: { limit?: number }): IngeniumMiddleware
// Note: these are zero-cost no-ops in v0.0.1 — body parsing is lazy via
// `ctx.body.json()` / `ctx.body.urlencoded()`. Provided for Express
// migration ergonomics so existing `app.use(express.json())` lines compile.
```

## Router

```ts
const r = Router()
r.get(path, handler)         // same surface as app
r.use(mw)
r.use(mountPath, mw | Router)

app.use('/api', r)           // mounts at /api — routes inside r get the prefix
```

## IngeniumContext

```ts
class IngeniumContext<Params = Record<string, string>> {
  // Request
  method: HttpMethod
  url: string                 // path + ?query
  path: string                // no query
  rawQuery: string            // raw query string
  query: URLSearchParams      // lazy parsed
  params: Params
  headers: IncomingHttpHeaders
  body: IngeniumBody
  state: Record<string, unknown>  // free-form per-request scratch

  // Response setters (chainable: status, set/setHeader)
  status(code: number): this
  set(name: string, value: string | string[]): this
  setHeader(name: string, value: string | string[]): this
  getHeader(name: string): string | string[] | undefined

  // Response writers (terminal — sets _written)
  json(body: unknown, status?: number): void
  text(body: string, status?: number): void
  html(body: string, status?: number): void
  send(body: Buffer | string, status?: number): void
  redirect(location: string, status?: number): void   // default 302
  stream(readable: Readable, contentType?: string): void
}
```

## IngeniumBody

```ts
class IngeniumBody {
  json<T>(schema?: StandardSchemaV1<unknown, T> | { safeParse } | { parse }, maxBytes?: number): Promise<T>
  text(maxBytes?: number): Promise<string>
  urlencoded(maxBytes?: number): Promise<Record<string, string>>
  buffer(maxBytes?: number): Promise<Buffer>           // default limit 100 KB
  stream(): Readable                                    // raw node:stream Readable; opts out of cache
  multipart(opts?: MultipartOptions): Promise<MultipartResult>  // terminal; opts out of cache
}
// Schema detection order: Standard Schema v1 ['~standard'] → Zod-like safeParse → { parse(input): T }.
// Validation failure throws IngeniumValidationError with field-level `fields`.
// Buffer-level cache: json/text/urlencoded/buffer can be called repeatedly without "already consumed";
// the raw bytes are cached on first read and re-decoded on subsequent calls.
```

## Middleware

```ts
type IngeniumMiddleware = (ctx: IngeniumContext, next: () => Promise<void>) => unknown | Promise<unknown>
type IngeniumHandler<P = Record<string, string>> = (ctx: IngeniumContext<P>) => unknown | Promise<unknown>
```

Handler return values are reflected to the wire:
- `undefined` + `_written === false` → 204 No Content
- `string` starting with `<` → 200 text/html
- other `string` → 200 text/plain
- `Buffer` / `Uint8Array` → 200 application/octet-stream
- `Readable` → 200 streamed
- any object → 200 application/json
- If `ctx.json/text/html/stream/redirect/send` was called, return value is ignored.

## Errors

All extend `IngeniumError`. Default boundary serializes:
```json
{ "error": "<message>", "code": "<CODE>", "fields"?: { ... } }
```

`onError(handler)` overrides; re-throw to delegate to the default.

## Composition lifecycle

- Registration order is journaled, NOT eagerly composed.
- First request (or explicit `app.compose()`) triggers composition of every leaf.
- Any registration after composition sets a dirty flag → next request recomposes.
- This is NOT frozen-after-listen; tests that register routes after `listen()` work.

## Path syntax

- `/users/:id` — required param
- `/users/:id?` — optional param
- `/files/*path` — wildcard tail
- Static segments win over `:param` over `*wild` (deterministic precedence).

## Files an agent MAY NOT touch

These are owned by the main thread:
- `packages/ingenium/src/**`  (core sources)
- `packages/ingenium/package.json`, `tsconfig.json`, `tsup.config.ts`
- root `package.json`, `tsconfig.base.json`, `tsconfig.json`, `vitest.config.ts`
- `API.md` (this file)

Agents MAY create any new files under their assigned directories.
