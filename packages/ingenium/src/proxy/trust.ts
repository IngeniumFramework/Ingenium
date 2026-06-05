/**
 * Trust-proxy resolution for `X-Forwarded-*` headers.
 *
 * Mirrors Express's `app.set('trust proxy', ...)` semantics:
 * - `false` (default): never trust XFF — `ctx.ip` always reflects the immediate
 *   socket peer.
 * - `true`: trust the entire `X-Forwarded-For` chain — last entry wins.
 * - `number n`: trust `n` upstream hops — return chain entry `n` from the right.
 * - `string` (single CIDR/IP/keyword) or `string[]` (list): trust connections
 *   from these addresses; walk the chain skipping trusted IPs.
 * - `(ip, hopIdx) => boolean`: custom predicate, called per chain entry.
 *
 * Supported keywords: `'loopback'` (127.0.0.0/8, ::1), `'linklocal'`
 * (169.254.0.0/16, fe80::/10), `'uniquelocal'` (10/8, 172.16/12, 192.168/16,
 * fc00::/7). CIDRs accepted in IPv4 dotted (`10.0.0.0/8`) and IPv6
 * (`fc00::/7`) form. Single addresses without `/` match exactly.
 */

const IS_DEV = process.env.NODE_ENV !== 'production'

/**
 * `trust: true` fully trusts a client-supplied `X-Forwarded-For` header, so any
 * caller can spoof `ctx.ip`. We warn exactly once (dev only) rather than change
 * the default, because the boolean form is documented Express-compatible behavior
 * and silently altering it would break apps that legitimately sit behind a single
 * trusted reverse proxy.
 */
let warnedTrustTrue = false

export type TrustProxy =
  | boolean
  | number
  | string
  | string[]
  | ((ip: string, hopIdx: number) => boolean)

export interface ForwardedInfo {
  /** The resolved client IP after walking the trusted hop chain. */
  ip: string
  /** Full forwarded chain, left-to-right (closest to client first), plus the immediate peer at the end. */
  ips: readonly string[]
  /** Best-effort protocol: `http` or `https`. */
  protocol: 'http' | 'https'
  /** Best-effort hostname (no port). */
  hostname: string
}

/**
 * Resolve forwarded info from raw headers + the immediate socket peer.
 *
 * @param trust          The `trustProxy` configuration.
 * @param remoteAddress  The socket-level peer address (always present).
 * @param headers        Lowercased request headers (Node convention).
 * @param defaultProtocol The protocol of the underlying transport (`http` for `node:http`,
 *                        `https` for TLS, `http` for h2c, `https` for h2/TLS).
 */
export function resolveForwarded(
  trust: TrustProxy,
  remoteAddress: string,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  defaultProtocol: 'http' | 'https' = 'http',
): ForwardedInfo {
  if (trust === false || trust === 0 || trust === undefined || trust === null) {
    return {
      ip: remoteAddress,
      ips: [remoteAddress],
      protocol: defaultProtocol,
      hostname: parseHost(headers, false),
    }
  }

  const xffHeader = headers['x-forwarded-for']
  const xff = parseHeaderList(xffHeader)
  // Append the immediate peer at the end so the chain is complete.
  const fullChain: string[] = [...xff, remoteAddress]

  let trustedIp = remoteAddress
  if (typeof trust === 'boolean' && trust === true) {
    if (IS_DEV && !warnedTrustTrue) {
      warnedTrustTrue = true
      try {
        process.emitWarning(
          "trustProxy: true fully trusts the client-supplied X-Forwarded-For header, so ctx.ip can be spoofed by any caller. This bypasses IP rate-limits/allowlists and poisons audit logs. For production, set trustProxy to a hop count (e.g. 1) or a CIDR/subnet trust list (e.g. ['loopback', '10.0.0.0/8']) so only your reverse proxy is trusted.",
          { code: 'INGENIUM_TRUST_PROXY_TRUE' },
        )
      } catch {
        // Worker runtimes can throw on emitWarning; the warning is best-effort.
      }
    }
    trustedIp = fullChain[0] ?? remoteAddress
  } else if (typeof trust === 'number') {
    // Skip `trust` hops from the right (the rightmost is the immediate peer).
    const idx = Math.max(0, fullChain.length - 1 - trust)
    trustedIp = fullChain[idx] ?? remoteAddress
  } else if (typeof trust === 'function') {
    trustedIp = walkChainPredicate(fullChain, trust)
  } else {
    const matchers = typeof trust === 'string' ? [trust] : trust
    const compiled = matchers.map(compileTrustEntry)
    const predicate = (ip: string): boolean => compiled.some((m) => m(ip))
    trustedIp = walkChainPredicate(fullChain, (ip) => predicate(ip))
  }

  const protoHeader = headers['x-forwarded-proto']
  const proto = parseHeaderList(protoHeader)[0]?.toLowerCase()
  const protocol: 'http' | 'https' = proto === 'https' ? 'https' : proto === 'http' ? 'http' : defaultProtocol

  const hostHeader = headers['x-forwarded-host']
  const xfhFirst = parseHeaderList(hostHeader)[0]
  const hostname = xfhFirst ? stripPort(xfhFirst) : parseHost(headers, false)

  return { ip: trustedIp, ips: fullChain, protocol, hostname }
}

