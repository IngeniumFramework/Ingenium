# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the project is in alpha (`0.x.y-alpha`), breaking changes may land in
minor (or even patch) releases — see `docs/roadmap.md` for the working list of
deferred items and likely-to-shift surfaces.

## [Unreleased]

### Added — QOL pass

- **Typed route params from the path string.** `app.get('/users/:id', ctx => ctx.params)` now narrows `ctx.params` to `{ id: string }`. `ExtractParams<Path>` was already exported as a type utility; the verb overloads on `Router` and `IngeniumApp` now pass it through to the handler signature. Pure type-level — zero runtime cost.
- **`app.inject({ method, url, headers, body })`** — in-process test client returning `{ status, headers, body, json<T>() }`. Bypasses the socket and transport entirely; ~10× faster than ephemeral-port integration tests. Mirrors Fastify's `inject()` DX. New exports: `InjectRequest`, `InjectResponse`.
- **`ctx.body.json()` parse cache.** Multiple consumers can now read the body without "already consumed" errors — an audit middleware can peek at the body and the handler can still parse it. Buffer-level cache, so different schemas across calls each validate cleanly against fresh-parsed JSON. `stream()` and `multipart()` remain terminal (opt out of the cache).
- **`app.route(path)` chainable verb builder.** Stack multiple verbs on the same path without retyping: `app.route('/users/:id').get(h).put(h).delete(h)`. Adds `.all(handler)` for GET/POST/PUT/PATCH/DELETE in one call. Available on both `IngeniumApp` and `Router`. Pure registration sugar — no per-request cost. New export: `RouteBuilder<P>`.
- **`ctx.cookies` first-class API.** `ctx.cookies.get(name)` / `.set(name, value, opts)` / `.clear(name)` / `.all()`. Lazy getter — apps that don't touch cookies pay zero per-request. Signed-cookie support via `{ signed: true }` with HMAC-SHA-256, `timingSafeEqual` verify, and key rotation (`cookieSecrets: ['new', 'old']` on the app options — first signs, all verify). Calling `{ signed: true }` without `cookieSecrets` configured throws `IngeniumError(500, 'COOKIE_SECRET_MISSING')`. RFC 6265 §4.1.1-compliant serialization including `Domain`, `Path`, `Expires`, `Max-Age`, `HttpOnly`, `Secure`, `SameSite`, `Priority`, `Partitioned`. New exports: `IngeniumCookies`, `CookieSetOptions`, `CookieGetOptions`.
- **Inline OpenAPI route options.** `app.get('/users/:id', { tags, summary, response, requestBody, deprecated, ... }, handler)` peels off well-known keys and forwards them to `app.describe(method, path, ...)` at registration time. Mixes freely with user-defined `app.declare(...)` keys in the same options object. `describe()` now merges shallowly rather than overwriting, so inline metadata + an explicit `app.describe()` call compose. Inline `response` / `requestBody` accept raw OpenAPI Schema only for now; Standard Schema / Zod validators throw at registration with a clear message — convert validators to JSON Schema or use precomputed schemas.
- **Plugin scoping.** `app.scope('/api/v2', s => s.use(authPlugin))` lets plugins decorate only a subtree. Compose-time resolution — the hot path is unchanged. Plugins now accept a `PluginTarget` (implemented by both `IngeniumApp` and `ScopedApp`). New exports: `ScopedApp`, `PluginTarget`. Limitation: decorators remain global in v1 (a `scope.decorate(...)` call emits a dev-mode warning explaining how to make the resolver path-aware).
- **Dev-mode footgun warnings**, all gated by `NODE_ENV !== 'production'` so V8 dead-code eliminates them in prod builds:
  - `IngeniumDoubleWriteWarning` — `ctx.json()` called after the response was already written.
  - `IngeniumTrustProxyWarning` — `ctx.ip` (or `ips`/`protocol`/`hostname`) read with `trustProxy: false` while the request carries `X-Forwarded-For`. Fires once per process.
  - `IngeniumResponseObjectWarning` — handler returned a fetch-style `Response` object. Fires once per process; the Response is ignored and the request falls through to 204.
  - `TypeError` thrown when `app.listen()` is called on an app that's already listening (instead of an unclear `EADDRINUSE`).

