import { createPublicKey, type KeyObject } from 'node:crypto'

/**
 * In-memory JWKS cache.
 *
 * One entry per URL. Each entry holds the parsed `Map<kid, KeyObject>` and
 * the absolute timestamp at which it expires. A `pending` promise is stored
 * alongside so concurrent callers for the same URL share a single in-flight
 * fetch — we never stampede the upstream IdP.
 */
interface CacheEntry {
  keys: Map<string, KeyObject>
  expiresAt: number
  pending: Promise<Map<string, KeyObject>> | null
}

const cache = new Map<string, CacheEntry>()

/**
 * Hard cap on distinct JWKS URLs we cache.
 *
 * WHY: the cache is keyed by URL, and the URL can flow from per-app config
 * that is itself driven by attacker-influenced input in some deployments
 * (multi-tenant issuers, dynamic `jwksUrl` resolution). An unbounded Map lets
 * a resolver-abuse attacker pin unlimited distinct entries and OOM the
 * process. We evict the oldest (insertion-order) entry once the cap is hit.
 * 50 is far above any legitimate fan-out of IdPs a single process talks to.
 */
const MAX_JWKS_CACHE_ENTRIES = 50

/**
 * Insert a fresh cache entry, evicting the oldest if we're at capacity.
 *
 * Only evicts when inserting a genuinely NEW url — re-`set`ting an existing
 * key (the common case: refresh / in-flight parking) updates in place and
 * never trips the cap, so the in-flight coalescing logic is untouched.
 */
function setCacheEntry(url: string, entry: CacheEntry): void {
  if (cache.size >= MAX_JWKS_CACHE_ENTRIES && !cache.has(url)) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(url, entry)
}

/** JWK shape we accept. We tolerate extra fields and ignore unsupported `kty`. */
interface Jwk {
  kty?: string
  kid?: string
  use?: string
  alg?: string
  n?: string
  e?: string
  crv?: string
  x?: string
  y?: string
  // RSA private parts / EC `d` are intentionally ignored — verifier-only.
  [k: string]: unknown
}

interface JwksResponse {
  keys?: Jwk[]
}

/**
 * Fetch + cache a JWKS. Returns a `Map<kid, KeyObject>`.
 *
 * Concurrency: if a fetch is already in flight for `url` we await the same
 * promise, ensuring a thundering-herd of requests collapses to one upstream
 * call. After the fetch resolves, all waiters get the same keys.
 *
 * Failure mode: any thrown error (network, JSON parse, malformed JWK, empty
 * keyset) bubbles as a generic `Error('jwks_fetch_failed')` — the caller is
 * responsible for translating to a wire-safe `IngeniumUnauthorizedError`. We
 * deliberately do NOT serve a stale cache on failure: stale public keys can
 * mean accepting tokens that the IdP has rotated away from.
 */
export async function fetchJwks(url: string, ttlMs: number): Promise<Map<string, KeyObject>> {
  const now = Date.now()
  const entry = cache.get(url)

  // Fresh cache hit — return synchronously-resolved map.
  if (entry && entry.expiresAt > now && !entry.pending) {
    return entry.keys
  }

  // In-flight coalescing: another caller already triggered the fetch.
  if (entry?.pending) {
    return entry.pending
  }

  const pending = doFetch(url).then(
    (keys) => {
      setCacheEntry(url, { keys, expiresAt: Date.now() + ttlMs, pending: null })
      return keys
    },
    (err) => {
      // Drop the failed entry so the next caller retries (instead of being
      // pinned to a rejected promise forever).
      cache.delete(url)
      throw err
    },
  )

  // Park the in-flight promise so concurrent callers within this tick share it.
  // Preserve the existing `keys` map so reads during refresh have something
  // to fall back on if needed (currently unused — we always await `pending`).
  setCacheEntry(url, {
    keys: entry?.keys ?? new Map(),
    expiresAt: entry?.expiresAt ?? 0,
    pending,
  })

  return pending
}

/** Reset the in-process cache. Tests use this; production code shouldn't need it. */
export function clearJwksCache(): void {
  cache.clear()
}

/** Loopback/test hostnames we permit over plain `http:` (local test servers). */
function isLocalhostHost(hostname: string): boolean {
  // URL hosts wrap IPv6 literals in brackets; strip them before comparing.
  const h = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  return h === 'localhost' || h === '127.0.0.1' || h === '::1'
}

