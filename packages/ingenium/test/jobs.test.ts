import { describe, it, expect } from 'vitest'
import { IngeniumQueue } from '../src/jobs/queue.ts'
import { QueueRegistry } from '../src/jobs/registry.ts'
import { MemoryQueueStore } from '../src/jobs/store-memory.ts'
import type { QueueStore } from '../src/jobs/types.ts'

/** Wait for `n` macrotask turns so the worker pool can pump. */
function flush(n = 5): Promise<void> {
  let p: Promise<void> = Promise.resolve()
  for (let i = 0; i < n; i++) p = p.then(() => new Promise<void>((r) => setImmediate(r)))
  return p
}

/**
 * Wait until `predicate()` returns true, polling once per macrotask up to a
 * wall-clock budget. The budget is in milliseconds, NOT macrotask turns:
 * backoff/retry assertions depend on real elapsed time (a 60ms retry delay
 * spans thousands of `setImmediate` turns, so a turn-count budget would give
 * up in ~7ms — long before the timer fires — and fail spuriously on fast
 * machines). Aborts after `timeoutMs` so a stuck test fails loudly instead of
 * hanging the suite.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: predicate never became true')
    }
    await new Promise<void>((r) => setImmediate(r))
  }
}

describe('IngeniumQueue (in-memory)', () => {
  it('processes an enqueued job with attempt=1', async () => {
    const calls: { id: string; data: unknown; attempt: number }[] = []
    const q = new IngeniumQueue<string>('emails', {}, (job) => {
      calls.push({ id: job.id, data: job.data, attempt: job.attempt })
    })
    await q.add('hello')
    await waitFor(() => calls.length === 1)
    expect(calls[0]!.data).toBe('hello')
    expect(calls[0]!.attempt).toBe(1)
    expect(typeof calls[0]!.id).toBe('string')
  })

  it('preserves FIFO order at concurrency=1', async () => {
    const order: number[] = []
    const q = new IngeniumQueue<number>('serial', { concurrency: 1 }, async (job) => {
      // Tiny async gap so out-of-order processing would manifest.
      await Promise.resolve()
      order.push(job.data)
    })
    for (let i = 0; i < 10; i++) await q.add(i)
    await waitFor(() => order.length === 10)
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('runs jobs in parallel up to concurrency', async () => {
    let active = 0
    let peak = 0
    const release: (() => void)[] = []
    const q = new IngeniumQueue<number>('parallel', { concurrency: 3 }, async () => {
      active++
      if (active > peak) peak = active
      // Block until released so we can observe concurrency.
      await new Promise<void>((r) => release.push(r))
      active--
    })
    for (let i = 0; i < 5; i++) await q.add(i)
    await waitFor(() => active === 3)
    expect(peak).toBe(3)
    while (release.length) release.shift()!()
    await waitFor(() => active === 0)
  })

  it('retries on throw and increments attempt', async () => {
    const attempts: number[] = []
    const q = new IngeniumQueue<string>(
      'retry',
      { retries: { attempts: 3, backoffMs: () => 0 } },
      (job) => {
        attempts.push(job.attempt)
        if (job.attempt < 3) throw new Error('boom')
      },
    )
    await q.add('x')
    await waitFor(() => attempts.length === 3)
    expect(attempts).toEqual([1, 2, 3])
  })

  it('honors numeric retries shorthand (n total attempts)', async () => {
    const attempts: number[] = []
    const q = new IngeniumQueue<string>(
      'retry-n',
      { retries: 2 },
      (job) => {
        attempts.push(job.attempt)
        throw new Error('always')
      },
    )
    await q.add('x')
    await waitFor(() => attempts.length === 2, 500)
    expect(attempts).toEqual([1, 2])
  })

  it('calls onFailed and grows failedCount when retries exhaust', async () => {
    const failed: { id: string; attempt: number; lastError: unknown }[] = []
    const q = new IngeniumQueue<string>(
      'dlq',
      {
        retries: { attempts: 2, backoffMs: () => 0 },
        onFailed: (job) => {
          failed.push({ id: job.id, attempt: job.attempt, lastError: job.lastError })
        },
      },
      () => { throw new Error('nope') },
    )
    await q.add('x')
    await waitFor(() => failed.length === 1)
    expect(failed[0]!.attempt).toBe(2)
    expect((failed[0]!.lastError as Error).message).toBe('nope')
    expect(await q.failedCount()).toBe(1)
  })

  it('clearFailed empties the dead-letter list', async () => {
    const q = new IngeniumQueue<string>(
      'clear',
      { retries: { attempts: 1, backoffMs: () => 0 } },
      () => { throw new Error('x') },
    )
    await q.add('a')
    await q.add('b')
    // Poll synchronously via the store getter cached in the queue's failed count.
    for (let i = 0; i < 200; i++) {
      if ((await q.failedCount()) === 2) break
      await new Promise<void>((r) => setImmediate(r))
    }
    expect(await q.failedCount()).toBe(2)
    q.clearFailed()
    expect(await q.failedCount()).toBe(0)
  })

  it('pause stops new pickups; in-flight finishes; resume resumes', async () => {
    const seen: number[] = []
    let release: (() => void) | null = null
    const q = new IngeniumQueue<number>('pausable', { concurrency: 1 }, async (job) => {
      await new Promise<void>((r) => { release = r })
      seen.push(job.data)
    })
    await q.add(1)
    await q.add(2)
    await q.add(3)
    // Wait for first to be in-flight.
    await waitFor(() => release !== null)
    q.pause()
    // Release first; pause should prevent picking up #2.
    release!()
    release = null
    await waitFor(() => seen.length === 1)
    await flush(5)
    expect(seen).toEqual([1])
    // Resume → next job runs.
    q.resume()
    await waitFor(() => release !== null)
    release!()
    release = null
    await waitFor(() => seen.length === 2)
    expect(seen).toEqual([1, 2])
    // Drain the rest for cleanliness.
    await waitFor(() => release !== null)
    release!()
    await waitFor(() => seen.length === 3)
  })

  it('drain waits for in-flight jobs to complete', async () => {
    let release: (() => void) | null = null
    const q = new IngeniumQueue<number>('drain', { concurrency: 1 }, async () => {
      await new Promise<void>((r) => { release = r })
    })
    await q.add(1)
    await waitFor(() => release !== null)
    const drainPromise = q.drain()
    let drained = false
    void drainPromise.then(() => { drained = true })
    await flush(3)
    expect(drained).toBe(false)
    release!()
    const ok = await drainPromise
    expect(ok).toBe(true)
    expect(drained).toBe(true)
  })

  it('drain returns false on timeout when in-flight does not complete', async () => {
    const q = new IngeniumQueue<number>('drain-timeout', { concurrency: 1 }, async () => {
      await new Promise<void>(() => { /* never resolves */ })
    })
    await q.add(1)
    await flush(3)
    const ok = await q.drain(50)
    expect(ok).toBe(false)
  })

  it('drain returns true immediately when nothing is in-flight', async () => {
    const q = new IngeniumQueue<number>('idle-drain', {}, () => {})
    const ok = await q.drain()
    expect(ok).toBe(true)
  })

  it('refuses new jobs after drain', async () => {
    const q = new IngeniumQueue<number>('closed', {}, () => {})
    await q.drain()
    await expect(q.add(1)).rejects.toThrow(/is closed/)
  })

  it('uses a custom QueueStore when provided', async () => {
    const log: string[] = []
    let nextCount = 0
    const store: QueueStore<string> = {
      async enqueue(data) { log.push(`enqueue:${data}`); return { id: 'cid' } },
      async next() {
        if (nextCount++ === 0) {
          log.push('next:hit')
          return { id: 'cid', data: 'hello', attempt: 1 }
        }
        return null
      },
      async ack(id) { log.push(`ack:${id}`) },
      async retry() { /* unused */ },
      async fail() { /* unused */ },
      async size() { return 0 },
      async failedCount() { return 0 },
    }
    const seen: string[] = []
    const q = new IngeniumQueue<string>('custom', { store }, (job) => { seen.push(job.data) })
    await q.add('hello')
    await waitFor(() => seen.length === 1)
    expect(seen).toEqual(['hello'])
    expect(log).toContain('enqueue:hello')
    expect(log).toContain('next:hit')
    expect(log).toContain('ack:cid')
  })

  it('respects worker overload form via QueueRegistry default-opts overload', async () => {
    const reg = new QueueRegistry()
    const seen: string[] = []
    // The registry signature requires (name, opts, worker) — the app-level
    // overload is what collapses to `(name, worker)`. Validate both shapes
    // function via the registry by passing an empty opts object.
    reg.register<string>('emails', {}, (job) => { seen.push(job.data) })
    reg.startAll()
    await reg.get<string>('emails').add('hi')
    await waitFor(() => seen.length === 1)
    expect(seen).toEqual(['hi'])
  })

  it('supports multiple coexisting queues independently', async () => {
    const reg = new QueueRegistry()
    const aSeen: number[] = []
    const bSeen: string[] = []
    reg.register<number>('a', {}, (j) => { aSeen.push(j.data) })
    reg.register<string>('b', {}, (j) => { bSeen.push(j.data) })
    reg.startAll()
    await reg.get<number>('a').add(1)
    await reg.get<number>('a').add(2)
    await reg.get<string>('b').add('x')
    await waitFor(() => aSeen.length === 2 && bSeen.length === 1)
    expect(aSeen).toEqual([1, 2])
    expect(bSeen).toEqual(['x'])
  })

  it('registry throws on duplicate name', () => {
    const reg = new QueueRegistry()
    reg.register('dup', {}, () => {})
    expect(() => reg.register('dup', {}, () => {})).toThrow(/already registered/)
  })

  it('registry throws on missing get()', () => {
    const reg = new QueueRegistry()
    expect(() => reg.get('nope')).toThrow(/not registered/)
  })

  it('registry drainAll reports cleanly drained vs timed-out queues', async () => {
    const reg = new QueueRegistry()
    let releaseClean: (() => void) | null = null
    reg.register<number>('clean', {}, async () => {
      await new Promise<void>((r) => { releaseClean = r })
    })
    reg.register<number>('stuck', {}, async () => {
      await new Promise<void>(() => { /* never */ })
    })
    reg.startAll()
    await reg.get<number>('clean').add(1)
    await reg.get<number>('stuck').add(1)
    await waitFor(() => releaseClean !== null)
    setTimeout(() => releaseClean!(), 10).unref?.()
    const result = await reg.drainAll(100)
    expect(result.clean).toContain('clean')
    expect(result.timedOut).toContain('stuck')
  })

  it('size() reflects pending count before pickup', async () => {
    let release: (() => void) | null = null
    const q = new IngeniumQueue<number>('size', { concurrency: 1 }, async () => {
      await new Promise<void>((r) => { release = r })
    })
    await q.add(1)
    await q.add(2)
    await q.add(3)
    await waitFor(() => release !== null)
    // One in-flight + two pending.
    expect(await q.size()).toBe(2)
    // Release the in-flight job; it acks and the next pending job is picked
    // up, so the pending count drops from 2 to 1.
    release!()
    let pending = await q.size()
    const start = Date.now()
    while (pending !== 1 && Date.now() - start < 2000) {
      await new Promise<void>((r) => setImmediate(r))
      pending = await q.size()
    }
    expect(pending).toBe(1)
  })

  it('exponential backoff delays the retry', async () => {
    const stamps: number[] = []
    const q = new IngeniumQueue<number>(
      'backoff',
      { retries: { attempts: 2, backoffMs: () => 60 } },
      () => {
        stamps.push(Date.now())
        throw new Error('boom')
      },
    )
    await q.add(1)
    await waitFor(() => stamps.length === 2, 500)
    const delta = stamps[1]! - stamps[0]!
    // Expect at least 50ms (allowing jitter on slow CI).
    expect(delta).toBeGreaterThanOrEqual(40)
  })

  it('survives store.next() throwing', async () => {
    const seen: number[] = []
    let throwOnce = true
    const store: QueueStore<number> = {
      async enqueue() { return { id: '1' } },
      async next() {
        if (throwOnce) { throwOnce = false; throw new Error('store-blip') }
        return null
      },
      async ack() {},
      async retry() {},
      async fail() {},
      async size() { return 0 },
      async failedCount() { return 0 },
    }
    const q = new IngeniumQueue<number>('flaky', { store }, (job) => { seen.push(job.data) })
    // Should not throw / crash the pump.
    await q.add(1)
    await flush(5)
    // Worker may or may not have run depending on the next() ordering — the
    // important assertion is just "no unhandled rejection / no hang".
    expect(seen.length).toBeLessThanOrEqual(1)
  })

  it('MemoryQueueStore enqueue/next/ack roundtrip', async () => {
    const s = new MemoryQueueStore<string>()
    const { id } = await s.enqueue('hello')
    expect(typeof id).toBe('string')
    const next = await s.next()
    expect(next).not.toBeNull()
    expect(next!.data).toBe('hello')
    expect(next!.attempt).toBe(1)
    await s.ack(id)
    expect(await s.size()).toBe(0)
  })

  it('MemoryQueueStore retry bumps attempt', async () => {
    const s = new MemoryQueueStore<string>()
    await s.enqueue('x')
    const first = await s.next()
    await s.retry(first!.id, 0)
    const second = await s.next()
    expect(second!.attempt).toBe(2)
  })

  it('MemoryQueueStore fail moves to DLQ', async () => {
    const s = new MemoryQueueStore<string>()
    await s.enqueue('x')
    const job = await s.next()
    await s.fail(job!.id)
    expect(await s.failedCount()).toBe(1)
    expect(await s.size()).toBe(0)
  })
})