/**
 * Walk the chain right-to-left while the predicate keeps trusting the
 * current hop. Return the first untrusted address encountered (the real
 * client). If the predicate trusts every hop, return the leftmost entry.
 */
function walkChainPredicate(
  chain: readonly string[],
  isTrusted: (ip: string, hopIdx: number) => boolean,
): string {
  for (let i = chain.length - 1, hop = 0; i >= 0; i--, hop++) {
    const ip = chain[i]!
    if (!isTrusted(ip, hop)) return ip
  }
  return chain[0] ?? ''
}

/** Parse a comma-separated header (or array) into a trimmed list. */
function parseHeaderList(value: string | string[] | undefined): string[] {
  if (!value) return []
  const flat = Array.isArray(value) ? value.join(',') : value
  return flat
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function parseHost(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  trustForwarded: boolean,
): string {
  if (trustForwarded) {
    const xfh = parseHeaderList(headers['x-forwarded-host'])[0]
    if (xfh) return stripPort(xfh)
  }
  const host = headers['host']
  const flat = Array.isArray(host) ? host[0] : host
  if (!flat) return 'localhost'
  return stripPort(flat)
}

function stripPort(host: string): string {
  // IPv6 literals are bracketed: [::1]:8080
  if (host[0] === '[') {
    const end = host.indexOf(']')
    return end >= 0 ? host.slice(1, end) : host
  }
  const idx = host.lastIndexOf(':')
  return idx > 0 ? host.slice(0, idx) : host
}

// ───────────────────────────────────────────────────────────────────────────
// CIDR / keyword matchers
// ───────────────────────────────────────────────────────────────────────────

type IpMatcher = (ip: string) => boolean

const KEYWORDS: Record<string, string[]> = {
  loopback: ['127.0.0.0/8', '::1/128'],
  linklocal: ['169.254.0.0/16', 'fe80::/10'],
  uniquelocal: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'],
}

function compileTrustEntry(entry: string): IpMatcher {
  const expanded = KEYWORDS[entry] ?? [entry]
  const matchers = expanded.map(compileSingle)
  return (ip) => matchers.some((m) => m(ip))
}

function compileSingle(entry: string): IpMatcher {
  if (entry.includes('/')) return compileCidr(entry)
  return (ip) => ip === entry
}

function compileCidr(cidr: string): IpMatcher {
  const slash = cidr.indexOf('/')
  const network = cidr.slice(0, slash)
  const prefix = Number(cidr.slice(slash + 1))
  if (network.includes(':')) return compileCidrV6(network, prefix)
  return compileCidrV4(network, prefix)
}

function compileCidrV4(network: string, prefix: number): IpMatcher {
  const netBits = ipV4ToInt(network)
  if (netBits === null) return () => false
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0
  const target = (netBits & mask) >>> 0
  return (ip) => {
    const bits = ipV4ToInt(stripIpv6Wrap(ip))
    if (bits === null) return false
    return ((bits & mask) >>> 0) === target
  }
}

function compileCidrV6(network: string, prefix: number): IpMatcher {
  const netBytes = ipV6ToBytes(network)
  if (!netBytes) return () => false
  return (ip) => {
    const bytes = ipV6ToBytes(ip)
    if (!bytes) return false
    return cmpPrefix(netBytes, bytes, prefix)
  }
}

function cmpPrefix(a: Uint8Array, b: Uint8Array, prefix: number): boolean {
  const fullBytes = prefix >>> 3
  for (let i = 0; i < fullBytes; i++) if (a[i] !== b[i]) return false
  const rem = prefix & 7
  if (rem === 0) return true
  const shift = 8 - rem
  return (a[fullBytes]! >> shift) === (b[fullBytes]! >> shift)
}

function ipV4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    const v = Number(p)
    if (!Number.isInteger(v) || v < 0 || v > 255) return null
    n = (n << 8) | v
  }
  return n >>> 0
}

/** ::ffff:1.2.3.4 → 1.2.3.4 (so v4 matchers work on v4-mapped addresses). */
function stripIpv6Wrap(ip: string): string {
  if (ip.startsWith('::ffff:')) return ip.slice(7)
  return ip
}

function ipV6ToBytes(ip: string): Uint8Array | null {
  // Very small implementation: handles standard `a:b:...:h` and `::` shorthand.
  const cleaned = stripIpv6Wrap(ip)
  if (cleaned.includes('.')) return null // v4-mapped already stripped above; bare v4 not v6
  const out = new Uint8Array(16)
  let parts: string[]
  if (ip.includes('::')) {
    const [head, tail] = ip.split('::')
    const headParts = head ? head.split(':') : []
    const tailParts = tail ? tail.split(':') : []
    const fillCount = 8 - (headParts.length + tailParts.length)
    if (fillCount < 0) return null
    parts = [...headParts, ...new Array<string>(fillCount).fill('0'), ...tailParts]
  } else {
    parts = ip.split(':')
  }
  if (parts.length !== 8) return null
  for (let i = 0; i < 8; i++) {
    const v = parseInt(parts[i]!, 16)
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) return null
    out[i * 2] = (v >> 8) & 0xff
    out[i * 2 + 1] = v & 0xff
  }
  return out
}
