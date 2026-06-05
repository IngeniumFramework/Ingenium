# Ingenium Roadmap

## ⚠️ Production caveats — read first

**Not production-ready for multi-instance deploys.** The default in-memory stores for sessions, idempotency, rate-limit, and background-job queues don't share state across pods. Use the Redis-backed adapters in [`ingenium-redis`](../packages/ingenium-redis) before deploying behind a load balancer.

**Alpha API surface.** Verb registration, `ctx` shape, and middleware composition are stable enough to use; everything tagged `@internal` may change before 0.1.0.

## Version targets

| Milestone | Goal | Status |
|---|---|---|
| **v0.0.x** | Feature-complete framework surface; alpha API. | released |
| **v0.1.0** | All Redis stores shipped; plugin scoping; `ExtractParams` runtime narrowing; benchmark matrix on CI. | feature-complete on `main` |
| **v1.0.0** | API frozen. SemVer stability commitment. Production deployments officially supported. | planned |

## Shipped in v0.0.1

- `ingenium()` app factory with lazy-composed middleware pipeline and `app.compose()` pre-warm.
- `Router()` with prefix mounting and nested routers.
- `IngeniumContext` request/response surface (params, query, headers, `state`, status/header setters, terminal writers `json` / `text` / `html` / `send` / `redirect` / `stream`).
- `IngeniumBody` lazy parsers: `json`, `text`, `urlencoded`, `buffer`, `stream`, `multipart`. **Buffer-level parse cache** — multiple consumers can re-read the body without "already consumed" errors.
- `app.inject({ method, url, headers, body })` — in-process test client returning `{ status, headers, body, json<T>() }`. No socket, no transport — same dispatch path as the wire.
- `app.route(path).get(h).put(h).delete(h).all(h)` — chainable per-path builder. Pure registration sugar; same verb semantics, typed params via `ExtractParams<P>`.
- `app.route(path).get(h).put(h).delete(h).all(h)` — chainable per-path builder. Pure registration sugar; same verb semantics, typed params via `ExtractParams<P>`.
- `ctx.cookies` — first-class cookie API with signed-cookie support (`cookieSecrets` on app options, HMAC-SHA-256 with key rotation).
- Inline OpenAPI route options — `app.get(path, { tags, summary, response, requestBody, deprecated, ... }, handler)` peels off well-known keys at registration and routes them through `describe()`.
- `app.scope(prefix, register)` — plugin and middleware scoping onto a path subtree. Compose-time resolution; hot path unchanged. Plugins target `PluginTarget` (implemented by both `IngeniumApp` and `ScopedApp`).
- Type-level `ExtractParams<Path>` narrowing on verb handlers — `app.get('/users/:id', ctx => ctx.params.id)` types as `string`.
- `ctx.query.parse(schema)` symmetric with `ctx.body.json(schema)`. Shallow-array-aware coercion (repeated keys → `string[]`).
- Handler return-value reflection (object → JSON, string → text/html, `Buffer` → octet-stream, `Readable` → stream, `undefined` → 204).
- Path syntax with `:param`, `:param?`, `*wild`, deterministic precedence (static > param > wildcard).
- Error class hierarchy (`IngeniumError` and friends) with default JSON error boundary; `app.onError` override + re-throw delegation.
- Standard Schema v1 integration in `ctx.body.json(schema)` and `ctx.query.parse(schema)` (alongside Zod-style `safeParse` and duck-typed `{ parse }`).
- Express compat shim (`expressCompat`) — real-stream `req`/`res` shims; `(req, res, next)` middleware is a genuine drop-in (cors, helmet, body-parser, multer, compression, express-session, morgan, express-rate-limit).
- Node HTTP adapter with `app.listen(port, host?)` returning `{ port, close }`.
- Bun adapter (`ingenium-bun`) — `BunAdapter` transport for `Bun.serve()` sharing the same `app.handle(ctx)` dispatch entry, with a Web-Streams ↔ `node:stream` bridge.
- HTTP/2 (h2) + HTTP/2 cleartext (h2c) transports.
- WebSocket support via the opt-in `ws` peer dep; SSE helper sharing the same dispatch entry.
- Plugin system — `app.register(plugin, opts?)` with lifecycle hooks (`onRoute`, `onCompose`, `onRequest`, `onResponse`, `onError`) and per-request decorators (`app.decorate` lazy, `app.decorateRequest` eager). Hot path short-circuits when nothing is registered.
- Production primitives — `ingenium.static`, `ingenium.cors`, `ingenium.csrf`, `ingenium.rateLimit`, `sessionMiddleware`, `ingenium.idempotency`, `ingenium.jwt`, `ingenium.apiKey`, `ingenium.problemDetails`, content negotiation, trust-proxy, graceful shutdown.
- Hardening — header injection guard, `ctx.json()` safety on circular/BigInt, `IngeniumTimeoutError` (503) with late-write protection via the `_epoch` counter, hard transport-layer body cap (`maxRequestBytes`).
- Dev-mode footgun warnings (NODE_ENV-gated, zero prod cost) — `IngeniumDoubleWriteWarning`, `IngeniumTrustProxyWarning`, `IngeniumResponseObjectWarning`, plus a hard `TypeError` on `app.listen()` called twice.
- CLI scaffolder — `ingenium new <name> [--bun|--minimal]` (`ingenium-cli`) for bootstrapping new apps.
- ADR docs — `docs/adr/0001`–`0005` covering the load-bearing decisions (radix-trie router, lazy composition with dirty bit, return-value reflection, context pool, compat shim scope).