### Added — P0 production hardening (items 2–8)

- **Per-request timeout** (`ingenium({ requestTimeoutMs })`). New `IngeniumTimeoutError` (503). Late-write protection via per-context `_epoch` counter — orphaned-handler writes after a timeout are detected and discarded so the next request bound to the same pooled context isn't corrupted.
- **Hard request-body cap at the transport layer** (`ingenium({ maxRequestBytes })`, default 2 MiB). Wrapped via `createByteLimit` Transform on the source stream so the cap applies regardless of which `ctx.body.*` consumer reads — including `ctx.body.stream()`. Content-Length pre-check rejects oversized requests with 413 before acquiring a context. Wired into NodeAdapter, BunAdapter, Http2Adapter, and Http2cAdapter.
- **Asymmetric JWT (RS256/RS384/RS512, PS256/PS384/PS512, ES256/ES384/ES512)** + **JWKS support**. New `jwksUrl` / `jwksCacheMs` / `JwtKey` types. Algorithm-confusion attacks blocked at the allowlist. `'none'` rejected unconditionally — even if a caller adds it to `algorithms`. Built on `node:crypto` with zero new runtime deps. EC curves: P-256/P-384/P-521 (note: ES512 maps to curve P-521 per JOSE spec quirk). JWKS fetch coalesces concurrent requests into a single in-flight promise.
- **Detect-and-throw on broken compat-shim middleware**. `expressCompat(bodyParser.json())`, `expressCompat(multer().single(...))`, `expressCompat(session(...))`, `expressCompat(compression())` now throw a `TypeError` at registration with a message naming the Ingenium-native equivalent. Opt out with `expressCompat(mw, { allowKnownBroken: true })` to get a `process.emitWarning` instead.
- **Header injection guard**. `ctx.set(name, value)` rejects values containing `\r` or `\n` immediately with `IngeniumHeaderInjectionError` (500, code `HEADER_INJECTION`) — same for header names.
- **`ctx.json()` safety on circular refs / BigInt / unserializable values**. Throws `IngeniumUnserializableError` (500, code `UNSERIALIZABLE_RESPONSE`) with a structural reason instead of letting `JSON.stringify`'s `TypeError` bubble up as a generic 500. New `safeJsonStringify(value, opts?)` helper exported for lenient mode (handles circular refs as `[Circular]`, BigInt as JSON string).
- **Idempotency-Key — skip caching 5xx by default**. `IdempotencyOptions.cacheable: (status) => boolean` (default `(s) => s >= 200 && s < 500`). Transient 500s no longer get replayed for the entire TTL; the in-flight promise resolves with `null` on uncacheable status so concurrent waiters fall through to a fresh handler run.
- New error classes: `IngeniumTimeoutError`, `IngeniumHeaderInjectionError`, `IngeniumUnserializableError`. New helper exports: `safeJsonStringify`, `fetchJwks`, `clearJwksCache`. New types: `JwtKey`.

### Changed

- `TransportHooks.maxRequestBytes` is a new optional field; the framework's `app.listen()` always populates it (default 2 MiB). Consumers normalize `undefined` to `Number.POSITIVE_INFINITY` for backward compat with adapters that predate the hook (`WsNodeAdapter`).
- `jwtMiddleware` no longer throws at construction for `RS256`/`ES256`/etc. — those are now first-class. It still rejects `algorithms: ['none']` at construction.

### Earlier in [Unreleased] — already shipped before this push

