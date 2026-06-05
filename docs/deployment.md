# Production deployment

Ingenium is intentionally minimal at the network edge: it does not terminate TLS, run as a process supervisor, or ship its own observability layer. The job of the surrounding stack is to handle those things, and the framework is designed to slot in cleanly behind a reverse proxy.

This guide covers the patterns we recommend for production. Examples assume `ingenium` v0.1.0-alpha. Ingenium requires Node.js 20+; Node 24 LTS is recommended (see `.nvmrc`). The published packages are built targeting node20 syntax, so they run on Node 20 through 24.

---

## Behind nginx

Recommended for self-hosted deployments. Nginx terminates TLS, sets `X-Forwarded-*` headers, and proxies to Ingenium over a Unix socket or `127.0.0.1`.

```nginx
upstream ingenium_app {
  server 127.0.0.1:3000 keepalive 32;
  # or: server unix:/var/run/ingenium.sock;
  keepalive_timeout 60s;
}

server {
  listen 443 ssl http2;
  server_name app.example.com;

  ssl_certificate     /etc/letsencrypt/live/app.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/app.example.com/privkey.pem;

  location / {
    proxy_pass http://ingenium_app;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_read_timeout 60s;
  }
}
```

Match in your app:

```ts
const app = ingenium({ trustProxy: 'loopback' })
```

`'loopback'` trusts `127.0.0.0/8` and `::1` — exactly the nginx-on-localhost case. `ctx.ip`, `ctx.protocol`, and `ctx.hostname` will then reflect the original client.

---

## Behind Caddy

Caddy auto-provisions TLS certificates and sets the right headers by default.

```caddyfile
app.example.com {
  reverse_proxy localhost:3000
}
```

App config: same as nginx — `trustProxy: 'loopback'`.

---

## Behind a CDN (Cloudflare, Fastly, Vercel)

CDNs sit on public IPs you don't control. `'loopback'` and `'uniquelocal'` keywords won't cover them.

```ts
// Option 1: trust the entire chain (simplest, fine if your origin is firewalled
// to only accept connections from the CDN).
const app = ingenium({ trustProxy: true })

// Option 2: explicitly list the CDN's published IP ranges.
const app = ingenium({
  trustProxy: [
    '173.245.48.0/20',  // Cloudflare ranges (example — pull current list from CDN docs)
    '103.21.244.0/22',
    // ...
  ],
})

// Option 3: predicate-based (e.g. integrate with a service-discovery feed).
const app = ingenium({
  trustProxy: (ip, hopIdx) => isKnownEdgeIp(ip),
})
```

Cloudflare publishes its current IP ranges at https://www.cloudflare.com/ips/ — refresh periodically.

---

## Docker

Multi-stage Dockerfile with a non-root runtime user.

```dockerfile
# ── build stage ───────────────────────────────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY tsconfig.json ./
# (Optional) compile if your build step writes to dist/
# RUN npx tsup

# ── runtime stage ─────────────────────────────────────────────────────────────
FROM node:22-slim
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY package*.json ./

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1))"

CMD ["node", "--experimental-strip-types", "src/index.ts"]
```

Compose snippet:

```yaml
services:
  app:
    build: .
    init: true                # PID 1 → forwards SIGTERM/SIGINT correctly
    ports: ["3000:3000"]
    env_file: .env
    restart: unless-stopped
```

`init: true` is critical: without it, Node runs as PID 1 and may not receive `SIGTERM` from `docker stop`, breaking graceful shutdown.

---

## Environment variables (12-factor)

Validate config at boot and fail fast. `apps/notes-api/src/config.ts` is a working example.

```ts
import { z } from 'zod'

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().url(),
  SESSION_SECRET: z.string().min(32),
  CSRF_SECRET: z.string().min(32),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
})

export type AppConfig = z.infer<typeof ConfigSchema>

export function loadConfig(): AppConfig {
  const result = ConfigSchema.safeParse(process.env)
  if (!result.success) {
    console.error('Invalid environment:', result.error.flatten().fieldErrors)
    process.exit(1)
  }
  return result.data
}
```

Boot:

```ts
const cfg = loadConfig()
const app = ingenium({ trustProxy: 'loopback' })
const server = await app.listen(cfg.PORT, cfg.HOST)
```

---

## Graceful shutdown

Wire `gracefulShutdown` after `listen()`. Without it, SIGTERM kills the server immediately and in-flight requests are dropped.

```ts
import { ingenium, gracefulShutdown } from 'ingenium'

const app = ingenium()
const server = await app.listen(cfg.PORT, cfg.HOST)

gracefulShutdown(server, {
  gracefulTimeoutMs: 10_000,         // force-close idle keep-alives after 10s
  signals: ['SIGTERM', 'SIGINT'],
  onShutdown: async () => {
    await db.close()
    await queue.flush()
  },
})
```

Behavior on signal:
1. Stop accepting new connections immediately.
2. Wait for in-flight HTTP requests to complete naturally.
3. After `gracefulTimeoutMs`, force-destroy any idle keep-alive sockets so `close()` resolves.
4. Run your `onShutdown` cleanup (database, queue, etc).
5. `process.exit(0)`.

