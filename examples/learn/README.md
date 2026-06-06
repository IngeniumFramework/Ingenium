# Learn Ingenium

Eight tiny servers, each teaching one concept. Each file is under 60 lines, fully runnable, and only introduces ideas from the previous steps plus exactly one new thing.

If you already know Express, the entire path is ~30 minutes.

## Setup

```sh
# from the monorepo root
npm install
cd examples/learn
```

## The path

| # | File | New concept | Run |
|---|------|------------|-----|
| 1 | [`steps/01-hello.ts`](steps/01-hello.ts) | `ingenium()`, return-value reflection | `npm run 1` |
| 2 | [`steps/02-params.ts`](steps/02-params.ts) | Path params, optional params, `ctx.query` | `npm run 2` |
| 3 | [`steps/03-middleware.ts`](steps/03-middleware.ts) | `(ctx, next)`, `ctx.state`, mount-path middleware | `npm run 3` |
| 4 | [`steps/04-validation.ts`](steps/04-validation.ts) | `ctx.body.json(schema)` and `IngeniumValidationError` | `npm run 4` |
| 5 | [`steps/05-errors.ts`](steps/05-errors.ts) | Throwing `IngeniumError`, `app.onError`, delegation | `npm run 5` |
| 6 | [`steps/06-router.ts`](steps/06-router.ts) | `Router()`, mounting, nested routers | `npm run 6` |
| 7 | [`steps/07-plugin.ts`](steps/07-plugin.ts) | `app.register(plugin)`, `app.decorate`, module augmentation | `npm run 7` |
| 8 | [`steps/08-sessions.ts`](steps/08-sessions.ts) | `sessionMiddleware`, `ctx.session`, regenerate-on-login | `npm run 8` |

Each step prints `Listening on http://localhost:3000` once it's up. The top of every file lists `curl` commands you can paste to try the new behaviour.

## What's NOT here

The path covers the everyday surface. The rest of the production stack is one config call away from any of these examples: CORS, CSRF, rate-limit, idempotency, OpenAPI, sessions, and graceful shutdown ship in core `ingenium`, while JWT and API-key auth live in the separate [`ingenium-auth`](../../packages/ingenium-auth) package (`import { jwtMiddleware, apiKeyMiddleware } from 'ingenium-auth'`) and Redis-backed sessions in [`ingenium-redis`](../../packages/ingenium-redis). See the [root README](../../README.md#production-hardening) once you're through step 8.

## Where to go next

- [`../basic`](../basic) — same hello-world plus static files, lazy decorators, and an error handler in one file.
- [`../migrate-from-express`](../migrate-from-express) — Express version + Ingenium version of the same API, side by side.
- [`../with-plugin`](../with-plugin) — a realistic auth plugin with hooks and decorators.
- [`../../apps/notes-api`](../../apps/notes-api) — reference CRUD service with SQLite, Pino, Zod, and integration tests.
