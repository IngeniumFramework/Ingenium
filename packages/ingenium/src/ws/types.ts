/**
 * Public types for the optional WebSocket adapter. The `ws` package is an
 * OPTIONAL peer dependency — these types are erased at runtime, so this file
 * compiles even when `ws` is not installed.
 */

import type { IncomingMessage } from 'node:http'
// Type-only — TypeScript erases this; safe even without `ws` installed.
import type { WebSocket as WsWebSocket } from 'ws'
import type { IngeniumContext } from '../context/context.ts'

/** Re-export the underlying `ws` `WebSocket` type for convenience. */
export type WebSocket = WsWebSocket

/**
 * Handler invoked when a client successfully upgrades to a WebSocket.
 *
 * `socket` is the `ws.WebSocket` instance. `ctx` is a minimal `IngeniumContext`
 * populated from the upgrade `IncomingMessage` — the body / response writers
 * are not meaningful for WS handlers (the upgrade has already happened).
 */
export type WebSocketHandler = (socket: WsWebSocket, ctx: IngeniumContext) => void | Promise<void>

/**
 * Custom Origin verifier. Receives the request's `Origin` header (or
 * `undefined` when absent, e.g. a non-browser client) plus the raw upgrade
 * request. Return `true` to allow the upgrade, `false` to reject it with a
 * `403` handshake.
 */
export type WebSocketOriginVerifier = (
  origin: string | undefined,
  req: IncomingMessage,
) => boolean

/**
 * Origin allowlist policy for a WebSocket upgrade. WS handlers run OUTSIDE the
 * normal middleware pipeline, so the only built-in defense against
 * Cross-Site WebSocket Hijacking (CSWSH) is this option — browsers attach the
 * victim's cookies to cross-origin upgrades, so without an Origin check any
 * external page can open an authenticated socket.
 *
 * - `true` — same-origin only: the `Origin` host must equal the request `Host`.
 * - `string` / `string[]` — exact `Origin` allowlist (compared verbatim).
 * - function — custom predicate (see {@link WebSocketOriginVerifier}).
 *
 * Omitting the option preserves backward compatibility (no enforcement) but
 * emits a one-time dev warning, because the safe default for a browser-facing
 * socket is to restrict origins.
 */
export type WebSocketOriginOption =
  | boolean
  | string
  | string[]
  | WebSocketOriginVerifier

/** Per-handler options forwarded to `WebSocketServer({ noServer: true, ... })`. */
export interface WebSocketHandlerOptions {
  /** Max payload size (bytes) for incoming frames. */
  maxPayload?: number
  /** Enable permessage-deflate. Defaults to false (matches `ws` default). */
  perMessageDeflate?: boolean
  /**
   * Origin allowlist for the upgrade handshake — the built-in CSWSH defense.
   * See {@link WebSocketOriginOption} for semantics and why it matters.
   */
  origin?: WebSocketOriginOption
}

/** Internal: a registered handler entry. */
export interface WsRoute {
  path: string
  handler: WebSocketHandler
  options: WebSocketHandlerOptions
}

/** Bag passed to integrators (advanced). */
export interface WsIntegrator {
  (httpServer: import('node:http').Server): void
}

/** Shape of the per-app registrar exposed to `enableWebSockets`. */
export interface WsRegistrar {
  add(path: string, handler: WebSocketHandler, options?: WebSocketHandlerOptions): void
  attach(httpServer: import('node:http').Server): void
  close(): Promise<void>
}

/** Re-export so consumers can build minimal contexts in tests. */
export type { IncomingMessage }
