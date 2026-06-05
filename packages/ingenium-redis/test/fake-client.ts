import type { RedisClientLike, RedisSetOptions } from '../src/client.ts'

interface Entry {
  value: string
  /** absolute ms; Infinity = no expiry */
  expiresAt: number
}

/**
 * In-memory stand-in for node-redis used by the test suite. Implements the
 * subset of commands the three stores actually call, including a tiny
 * dispatcher for our rate-limit Lua script that emulates INCR + PEXPIRE +
 * PTTL atomically (atomicity here is free because the fake is single-threaded
 * within the test process).
 *
 * Deliberately NOT exported from the package — keep it test-only so we don't
 * accidentally suggest it as a production fallback.
 */
export class FakeRedisClient implements RedisClientLike {
  private readonly store = new Map<string, Entry>()
  /** Test hook: lets us advance "Redis time" without real timers. */
  now = (): number => Date.now()

  private expired(entry: Entry): boolean {
    return entry.expiresAt !== Infinity && this.now() >= entry.expiresAt
  }

  private read(key: string): Entry | null {
    const entry = this.store.get(key)
    if (!entry) return null
    if (this.expired(entry)) {
      this.store.delete(key)
      return null
    }
    return entry
  }

  get(key: string): Promise<string | null> {
    const entry = this.read(key)
    return Promise.resolve(entry?.value ?? null)
  }

  set(key: string, value: string, options?: RedisSetOptions): Promise<string | null> {
    if (options?.NX && this.read(key) !== null) return Promise.resolve(null)
    let expiresAt = Infinity
    if (options?.EX !== undefined) expiresAt = this.now() + options.EX * 1000
    if (options?.PX !== undefined) expiresAt = this.now() + options.PX
    this.store.set(key, { value, expiresAt })
    return Promise.resolve('OK')
  }

  del(key: string | readonly string[]): Promise<number> {
    const keys = typeof key === 'string' ? [key] : key
    let deleted = 0
    for (const k of keys) if (this.store.delete(k)) deleted += 1
    return Promise.resolve(deleted)
  }

  expire(key: string, seconds: number): Promise<boolean | number> {
    const entry = this.read(key)
    if (!entry) return Promise.resolve(0)
    entry.expiresAt = this.now() + seconds * 1000
    return Promise.resolve(1)
  }

  // --- Queue emulation state -------------------------------------------------
  // The queue Lua scripts operate on Redis ZSET/HASH/SET/LIST/STRING types that
  // the simple key/value `store` above can't represent, so we keep dedicated
  // JS structures keyed by the Redis key name. Single-threaded, so the "atomic"
  // guarantee of EVAL holds for free.
  /** pending: ZSET — key -> Map<member, score>. */
  private readonly zsets = new Map<string, Map<string, number>>()
  /** jobs: HASH — key -> Map<field, value>. */
  private readonly hashes = new Map<string, Map<string, string>>()
  /** inflight: SET — key -> Set<member>. */
  private readonly sets = new Map<string, Set<string>>()
  /** failed: LIST — key -> ordered array. */
  private readonly lists = new Map<string, string[]>()
  /** seq: STRING counters used by INCR (kept separate from `store`). */
  private readonly counters = new Map<string, number>()

  private zset(key: string): Map<string, number> {
    let z = this.zsets.get(key)
    if (!z) this.zsets.set(key, (z = new Map()))
    return z
  }
  private hash(key: string): Map<string, string> {
    let h = this.hashes.get(key)
    if (!h) this.hashes.set(key, (h = new Map()))
    return h
  }
  private getSet(key: string): Set<string> {
    let s = this.sets.get(key)
    if (!s) this.sets.set(key, (s = new Set()))
    return s
  }
  private list(key: string): string[] {
    let l = this.lists.get(key)
    if (!l) this.lists.set(key, (l = []))
    return l
  }

  eval(
    script: string,
    options: { keys: readonly string[]; arguments: readonly string[] },
  ): Promise<unknown> {
    if (script.includes('INGENIUM_RATELIMIT_HIT')) {
      return Promise.resolve(this.runRateLimitHit(options.keys, options.arguments))
    }
    if (script.includes('INGENIUM_QUEUE_')) {
      return Promise.resolve(this.runQueueScript(script, options.keys, options.arguments))
    }
    throw new Error(`FakeRedisClient: unrecognized EVAL script:\n${script}`)
  }

