import type { ComposedHandler } from '../middleware/types.ts'
import type { HttpMethod } from './types.ts'

/**
 * One node in the radix trie. Static segments win over `:param`, which wins
 * over `*wild`. Method-specific composed handlers live at the leaf.
 */
export class TrieNode {
  staticChildren: Map<string, TrieNode> = new Map()
  paramChild: TrieNode | null = null
  paramName: string | null = null
  wildcardChild: TrieNode | null = null
  wildcardName: string | null = null

  /**
   * Compiled inline constraint for this node *as a param child*, or `null`
   * when the param is unconstrained. Set at insert time when the registered
   * segment carries a `(regex)` group (e.g. `:id(\d+)`). The `find()` hot
   * path loads this field and only runs `.test()` when it is non-null, so
   * unconstrained routes pay zero extra cost. Lives on the param node itself
   * (the child) so the matcher can test it the instant it descends.
   */
  paramConstraint: RegExp | null = null

  /** Per-method composed handlers, populated by `RouteRegistry` after compose. */
  handlers: Partial<Record<HttpMethod, ComposedHandler>> = {}

  /**
   * Lazily-cached `Object.keys(handlers)` — the set of methods registered at
   * this leaf. `null` until first read, then memoized. Safe to cache because
   * `handlers` is only written at compose time and a recompose builds a brand-
   * new trie (nodes are never reused across composes), so the method set is
   * immutable for this node's lifetime. Hoisting it off the per-request hot
   * path matters: `find()` previously called `Object.keys(handlers)` on EVERY
   * successful match to populate `MatchResult.allowed` — a fresh string-array
   * allocation per request for data the dispatcher never reads on a hit.
   * Initialized as a class field so the constructor stamps the hidden class.
   */
  allowedMethods: readonly HttpMethod[] | null = null

  /**
   * Param names accumulated from root → this node, in order. Cached so
   * matching can fill the params object in O(k) without re-walking parents.
   */
  paramNames: readonly string[] = []
}

/** Result of a trie lookup. `params` may be empty if the route had none. */
export interface MatchResult {
  handler: ComposedHandler
  params: Record<string, string>
  /** Methods registered at this leaf — used to populate `Allow` on 405. */
  allowed: readonly HttpMethod[]
}

/** Why a lookup failed. */
export type MatchMiss =
  | { kind: 'not-found' }
  | { kind: 'method-not-allowed'; allowed: readonly HttpMethod[] }

/**
 * Radix trie router. `insert()` is called at registration; `find()` runs on
 * every request and is the single hottest piece of code in the framework.
 */
export class RouterTrie {
  readonly root = new TrieNode()

  /**
   * Walks/creates trie nodes for the path. Returns the leaf where handlers
   * should be attached. Path must start with `/`.
   */
  insert(path: string): TrieNode {
    if (path.length === 0 || path[0] !== '/') {
      throw new Error(`Route path must start with '/': ${path}`)
    }
    const segments = splitPath(path)
    let node = this.root
    const paramNames: string[] = []

    for (const seg of segments) {
      if (seg.length === 0) continue

      if (seg[0] === ':') {
        const { name, constraint } = parseParamSegment(seg)
        if (!node.paramChild) {
          node.paramChild = new TrieNode()
          node.paramName = name
          node.paramChild.paramConstraint = constraint
        } else {
          if (node.paramName !== name) {
            throw new Error(
              `Conflicting param names at the same trie level: ':${node.paramName}' vs ':${name}'`,
            )
          }
          // Same name, but the constraint may differ. Rule: a constraint is a
          // promise about the shape of matched segments; two registrations of
          // the same param must agree on that promise. We require the *source*
          // of the compiled regex to match (or both to be unconstrained).
          // Last-writer-wins would silently let one route's `:id(\d+)` weaken
          // another's, which is a footgun, so we throw instead — same style as
          // the param-name conflict above.
          const existing = node.paramChild.paramConstraint
          const incoming = constraint
          const existingSrc = existing ? existing.source : ''
          const incomingSrc = incoming ? incoming.source : ''
          if (existingSrc !== incomingSrc) {
            const fmt = (n: string, c: RegExp | null) => (c ? `:${n}(...)` : `:${n}`)
            throw new Error(
              `Conflicting param constraints at the same trie level: ` +
                `'${fmt(name, existing)}' vs '${fmt(name, incoming)}' for param ':${name}'`,
            )
          }
        }
        paramNames.push(name)
        node = node.paramChild
      } else if (seg[0] === '*') {
        const name = seg.slice(1) || 'wildcard'
        if (!node.wildcardChild) {
          node.wildcardChild = new TrieNode()
          node.wildcardName = name
        }
        paramNames.push(name)
        node = node.wildcardChild
        // Wildcards consume the rest of the path; later segments are ignored
        // by the matcher anyway, but we don't allow more registration past *.
        break
      } else {
        let child = node.staticChildren.get(seg)
        if (!child) {
          child = new TrieNode()
          node.staticChildren.set(seg, child)
        }
        node = child
      }
    }

    node.paramNames = paramNames
    return node
  }

