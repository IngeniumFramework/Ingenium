/**
 * WebSocket registrar — the small piece of state that holds path → handler
 * mappings and knows how to wire `'upgrade'` on a Node `http.Server`.
 *
 * Design: the `ws` package is loaded lazily via dynamic `import('ws')` so
 * apps that never use WebSockets pay no cost (no module load, no peer-dep
 * requirement). The first call to `attach()` resolves the import.
 */

import type { Server as HttpServer, IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { IngeniumContext } from '../context/context.ts'
import type { HttpMethod } from '../router/types.ts'
import type { TrustProxy } from '../proxy/trust.ts'
import type {
  WebSocketHandler,
  WebSocketHandlerOptions,
  WebSocketOriginOption,
  WsRegistrar,
  WsRoute,
} from './types.ts'

/**
 * Read once at module load so V8 dead-code-eliminates the dev warning in
 * production builds (`if (false) { ... }`). See CLAUDE.md.
 */
const IS_DEV = process.env.NODE_ENV !== 'production'

/**
 * Default upgrade-handshake deadline. A client that opens the socket and stalls
 * (never finishing the handshake, or never sending a frame) would otherwise pin
 * the file descriptor forever — a slowloris-style DoS. We arm `socket.setTimeout`
 * before `handleUpgrade` and clear it the moment the handshake completes.
 */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000

/** Construction-time options for the registrar. */
export interface WsRegistrarOptions {
  /** Carried in from the app so `ctx.ip` inside a WS handler honors trust-proxy. */
  trustProxy?: TrustProxy
  /** Upgrade-handshake deadline in ms. Default 10_000. `0` disables. */
  handshakeTimeoutMs?: number
}

/**
 * Attempt to detect whether `ws` is installed. Used by the test suite to
 * `describe.skipIf` the WS suite when the optional peer dep is missing.
 */
export async function peerHasWs(): Promise<boolean> {
  try {
    await import('ws')
    return true
  } catch {
    return false
  }
}

/**
 * Build a registrar bound to an app. The registrar is intentionally
 * decoupled from `IngeniumApp` — the app calls `add()` from `app.ws()`, and
 * `enableWebSockets()` (or the app's `listen()` integration) calls `attach()`
 * once the underlying `http.Server` is created.
 */
export function createWebSocketRegistrar(options: WsRegistrarOptions = {}): WsRegistrar {
  const trustProxy = options.trustProxy ?? false
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
  const routes: Map<string, WsRoute> = new Map()
  let attachedServer: HttpServer | null = null
  // The `ws` `WebSocketServer` instance, lazy-initialized on first upgrade.
  // We use one server per registered path so per-handler options apply.
  const wssByPath: Map<string, unknown> = new Map()
  // We keep a reference to the `ws` module after the first dynamic import.
  let wsModule: typeof import('ws') | null = null

  // Single shared upgrade listener — installed exactly once.
  let upgradeListener: ((req: IncomingMessage, socket: Socket, head: Buffer) => void) | null = null

  function add(path: string, handler: WebSocketHandler, options: WebSocketHandlerOptions = {}): void {
    if (routes.has(path)) {
      throw new Error(`ingenium.ws: path "${path}" already has a WebSocket handler`)
    }
    // WS handlers run OUTSIDE the middleware pipeline, so a route with no
    // `origin` policy is open to Cross-Site WebSocket Hijacking — a browser
    // attaches the victim's cookies to a cross-origin upgrade. Nudge the
    // developer to opt into an Origin check (or authenticate explicitly).
    if (IS_DEV && options.origin === undefined) {
      try {
        process.emitWarning(
          `ingenium.ws: WebSocket route "${path}" registered without an \`origin\` option. ` +
            'WS handlers run outside the middleware pipeline and the browser sends the ' +
            "user's cookies on cross-origin upgrades — restrict the Origin (e.g. " +
            '`{ origin: true }` for same-origin) or authenticate inside the handler to ' +
            'prevent Cross-Site WebSocket Hijacking (CSWSH).',
        )
      } catch { /* worker runtimes can throw on emitWarning */ }
    }
    routes.set(path, { path, handler, options })
  }

  function attach(httpServer: HttpServer): void {
    if (attachedServer === httpServer) return // idempotent
    if (attachedServer !== null) {
      throw new Error('ingenium.ws: registrar already attached to a different http.Server')
    }
    attachedServer = httpServer

    upgradeListener = (req, socket, head) => {
      // Slowloris defense: a client can open the TCP socket and stall the
      // handshake (including across the lazy `import('ws')` below), pinning the
      // FD indefinitely. We use an ABSOLUTE deadline, not `socket.setTimeout`
      // (an idle timer an active trickle of bytes would keep resetting): the
      // handshake must complete within `handshakeTimeoutMs` of the upgrade
      // arriving, full stop. Cleared the instant the handshake completes, and
      // on socket teardown so the timer can't outlive the socket.
      let handshakeTimer: ReturnType<typeof setTimeout> | null = null
      if (handshakeTimeoutMs > 0) {
        handshakeTimer = setTimeout(() => socket.destroy(), handshakeTimeoutMs)
        // Don't keep the event loop alive solely for this guard.
        if (typeof handshakeTimer.unref === 'function') handshakeTimer.unref()
        socket.once('close', () => {
          if (handshakeTimer) clearTimeout(handshakeTimer)
        })
      }
      const clearHandshakeTimer = (): void => {
        if (handshakeTimer) {
          clearTimeout(handshakeTimer)
          handshakeTimer = null
        }
      }

      // Parse the path from the upgrade request URL. We only look at the
      // pathname — query strings are exposed via `ctx.rawQuery` for handlers
      // that care.
      const url = req.url ?? '/'
      const qIdx = url.indexOf('?')
      const path = qIdx >= 0 ? url.slice(0, qIdx) : url

      const route = routes.get(path)
      if (!route) {
        // No handler for this path — close the socket cleanly. The
        // 404-equivalent for WebSockets is just refusing the upgrade.
        socket.destroy()
        return
      }

      // CSWSH defense: enforce the Origin policy BEFORE `handleUpgrade`, so a
      // rejected cross-origin request never completes the handshake. We reply
      // with a real `403` handshake response (not a bare destroy) so the
      // browser surfaces the rejection rather than a generic socket error.
      if (route.options.origin !== undefined) {
        const origin = req.headers.origin
        if (!isOriginAllowed(route.options.origin, origin, req)) {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
      }

      // Lazy-load `ws`. On the first upgrade, dynamically import. If `ws`
      // isn't installed, give a clear actionable error and tear the socket
      // down — apps that wired `app.ws(...)` without installing the peer
      // dep should learn about it the moment a client tries to connect.
      void (async () => {
        try {
          if (wsModule === null) wsModule = await import('ws')
        } catch (err) {
          process.emitWarning(
            'ingenium: app.ws() was called but the `ws` package is not installed. ' +
              'Install it with `npm install ws` (and `@types/ws` for TypeScript).',
          )
          socket.destroy()
          return
        }

        let wss = wssByPath.get(route.path) as
          | InstanceType<typeof import('ws').WebSocketServer>
          | undefined
        if (!wss) {
          wss = new wsModule.WebSocketServer({
            noServer: true,
            // `ws` defaults maxPayload to 100 MiB/frame when undefined — a
            // single hostile peer can pin that much memory per message. Cap at
            // a conservative 1 MiB unless the route explicitly opts into more.
            maxPayload: route.options.maxPayload ?? 1024 * 1024,
            perMessageDeflate: route.options.perMessageDeflate ?? false,
          })
          wssByPath.set(route.path, wss)
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
          // Handshake is done — disarm the deadline so a long-lived connection
          // isn't torn down mid-session. (The handler owns liveness from here.)
          clearHandshakeTimer()
          const ctx = buildMinimalContext(req, path, trustProxy)
          try {
            const ret = route.handler(ws, ctx)
            if (ret && typeof (ret as Promise<unknown>).then === 'function') {
              ;(ret as Promise<unknown>).catch((err) => {
                process.emitWarning(
                  `ingenium.ws: handler for ${path} rejected: ${(err as Error)?.message ?? String(err)}`,
                )
                try { ws.close(1011, 'handler error') } catch { /* socket may already be dead */ }
              })
            }
          } catch (err) {
            process.emitWarning(
              `ingenium.ws: handler for ${path} threw: ${(err as Error)?.message ?? String(err)}`,
            )
            try { ws.close(1011, 'handler error') } catch { /* ignore */ }
          }
        })
      })()
    }

    httpServer.on('upgrade', upgradeListener)
  }

  async function close(): Promise<void> {
    // Detach the upgrade listener so a re-listen on the same server doesn't
    // double-up handlers.
    if (attachedServer && upgradeListener) {
      attachedServer.off('upgrade', upgradeListener)
    }
    upgradeListener = null
    attachedServer = null

    // Close every per-path WebSocketServer. `ws.WebSocketServer.close(cb)`
    // fires once all clients have disconnected; we await each in parallel.
    const closes: Promise<void>[] = []
    for (const wss of wssByPath.values()) {
      const server = wss as InstanceType<typeof import('ws').WebSocketServer>
      // Forcibly terminate any still-open clients so close() resolves
      // promptly during test teardown.
      for (const client of server.clients) {
        try { client.terminate() } catch { /* ignore */ }
      }
      closes.push(new Promise<void>((resolve) => server.close(() => resolve())))
    }
    wssByPath.clear()
    await Promise.all(closes)
  }

  return { add, attach, close }
}

/**
 * Decide whether an upgrade Origin passes the configured policy. Centralized
 * so the listener stays readable and the boolean/string/array/function arms
 * are tested in one place.
 *
 * `true` means same-origin: the `Origin` URL's host (incl. port) must match
 * the request `Host` header. A missing `Origin` (non-browser clients never
 * send one) is rejected under `true` because we cannot prove same-origin —
 * browser-facing sockets are the threat model here; trusted backend clients
 * should use an explicit allowlist or a custom verifier instead.
 */
function isOriginAllowed(
  policy: WebSocketOriginOption,
  origin: string | undefined,
  req: IncomingMessage,
): boolean {
  if (typeof policy === 'function') return policy(origin, req)

  if (policy === false) return true // explicitly disabled — allow all
  if (policy === true) {
    if (origin === undefined) return false
    let originHost: string
    try {
      originHost = new URL(origin).host
    } catch {
      return false // malformed Origin header
    }
    return originHost === req.headers.host
  }

  // string | string[] — exact allowlist match against the raw Origin header.
  if (origin === undefined) return false
  return Array.isArray(policy) ? policy.includes(origin) : policy === origin
}

/**
 * Build a minimal `IngeniumContext` for a WebSocket handler. We don't run the
 * full request pipeline (no middleware, no decorators) because the upgrade
 * has already taken place — the handler owns the socket from here.
 */
function buildMinimalContext(
  req: IncomingMessage,
  path: string,
  trustProxy: TrustProxy,
): IngeniumContext {
  const ctx = new IngeniumContext()
  ctx.method = (req.method ?? 'GET') as HttpMethod
  ctx.url = req.url ?? '/'
  ctx.path = path
  const url = ctx.url
  const qIdx = url.indexOf('?')
  ctx.rawQuery = qIdx >= 0 ? url.slice(qIdx + 1) : ''
  ctx.headers = req.headers
  // Surface the real peer address and the app's trust-proxy config so a handler
  // that authorizes on `ctx.ip` resolves it the same way the HTTP path does.
  // Without this, `ctx.ip` would return the pool default and ignore XFF policy.
  ctx.remoteAddress = req.socket?.remoteAddress ?? '127.0.0.1'
  ctx._trustProxy = trustProxy
  return ctx
}