- **CSRF protection.** Native `ingenium.csrf(opts)` middleware (also exported as
  `csrfMiddleware`). Two storage modes:
  - `'cookie'` (default): double-submit cookie pattern with HMAC-SHA-256
    signing. Token written to a non-`HttpOnly` cookie on safe requests; client
    must echo via `X-CSRF-Token` (or `X-XSRF-Token` / `?_csrf=`) on unsafe
    requests. Verified with `crypto.timingSafeEqual`. Secret rotation supported.
  - `'session'`: synchronizer pattern. Token stored on `ctx.session.csrfToken`,
    requires `sessionMiddleware` to run first.
  - Failures throw `IngeniumCsrfError` (HTTP 403, code `CSRF_FAILED`).
  - Token exposed via `ctx.csrfToken()` and `ctx.state.csrfToken` for embedding
    in HTML forms.
  - 23 unit tests across both modes, including timing-safe compare and rotation.

- **`docs/api/csrf.md`** — full CSRF reference (storage modes, options,
  failure mode, rotation, skip patterns, what CSRF does NOT replace).
- **`docs/deployment.md`** — production deployment guide (nginx, Caddy, CDN,
  Docker, k8s, env vars, graceful shutdown, observability, HTTPS, process
  managers, pre-flight checklist).
- **`CODE_OF_CONDUCT.md`** — Contributor Covenant v2.1 reference.

### Changed

- Renamed `makeRexFactory` → `makeIngeniumFactory` and `rexCore` → `ingeniumCore`
  (caught by post-rename sweep — the word-boundary script missed
  mid-camelCase tokens).

### Fixed

- **Middleware now runs on trie misses.** `app.use(ingenium.static(...))` and
  `app.use(corsMw)` patterns work correctly: when no route matches, a
  fallback chain composed of global + path-matching scoped middleware runs
  before the 404/405 surfaces. Previously a request to an unregistered
  path 404'd before any middleware fired.

## [0.0.4] - 2026-06-05

Security release — two highs and several mediums from a multi-agent audit, plus
follow-up hardening. All findings were adversarially verified before fixing.

### Security — Fixed

- **Route param constraints are now tested against the DECODED value** (`router/trie.ts`). Previously the constraint ran against the raw percent-encoded segment while the handler received the decoded value, so `%2f`/`%2e`/`%00` smuggled `/`, `.`, or NUL past a constraint written as a filter (e.g. `:file([^/]+)` used as a traversal guard). **(High)**
- **Timed-out request contexts are poisoned and dropped from the pool** instead of being reused (`context/pool.ts`, `app.ts`, `IngeniumContext._timedOut`). The orphan-write guard only covered the body writers; an orphaned handler's `ctx.set()`/`ctx.status()` could land on the next request's recycled context (cross-request header/status bleed). Poisoned contexts are now never rebound. **(High)**
- **JWKS SSRF guard normalizes IPv4-mapped IPv6** (`jwt/jwks.ts`). `::ffff:127.0.0.1` / `::ffff:169.254.169.254` / `::ffff:10.0.0.5` (and the hex forms `new URL()` canonicalizes to) are collapsed to their embedded IPv4 and blocked. Also blocks `0.0.0.0/8`, and adds DNS resolve-and-check so a hostname that resolves into private/loopback/link-local space is rejected. **(Medium)**
- **Sessions are no longer persisted until written to** (`session/middleware.ts`). New `SessionOptions.saveUninitialized` (default `false`) — empty anonymous sessions are no longer stored/cookied by default, closing a cookieless-flood memory-DoS against the in-memory store. The session `MemoryStore` is now bounded (`maxEntries`, default 100k, LRU eviction). **(Medium)**
- **Default error boundary no longer leaks raw exception messages in production** (`app.ts`). A thrown non-`IngeniumError` now serializes a generic `Internal Server Error` in production (raw message only when `NODE_ENV !== 'production'`), matching the RFC 7807 serializer. `IngeniumError` messages remain surfaced. **(Medium)**
- **SSE framing fields are sanitized** (`sse/sse.ts`). CR/LF is stripped from `event`/`id`/comment values and `data` is CRLF-normalized, preventing SSE field/event injection (response-splitting analog). Non-finite `retry` is ignored. **(Medium)**
- **The WebSocket adapter now enforces `maxRequestBytes`** (`ws/ws-node-adapter.ts`). Enabling WebSockets previously dropped the transport-level body cap, leaving `ctx.body.stream()` consumers uncapped. Body-size enforcement is extracted to `transport/body-limit.ts` and shared by both Node adapters so they can't drift. **(Medium)**
- **Static serving resolves symlinks** (`static/middleware.ts`). New `StaticOptions.symlinks` (default `'deny'`) realpath-resolves the final target and 403s if it escapes the root, closing the in-root-symlink-points-out escape. Set `'allow'` to opt out.
- **Rate limiter warns when defaulting to the in-process store** (dev-only), and `MultipartFile.filename` is documented as untrusted (traversal vector for naive disk writes).