  /**
   * Look up a route. Iterative with single-level wildcard backtrack — if the
   * static/param walk dead-ends and an ancestor had a `*wildcard` child, we
   * retry from the wildcard with the remaining segments. Backtrack frames
   * are tracked in a small stack (one per wildcard ancestor encountered).
   */
  find(method: HttpMethod, path: string): MatchResult | MatchMiss {
    const segments = splitPath(path)

    // Stack of wildcard fallback points. `paramCount` is paramValues.length
    // captured at the moment the fallback was recorded — used to truncate
    // any params collected past that point if we have to backtrack.
    type Fallback = { node: TrieNode; segIdx: number; paramCount: number }
    const fallbacks: Fallback[] = []

    let node: TrieNode = this.root
    const paramValues: string[] = []
    let consumedWildcard = false

    let i = 0
    walk: while (i < segments.length) {
      const seg = segments[i]!
      if (seg.length === 0) {
        i++
        continue
      }

      // Record a wildcard fallback at this level *before* descending, so a
      // later miss can rewind and consume from `i` greedily via the wildcard.
      if (node.wildcardChild) {
        fallbacks.push({ node: node.wildcardChild, segIdx: i, paramCount: paramValues.length })
      }

      const staticChild = node.staticChildren.get(seg)
      if (staticChild) {
        node = staticChild
        i++
        continue
      }

      if (node.paramChild) {
        // Hot-path gate: only constrained params (a tiny minority of routes)
        // run a regex. The field load + `!== null` is one branch; unconstrained
        // routes never touch `.test()`, so they pay zero extra cost.
        //
        // SECURITY: a constrained param MUST be tested against the SAME string
        // the handler receives — i.e. the DECODED value — not the raw
        // percent-encoded segment. Testing the raw segment lets `%2f`/`%2e`/`%00`
        // smuggle a '/' '.' or NUL past a constraint that was written to forbid
        // them (e.g. `:file([^/]+)` used as a traversal guard). We decode first
        // (cheap: `decodeParam` no-ops when there's no '%'), then test, then
        // push the decoded value — so a decoded '/' fails `^(?:[^/]+)$` as the
        // route author intended.
        const constraint = node.paramChild.paramConstraint
        const decoded = decodeParam(seg)
        if (constraint === null || constraint.test(decoded)) {
          paramValues.push(decoded)
          node = node.paramChild
          i++
          continue
        }
        // Constraint miss: this param branch is dead. Fall through to the
        // wildcard child / backtrack stack exactly as a structural dead-end
        // would, so a sibling `*wild` can still catch the segment, else 404.
      }

      if (node.wildcardChild) {
        const remaining = segments.slice(i).join('/')
        paramValues.push(decodeParam(remaining))
        node = node.wildcardChild
        consumedWildcard = true
        break walk
      }

      // Dead end — try the most recent wildcard fallback.
      const fb = fallbacks.pop()
      if (!fb) return { kind: 'not-found' }
      const remaining = segments.slice(fb.segIdx).join('/')
      paramValues.length = fb.paramCount
      paramValues.push(decodeParam(remaining))
      node = fb.node
      consumedWildcard = true
      break walk
    }

    if (!consumedWildcard && !node.handlers[method] && fallbacks.length > 0) {
      // Walked to the end via static/param but no handler at this leaf —
      // try the most recent wildcard fallback.
      const fb = fallbacks.pop()!
      const remaining = segments.slice(fb.segIdx).join('/')
      paramValues.length = fb.paramCount
      paramValues.push(decodeParam(remaining))
      node = fb.node
    }

    const handler = node.handlers[method]
    if (!handler) {
      const allowed = node.allowedMethods ?? (node.allowedMethods = Object.keys(node.handlers) as HttpMethod[])
      if (allowed.length === 0) return { kind: 'not-found' }
      return { kind: 'method-not-allowed', allowed }
    }

    // Build params object — one allocation per match. Stable key insertion
    // order (driven by paramNames recorded at insert time) → V8 monomorphic
    // hidden class per route.
    let params: Record<string, string>
    if (node.paramNames.length === 0) {
      params = EMPTY_PARAMS
    } else {
      params = {}
      for (let j = 0; j < node.paramNames.length; j++) {
        params[node.paramNames[j]!] = paramValues[j]!
      }
    }

    return {
      handler,
      params,
      allowed: node.allowedMethods ?? (node.allowedMethods = Object.keys(node.handlers) as HttpMethod[]),
    }
  }
}