  /**
   * Emulates the RedisQueueStore Lua scripts. KEYS order matches the real
   * scripts: [pending(ZSET), jobs(HASH), inflight(SET), failed(LIST), seq].
   */
  private runQueueScript(
    script: string,
    keys: readonly string[],
    args: readonly string[],
  ): unknown {
    const [pendingK, jobsK, inflightK, failedK, seqK] = keys as [
      string,
      string,
      string,
      string,
      string,
    ]
    const pending = this.zset(pendingK)
    const jobs = this.hash(jobsK)
    const inflight = this.getSet(inflightK)
    const failed = this.list(failedK)

    // Mirrors the Lua model: `jobs` HASH holds field `<id>` = payload JSON and
    // field `<id>:a` = attempt integer (so retry is an HINCRBY, not a parse).
    if (script.includes('INGENIUM_QUEUE_ENQUEUE')) {
      const score = Number(args[0])
      const payload = args[1]!
      const id = String((this.counters.get(seqK) ?? 0) + 1)
      this.counters.set(seqK, Number(id))
      jobs.set(id, payload)
      jobs.set(`${id}:a`, '1')
      pending.set(id, score)
      return id
    }

    if (script.includes('INGENIUM_QUEUE_NEXT')) {
      const now = Number(args[0])
      // Lowest score <= now; tie-break by ascending numeric id (FIFO / INCR order).
      let best: string | null = null
      let bestScore = Infinity
      for (const [id, score] of pending) {
        if (score > now) continue
        if (
          best === null ||
          score < bestScore ||
          (score === bestScore && Number(id) < Number(best))
        ) {
          best = id
          bestScore = score
        }
      }
      if (best === null) return null
      pending.delete(best)
      inflight.add(best)
      return [best, jobs.get(best) ?? null, jobs.get(`${best}:a`) ?? '1']
    }

    if (script.includes('INGENIUM_QUEUE_ACK')) {
      const id = args[0]!
      inflight.delete(id)
      jobs.delete(id)
      jobs.delete(`${id}:a`)
      return 1
    }

    if (script.includes('INGENIUM_QUEUE_RETRY')) {
      const id = args[0]!
      const readyAt = Number(args[1])
      if (!inflight.delete(id)) return 0
      if (!jobs.has(id)) return 0
      const attempt = Number(jobs.get(`${id}:a`) ?? '1')
      jobs.set(`${id}:a`, String(attempt + 1))
      pending.set(id, readyAt)
      return 1
    }

    if (script.includes('INGENIUM_QUEUE_FAILED_COUNT')) {
      return failed.length
    }

    // NB: check FAILED_COUNT above — 'INGENIUM_QUEUE_FAIL' is a substring of it.
    if (script.includes('INGENIUM_QUEUE_FAIL ')) {
      const id = args[0]!
      if (!inflight.delete(id)) return 0
      const payload = jobs.get(id)
      if (payload !== undefined) {
        const attempt = jobs.get(`${id}:a`) ?? '1'
        failed.push(`{"id":"${id}","d":${payload},"a":${attempt}}`)
        jobs.delete(id)
        jobs.delete(`${id}:a`)
      }
      return 1
    }

    if (script.includes('INGENIUM_QUEUE_SIZE')) {
      return pending.size
    }

    throw new Error(`FakeRedisClient: unrecognized QUEUE script:\n${script}`)
  }

  private runRateLimitHit(
    keys: readonly string[],
    args: readonly string[],
  ): [number, number] {
    const key = keys[0]
    const windowMs = Number(args[0])
    if (key === undefined || !Number.isFinite(windowMs)) {
      throw new Error('FakeRedisClient: bad RATELIMIT_HIT invocation')
    }

    const now = this.now()
    let entry = this.store.get(key)
    if (entry && this.expired(entry)) {
      this.store.delete(key)
      entry = undefined
    }

    let count: number
    if (!entry) {
      count = 1
      this.store.set(key, { value: '1', expiresAt: now + windowMs })
    } else {
      count = Number(entry.value) + 1
      entry.value = String(count)
    }

    const refreshed = this.store.get(key)!
    const ttl =
      refreshed.expiresAt === Infinity
        ? -1
        : Math.max(0, refreshed.expiresAt - now)
    return [count, ttl]
  }
}
