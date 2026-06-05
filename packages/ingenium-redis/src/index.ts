/**
 * Redis-backed stores for Ingenium. Drop-in replacements for the in-memory
 * defaults shipped in the core package — required for multi-instance
 * deployments where sessions, idempotency replays, rate-limit counters, and
 * background-job queues must share state across replicas.
 *
 * Bring your own connected client (node-redis v4+ recommended). The package
 * intentionally does not own connection lifecycle.
 *
 * @example
 * ```ts
 * import { createClient } from 'redis'
 * import { ingenium, sessionMiddleware, IdempotencyMemoryStore } from 'ingenium'
 * import {
 *   RedisSessionStore,
 *   RedisIdempotencyStore,
 *   RedisRateLimitStore,
 *   RedisQueueStore,
 * } from 'ingenium-redis'
 *
 * const client = createClient({ url: process.env.REDIS_URL })
 * await client.connect()
 *
 * const app = ingenium()
 * app.use(sessionMiddleware({
 *   secret: [process.env.SESSION_SECRET!],
 *   store: new RedisSessionStore({ client }),
 * }))
 * app.use(ingenium.idempotency({ store: new RedisIdempotencyStore({ client }) }))
 * app.use(ingenium.rateLimit({
 *   windowMs: 60_000,
 *   limit: 100,
 *   store: new RedisRateLimitStore({ client }),
 * }))
 *
 * // Background jobs shared across replicas:
 * app.queue('emails', {
 *   store: new RedisQueueStore({ client }),
 * }, async (job) => { await sendEmail(job.data) })
 * ```
 */

export { RedisSessionStore, type RedisSessionStoreOptions } from './session.ts'
export {
  RedisIdempotencyStore,
  type RedisIdempotencyStoreOptions,
} from './idempotency.ts'
export {
  RedisRateLimitStore,
  type RedisRateLimitStoreOptions,
} from './rate-limit.ts'
export { RedisQueueStore, type RedisQueueStoreOptions } from './queue.ts'
export type { RedisClientLike, RedisSetOptions } from './client.ts'
