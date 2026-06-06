# API reference

This is the per-module reference for the core `ingenium` package. The locked public surface — what code outside the framework is allowed to import — lives in [`API.md`](../../API.md) at the repo root. The pages here go deeper: every exported function, class, type, option, throw, and edge case, grounded in the source under [`packages/ingenium/src`](../../packages/ingenium/src).

If something in these pages disagrees with the actual source, the source wins — please open an issue.

## Modules

| Page | Covers |
|---|---|
| [app.md](./app.md) | `ingenium()` factory, `IngeniumApp`, options, `use`, method registration, hooks, decorators, `compose`, `handle`, `listen`, `register` |
| [routing.md](./routing.md) | `Router`, mount semantics, path syntax, precedence, `ExtractParams`, `HttpMethod`, `HTTP_METHODS` |
| [context.md](./context.md) | `IngeniumContext` — request, network info, response setters and writers, pool semantics |
| [body.md](./body.md) | `IngeniumBody` on `ctx.body` — `json`, `text`, `urlencoded`, `buffer`, `stream`, `multipart`, schema detection |
| [errors.md](./errors.md) | `IngeniumError` and the per-status subclasses, default boundary, `app.onError` |
| [middleware.md](./middleware.md) | Built-in middleware — `ingenium.json`, `ingenium.urlencoded`, `ingenium.static`, `ingenium.cors`, `ingenium.csrf`, `ingenium.sse`, `ingenium.rateLimit`, `sessionMiddleware` |
| [csrf.md](./csrf.md) | `ingenium.csrf` middleware — cookie + session storage modes, token issuance, `IngeniumCsrfError` |
| [transports.md](./transports.md) | `Transport` interface, `NodeAdapter`, `BunAdapter`, `Http2Adapter`, `Http2cAdapter`, `WsNodeAdapter`, `gracefulShutdown` |
| [cli.md](./cli.md) | `ingenium-cli` — `ingenium new`, flags, templates |
| [compat.md](./compat.md) | `expressCompat()` shim, status matrix pointer |
| [schema.md](./schema.md) | Standard Schema v1 integration, `isStandardSchema`, detection order |

## Conventions

- Every code block uses TypeScript fences. Import from `'ingenium'` unless noted.
- Names follow the v0.0.1 rename: `ingenium()` factory, `Ingenium*` classes (`IngeniumApp`, `IngeniumContext`, `IngeniumBody`, `IngeniumError`, …), `ingenium.*` static helpers (`ingenium.json`, `ingenium.cors`, `ingenium.static`, `ingenium.sse`, `ingenium.rateLimit`).
- Anything marked `@internal` in the source is documented for context only — do not depend on it; semver does not apply.

## Companion packages

These pages cover the core `ingenium` package only. Some surfaces ship as
separate packages and are documented alongside their source:

- **JWT + API-key auth** — `jwtMiddleware`, `apiKeyMiddleware`, `verifyJwt`,
  JWKS helpers — live in [`ingenium-auth`](../../packages/ingenium-auth)
  (`import { jwtMiddleware, apiKeyMiddleware } from 'ingenium-auth'`). They are
  no longer exported from core `ingenium`.
- **Redis session/rate-limit stores** live in
  [`ingenium-redis`](../../packages/ingenium-redis).
- **Bun transport** (`BunAdapter`) lives in
  [`ingenium-bun`](../../packages/ingenium-bun); see also
  [transports.md](./transports.md).
- **Express compat shim** is summarized in [compat.md](./compat.md) and lives in
  [`ingenium-compat`](../../packages/ingenium-compat).
