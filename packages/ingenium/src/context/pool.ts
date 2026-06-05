import { IngeniumContext } from './context.ts'

/**
 * A bounded free-list of `IngeniumContext` objects. Acquire on each request,
 * release back when the response has been written. If the pool is empty,
 * a fresh context is allocated; if the pool is full on release, the
 * context is discarded (GC handles it). Never blocks.
 */
export class IngeniumContextPool {
  private readonly pool: IngeniumContext[] = []
  private readonly max: number

  constructor(maxSize = 1024) {
    this.max = maxSize
  }

  /** Acquire a context. Caller must call `release()` when done. */
  acquire(): IngeniumContext {
    return this.pool.pop() ?? new IngeniumContext()
  }

  /** Reset and return the context to the free list (or discard if full). */
  release(ctx: IngeniumContext): void {
    // A context whose dispatch timed out is POISONED: the orphaned handler is
    // still running and may write to it (headers/status are not epoch-guarded).
    // Discard it WITHOUT reset/reuse so those late writes land on an object
    // that is never bound to another request, then get GC'd once the orphan
    // finishes. Reusing it would let request A's late writes corrupt request B.
    if (ctx._timedOut) return
    ctx.reset()
    if (this.pool.length < this.max) this.pool.push(ctx)
  }

  /** Current free-list size. Useful for tests and metrics. */
  get size(): number {
    return this.pool.length
  }
}
