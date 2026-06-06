# ingenium-example-basic

A minimal Ingenium hello-world server showing middleware, route params, JSON body parsing, static files, decorators, the error boundary, and graceful shutdown. Run from this directory with `npm run dev` (uses `tsx`, so any Node 20+ works); `npm start` runs the same file. The server listens on port 3000 and exposes:

- `GET /` — returns the string `Hello from Ingenium` (text/plain)
- `GET /health` — returns `{ "ok": true }` as JSON
- `GET /users/:id` — returns `{ "id": "<param>" }` as JSON
- `POST /echo` — parses the JSON body and echoes it back as `{ "youSent": ... }`
- Any file under `./public` is served at `/` via `ingenium.static('./public')`

A logger middleware times every request and prints `METHOD PATH -> Nms`, reading a per-request `ctx.startedAt` attached with `app.decorateRequest`. The `app.onError` handler catches anything thrown inside a handler and replies with a JSON error. On `SIGINT`/`SIGTERM` the server drains in-flight requests via `gracefulShutdown` (default 10s timeout) before exiting.
