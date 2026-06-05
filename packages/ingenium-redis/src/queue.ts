import type { QueueStore } from 'ingenium'
import type { RedisClientLike } from './client.ts'

/**
 * Lua scripts backing {@link RedisQueueStore}. Every multi-step operation runs
 * server-side in a single `EVAL` so the steps are atomic against concurrent
 * workers on other replicas — Redis executes a script to completion before
 * servicing any other command, so there is no window where (e.g.) two workers
 * both ZREM the same id, or where a job is removed from `pending` but not yet
 * recorded in-flight.
 *
 * The marker comment on line 1 of each script is load-bearing for the
 * in-memory fake used by the test suite — see test/fake-client.ts, which
 * dispatches on it. Real Redis ignores the comment.
 *
 * Key layout (KEYS, in the order every script receives them):
 *   1. pending  — ZSET, score = ready-time ms (notBefore), member = id.
 *                 Picking the lowest score <= now gives FIFO with delay support.
 *   2. jobs     — HASH. Two fields per job: `<id>` holds the raw JSON payload,
 *                 `<id>:a` holds the attempt count as a plain integer. Splitting
 *                 the count into its own field lets `retry` use `HINCRBY` —
 *                 no parsing of the (arbitrary, possibly `}`-containing) payload
 *                 JSON inside Lua, which a single-regex envelope can't do safely.
 *   3. inflight — SET of ids currently delivered but not yet acked/retried/failed.
 *   4. failed   — LIST (dead-letter); RPUSH on fail, LLEN for the count.
 *   5. seq      — STRING counter; INCR yields monotonic ids.
 *
 * The `:a` field suffix is an ARGV (not hard-coded in the script) only for the
 * fake's benefit; in real Lua it's concatenated. Both store + fake build it the
 * same way: `id .. ':a'`.
 */

/**
 * Append a job to the tail. `now` (ARGV[1]) is the score so a freshly enqueued
 * job is immediately ready and ordered after everything already pending —
 * equal scores tie-break by member, and ids are monotonic via INCR, so equal
 * scores still resolve to enqueue order. attempt starts at 1, mirroring
 * MemoryQueueStore.
 */
const ENQUEUE_SCRIPT = `-- INGENIUM_QUEUE_ENQUEUE v1
local id = tostring(redis.call('INCR', KEYS[5]))
redis.call('HSET', KEYS[2], id, ARGV[2])
redis.call('HSET', KEYS[2], id .. ':a', '1')
redis.call('ZADD', KEYS[1], ARGV[1], id)
return id`

/**
 * Atomically pop the next ready job. ZRANGEBYSCORE with `-inf`..now and
 * `LIMIT 0 1` yields the lowest-score member whose delay has elapsed; if none
 * is ready (queue empty, or every pending job is still delayed) we return nil
 * — matching MemoryQueueStore returning `null`. The chosen id is ZREM'd from
 * pending and SADD'd to inflight in the same script so it can never be picked
 * twice. Returns `{id, payloadJson, attempt}`.
 */
const NEXT_SCRIPT = `-- INGENIUM_QUEUE_NEXT v1
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, 1)
if not ids[1] then
  return nil
end
local id = ids[1]
redis.call('ZREM', KEYS[1], id)
redis.call('SADD', KEYS[3], id)
local payload = redis.call('HGET', KEYS[2], id)
local attempt = redis.call('HGET', KEYS[2], id .. ':a')
return {id, payload, attempt}`

/**
 * Remove a completed in-flight job entirely. SREM + HDEL (both the payload and
 * the attempt field) clears all trace; a no-op if the id is unknown (already
 * acked), so ack is idempotent.
 */
const ACK_SCRIPT = `-- INGENIUM_QUEUE_ACK v1
redis.call('SREM', KEYS[3], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1], ARGV[1] .. ':a')
return 1`

/**
 * Re-enqueue an in-flight job after a delay, incrementing its attempt counter
 * (the MUST-increment contract from QueueStore). `HINCRBY` on the `<id>:a`
 * field is atomic and needs no payload parsing. ZADD back into pending at score
 * `readyAt` (ARGV[2] = now + delayMs). If the id is not in-flight we do nothing
 * — a job already acked/failed can't be retried.
 */
const RETRY_SCRIPT = `-- INGENIUM_QUEUE_RETRY v1
if redis.call('SREM', KEYS[3], ARGV[1]) == 0 then
  return 0
end
if redis.call('HEXISTS', KEYS[2], ARGV[1]) == 0 then
  return 0
end
redis.call('HINCRBY', KEYS[2], ARGV[1] .. ':a', 1)
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
return 1`

/**
 * Move an in-flight job to the dead-letter list. We RPUSH a self-contained
 * envelope `{"d":<payload>,"a":<attempt>}` onto `failed` (built by concatenating
 * the raw payload JSON and the integer attempt — no re-encode of the payload),
 * then drop the in-flight marker and both hash fields. No-op if the id is not
 * in-flight, so fail is idempotent.
 */
const FAIL_SCRIPT = `-- INGENIUM_QUEUE_FAIL v1
if redis.call('SREM', KEYS[3], ARGV[1]) == 0 then
  return 0
end
local payload = redis.call('HGET', KEYS[2], ARGV[1])
if payload then
  local attempt = redis.call('HGET', KEYS[2], ARGV[1] .. ':a') or '1'
  local envelope = '{"id":"' .. ARGV[1] .. '","d":' .. payload .. ',"a":' .. attempt .. '}'
  redis.call('RPUSH', KEYS[4], envelope)
  redis.call('HDEL', KEYS[2], ARGV[1], ARGV[1] .. ':a')
end
return 1`

