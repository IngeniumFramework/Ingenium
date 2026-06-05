import { MemoryQueueStore } from './store-memory.ts'
import type {
  FailedJob,
  QueueOptions,
  QueueStore,
  QueueWorker,
  RetryPolicy,
} from './types.ts'

/** Default exponential backoff: 100ms, 400ms, 1.6s, 6.4s, ... (4^(n-1) * 100). */
const DEFAULT_RETRIES: RetryPolicy = {
  attempts: 3,
  backoffMs: (attempt: number) => 100 * Math.pow(4, attempt - 1),
}

function normalizeRetries(retries: number | RetryPolicy | undefined): RetryPolicy {
  if (retries === undefined) return DEFAULT_RETRIES
  if (typeof retries === 'number') {
    return { attempts: Math.max(1, retries), backoffMs: DEFAULT_RETRIES.backoffMs }
  }
  return retries
}

/**
 * A single named background queue. Wraps a {@link QueueStore} with a worker
 * pool, retry/backoff logic, pause/resume controls, and a `drain()` for
 * graceful shutdown.
 *
 * The pool is event-driven: when a slot frees up, the queue immediately
 * tries to pull another job; if none is ready (empty or all delayed), the
 * pool sleeps until either:
 *   - a new `add()` call wakes it, or
 *   - the earliest delayed job's `notBefore` elapses (timer-based wake).
 *
 * All timers are `unref()`'d so the queue alone never keeps the event loop alive.
 */
export class IngeniumQueue<TData = unknown> {
  readonly name: string
  private readonly store: QueueStore<TData>
  private readonly worker: QueueWorker<TData>
  private readonly retries: RetryPolicy
  private readonly concurrency: number
  private readonly onFailed: ((job: FailedJob<TData>) => void | Promise<void>) | undefined

  /** Active worker slot count. When `< concurrency`, pull more work. */
  private active = 0
  /** Whether `pause()` has been called and `resume()` not yet. */
  private paused = false
  /** Whether `drain()`/close has been called. No new jobs accepted. */
  private closed = false
  /** Timer for waking the pool when a delayed retry becomes due. */
  private wakeTimer: NodeJS.Timeout | null = null
  /** Resolvers waiting for `active` to hit 0 (used by `drain()`). */
  private idleWaiters: (() => void)[] = []
  /** Set when the pool is started — protects against double-start. */
  private started = false

  constructor(name: string, opts: QueueOptions<TData>, worker: QueueWorker<TData>) {
    this.name = name
    this.store = opts.store ?? new MemoryQueueStore<TData>()
    this.worker = worker
    this.retries = normalizeRetries(opts.retries)
    this.concurrency = Math.max(1, opts.concurrency ?? 1)
    this.onFailed = opts.onFailed
  }

  /**
   * Start the worker pool. Idempotent — safe to call multiple times. The
   * pool is also implicitly started by the first `add()` call so direct
   * invocation is optional.
   */
  start(): void {
    if (this.started) return
    this.started = true
    this.pump()
  }

  /** Enqueue a job. Returns the assigned id. */
  async add(data: TData): Promise<{ id: string }> {
    if (this.closed) {
      throw new Error(`ingenium: queue "${this.name}" is closed (no new jobs accepted)`)
    }
    const handle = await this.store.enqueue(data)
    // Lazy-start: first add() triggers worker pool boot if `start()` wasn't called.
    if (!this.started) this.start()
    else this.pump()
    return handle
  }

  /** Approximate number of pending jobs. */
  size(): Promise<number> {
    return this.store.size()
  }

  /** Number of jobs in the dead-letter list. */
  failedCount(): Promise<number> {
    return this.store.failedCount()
  }

  /**
   * Empty the dead-letter list. Only effective when the underlying store
   * is the default {@link MemoryQueueStore}; custom stores should provide
   * their own clearing surface.
   */
  clearFailed(): void {
    if (this.store instanceof MemoryQueueStore) this.store.clearFailed()
  }

  /**
   * Stop pulling new jobs from the store. In-flight jobs continue to run
   * until they complete. Idempotent.
   */
  pause(): void {
    this.paused = true
  }

  /** Resume pulling jobs. Wakes the pool. */
  resume(): void {
    if (!this.paused) return
    this.paused = false
    this.pump()
  }