/**
 * Reject JWKS hostnames that point at private / loopback / link-local space.
 *
 * WHY (SSRF): `jwksUrl` is frequently operator config that can be influenced
 * by tenant / discovery input. Without this guard an attacker can aim the
 * fetch at internal services — cloud metadata endpoints, admin panels, other
 * pods — and use the JWKS fetcher as a request-forgery primitive. We block
 * the obviously-internal literal ranges here as a defense-in-depth layer on
 * top of the https-only + no-redirect policy in `doFetch`. This is a
 * best-effort literal check (it does NOT do DNS resolution), so it is paired
 * with `redirect: 'error'` so a public hostname can't 30x-pivot to an
 * internal one mid-chain.
 *
 * Note: the localhost test allowance is handled by the caller BEFORE this
 * runs, so `127.0.0.1` / `::1` reaching here means they were NOT the
 * explicitly-permitted local test host and are treated as blocked.
 */
function isBlockedJwksHost(hostname: string): boolean {
  // Strip IPv6 brackets and any zone id.
  let h = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  const pct = h.indexOf('%')
  if (pct !== -1) h = h.slice(0, pct)
  h = h.toLowerCase()

  // IPv4 private / loopback / link-local literals.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    if (a === 10) return true // 10.0.0.0/8
    if (a === 127) return true // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
    if (a === 192 && b === 168) return true // 192.168.0.0/16
    return false
  }

  // IPv6 loopback / ULA (fc00::/7) / link-local (fe80::/10).
  if (h === '::1' || h === '::') return true
  if (h.startsWith('fc') || h.startsWith('fd')) return true // fc00::/7 ULA
  if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) {
    return true // fe80::/10 link-local
  }
  return false
}

async function doFetch(url: string): Promise<Map<string, KeyObject>> {
  let res: Response
  try {
    // SSRF guard: parse + validate the destination before issuing the
    // request. https-only, except an explicit localhost allowance for local
    // test servers running plain http. Private/loopback/link-local literals
    // are rejected, and the fetch itself refuses redirects and bounds the
    // upstream wait so a slow-loris or 30x chain can't be used to pivot.
    const parsed = new URL(url)
    const localAllowed = parsed.protocol === 'http:' && isLocalhostHost(parsed.hostname)
    if (parsed.protocol !== 'https:' && !localAllowed) {
      throw new Error('jwks_fetch_failed')
    }
    if (!localAllowed && isBlockedJwksHost(parsed.hostname)) {
      throw new Error('jwks_fetch_failed')
    }
    res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) })
  } catch {
    throw new Error('jwks_fetch_failed')
  }
  if (!res.ok) throw new Error('jwks_fetch_failed')

  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new Error('jwks_fetch_failed')
  }

  if (!body || typeof body !== 'object') throw new Error('jwks_fetch_failed')
  const jwks = body as JwksResponse
  if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) {
    throw new Error('jwks_fetch_failed')
  }

  const out = new Map<string, KeyObject>()
  for (const jwk of jwks.keys) {
    if (!jwk || typeof jwk !== 'object') continue
    if (typeof jwk.kid !== 'string' || jwk.kid.length === 0) continue
    if (jwk.kty !== 'RSA' && jwk.kty !== 'EC') continue
    // EC: only accept the JWT-spec curves. P-521 (note: 521, not 512) is
    // the curve name JOSE uses for ES512 — yes, the off-by-one is in the spec.
    if (jwk.kty === 'EC' && jwk.crv !== 'P-256' && jwk.crv !== 'P-384' && jwk.crv !== 'P-521') {
      continue
    }
    try {
      // node:crypto accepts JWK directly when format is 'jwk'. For RSA it
      // needs `n` + `e`; for EC it needs `crv` + `x` + `y`. Private fields
      // are ignored when we createPublicKey.
      const key = createPublicKey({ key: jwk as never, format: 'jwk' })
      out.set(jwk.kid, key)
    } catch {
      // Skip individual bad keys rather than failing the whole keyset —
      // an IdP rolling a new (broken) key shouldn't blow up verification of
      // tokens signed with the still-valid old keys.
      continue
    }
  }

  if (out.size === 0) throw new Error('jwks_fetch_failed')
  return out
}