---

## Shipped in v0.1.0

- **All Redis stores shipped.** `ingenium-redis` now ships `RedisQueueStore` alongside the existing session / idempotency / rate-limit adapters, so every pluggable store in core (`SessionStore`, `IdempotencyStore`, `RateLimitStore`, `QueueStore`) has a multi-replica Redis backing. The queue store is all-Lua (atomic `next` / `retry` / `fail`) and keeps the `RedisClientLike` surface unchanged.
- **`ExtractParams` runtime constraint enforcement.** Inline param constraints (`:id(\d+)`, `:slug([a-z-]+)`) are now honored at request time — the trie compiles the constraint once at insert and tests the segment at match, falling through to wildcard/404 on a miss. The hot path is gated: routes without constraints pay one field load and zero regex. Param values remain strings; type-level number-narrowing stays deferred (see below). See ADR 0006.
- **Plugin / middleware scoping.** `app.scope(prefix, register)` confines a plugin's `use` / `before` / `after` / route registrations to a path subtree, resolved at compose time with no per-request cost. `PluginTarget` (implemented by both `IngeniumApp` and `ScopedApp`) now exposes the full registration surface including `before` / `after`.
- **Benchmark matrix on CI.** The v2 harness runs five scenarios — hello, body, middleware, and ~1KB / ~100KB JSON-payload echo — across an Express / Fastify / Hono / Ingenium matrix, on a Node `[20, 22]` CI matrix, triggered per-PR (path-filtered to `benchmarks/**` and `packages/ingenium/**`) plus nightly and on demand. Competitor versions are pinned to exact releases, and each run reports the server child process's RSS alongside throughput / latency. These stay local/CI regression detectors, not published comparative claims.

---

## Performance

We do not publish benchmark numbers in this repo. Run the local harness in
`benchmarks/scenarios/v2/` against your own hardware and workload — those
results are what matter for your decision. Publishable comparative numbers
require isolated hardware, CPU pinning, multi-run / std-dev aggregation, and
pinned framework versions; the bench scripts here are regression detectors
during development, not marketing material.

---

## Known issues — gaps

- **Inline OpenAPI accepts raw schemas only** — `app.get('/path', { response: Schema }, handler)` works for raw OpenAPI Schema objects, but Standard Schema / Zod validators passed inline still throw at registration (validator → JSON Schema conversion is deferred; see below). The `app.describe(...)` call remains for the validator case.

---

## Deferred to next session

### Bun runs in the benchmark matrix

The benchmark matrix (pinned versions, 1KB / 100KB payloads, RSS, per-PR CI) shipped in v0.1.0, but it still varies only Node `[20, 22]`. The harness spawns Node child processes, so running it under Bun would not exercise the Bun runtime end-to-end — covering Bun needs a Bun-native v2 harness. Isolated CPU pinning for publishable comparative numbers also remains out of scope here.

### Inline OpenAPI schema conversion

Inline `{ response, requestBody }` accepts only raw OpenAPI Schema objects today. Standard Schema / Zod validators passed inline throw at registration. Lift the limitation by adapting validators → JSON Schema via vendor-specific helpers (TypeBox is JSON Schema natively; Zod has `zod-to-json-schema`).

### Session / CSRF migration to `ctx.cookies`

Both subsystems still hand-roll cookie writes — there's a `// TODO: migrate to ctx.cookies` marker on each. Migrating is largely mechanical but the existing tests need to still pass on the rolling-session edge cases.

### TypeBox-specific bridge

Standard Schema v1 covers TypeBox already; a tighter integration that consumes TypeBox compiled validators could shave validation overhead. Worth doing only after the benchmark matrix lands so the gain is measurable.

### Constrained param type narrowing (to `number`)

Runtime enforcement of inline constraints shipped in v0.1.0 (`:id(\\d+)` only matches digits — see ADR 0006), but param values are still always `string`. The remaining enhancement is type-level: recognize numeric / enum constraints in `ExtractParams<Path>` and coerce + narrow `ctx.params.id` to `number`. Deferred because auto-coercing param values changes the `ctx.params` value contract (and its V8 hidden-class shape) — it deserves its own decision now that the runtime half is in place.

### Scoped decorators

`app.scope(...)` scopes middleware today but decorators remain global (a lazy decorator installs onto the pooled context at request start, before the route is matched). Making them path-aware requires a runtime check on every property access — measure before shipping.

---

## Open questions

- **Lazy compose dirty-bit cost under heavy mutation.** Apps that register routes per-request (rare, but possible in plugin-heavy or hot-reload setups) will recompose on every request. Do we cap it, warn after N recomposes per minute, or expose a `freeze()` toggle for production?
- **Compat shim long-tail support strategy.** The Express ecosystem is huge and each `req` / `res` accessor we proxy widens the surface. Do we aim for "covers the top 20 middleware on npm" with documented gaps, or stay minimal and route everyone to native ports?

---

## Non-goals

- **A full Express drop-in.** The compat shim is for the long tail of `(req, res, next)` middleware; it is not a goal to make Express apps work unmodified. The migration guide is the supported path.
- **A monorepo bundler / framework wrapper.** Ingenium is the HTTP framework. View templating, ORM, CLI for app structure are out of scope.
- **Multi-runtime fetch-style `Response` interop.** Handlers return plain values or call `ctx` writers. We will not add `return new Response(...)` translation; the dev warning makes the mistake loud and the fix is one line.
- **A community plugin marketplace.** Plugins are npm packages; discovery happens via npm and the docs index.
