/**
 * WebSocket adapter for Ingenium (optional `ws` peer dependency).
 *
 * # Usage
 * ```ts
 * import { ingenium } from 'ingenium'
 * import { enableWebSockets } from 'ingenium/ws'
 *
 * const app = ingenium()
 * enableWebSockets(app)
 * app.ws('/echo', (sock) => {
 *   sock.on('message', (m) => sock.send(m))
 * })
 * await app.listen(3000)
 * ```
 *
 * # Why a monkey-patch?
 * `enableWebSockets(app)` augments the app instance with `app.ws()` and
 * wraps `app.listen()` so the registrar gets attached to the underlying
 * `http.Server` once it's bound. We chose this over extending `IngeniumApp` to
 * avoid pulling `./ws/middleware.ts` into the core import graph (which would
 * create a soft dep on `ws` types from every `app.ts` consumer). This is a
 * known pattern in WS-extending frameworks (e.g. `express-ws`).
 *
 * The trade-off: TypeScript can't statically see `app.ws` unless the
 * augmentation below is loaded. Importing this module both registers the
 * runtime patch AND adds the type augmentation to the global `IngeniumApp`.
 */

import type { IngeniumApp } from '../app.ts'
import type { ListeningServer, Transport } from '../transport/types.ts'
import { createWebSocketRegistrar, peerHasWs } from './middleware.ts'
import { WsNodeAdapter } from './ws-node-adapter.ts'
import type {
  WebSocketHandler,
  WebSocketHandlerOptions,
  WsIntegrator,
  WsRegistrar,
} from './types.ts'

export type {
  WebSocketHandler,
  WebSocketHandlerOptions,
  WebSocketOriginOption,
  WebSocketOriginVerifier,
  WsIntegrator,
  WsRegistrar,
  WebSocket,
} from './types.ts'
export { createWebSocketRegistrar, peerHasWs } from './middleware.ts'

// ───── Type augmentation ────────────────────────────────────────────────────
// Declared on IngeniumApp so `app.ws(...)` and `app.upgradeWith(...)` typecheck
// for any consumer that imports from 'ingenium/ws'.
declare module '../app.ts' {
  interface IngeniumApp {
    ws(path: string, handler: WebSocketHandler, options?: WebSocketHandlerOptions): IngeniumApp
    upgradeWith(integrator: WsIntegrator): IngeniumApp
  }
}

/** Per-app state attached by `enableWebSockets`. Internal. */
interface WsAppState {
  registrar: WsRegistrar
  integrators: WsIntegrator[]
  enabled: true
}

const APP_STATE: WeakMap<IngeniumApp, WsAppState> = new WeakMap()

/** Options for `enableWebSockets`. Reserved for future use. */
export interface EnableWebSocketsOptions {
  /**
   * When `true`, eagerly probes for the `ws` peer dependency at install
   * time and prints a warning if it is missing. Default: `false` (we wait
   * until the first upgrade attempt).
   */
  warnOnMissingPeer?: boolean
}

/**
 * Augment a `IngeniumApp` with WebSocket support. Idempotent — calling more than
 * once on the same app is a no-op.
 */
export function enableWebSockets(app: IngeniumApp, opts: EnableWebSocketsOptions = {}): void {
  if (APP_STATE.has(app)) return

  const registrar = createWebSocketRegistrar()
  const state: WsAppState = { registrar, integrators: [], enabled: true }
  APP_STATE.set(app, state)

  if (opts.warnOnMissingPeer) {
    void peerHasWs().then((ok) => {
      if (!ok) {
        process.emitWarning(
          'ingenium: enableWebSockets() called but `ws` is not installed. ' +
            'Install it with `npm install ws`.',
        )
      }
    })
  }

  // Attach the new methods. We assign with a cast because the augmentation
  // above only exists at the type layer.
  ;(app as unknown as { ws: IngeniumApp['ws'] }).ws = function (
    path: string,
    handler: WebSocketHandler,
    options?: WebSocketHandlerOptions,
  ): IngeniumApp {
    state.registrar.add(path, handler, options)
    return app
  }

  ;(app as unknown as { upgradeWith: IngeniumApp['upgradeWith'] }).upgradeWith = function (
    integrator: WsIntegrator,
  ): IngeniumApp {
    state.integrators.push(integrator)
    return app
  }

  // Swap in a WebSocket-aware Node transport. We do this via bracket-access
  // because `IngeniumApp#transport` is `private` (TypeScript-only — `private`
  // doesn't actually hide the field at runtime). If the user injected a
  // custom transport via `IngeniumAppOptions.transport`, we leave it alone and
  // log a warning — they're responsible for calling `registrar.attach()`
  // themselves via `app.upgradeWith(...)`.
  const appAny = app as unknown as { transport: Transport }
  const existing = appAny.transport
  const isDefault = existing.constructor?.name === 'NodeAdapter'

  if (isDefault) {
    appAny.transport = new WsNodeAdapter((httpServer) => {
      state.registrar.attach(httpServer)
      for (const integrator of state.integrators) integrator(httpServer)
    })
  } else {
    process.emitWarning(
      'ingenium.ws: a custom Transport is in use — WebSockets will only be wired ' +
        'if you call `app.upgradeWith((httpServer) => registrar.attach(httpServer))` from your transport.',
    )
  }

  // Wrap close() of the eventual ListeningServer so the registrar tears
  // down its WebSocketServers first — otherwise `server.close()` hangs
  // forever waiting on the open WS sockets.
  const originalListen = app.listen.bind(app)
  ;(app as unknown as { listen: IngeniumApp['listen'] }).listen = async function (
    port: number,
    host?: string,
  ): Promise<ListeningServer> {
    const server = await originalListen(port, host)
    const originalClose = server.close.bind(server)
    return {
      port: server.port,
      host: server.host,
      close: async (closeOpts) => {
        await state.registrar.close()
        await originalClose(closeOpts)
      },
    }
  }
}

// Re-export the WS-aware Node transport for advanced users who want to
// construct it manually (e.g. when wiring a custom Transport stack).
export { WsNodeAdapter } from './ws-node-adapter.ts'