  /**
   * Wait for all in-flight jobs to complete, then stop accepting new ones.
   * If `timeoutMs` elapses first, resolve anyway — the orphaned jobs keep
   * running until they naturally finish (JS can't cancel a Promise), but
   * the framework stops waiting.
   *
   * Returns `true` if the queue drained cleanly; `false` on timeout.
   */
  async drain(timeoutMs?: number): Promise<boolean> {
    this.closed = true
    this.paused = true // stop pulling new work even if currently active
    if (this.active === 0) {
      this.clearWakeTimer()
      return true
    }
    return new Promise<boolean>((resolve) => {
      let settled = false
      const onIdle = (): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        this.clearWakeTimer()
        resolve(true)
      }
      this.idleWaiters.push(onIdle)
      const timer = timeoutMs !== undefined
        ? setTimeout(() => {
            if (settled) return
            settled = true
            // Drop our waiter so the pool doesn't re-resolve us.
            const idx = this.idleWaiters.indexOf(onIdle)
            if (idx >= 0) this.idleWaiters.splice(idx, 1)
            this.clearWakeTimer()
            resolve(false)
          }, timeoutMs)
        : null
      timer?.unref?.()
    })
  }

  /**
   * Pump the pool: while we have free slots and we're not paused, pull jobs
   * and dispatch them. No-op when paused / saturated. Re-entrant: every
   * job completion calls `pump()` again to fill the slot.
   */
  private pump(): void {
    if (this.paused) {
      this.checkIdle()
      return
    }
    while (this.active < this.concurrency) {
      // Synchronously check store state via a microtask. The store API is
      // async (so a Redis adapter works), so each pull is a Promise we don't
      // await inline — we just kick it off and let `runOne` increment/decrement
      // `active` around the actual worker invocation.
      const slotOpen = this.tryFillSlot()
      if (!slotOpen) break
    }
    this.checkIdle()
  }

  /**
   * Attempts to take one job from the store and run it. Returns `false` if
   * the store is empty (or all-delayed) so the caller stops looping.
   *
   * NOTE: we increment `active` BEFORE the async `next()` resolves so a
   * burst of synchronous `pump()` calls doesn't over-subscribe the pool.
   * We decrement on the `null` path.
   */
  private tryFillSlot(): boolean {
    this.active++
    void this.runOne().catch(() => {
      // runOne handles all errors internally; this catch is a defensive
      // backstop so an unexpected bug doesn't unhandle a rejection.
    })
    return true
  }

  private async runOne(): Promise<void> {
    let job: { id: string; data: TData; attempt: number } | null = null
    try {
      job = await this.store.next()
    } catch {
      // Store failure pulling the next job — release slot and back off.
      this.active--
      this.checkIdle()
      return
    }
    if (job === null) {
      // Empty (or all delayed). Release the speculative slot, schedule a
      // wake for the earliest delayed job (if any), and stop pulling.
      this.active--
      this.scheduleDelayedWake()
      this.checkIdle()
      return
    }

    let lastError: unknown = undefined
    try {
      await this.worker({ id: job.id, data: job.data, attempt: job.attempt })
      await this.store.ack(job.id)
    } catch (err) {
      lastError = err
      const attempt = job.attempt
      if (attempt < this.retries.attempts) {
        const delay = Math.max(0, this.retries.backoffMs(attempt))
        try {
          await this.store.retry(job.id, delay)
        } catch {
          // If retry bookkeeping fails, fall back to fail() so the job
          // doesn't get stuck in-flight forever.
          await this.safeFail(job, lastError)
        }
      } else {
        await this.safeFail(job, lastError)
      }
    } finally {
      this.active--
      // Refill the freed slot on the next macrotask, not synchronously. A
      // synchronous refill would chain pickup of the *next* job into the same
      // microtask run as this job's completion, so the pool would never be
      // observably idle between jobs (active would dip and immediately rise
      // within one turn). Deferring to setImmediate yields a macrotask
      // boundary where `active` reflects only genuinely-running jobs.
      const t = setImmediate(() => this.pump())
      t.unref?.()
    }
  }

  private async safeFail(
    job: { id: string; data: TData; attempt: number },
    lastError: unknown,
  ): Promise<void> {
    try {
      await this.store.fail(job.id)
    } catch {
      // If even fail() throws, we've done what we can — the job stays
      // in-flight in the store, which is at-least-once-correct.
      return
    }
    if (this.onFailed) {
      try {
        await this.onFailed({ id: job.id, data: job.data, attempt: job.attempt, lastError })
      } catch {
        // onFailed errors are observation-only; swallow.
      }
    }
  }

  /**
   * If the store has only delayed entries (e.g. just-retried jobs whose
   * backoff hasn't elapsed), schedule a one-shot wake when the earliest
   * delay fires so we don't spin or sleep forever.
   *
   * Only the default in-memory store exposes `earliestPendingAt`; for
   * custom stores we don't poll — we rely on the next `add()` to wake us.
   */
  private scheduleDelayedWake(): void {
    if (!(this.store instanceof MemoryQueueStore)) return
    const earliest = this.store.earliestPendingAt()
    if (earliest === null) return
    const delay = Math.max(1, earliest - Date.now())
    this.clearWakeTimer()
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null
      this.pump()
    }, delay)
    this.wakeTimer.unref?.()
  }

  private clearWakeTimer(): void {
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer)
      this.wakeTimer = null
    }
  }

  private checkIdle(): void {
    if (this.active !== 0 || this.idleWaiters.length === 0) return
    const waiters = this.idleWaiters.splice(0, this.idleWaiters.length)
    for (const w of waiters) w()
  }
}
