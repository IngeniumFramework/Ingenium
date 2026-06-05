import { describe, it, expect } from 'vitest'
import { RedisQueueStore } from '../src/queue.ts'
import { FakeRedisClient } from './fake-client.ts'

/**
 * Drives the store against the in-memory FakeRedisClient (which emulates the
 * queue Lua scripts). Virtual time is controlled via the store's injectable
 * `now` clock — both the store and the fake share it so delayed-job ordering
 * is deterministic without real timers.
 */
function makeStore<T>(now: () => number = () => Date.now()) {
  const client = new FakeRedisClient()
  client.now = now
  const store = new RedisQueueStore<T>({ client, now })
  return { client, store }
}

describe('RedisQueueStore', () => {
  it('enqueue → next → ack roundtrip with attempt = 1', async () => {
    const { store } = makeStore<{ msg: string }>()
    const { id } = await store.enqueue({ msg: 'hello' })
    expect(id).toBe('1')

    const job = await store.next()
    expect(job).not.toBeNull()
    expect(job!.id).toBe('1')
    expect(job!.data).toEqual({ msg: 'hello' })
    expect(job!.attempt).toBe(1)

    await store.ack('1')
    expect(await store.size()).toBe(0)
    expect(await store.next()).toBeNull()
  })

  it('delivers jobs in FIFO order', async () => {
    const { store } = makeStore<number>()
    await store.enqueue(10)
    await store.enqueue(20)
    await store.enqueue(30)

    expect((await store.next())!.data).toBe(10)
    expect((await store.next())!.data).toBe(20)
    expect((await store.next())!.data).toBe(30)
  })

  it('retry increments attempt and respects the delay', async () => {
    let clock = 1_000
    const { store } = makeStore<string>(() => clock)
    await store.enqueue('work')

    const first = await store.next()
    expect(first!.attempt).toBe(1)

    // Retry with a 5s delay: not visible until the clock advances.
    await store.retry(first!.id, 5_000)
    expect(await store.next()).toBeNull()
    expect(await store.size()).toBe(1) // still pending (delayed)

    clock = 5_999
    expect(await store.next()).toBeNull() // delay not elapsed yet

    clock = 6_000
    const second = await store.next()
    expect(second).not.toBeNull()
    expect(second!.id).toBe(first!.id)
    expect(second!.attempt).toBe(2)

    await store.retry(second!.id, 0)
    clock = 6_001
    const third = await store.next()
    expect(third!.attempt).toBe(3)
  })

  it('fail moves the job to the dead-letter list and bumps failedCount', async () => {
    const { store } = makeStore<{ v: number }>()
    await store.enqueue({ v: 1 })
    const job = await store.next()

    expect(await store.failedCount()).toBe(0)
    await store.fail(job!.id)
    expect(await store.failedCount()).toBe(1)

    // No longer pending or deliverable.
    expect(await store.size()).toBe(0)
    expect(await store.next()).toBeNull()
  })

  it('size reflects pending including delayed jobs', async () => {
    let clock = 0
    const { store } = makeStore<number>(() => clock)
    await store.enqueue(1)
    await store.enqueue(2)
    expect(await store.size()).toBe(2)

    const job = await store.next() // one becomes in-flight
    expect(await store.size()).toBe(1)

    await store.retry(job!.id, 10_000) // re-pending but delayed
    expect(await store.size()).toBe(2) // delayed job still counted
  })

  it('next() returns null when empty or all jobs are delayed', async () => {
    let clock = 0
    const { store } = makeStore<number>(() => clock)
    expect(await store.next()).toBeNull() // empty

    await store.enqueue(99)
    const job = await store.next()
    await store.retry(job!.id, 1_000)

    // Only job is delayed → next() null until the clock advances.
    expect(await store.next()).toBeNull()
    clock = 1_000
    expect((await store.next())!.attempt).toBe(2)
  })

  it('ack/retry/fail are no-ops for unknown ids', async () => {
    const { store } = makeStore<number>()
    await expect(store.ack('does-not-exist')).resolves.toBeUndefined()
    await expect(store.retry('nope', 0)).resolves.toBeUndefined()
    await expect(store.fail('nope')).resolves.toBeUndefined()
    expect(await store.failedCount()).toBe(0)
  })

  it('preserves arbitrary JSON payloads across enqueue → next', async () => {
    const { store } = makeStore<unknown>()
    const payload = { a: 1, nested: { b: [1, 2, 3], s: 'x"y' }, n: null }
    await store.enqueue(payload)
    const job = await store.next()
    expect(job!.data).toEqual(payload)
  })

  it('isolates queues by prefix', async () => {
    const client = new FakeRedisClient()
    const a = new RedisQueueStore<number>({ client, prefix: 'q:a:' })
    const b = new RedisQueueStore<number>({ client, prefix: 'q:b:' })
    await a.enqueue(1)
    expect(await a.size()).toBe(1)
    expect(await b.size()).toBe(0)
    expect(await b.next()).toBeNull()
  })
})
