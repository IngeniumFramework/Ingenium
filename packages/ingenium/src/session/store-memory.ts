import type { SessionStore } from './types.ts'

interface Entry {
  data: Record<string, unknown>
  expiresAt: number
}

/** Default cap on the number of distinct sessions held in the in-memory store. */
const DEFAULT_MAX_ENTRIES = 100_000

/**
 * In-process session store backed by a `Map`. Suitable for development and
 * single-instance deployments. NOT shared across workers/replicas.
 *
 * Expired entries are evicted lazily on access AND periodically by a
 * background sweep. The sweep timer is `unref()`'d so it never keeps the
 * Node process alive on its own.
 *
 * The `Map` is bounded by `maxEntries` (default 100k): when full, the
 * least-recently-used entry is evicted before inserting a new one. This is a
 * hard ceiling on memory under adversarial conditions (e.g. a flood that
 * creates sessions) — eviction means the evicted user is logged out, a real
 * trade-off, but better than OOM. We rely on `Map` insertion order plus
 * delete-then-set on every access to keep the first iterated key as the genuine
 * LRU. For high-cardinality production, use a Redis/Postgres-backed store.
 */
export class MemoryStore implements SessionStore {
  private readonly map = new Map<string, Entry>()
  private readonly sweep: NodeJS.Timeout | null
  private readonly maxEntries: number

  /**
   * @param sweepIntervalMs How often to scan the map for expired entries.
   * Defaults to 60s. Pass `0` to disable the timer entirely (tests).
   * @param maxEntries Hard cap on retained sessions; LRU-evicted when exceeded.
   * Defaults to 100,000.
   */
  constructor(sweepIntervalMs = 60_000, maxEntries = DEFAULT_MAX_ENTRIES) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError(
        `MemoryStore: maxEntries must be a positive integer, got ${String(maxEntries)}`,
      )
    }
    this.maxEntries = maxEntries
    if (sweepIntervalMs > 0) {
      this.sweep = setInterval(() => this.purge(), sweepIntervalMs)
      // Don't keep the event loop alive just for the sweep.
      this.sweep.unref?.()
    } else {
      this.sweep = null
    }
  }

  async get(id: string): Promise<Record<string, unknown> | null> {
    const entry = this.map.get(id)
    if (!entry) return null
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(id)
      return null
    }
    // Touch: move to the end of insertion order so an actively-read session is
    // not the LRU eviction candidate.
    this.map.delete(id)
    this.map.set(id, entry)
    return entry.data
  }

  async set(id: string, data: Record<string, unknown>, ttlSeconds: number): Promise<void> {
    // Evict the LRU before inserting a genuinely new key at capacity. Re-setting
    // an existing key updates in place (delete+set moves it to MRU) and never
    // trips the cap.
    if (this.map.has(id)) {
      this.map.delete(id)
    } else if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
    this.map.set(id, { data, expiresAt: Date.now() + ttlSeconds * 1000 })
  }

  async destroy(id: string): Promise<void> {
    this.map.delete(id)
  }

  async touch(id: string, ttlSeconds: number): Promise<void> {
    const entry = this.map.get(id)
    if (!entry) return
    entry.expiresAt = Date.now() + ttlSeconds * 1000
    // Move to MRU on touch (rolling sessions) so it survives eviction pressure.
    this.map.delete(id)
    this.map.set(id, entry)
  }

  /**
   * Stop the background sweep timer. Useful in tests / graceful shutdown.
   * After this call the store still works but expired entries are only
   * evicted on access.
   */
  stop(): void {
    if (this.sweep) clearInterval(this.sweep)
  }

  /** @internal Test helper: number of live (non-expired) entries. */
  size(): number {
    this.purge()
    return this.map.size
  }

  private purge(): void {
    const now = Date.now()
    for (const [id, entry] of this.map) {
      if (entry.expiresAt <= now) this.map.delete(id)
    }
  }
}