A second signal during shutdown → immediate `process.exit(1)` (force quit).

For Kubernetes set `terminationGracePeriodSeconds: 30` (or larger than your `gracefulTimeoutMs + onShutdown` budget) on the pod spec.

---

## Observability

Ingenium doesn't ship a logger; bring your own. The plugin pattern below gives you per-request structured logs with request IDs.

```ts
import pino from 'pino'
import { ingenium, type IngeniumPlugin } from 'ingenium'
import { randomUUID } from 'node:crypto'

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })

const observability: IngeniumPlugin = (app) => {
  app.decorateRequest('reqId', () => randomUUID())
  app.decorateRequest('log', (ctx) =>
    logger.child({ reqId: (ctx as IngeniumContext & { reqId: string }).reqId })
  )

  app.hooks.onRequest((ctx) => {
    const start = Date.now()
    ;(ctx.state as { _start: number })._start = start
  })

  app.hooks.onResponse((ctx) => {
    const log = (ctx as IngeniumContext & { log: pino.Logger }).log
    const ms = Date.now() - (ctx.state as { _start: number })._start
    log.info({
      method: ctx.method, path: ctx.path, status: ctx._statusCode, ms,
    }, 'request')
  })

  app.hooks.onError((err, ctx) => {
    const log = (ctx as IngeniumContext & { log: pino.Logger }).log
    log.error({ err, method: ctx.method, path: ctx.path }, 'unhandled')
  })
}

await app.register(observability)
```

OpenTelemetry: there isn't a first-party instrumentation yet. The plugin lifecycle (`onRequest`, `onResponse`, `onError`) gives you the hook points to wire OTel manually; a dedicated instrumentation package is roadmap'd for v0.2.

---

## HTTPS

Ingenium does not terminate TLS in core. Two paths:

1. **Reverse proxy (recommended).** nginx, Caddy, Cloudflare, fly.io, Vercel — they all do TLS better than a Node process can. Run Ingenium on plain HTTP behind them.
2. **Direct via Http2Adapter.** When you need ALPN HTTP/2 end-to-end without an intermediate proxy, use `Http2Adapter`:
   ```ts
   import { ingenium, Http2Adapter } from 'ingenium'
   import { readFileSync } from 'node:fs'

   const app = ingenium({
     transport: new Http2Adapter({
       cert: readFileSync('/etc/ssl/cert.pem'),
       key:  readFileSync('/etc/ssl/key.pem'),
       allowHttp1: true,
     }),
   })
   await app.listen(443, '0.0.0.0')
   ```
   You're responsible for cert rotation (watch the file, restart on change, or use a process manager that does).

---

## Process management

### systemd unit

```ini
# /etc/systemd/system/ingenium.service
[Unit]
Description=Ingenium app
After=network.target

[Service]
Type=simple
User=node
WorkingDirectory=/opt/ingenium
Environment="NODE_ENV=production"
EnvironmentFile=/etc/ingenium/env
ExecStart=/usr/bin/node --experimental-strip-types src/index.ts
Restart=on-failure
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=15        # > gracefulTimeoutMs

[Install]
WantedBy=multi-user.target
```

### PM2

```sh
pm2 start src/index.ts --name ingenium \
  --interpreter node \
  --interpreter-args="--experimental-strip-types" \
  --kill-timeout 15000
```

### Kubernetes Deployment (minimal)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ingenium
spec:
  replicas: 3
  selector: { matchLabels: { app: ingenium } }
  template:
    metadata: { labels: { app: ingenium } }
    spec:
      terminationGracePeriodSeconds: 30
      containers:
        - name: app
          image: my-registry/ingenium:latest
          ports: [{ containerPort: 3000 }]
          envFrom: [{ secretRef: { name: ingenium-env } }]
          readinessProbe:
            httpGet: { path: /api/health, port: 3000 }
            periodSeconds: 5
          livenessProbe:
            httpGet: { path: /api/health, port: 3000 }
            periodSeconds: 30
            failureThreshold: 3
```

---

## Pre-flight checklist

Before pushing a Ingenium app to production, verify:

- [ ] `trustProxy` set correctly for your edge (loopback / CIDR list / `true`)
- [ ] `gracefulShutdown(server, { gracefulTimeoutMs })` wired after `listen()`
- [ ] `sessionMiddleware` (if used) has rotated `secret: [...]` from a secrets manager
- [ ] `ingenium.csrf({ secret })` enabled for any cookie-authenticated mutating routes
- [ ] `ingenium.cors({ origin })` configured to your actual allowed origins (no `'*'` with credentials)
- [ ] `ingenium.rateLimit({ windowMs, limit })` on auth endpoints at minimum
- [ ] `ingenium.static(...)` is NOT being used to serve user-uploaded content from a public directory unsanitized
- [ ] Body size limits are appropriate for each endpoint (`ctx.body.json(schema, maxBytes)`)
- [ ] Error handler logs server-side context but does not leak stack traces to clients
- [ ] Health endpoint exists and is exempt from rate-limiting + CSRF
- [ ] Process supervisor forwards SIGTERM (Docker `init: true`, k8s default OK)
- [ ] Metrics or structured logs going somewhere you'll actually look