/** `size()` = ZCARD pending (includes delayed jobs). */
const SIZE_SCRIPT = `-- INGENIUM_QUEUE_SIZE v1
return redis.call('ZCARD', KEYS[1])`

/** `failedCount()` = LLEN of the dead-letter list. */
const FAILED_COUNT_SCRIPT = `-- INGENIUM_QUEUE_FAILED_COUNT v1
return redis.call('LLEN', KEYS[4])`

export interface RedisQueueStoreOptions {
  /** Connected Redis client. Caller owns lifecycle. */
  client: RedisClientLike
  /**
   * Key prefix for every structure owned by this queue instance. Default
   * `'ingenium:queue:'`. Two queues that must not share work need distinct
   * prefixes (e.g. `'ingenium:queue:emails:'`).
   */
  prefix?: string
  /**
   * Clock used to stamp ready-times (ZSET scores). Defaults to `Date.now`.
   * Overridable so tests can drive virtual time; production code never sets it.
   */
  now?: () => number
}

/**
 * Redis-backed {@link QueueStore}. A FIFO job queue with delayed retries and a
 * dead-letter list, sharing state across replicas so any worker on any pod can
 * pick up any job.
 *
 * Atomicity: every operation that touches more than one key (`next`, `retry`,
 * `fail`, and—for uniformity and to keep {@link RedisClientLike} tiny—`enqueue`,
 * `ack`, `size`, `failedCount`) runs as a single Lua `EVAL`. This is what keeps
 * the client surface unchanged: we never need MULTI/WATCH or any command beyond
 * `eval`. Redis runs each script to completion atomically, so concurrent workers
 * can't double-deliver a job or lose a payload between the ZREM and the
 * in-flight SADD.
 *
 * Delivery guarantee: at-least-once. A job that is `next()`-ed but whose worker
 * crashes before `ack`/`retry`/`fail` stays in the `inflight` set and in the
 * `jobs` hash, but NOT in `pending` — it will not be re-delivered automatically
 * by this store (there is no visibility-timeout sweeper). That matches
 * {@link MemoryQueueStore}, which also leaves crashed jobs stuck in its
 * in-flight map. Add a reaper that re-enqueues stale inflight ids if you need
 * crash recovery; the data model (inflight SET + jobs HASH) supports it.
 *
 * `size()` returns the pending count INCLUDING delayed (not-yet-ready) jobs,
 * mirroring `MemoryQueueStore.size()` which returns `pending.length`. Delayed
 * jobs live in the same ZSET with a future score, so `ZCARD` counts them.
 */
export class RedisQueueStore<TData> implements QueueStore<TData> {
  private readonly client: RedisClientLike
  private readonly now: () => number
  /** KEYS passed to every script, in fixed order: pending, jobs, inflight, failed, seq. */
  private readonly keys: readonly [string, string, string, string, string]

  constructor(opts: RedisQueueStoreOptions) {
    this.client = opts.client
    this.now = opts.now ?? Date.now
    const prefix = opts.prefix ?? 'ingenium:queue:'
    this.keys = [
      prefix + 'pending',
      prefix + 'jobs',
      prefix + 'inflight',
      prefix + 'failed',
      prefix + 'seq',
    ]
  }

  async enqueue(data: TData): Promise<{ id: string }> {
    const id = (await this.client.eval(ENQUEUE_SCRIPT, {
      keys: this.keys,
      arguments: [String(this.now()), JSON.stringify(data)],
    })) as string
    return { id: String(id) }
  }

  async next(): Promise<{ id: string; data: TData; attempt: number } | null> {
    const result = (await this.client.eval(NEXT_SCRIPT, {
      keys: this.keys,
      arguments: [String(this.now())],
    })) as [string, string | null, string | null] | null

    if (result == null || !Array.isArray(result)) return null
    const [id, payload, attempt] = result
    if (id == null || payload == null) return null
    let data: TData
    try {
      data = JSON.parse(payload) as TData
    } catch {
      return null
    }
    return { id: String(id), data, attempt: Number(attempt) || 1 }
  }

  async ack(id: string): Promise<void> {
    await this.client.eval(ACK_SCRIPT, { keys: this.keys, arguments: [id] })
  }

  async retry(id: string, delayMs: number): Promise<void> {
    const readyAt = this.now() + Math.max(0, delayMs)
    await this.client.eval(RETRY_SCRIPT, {
      keys: this.keys,
      arguments: [id, String(readyAt)],
    })
  }

  async fail(id: string): Promise<void> {
    await this.client.eval(FAIL_SCRIPT, { keys: this.keys, arguments: [id] })
  }

  async size(): Promise<number> {
    const n = (await this.client.eval(SIZE_SCRIPT, {
      keys: this.keys,
      arguments: [],
    })) as number
    return Number(n) || 0
  }

  async failedCount(): Promise<number> {
    const n = (await this.client.eval(FAILED_COUNT_SCRIPT, {
      keys: this.keys,
      arguments: [],
    })) as number
    return Number(n) || 0
  }
}
