# Ingenium

> Express ergonomics, Hono/Fastify-class throughput. A typed HTTP framework for Node 20+ and Bun 1.1+.

```
  ___                       _                 
 |_ _|_ __   __ _  ___ _ __ (_)_   _ _ __ ___  
  | || '_ \ / _` |/ _ \ '_ \| | | | | '_ ` _ \ 
  | || | | | (_| |  __/ | | | | |_| | | | | | |
 |___|_| |_|\__, |\___|_| |_|_|\__,_|_| |_| |_|
             |___/                               
```

Ingenium is what happens if you fix Express's three structural problems — linear routing, untyped `req`/`res`, and per-request allocation — without forcing developers to learn a new mental model. It's the same shape (`app.get`, `app.use`, mountable routers, drop-in middleware), with a typed `ctx` instead of `(req, res, next)`, and a router/dispatcher built for current-decade Node throughput.

**Status: alpha (v0.0.1).** API is mostly settled but still subject to change before 0.1.0. Use it for side projects and internal tools; revisit for production once 1.0 lands.

---

## Table of contents

- [Show me the code](#show-me-the-code)
- [Why Ingenium](#why-ingenium)
- [Install](#install)
- [The 5-minute Express → Ingenium diff](#the-5-minute-express--ingenium-diff)
- [Core concepts](#core-concepts)
  - [App + Router](#app--router)
  - [IngeniumContext](#ingeniumcontext)
  - [Middleware](#middleware)
  - [Body parsing](#body-parsing)
  - [Response reflection](#response-reflection)
  - [Errors](#errors)
  - [Plugins](#plugins)
  - [Trust-proxy](#trust-proxy)
- [Built-in middleware](#built-in-middleware)
  - [`ingenium.json` / `ingenium.urlencoded`](#ingeniumjson--ingeniumurlencoded)
  - [`ingenium.static`](#ingeniumstatic)
  - [`ingenium.cors`](#ingeniumcors)
  - [`ingenium.sse` (Server-Sent Events)](#ingeniumsse-server-sent-events)
  - [`ingenium.rateLimit`](#ingeniumratelimit)
  - [`ingenium.csrf`](#ingeniumcsrf)
  - [`sessionMiddleware`](#sessionmiddleware)
- [Transports](#transports)
  - [Node `http` (default)](#node-http-default)
  - [Bun.serve](#bunserve)
  - [HTTP/2 (h2 + h2c)](#http2-h2--h2c)
  - [WebSocket](#websocket)
  - [Graceful shutdown](#graceful-shutdown)
- [Express compatibility shim](#express-compatibility-shim)
- [CLI scaffolder](#cli-scaffolder)
- [Schema validation](#schema-validation)
- [Reference application](#reference-application)
- [Packages](#packages)
- [Examples](#examples)
- [Architecture and design notes](#architecture-and-design-notes)
- [Repo layout](#repo-layout)
- [Development](#development)
- [Roadmap and known gaps](#roadmap-and-known-gaps)
- [Contributing](#contributing)
- [License](#license)

---

## Show me the code

```ts
import { ingenium } from 'ingenium'

const app = ingenium()

app.use(async (ctx, next) => {
  const start = Date.now()
  await next()
  console.log(`${ctx.method} ${ctx.path} -> ${ctx._statusCode} ${Date.now() - start}ms`)
})

app.get('/', () => 'hello')
app.get('/users/:id', (ctx) => ({ id: ctx.params.id }))
app.post('/echo', async (ctx) => ctx.body.json())

const server = await app.listen(3000)
console.log(`listening on http://localhost:${server.port}`)
```

That's a full server. No `res.send`. No `body-parser`. No `app.set('case sensitive routing', true)`. Return a value and Ingenium reflects it to the wire — object → JSON, string → text/html, `Buffer` → octet-stream, `Readable` → stream, `undefined` → 204. Call `ctx.json(...)` when you want explicit control over status or headers.

---

## Why Ingenium

| Pain point | Express | Hono / Fastify | Ingenium |
|---|---|---|---|
| Router speed at 1000 routes | O(n) linear scan | O(k) trie | O(k) radix trie + wildcard backtrack |
| `req` / `res` types | `any` in practice | strict, but unfamiliar surface | strict, Express-shaped |
| Per-request allocation | new `req`/`res`/`next` each request | varies | pooled `IngeniumContext`, lazy getters |
| Middleware composition | re-walked per request | compose-on-register | lazy compose with dirty-bit recompose |
| Body parsing | `body-parser` middleware always runs | always-on parsing | lazy via `ctx.body.json()` |
| Default body size limit | 100 KB (`body-parser`) | varies | 100 KB (matches Express) |
| Bun support | community shim | varies | first-class adapter |
| Migration cost from Express | n/a | high | low |

The pitch in one sentence: **the shortest path from a working Express app to throughput competitive with Hono and Fastify.**

---

## Production hardening

Native primitives an API team actually needs in prod, all opt-in:

| Concern | Surface | Why it matters |
|---|---|---|
| Per-request timeout ceiling | `ingenium({ requestTimeoutMs: 30_000 })` → `IngeniumTimeoutError` (503) | A handler that never resolves leaks the context, socket, and pool slot forever. |
| Hard request-body cap | `ingenium({ maxRequestBytes: 2_000_000 })` enforced at the **transport** layer | Default-100KB per-call check doesn't help if the handler reads via `ctx.body.stream()`. Cap is enforced before any consumer touches a byte. |
| Header injection guard | `ctx.set(name, value)` rejects `\r\n` immediately → `IngeniumHeaderInjectionError` | Catches CRLF injection at the call site instead of deep inside Node's wire path. |
| `ctx.json()` safety on circular refs / BigInt | Throws `IngeniumUnserializableError` (500) with the structural reason | No more useless `TypeError: Converting circular...` bubbling up as a generic 500. `safeJsonStringify(value)` exported for lenient mode. |
| Idempotency-Key — skip caching 5xx | `ingenium.idempotency({ cacheable: (s) => s < 500 })` (default) | A transient 500 no longer gets replayed for the entire TTL. |
| Compat shim — real-stream Express drop-in | `expressCompat(mw)` runs `(req, res, next)` middleware on real Node streams (`req` is a `Readable`, `res` a `Writable`) | `body-parser`, `multer`, `compression`, `express-session`, `morgan` all work end-to-end; cost is opt-in per wrapped middleware. |
| Asymmetric JWT (RS/PS/ES + JWKS) | `ingenium.jwt({ algorithms: ['RS256'], jwksUrl: '...' })` | Required for any IdP with a JWKS endpoint (Auth0, Okta, Cognito, Clerk, Supabase). Algorithm-confusion attacks blocked at the allowlist. `'none'` rejected unconditionally. |
| Late-write protection | `_epoch` counter on `IngeniumContext` — orphaned-handler writes after a timeout are detected and discarded | Stops cross-request response corruption when the pool recycles the context. |

Wire all of these in production:

```ts
import {
  ingenium, sessionMiddleware, gracefulShutdown,
  IdempotencyMemoryStore,
} from 'ingenium'

const app = ingenium({
  trustProxy: 'loopback',                  // behind nginx / Caddy / etc.
  requestTimeoutMs: 30_000,                // hung-handler protection
  maxRequestBytes: 2 * 1024 * 1024,        // 2 MiB body ceiling
  poolSize: 4096,
})

app.use(ingenium.cors({ origin: 'https://app.example.com', credentials: true }))
app.use(ingenium.csrf({ secret: process.env.CSRF_SECRET! }))
app.use(sessionMiddleware({ secret: [process.env.SESSION_SECRET!] }))
app.use(ingenium.rateLimit({ windowMs: 60_000, limit: 100 }))
app.use(ingenium.idempotency({ store: new IdempotencyMemoryStore() }))   // swap for RedisIdempotencyStore (ingenium-redis) for multi-instance
app.use(ingenium.problemDetails({ typeBaseUrl: 'https://api.example.com/errors/' }))
app.use(ingenium.jwt({
  algorithms: ['RS256'],
  jwksUrl: 'https://example.auth0.com/.well-known/jwks.json',
  issuer: 'https://example.auth0.com/',
  audience: 'https://api.example.com',
}))

const server = await app.listen(cfg.PORT, '0.0.0.0')
gracefulShutdown(server, { gracefulTimeoutMs: 10_000, onShutdown: () => db.close() })
```

> **Multi-instance deploys:** swap the in-memory stores for the Redis-backed ones in [`ingenium-redis`](packages/ingenium-redis). One `createClient()` instance, four drop-in stores (sessions, idempotency, rate-limit, job queue), no API changes elsewhere. See the package [README](packages/ingenium-redis/README.md) for the wire-in.

---

## Install

```sh
npm install ingenium
```

Optional packages by use case:

```sh
# Bun.serve adapter
npm install ingenium ingenium-bun

# Express middleware compatibility (cors, helmet, etc.)
npm install ingenium ingenium-compat

# Redis stores for multi-instance prod (sessions, idempotency, rate-limit)
npm install ingenium ingenium-redis redis

# Project scaffolder
npm install -g ingenium-cli
ingenium new my-api
```

**Requirements:** Node.js 20+. Node 24 LTS is recommended (see `.nvmrc`). Bun 1.1+ for the Bun adapter. WebSocket support requires installing `ws` as a peer dep.

---

## The 5-minute Express → Ingenium diff

```ts
// Express                                      // Ingenium
import express from 'express'                   import { ingenium } from 'ingenium'
const app = express()                           const app = ingenium()

app.use(express.json())                         app.use(ingenium.json())  // (no-op, parsing is lazy)

app.use((req, res, next) => {                   app.use(async (ctx, next) => {
  req.startedAt = Date.now()                      ctx.state.startedAt = Date.now()
  next()                                          await next()
})                                              })

app.get('/users/:id', (req, res) => {           app.get('/users/:id', (ctx) =>
  res.json({ id: req.params.id })                 ({ id: ctx.params.id }))
})

app.post('/users', (req, res) => {              app.post('/users', async (ctx) => {
  const body = req.body                           const body = await ctx.body.json()
  // ...                                          // ...
  res.status(201).json(user)                      return ctx.json(user, 201)
})                                              })

const router = express.Router()                 const router = ingenium.Router()
router.get('/health', (req, res) =>             router.get('/health', () => ({ ok: 1 }))
  res.json({ok:1}))
app.use('/api', router)                         app.use('/api', router)

app.use((err, req, res, next) => {              app.onError((err, ctx) => {
  res.status(500).json({err: err.message})        ctx.json({ err: err.message }, 500)
})                                              })

app.listen(3000)                                await app.listen(3000)
```

Breakable changes:
1. **Handlers may return values.** `return obj` is `res.json(obj)`; `return 'text'` is `res.text(...)`. Calling `ctx.json(...)` explicitly still works.
2. **Body parsing is lazy.** `app.use(ingenium.json())` is a no-op stub for ergonomics; the actual parse happens in `ctx.body.json()` inside your handler.
3. **`ctx.state` is the per-request scratch space**, not `ctx.user = ...` directly (though plugins can decorate `ctx` to enable that).

That's the whole list. Everything else from the Express mental model carries over verbatim.

---

## Core concepts

### App + Router

```ts
import { ingenium, Router } from 'ingenium'

const app = ingenium({ poolSize: 1024, trustProxy: false })

// HTTP methods — same surface as Express
app.get('/', handler)
app.post('/users', handler)
app.put('/users/:id', handler)
app.patch('/users/:id', handler)
app.delete('/users/:id', handler)
app.head('/users/:id', handler)
app.options('/users/:id', handler)
app.method('OPTIONS', '/anywhere', handler)  // any method by string

// Mountable routers
const api = Router()
api.get('/health', () => ({ ok: true }))
api.use('/notes', notesRouter)               // routers can mount routers
app.use('/api', api)

// Middleware
app.use(globalMiddleware)
app.use('/admin', adminOnlyMiddleware)
app.use('/admin', adminRouter)               // mount middleware OR router

// Lifecycle
await app.compose()                          // pre-warm; runs lazily on first request otherwise
const server = await app.listen(3000, '0.0.0.0')
await server.close({ gracefulTimeoutMs: 10_000 })
```

**Path syntax.** `:param` (required), `:param?` (optional), `*wildcard` (greedy tail). Static segments win over params, params win over wildcards, but the matcher backtracks one level to a wildcard if the param branch dead-ends.

**Composition timing.** Registration is journaled, not eagerly composed. The trie + composed handlers are built on first request (or via `app.compose()`). Adding routes after `listen()` sets a dirty bit and triggers recompose on the next request — tests that register routes per-test work without ceremony.

### IngeniumContext

```ts
class IngeniumContext<Params = Record<string, string>> {
  // Request
  method: HttpMethod              // 'GET' | 'POST' | ...
  url: string                     // path + ?query
  path: string                    // no query
  rawQuery: string
  query: URLSearchParams          // lazy
  params: Params                  // route params
  headers: IncomingHttpHeaders    // lowercased per Node convention
  body: IngeniumBody                   // lazy parsers
  state: Record<string, unknown>  // per-request scratch

  // Network info (trust-proxy aware)
  ip: string                      // client IP (XFF-aware if trustProxy enabled)
  ips: readonly string[]          // full forwarded chain
  protocol: 'http' | 'https'
  secure: boolean
  hostname: string
  remoteAddress: string           // immediate socket peer
  baseProtocol: 'http' | 'https'  // underlying transport

  // Response setters (chainable)
  status(code: number): this
  set(name: string, value: string | string[]): this
  setHeader(name: string, value: string | string[]): this
  getHeader(name: string): string | string[] | undefined

  // Response writers
  json(body: unknown, status?: number): void
  text(body: string, status?: number): void
  html(body: string, status?: number): void
  send(body: Buffer | string, status?: number): void
  redirect(location: string, status?: number): void  // default 302
  stream(readable: Readable, contentType?: string): void
}
```

The class is pool-bound: one instance per pool slot, reused across requests. `reset()` zeros every field by reassignment to keep the V8 hidden class stable.

### Middleware

```ts
type IngeniumMiddleware = (ctx: IngeniumContext, next: () => Promise<void>) => unknown | Promise<unknown>
```

Same dispatch model as Koa: `await next()` in the middle, do work before/after. Errors thrown anywhere in the chain bubble up to `app.onError`.

### Body parsing

```ts
ctx.body.json<T>(schema?, maxBytes?: number): Promise<T>
ctx.body.text(maxBytes?: number): Promise<string>
ctx.body.urlencoded(maxBytes?: number): Promise<Record<string, string>>
ctx.body.buffer(maxBytes?: number): Promise<Buffer>
ctx.body.stream(): Readable
ctx.body.multipart(opts?: MultipartOptions): Promise<MultipartResult>
```

Default `maxBytes` is **100,000** (matches Express's `body-parser` default). Override per-call. The schema arg accepts:
1. Standard Schema v1 (any validator that exposes `["~standard"]`)
2. Zod-like `safeParse(input)`
3. Plain `parse(input): T`

Validation failures throw `IngeniumValidationError` with a `fields` map. Body-too-large throws `IngeniumPayloadTooLargeError` mid-stream (no post-buffer rejection).

### Response reflection

| Return value           | Wire output                  |
|------------------------|------------------------------|
| `undefined` / `null`   | 204 No Content               |
| `string` starting `<`  | 200 text/html                |
| other `string`         | 200 text/plain               |
| `Buffer` / `Uint8Array`| 200 application/octet-stream |
| `Readable`             | 200 streamed                 |
| any object/array       | 200 application/json         |

If a `ctx.json/text/html/send/redirect/stream` helper has been called, the return value is ignored.

### Errors

```ts
import {
  IngeniumError,
  IngeniumNotFoundError,        // 404
  IngeniumUnauthorizedError,    // 401
  IngeniumMethodNotAllowedError,// 405 (auto-thrown on path match + method miss)
  IngeniumPayloadTooLargeError, // 413
  IngeniumValidationError,      // 422 with .fields
  IngeniumBadRequestError,      // 400
} from 'ingenium'

app.onError((err, ctx) => {
  if (err instanceof IngeniumValidationError) {
    return ctx.json({ error: err.message, fields: err.fields }, 422)
  }
  if (err instanceof IngeniumError) throw err  // delegate to default boundary
  ctx.json({ error: 'internal' }, 500)
})
```

The default boundary serializes any `IngeniumError` as `{ error, code, fields? }` with the right status. Unknown errors become 500s. `IngeniumMethodNotAllowedError` writes the `Allow` response header automatically.

### Plugins

```ts
import { ingenium, type IngeniumPlugin } from 'ingenium'

interface User { id: string; email: string }

const auth: IngeniumPlugin<{ secret: string }> = (app, opts) => {
  app.decorate('user', async (ctx) => {
    const token = ctx.headers.authorization?.split(' ')[1]
    if (!token) throw new IngeniumUnauthorizedError()
    return verifyToken(token, opts.secret) as User
  })
  app.hooks.onRequest((ctx) => {
    ctx.state.requestId = crypto.randomUUID()
  })
}

const app = ingenium()
await app.register(auth, { secret: process.env.JWT_SECRET! })

declare module 'ingenium' {
  interface IngeniumContext {
    user: User
  }
}

app.get('/me', (ctx) => ctx.user)  // typed, lazily resolved on first access
```

Lifecycle hooks: `onRoute`, `onCompose`, `onRequest`, `onResponse`, `onError`. Decorators come in two flavors: lazy (`decorate` — `defineProperty` self-replacing getter, computed on first access) and eager (`decorateRequest` — assigned at request start). Hot-path checks `hooks.hasAny()` and `decorators.hasAny()` so plugin-free apps pay zero overhead.

### Trust-proxy

```ts
const app = ingenium({ trustProxy: 'loopback' })

// Then in handlers:
ctx.ip          // real client IP after walking the X-Forwarded-For chain
ctx.protocol    // 'https' if X-Forwarded-Proto: https
ctx.hostname    // X-Forwarded-Host (if set), else Host header
```

Mirrors Express's `app.set('trust proxy', ...)`:

| Value | Behavior |
|---|---|
| `false` (default) | Never trust XFF — `ctx.ip` is the socket peer |
| `true` | Trust the entire chain — leftmost XFF entry wins |
| `number n` | Trust `n` upstream hops |
| `'loopback'` | Trust 127.0.0.0/8, ::1 |
| `'linklocal'` | Trust 169.254.0.0/16, fe80::/10 |
| `'uniquelocal'` | Trust 10/8, 172.16/12, 192.168/16, fc00::/7 |
| `'10.0.0.0/8'` (CIDR) | Trust matching addresses |
| `string[]` | Multiple of any of the above |
| `(ip, hopIdx) => boolean` | Custom predicate |

---

## Built-in middleware

### `ingenium.json` / `ingenium.urlencoded`

Stub middleware for Express compatibility. Body parsing is lazy via `ctx.body.json()` / `ctx.body.urlencoded()`, so these are no-ops. They exist so existing Express migration code (`app.use(express.json())`) compiles and reads naturally.

### `ingenium.static`

```ts
app.use(ingenium.static('./public', {
  index: 'index.html',     // default; set false to disable
  maxAge: 60_000,          // ms — sets Cache-Control: public, max-age=60
  extensions: ['html'],    // try /foo + /foo.html when /foo not found
  dotfiles: 'ignore',      // 'allow' | 'deny' | 'ignore' (default: ignore → next())
}))
```

Ships with weak ETags (`W/"size-mtime"`), conditional GET (`If-None-Match` → 304), range requests (`Range: bytes=N-M` → 206), MIME from extension (extensible map), and path-traversal protection (`../etc/passwd` → 403).

### `ingenium.cors`

```ts
app.use(ingenium.cors({
  origin: 'https://app.example.com',  // or true | string[] | RegExp | (origin, ctx) => boolean | string | Promise<>
  methods: ['GET', 'POST', 'PUT'],    // default: GET HEAD PUT PATCH POST DELETE
  allowedHeaders: ['x-trace-id'],     // default: mirror Access-Control-Request-Headers
  exposedHeaders: ['x-trace-id'],
  credentials: true,                   // throws at construction with origin: '*'
  maxAge: 3600,                        // preflight cache seconds
  optionsSuccessStatus: 204,
}))
```

Handles simple requests, preflights (responds 204 with negotiated methods/headers, does NOT call `next()`), and `Vary: Origin` whenever the origin is reflected from the request.

### `ingenium.sse` (Server-Sent Events)

```ts
import { ingenium, sse, startKeepAlive } from 'ingenium'

app.get('/events', (ctx) => {
  const stream = sse(ctx)
  startKeepAlive(stream, 15_000)

  let n = 0
  const timer = setInterval(() => {
    stream.send({ event: 'tick', id: String(n), data: { n: n++ } })
    if (n >= 10) {
      clearInterval(timer)
      stream.close()
    }
  }, 1000)
})
```

`SseStream` API: `send(event | string)`, `comment(text)`, `close()`, `closed: boolean`. Multi-line `data` is split per spec. Object data is JSON-stringified.

### `ingenium.rateLimit`

```ts
app.use(ingenium.rateLimit({
  windowMs: 60_000,
  limit: 100,
  // default keygen reads X-Forwarded-For — make sure trustProxy is set!
  keyGenerator: (ctx) => ctx.ip,
  skip: (ctx) => ctx.path.startsWith('/health'),
}))
```

Fixed-window in-memory store (`MemoryStore`) by default, with cleanup interval `unref()`'d so it never holds the event loop alive. Pluggable via the `RateLimitStore` interface (Promise-returning so a Redis-backed store fits cleanly). Sets `X-RateLimit-{Limit,Remaining,Reset}` on every response and `Retry-After` on 429s.

### `ingenium.csrf`

```ts
import { ingenium } from 'ingenium'

const app = ingenium()
app.use(ingenium.csrf({
  secret: process.env.CSRF_SECRET!,    // required for cookie storage
  storage: 'cookie',                    // 'cookie' (default) | 'session'
  cookie: { sameSite: 'lax', secure: true },
  ignoreMethods: ['GET', 'HEAD', 'OPTIONS', 'TRACE'],
  // skip: (ctx) => ctx.path.startsWith('/api/webhooks/'),  // opt-out
}))

app.get('/form', (ctx) => {
  // ctx.csrfToken() returns the current token to embed in HTML / send to a JS client.
  return `<form method="POST" action="/submit">
    <input type="hidden" name="_csrf" value="${ctx.csrfToken()}">
    <button>Submit</button>
  </form>`
})

app.post('/submit', async (ctx) => {
  // CSRF middleware already validated; if we got here the token is good.
  const body = await ctx.body.json()
  return { ok: true, body }
})
```

Two storage modes:
- **`cookie`** (default, no session needed) — double-submit cookie pattern with HMAC-signed tokens. The token is written to a non-`HttpOnly` cookie on safe requests; the client must echo it back via `X-CSRF-Token` (or `X-XSRF-Token` for Angular, or `?_csrf=` query param) on unsafe requests. Same-origin policy + HMAC verification together prevent forgery.
- **`session`** — synchronizer pattern. Token stored on `ctx.session.csrfToken`; submitted token compared against it. Requires `sessionMiddleware` to run first; throws a clear developer error if missing.

Verification uses `crypto.timingSafeEqual`. Secret rotation supported (`secret: ['new', 'old']`). Failures throw `IngeniumCsrfError` (HTTP 403, code `CSRF_FAILED`) which the default error boundary serializes; catch in `app.onError` for custom handling.

> **Sessioned apps should opt in to `storage: 'session'`.** The default is `'cookie'` because it's self-contained, but if you're already running `sessionMiddleware` the synchronizer pattern is simpler (one cookie instead of two, and rotating the session secret rotates CSRF protection automatically). We don't auto-detect because middleware order shouldn't change semantics. See [docs/api/csrf.md](docs/api/csrf.md#recommendation).

### `sessionMiddleware`

```ts
import { sessionMiddleware, type Session } from 'ingenium'

app.use(sessionMiddleware({
  secret: [process.env.SESSION_SECRET!, ...rotatedSecrets],
  cookieName: 'ingenium.sid',
  maxAgeSeconds: 7 * 86_400,
  rolling: false,
  cookie: { secure: true, sameSite: 'lax', httpOnly: true },
}))

declare module 'ingenium' {
  interface IngeniumContext { session: Session }
}

app.post('/login', async (ctx) => {
  const { user } = await ctx.body.json()
  await ctx.session.regenerate()       // new id, fresh against fixation
  ctx.session.set('userId', user.id)
  return { ok: true }
})

app.post('/logout', async (ctx) => {
  await ctx.session.destroy()
  return { ok: true }
})
```

HMAC-SHA256-signed cookies, 18-byte (144-bit) ids, `crypto.timingSafeEqual` verification, secret rotation (index 0 signs, all entries verify), `regenerate()` for post-login fixation defense, pluggable `SessionStore` interface (default `SessionMemoryStore`).

---

## Transports

### Node `http` (default)

```ts
const app = ingenium()
const server = await app.listen(3000)
```

Uses `node:http` directly. No translation layer to WinterCG `Request`/`Response` — adapter writes straight from `IncomingMessage` to the `IngeniumContext`, and the `IngeniumContext` straight to the `ServerResponse`.

### Bun.serve

```ts
import { ingenium } from 'ingenium'
import { BunAdapter } from 'ingenium-bun'

const app = ingenium({ transport: new BunAdapter() })
await app.listen(3000)
```

Wraps `Bun.serve()` with a Web-Streams ↔ `node:stream` bridge so existing `IngeniumBody` parsers work unchanged. Lazy body — request body is not materialized unless `ctx.body.*` is called.

### HTTP/2 (h2 + h2c)

```ts
import { ingenium, Http2Adapter, Http2cAdapter } from 'ingenium'
import { readFileSync } from 'node:fs'

// h2c (cleartext HTTP/2)
const app = ingenium({ transport: new Http2cAdapter() })
await app.listen(3000)

// h2 (TLS)
const tlsApp = ingenium({
  transport: new Http2Adapter({
    cert: readFileSync('cert.pem'),
    key: readFileSync('key.pem'),
    allowHttp1: true,           // ALPN fallback to HTTP/1.1
  }),
})
await tlsApp.listen(443)
```

Built on `node:http2`. Pseudo-headers (`:method`, `:path`, `:status`, `:scheme`, `:authority`) handled internally; user code reads regular headers. `Transfer-Encoding: chunked` is stripped from responses (HTTP/2 has implicit framing).

### WebSocket

WebSocket support is opt-in via the `ws` peer dependency.

```sh
npm install ws @types/ws
```

```ts
import { ingenium, enableWebSockets } from 'ingenium'

const app = ingenium()
enableWebSockets(app)

app.ws('/echo', (sock) => {
  sock.on('message', (msg) => sock.send(msg))
})

// Or hand the underlying http.Server to your own integrator:
app.upgradeWith((httpServer) => {
  // wire up `ws`, socket.io, etc.
})

await app.listen(3000)
```

Uses `WebSocketServer({ noServer: true })` and hooks the `upgrade` event on the underlying `http.Server`. Per-path handlers are registered up front; unknown paths get the socket destroyed cleanly.

### Graceful shutdown

```ts
import { ingenium, gracefulShutdown } from 'ingenium'

const app = ingenium()
const server = await app.listen(3000)

gracefulShutdown(server, {
  gracefulTimeoutMs: 10_000,                  // force-close idle keep-alives after 10s
  signals: ['SIGTERM', 'SIGINT'],
  onShutdown: async () => {
    await db.close()
    await queue.flush()
  },
})
```

A second signal during shutdown → immediate `exit(1)` (force quit). Without graceful shutdown wired, your server dies immediately on SIGTERM and in-flight requests are dropped. Every production deployment needs this.

---

## Express compatibility shim

```sh
npm install ingenium ingenium-compat cors helmet
```

```ts
import { ingenium } from 'ingenium'
import { expressCompat } from 'ingenium-compat'
import cors from 'cors'
import helmet from 'helmet'

const app = ingenium()
app.use(expressCompat(cors({ origin: 'https://app.example.com' })))
app.use(expressCompat(helmet()))
```

The shim wraps `(req, res, next)` middleware so it can run inside an Ingenium middleware chain. The shims are **real Node streams** — `req` extends `stream.Readable`, `res` extends `stream.Writable` (a real `EventEmitter`) — wired to the `IngeniumContext`, so body-reading and response-transforming middleware are genuine drop-ins. Header/status proxy live to the context and the request body is lazy, so header-only middleware pay near-zero overhead.

**Compatibility status** (validated end-to-end in `packages/ingenium-compat/test/e2e.test.ts`):

| Middleware | Status | Notes |
|---|---|---|
| `cors` | supported | full feature parity |
| `helmet` | supported | full feature parity |
| `cookie-parser` | supported | `req.cookies` populated, mirrored to `ctx.state.cookies` |
| `morgan` | supported | end-of-request tokens (`:status`, `:response-time`) fire on `res` `finish` |
| `express-rate-limit` | supported | `req.ip` populated — no custom `keyGenerator` needed |
| `compression` | supported | downstream response replayed through the patched `res`; body gzipped, `Content-Encoding` set |
| `body-parser` | supported | reads the real request stream; `req.body` → `ctx.state.body` |
| `passport.initialize` | supported | `req._passport` propagates to `ctx.state` |
| `passport.authenticate` | partial | `res.redirect`/cookie writes work; session-backed strategies need a session store |
| `express-session` | supported | `Set-Cookie` via `on-headers` + save on `res.end` |
| `multer` | supported | `req.pipe(busboy)` works; `req.file` → `ctx.state` |

Full matrix and internals in [`packages/ingenium-compat/COMPATIBILITY.md`](packages/ingenium-compat/COMPATIBILITY.md).

---

## CLI scaffolder

```sh
npm install -g ingenium-cli

ingenium new my-api                      # default template
ingenium new my-bun-api --bun            # uses BunAdapter
ingenium new tiny --minimal              # 10-line hello world
ingenium new my-api --force              # overwrite existing dir
ingenium --version
ingenium --help
```

Templates ship with: `package.json`, `tsconfig.json`, `.gitignore`, `src/index.ts`, `README.md`. Zero runtime dependencies (only Node built-ins). Requires Node 22+ (uses `--experimental-strip-types`).

---

## Schema validation

`ctx.body.json(schema)` accepts three validator shapes, detected in this order:

```ts
// 1. Standard Schema v1 (any validator with ["~standard"])
import { type } from 'arktype'
const User = type({ name: 'string', email: 'string' })
app.post('/users', async (ctx) => ctx.body.json(User))

// 2. Zod-like safeParse
import { z } from 'zod'
const User = z.object({ name: z.string(), email: z.string().email() })
app.post('/users', async (ctx) => ctx.body.json(User))

// 3. Plain { parse(input): T }
const User = {
  parse(input: unknown): { name: string } {
    if (typeof input !== 'object') throw new Error('expected object')
    return input as { name: string }
  },
}
app.post('/users', async (ctx) => ctx.body.json(User))
```

All three throw `IngeniumValidationError` with a `fields: Record<string, string>` map on failure. Standard Schema v1 issues with structured paths are dot-joined (`['user', 'email']` → `'user.email'`).

---

## Testing with `app.inject()`

Drop the ephemeral-port dance for unit tests — dispatch a synthetic request straight through the framework:

```ts
const app = ingenium()
app.post('/users', async (ctx) => ctx.json(await ctx.body.json(), 201))

const res = await app.inject({
  method: 'POST',
  url: '/users',
  body: { name: 'Ada' },
})

expect(res.status).toBe(201)
expect(res.json()).toEqual({ name: 'Ada' })
```

Body conversion: `string` → UTF-8 buffer, `Buffer` / `Uint8Array` → verbatim, plain object/array → `JSON.stringify` + auto `content-type: application/json`. Streams are drained into a UTF-8 string for `res.body`. Same composed middleware + hooks + error boundary as the wire path; ~10× faster than ephemeral-port tests.

---

## Plugin scoping with `app.scope()`

Mount plugins (and their middleware) onto a subtree:

```ts
app.scope('/api/v2', (scope) => {
  scope.use(requireAuth)           // only /api/v2/*
  scope.register(metricsPlugin)    // plugin's use() / get() / etc. are prefix-relative
  scope.get('/users', listUsers)   // → /api/v2/users
})
```

Compose-time resolution — the per-request hot path is unchanged. The same `IngeniumPlugin` shape works on both the root app and a scope (both implement `PluginTarget`). Decorators called from inside a scope still register globally and emit a dev-mode warning explaining why (the lazy decorator runs before the route is matched). For per-route auth, prefer `scope.use(authMw)` over `scope.decorate(...)`.

---

## Reference application

[`apps/notes-api/`](apps/notes-api) is a small but realistic notes service that exercises the full feature surface:

- Bearer-token auth via a plugin (`app.register(authPlugin)`)
- `app.decorate('user', ...)` lazy decorator + `requireAuth` middleware
- Pino logger plugin with `onRequest` / `onResponse` hooks
- SQLite persistence (better-sqlite3) with FTS5 full-text search
- Mounted routers (`/api/users`, `/api/notes`, `/api/health`)
- Zod-validated request bodies via `ctx.body.json(Schema)`
- Custom error boundary with status-aware responses
- Real HTTP integration tests on ephemeral ports

Run it:

```sh
cd apps/notes-api
npm install
npm run dev
```

---

## Packages

| Package | Description |
|---|---|
| [`ingenium`](packages/ingenium) | Core framework — `ingenium()`, `Router`, `IngeniumContext`, plugins, static, CORS, SSE, rate-limit, sessions, multipart, transports |
| [`ingenium-compat`](packages/ingenium-compat) | `expressCompat(mw)` shim for `(req, res, next)` middleware |
| [`ingenium-bun`](packages/ingenium-bun) | `BunAdapter` — drop-in transport for `Bun.serve()` |
| [`ingenium-cli`](packages/ingenium-cli) | `ingenium new <name> [--bun\|--minimal]` scaffolder |
| [`ingenium-redis`](packages/ingenium-redis) | `RedisSessionStore`, `RedisIdempotencyStore`, `RedisRateLimitStore`, `RedisQueueStore` — required for multi-instance deployments |

Each package is independently publishable to npm.

---

## Examples

| Example | Demonstrates |
|---|---|
| [`examples/learn`](examples/learn) | **Start here.** 8-step progressive tutorial — one concept per file, ~30 minutes end-to-end |
| [`examples/basic`](examples/basic) | Hello world, params, body, error handler, graceful shutdown, static files, decorator |
| [`examples/migrate-from-express`](examples/migrate-from-express) | Express version + Ingenium version side by side, identical routes |
| [`examples/with-plugin`](examples/with-plugin) | Custom auth plugin, decorator, hooks, module augmentation |
| [`examples/with-bun`](examples/with-bun) | `BunAdapter` for `Bun.serve()` |

---

## Architecture and design notes

Five [Architecture Decision Records](docs/adr/) document the load-bearing choices:

1. [ADR 0001 — Radix trie router](docs/adr/0001-radix-trie-router.md): why we chose a radix trie over Express's linear scan or Hono's smart router
2. [ADR 0002 — Lazy composition with a dirty bit](docs/adr/0002-lazy-composition-with-dirty-bit.md): how registration is journaled and composed lazily, and why we don't freeze on listen
3. [ADR 0003 — Handler return-value reflection](docs/adr/0003-handler-return-value-reflection.md): why handlers return values instead of calling `res.send`
4. [ADR 0004 — Context object pool](docs/adr/0004-context-pool.md): per-request pooling for GC pressure, V8 hidden class stability
5. [ADR 0005 — Express compat shim scope](docs/adr/0005-express-compat-shim-scope.md): what's in, what's out, and why

---

## Repo layout

```
ingenium/
├── packages/
│   ├── ingenium/              # core
│   ├── ingenium-compat/       # Express middleware shim
│   ├── ingenium-bun/          # Bun.serve adapter
│   ├── ingenium-redis/        # Redis stores (sessions, idempotency, rate-limit, job queue)
│   └── ingenium-cli/          # ingenium new scaffolder
├── apps/
│   └── notes-api/                # reference CRUD service
├── examples/
│   ├── basic/
│   ├── migrate-from-express/
│   ├── with-plugin/
│   └── with-bun/
├── benchmarks/
│   ├── scenarios/                # v1 — in-process (deprecated)
│   └── scenarios/v2/             # separate-process bench vs Express/Fastify/Hono
├── docs/
│   ├── migration-guide.md
│   ├── plugins.md
│   ├── roadmap.md
│   └── adr/                      # 0001-0005
├── .github/workflows/
│   ├── ci.yml                    # Node 20/22/24 × ubuntu/windows
│   ├── bench.yml                 # nightly bench, artifact upload
│   ├── audit.yml                 # banned-packages scan
│   ├── publish.yml               # manual, alpha-gated npm publish
│   └── release.yml               # tag-driven GitHub Release
├── README.md, API.md, CHANGELOG.md, CONTRIBUTING.md, SECURITY.md, LICENSE
├── tsconfig.base.json, tsconfig.json
├── vitest.config.ts
└── package.json (npm workspaces)
```

---

## Development

```sh
git clone https://github.com/IngeniumFramework/Ingenium.git
cd ingenium
npm install

npm run typecheck          # tsc --noEmit across all workspaces
npm test                   # vitest run

# build the publishable core to dist/
npm run build --workspace packages/ingenium

# run a benchmark scenario
cd benchmarks
npx tsx scenarios/v2/hello.ts
```

CI runs typecheck + tests on every push, matrix Node 20/22/24 × ubuntu-latest/windows-latest. Bench runs nightly on Node 22 ubuntu-latest, output uploaded as a workflow artifact.

---

## Roadmap and known gaps

See [docs/roadmap.md](docs/roadmap.md) for the full breakdown. Highlights:

**Shipped in v0.0.1:**
- All deliverables 1–10 from the original session plan
- HTTP/2, WebSocket, SSE, rate limit, session, multipart, trust-proxy
- CI matrix, ADRs, reference app, governance bundle

**Known issues:**
- `ExtractParams` doesn't narrow **constrained** params (`:id(\\d+)` stays `string`). Unconstrained params (`:id`) now narrow correctly through the verb overloads.
- `ctx.query.parse(schema)` uses a fixed shallow-array-aware coercion model — see the [Schema validation](#schema-validation) section for the trade-offs

**Deferred to next session:**
- TypeBox-specific bridge (Standard Schema covers it but a tighter integration could be cleaner)
- Scoped decorators (`app.scope()` scopes middleware today; decorators remain global — see `app.scope()` JSDoc for the rationale)

---

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and the relevant [ADR](docs/adr/) before opening a PR that changes a load-bearing design choice. Bug reports and design feedback welcome via GitHub Issues. Use [SECURITY.md](SECURITY.md) for vulnerability reports — do not file them as public issues.

---

## License

[MIT](LICENSE) © Ingenium contributors.
