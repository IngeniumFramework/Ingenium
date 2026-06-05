import type { IngeniumContext } from '../context/context.ts'
import type { IngeniumMiddleware } from '../middleware/types.ts'
import { MemoryStore } from './store.ts'
import type { RateLimitOptions } from './types.ts'

/**
 * Default key generator — buckets by client IP.
 *
 * WHY `ctx.ip` and not the raw `x-forwarded-for` / `x-real-ip` headers:
 * those headers are entirely client-controlled. A client can forge an
 * arbitrary `X-Forwarded-For` to (a) evade the limit by rotating a fake
 * first hop on every request, or (b) frame a victim by pinning their real
 * IP into the throttle bucket. `ctx.ip` respects the app's configured trust
 * boundary — it only walks the XFF chain when `trustProxy` is set (i.e. when
 * the operator has asserted an upstream proxy it controls), and otherwise
 * returns the immediate socket peer. Trusting the header directly would make
 * the limiter trivially bypassable on any internet-facing deployment.
 */
function defaultKeyGenerator(ctx: IngeniumContext): string {
  const ip = ctx.ip
  return ip && ip.length > 0 ? ip : 'unknown'
}

/**
 * Fixed-window rate-limiting middleware. Each key is allowed at most `max`
 * requests per `windowMs`. Over-limit requests get a `429 Too Many
 * Requests` response with `Retry-After` and a JSON body.
 *
 * Every passing response carries `X-RateLimit-Limit`,
 * `X-RateLimit-Remaining`, and `X-RateLimit-Reset` (unix seconds).
 *
 * @example
 *   app.use(rateLimit({ max: 100, windowMs: 60_000 }))
 *   app.use('/auth', rateLimit({ max: 5, windowMs: 60_000 }))
 */
export function rateLimit(opts: RateLimitOptions = {}): IngeniumMiddleware {
  const windowMs = opts.windowMs ?? 60_000
  const max = opts.max ?? 100
  const keyGenerator = opts.keyGenerator ?? defaultKeyGenerator
  const skip = opts.skip
  const store = opts.store ?? new MemoryStore()

  if (windowMs <= 0) throw new Error('rateLimit: windowMs must be > 0')
  if (max <= 0) throw new Error('rateLimit: max must be > 0')

  return async (ctx, next) => {
    if (skip && skip(ctx)) {
      return next()
    }

    const key = keyGenerator(ctx)
    const { count, resetAt } = await store.hit(key, windowMs)

    const remaining = Math.max(0, max - count)
    const resetSeconds = Math.ceil(resetAt / 1000)

    ctx.set('x-ratelimit-limit', String(max))
    ctx.set('x-ratelimit-remaining', String(remaining))
    ctx.set('x-ratelimit-reset', String(resetSeconds))

    if (count > max) {
      const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))
      ctx.set('retry-after', String(retryAfter))
      ctx.json(
        {
          error: 'Too Many Requests',
          code: 'RATE_LIMITED',
          retryAfter,
        },
        429,
      )
      return
    }

    return next()
  }
}