/** Shared frozen empty-params sentinel — exported so the dispatcher can identity-compare. */
export const EMPTY_PARAMS: Record<string, string> = Object.freeze({}) as Record<string, string>

/**
 * Split `/users/42/posts` into `['users', '42', 'posts']`. Reused by both
 * insert and lookup, so the implementation is hot — manual scan beats
 * `String.prototype.split` only marginally; we use split for clarity.
 */
function splitPath(path: string): string[] {
  // Strip leading and trailing slash for a stable segment count.
  let start = 0
  let end = path.length
  if (start < end && path[start] === '/') start++
  if (end > start && path[end - 1] === '/') end--
  if (start >= end) return []
  return path.slice(start, end).split('/')
}

/**
 * Parse a `:param` segment into its clean name and an optional compiled
 * constraint. Runs at *insert* time only (never on the request hot path), so
 * the regex compile cost is paid once per route.
 *
 * Grammar handled:
 *   `:name`            → { name: 'name', constraint: null }
 *   `:name?`           → { name: 'name', constraint: null }
 *   `:name(regex)`     → { name: 'name', constraint: /^(?:regex)$/ }
 *   `:name(regex)?`    → { name: 'name', constraint: /^(?:regex)$/ }
 *
 * The constraint is anchored with `^(?:...)$` so it must match the *entire*
 * segment — a partial match (e.g. `\d+` against `12a`) does NOT slip through.
 * The `(?:...)` wrapper keeps the user's alternations (`a|b`) from binding
 * past the anchors.
 */
function parseParamSegment(seg: string): { name: string; constraint: RegExp | null } {
  // Strip the leading ':'.
  let body = seg.slice(1)

  // Strip a trailing optional marker first; it sits *after* the constraint
  // group in the documented grammar (`:id(\d+)?`).
  if (body.length > 0 && body[body.length - 1] === '?') {
    body = body.slice(0, -1)
  }

  // Detect a constraint group: `name(regex)`. The regex body is everything
  // between the first '(' and the final ')'.
  const open = body.indexOf('(')
  if (open !== -1 && body[body.length - 1] === ')') {
    const name = body.slice(0, open)
    const pattern = body.slice(open + 1, -1)
    // Anchor fully so the constraint governs the whole segment.
    return { name, constraint: new RegExp(`^(?:${pattern})$`) }
  }

  return { name: body, constraint: null }
}

function decodeParam(raw: string): string {
  // Hot path: skip decode if no '%' present.
  if (raw.indexOf('%') === -1) return raw
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}