### Added

- `StaticOptions.symlinks`, `SessionOptions.saveUninitialized`, session `MemoryStore` `maxEntries`.

## [0.1.0-alpha] - 2026-05-12

First publishable alpha. Locks the core surface described in `API.md` and adds
the production-grade middleware required for non-trivial deployments.

### Added

- **App + Router.** `ingenium()` factory, `IngeniumApp`, mountable `Router` with prefix
  composition, lazy middleware composition with a dirty-bit recompose, and
  `app.compose()` pre-warm.
- **Routing.** Radix-trie router with deterministic precedence
  (static > `:param` > `*wildcard`), optional params (`:id?`), wildcard tails
  (`*path`), typed param extraction via `ExtractParams<Path>`.
- **Context + body.** Pooled `IngeniumContext`, lazy `URLSearchParams`, lazy
  `IngeniumBody` parsers (`json`, `text`, `urlencoded`, `buffer`, `stream`,
  `multipart`). Body-parser default limit is **100,000 bytes** (matches
  Express's `body-parser` default).
- **Multipart.** Native `IngeniumBody.multipart()` for `multipart/form-data` with
  per-file / per-field caps and an allow-list for MIME prefixes.
- **Validation.** First-class
  [Standard Schema v1](https://standardschema.dev) detection in
  `IngeniumBody.json(schema)`, with fallbacks for Zod's `safeParse` and any
  `{ parse(input): T }` validator. Issues normalized into a
  `IngeniumValidationError` with a `fields` map.
- **Response helpers.** `ctx.json/text/html/send/redirect/stream` plus
  return-value reflection (object → JSON, string → text/html, `Buffer` →
  octet-stream, `Readable` → stream, `undefined` → 204).
- **Errors.** `IngeniumError` hierarchy
  (`IngeniumNotFoundError`, `IngeniumUnauthorizedError`, `IngeniumMethodNotAllowedError`,
  `IngeniumPayloadTooLargeError`, `IngeniumValidationError`, `IngeniumBadRequestError`)
  and an `app.onError(handler)` boundary that re-throws to delegate.
- **Plugins.** `app.register(plugin, opts?)`, lifecycle hooks (`onRoute`,
  `onCompose`, `onRequest`, `onResponse`, `onError`), `app.decorate(name, fn)`
  (lazy) and `app.decorateRequest(name, fn)` (eager). Hot path
  short-circuits when no plugins are registered.
- **Middleware (built-ins).**
  - `ingenium.json(opts?)` / `ingenium.urlencoded(opts?)` — Express-compat no-ops
    (parsing remains lazy via `ctx.body.*`).
  - `ingenium.static(root, opts?)` — ETag, conditional GET, range requests, MIME
    detection, `index` / `extensions` / `dotfiles` / `maxAge` (ms).
  - `ingenium.cors(opts?)` — simple + preflight CORS with origin allowlist /
    regex / function, `Vary: Origin`, credentials guard against `*`.
  - `sessionMiddleware` — HMAC-signed cookie sessions, key rotation,
    `regenerate()`, pluggable store (default in-process), rolling TTL.
  - `rateLimit` — fixed-window limiter with `X-RateLimit-*` headers,
    `Retry-After`, pluggable store.
  - `sse(ctx)` + `startKeepAlive` — Server-Sent Events stream helper.
- **Transports.**
  - `NodeAdapter` (default) — `node:http`, socket tracking for graceful
    close.
  - `Http2Adapter` — `h2` over TLS with optional ALPN HTTP/1.1 fallback.
  - `Http2cAdapter` — `h2c` cleartext for local / behind-proxy use.
  - `BunAdapter` (`ingenium-bun`) — `Bun.serve()` with WinterCG ↔
    `node:stream` body bridge.
  - `WsNodeAdapter` (`ingenium/ws`) — opt-in WebSocket support via the
    optional `ws` peer dep, exposed through `enableWebSockets(app)`.
- **Trust-proxy.** `IngeniumAppOptions.trustProxy` mirroring Express's
  `app.set('trust proxy', ...)` semantics — booleans, hop counts, CIDRs,
  keywords (`loopback`, `linklocal`, `uniquelocal`), or a custom predicate.
  `ctx.ip`, `ctx.ips`, `ctx.protocol`, `ctx.hostname`, `ctx.secure` are
  populated from `X-Forwarded-*` according to the policy.
- **Graceful shutdown.** `gracefulShutdown(server, opts?)` wires SIGTERM /
  SIGINT to drain the server, run a user `onShutdown` hook, and force-close
  idle keep-alive sockets after `gracefulTimeoutMs` (default 10 s, matching
  Kubernetes' default `terminationGracePeriodSeconds` headroom).
- **Express compat shim** (`ingenium-compat`). `expressCompat(mw)`
  proxies pure-function `(req, res, next)` middleware (cors, helmet,
  morgan, compression). Documented incompatibilities in
  `docs/migration-guide.md`.
- **CLI** (`ingenium-cli`). `ingenium new <name> [--bun|--minimal|--force]`
  scaffolds a project. `ingenium routes` is reserved for v0.2.
- **CI.** GitHub Actions matrix on Node 20 / 22 / 24 across Ubuntu and
  Windows; typecheck + Vitest run on every push.
- **Architecture decision records.** `docs/adr/0001`–`0005` covering the
  radix-trie router, lazy composition with the dirty bit, return-value
  reflection, the context pool, and the compat-shim scope.

### Changed

- Body-parser default limit standardized to 100,000 bytes for `json` /
  `text` / `urlencoded` / `buffer` (was previously documented as 1 MiB
  for `buffer` — see `packages/ingenium/src/context/body.ts`).

### Deprecated

- Nothing yet.

### Removed

- Nothing yet.

### Fixed

- N/A — first public alpha.

### Security

- `sessionMiddleware` uses HMAC-SHA-256, `timingSafeEqual` verification,
  and 144-bit random ids. Tampered cookies silently issue a fresh session
  (no error response) so this surface is not an oracle.
- `ingenium.cors` rejects `credentials: true` combined with `origin: '*'` at
  construction time per the Fetch spec.
- `ingenium.static` resolves paths under `root` and rejects traversal; the
  `dotfiles` policy defaults to `'ignore'`.
- Default rate-limit `keyGenerator` reads `X-Forwarded-For` directly —
  see the JSDoc warning. Production deployments behind a proxy must
  configure `trustProxy` or supply a custom `keyGenerator`.

[Unreleased]: https://github.com/ingenium/ingenium/compare/v0.1.0-alpha...HEAD
[0.1.0-alpha]: https://github.com/ingenium/ingenium/releases/tag/v0.1.0-alpha
