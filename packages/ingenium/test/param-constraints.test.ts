import { describe, it, expect, expectTypeOf } from 'vitest'
import { RouterTrie, type MatchResult, type MatchMiss } from '../src/router/trie.ts'
import type { ComposedHandler } from '../src/middleware/types.ts'
import type { HttpMethod, ExtractParams } from '../src/router/types.ts'

const noop: ComposedHandler = async () => {}

const register = (
  trie: RouterTrie,
  method: HttpMethod,
  path: string,
  handler: ComposedHandler = noop,
) => {
  const leaf = trie.insert(path)
  leaf.handlers[method] = handler
}

const isHit = (r: MatchResult | MatchMiss): r is MatchResult => 'handler' in r

describe('inline param constraints — runtime enforcement', () => {
  it(':id(\\d+) matches a digit segment', () => {
    const trie = new RouterTrie()
    register(trie, 'GET', '/users/:id(\\d+)')
    const result = trie.find('GET', '/users/42')
    expect(isHit(result)).toBe(true)
    if (isHit(result)) expect(result.params).toEqual({ id: '42' })
  })

  it(':id(\\d+) rejects a non-digit segment (404)', () => {
    const trie = new RouterTrie()
    register(trie, 'GET', '/users/:id(\\d+)')
    const result = trie.find('GET', '/users/abc')
    expect(isHit(result)).toBe(false)
    expect(!isHit(result) && result.kind).toBe('not-found')
  })

  it('rejects a partially-numeric segment (anchored, no partial match)', () => {
    const trie = new RouterTrie()
    register(trie, 'GET', '/users/:id(\\d+)')
    // `\d+` would partial-match '12' in '12a' without anchoring.
    const result = trie.find('GET', '/users/12a')
    expect(isHit(result)).toBe(false)
  })

  it('constrained param value stays a STRING (no coercion)', () => {
    const trie = new RouterTrie()
    register(trie, 'GET', '/users/:id(\\d+)')
    const result = trie.find('GET', '/users/42')
    expect(isHit(result)).toBe(true)
    if (isHit(result)) {
      expect(result.params.id).toBe('42')
      expect(typeof result.params.id).toBe('string')
    }
  })

  it('a sibling *wild catches a constraint miss', () => {
    const trie = new RouterTrie()
    const numHandler: ComposedHandler = async () => {}
    const wildHandler: ComposedHandler = async () => {}
    register(trie, 'GET', '/x/:id(\\d+)', numHandler)
    register(trie, 'GET', '/x/*rest', wildHandler)

    const numeric = trie.find('GET', '/x/42')
    const nonNumeric = trie.find('GET', '/x/abc')

    expect(isHit(numeric) && numeric.handler).toBe(numHandler)
    expect(isHit(numeric) && numeric.params).toEqual({ id: '42' })

    // Constraint miss must fall through to the wildcard sibling.
    expect(isHit(nonNumeric) && nonNumeric.handler).toBe(wildHandler)
    expect(isHit(nonNumeric) && nonNumeric.params).toEqual({ rest: 'abc' })
  })

  it('static sibling still wins over a constrained param', () => {
    const trie = new RouterTrie()
    const staticHandler: ComposedHandler = async () => {}
    const paramHandler: ComposedHandler = async () => {}
    register(trie, 'GET', '/x/special', staticHandler)
    register(trie, 'GET', '/x/:id(\\d+)', paramHandler)

    const exact = trie.find('GET', '/x/special')
    const param = trie.find('GET', '/x/7')
    expect(isHit(exact) && exact.handler).toBe(staticHandler)
    expect(isHit(param) && param.handler).toBe(paramHandler)
  })

  it('optional constrained param :id(\\d+)? matches a digit segment', () => {
    const trie = new RouterTrie()
    register(trie, 'GET', '/users/:id(\\d+)?')
    const result = trie.find('GET', '/users/99')
    expect(isHit(result)).toBe(true)
    if (isHit(result)) expect(result.params).toEqual({ id: '99' })
  })

  it('optional constrained param :id(\\d+)? still rejects non-digits', () => {
    const trie = new RouterTrie()
    register(trie, 'GET', '/users/:id(\\d+)?')
    const result = trie.find('GET', '/users/xyz')
    expect(isHit(result)).toBe(false)
  })

  it('non-numeric regex :slug([a-z-]+) matches lowercase/dashes, rejects others', () => {
    const trie = new RouterTrie()
    register(trie, 'GET', '/posts/:slug([a-z-]+)')

    const ok = trie.find('GET', '/posts/hello-world')
    expect(isHit(ok)).toBe(true)
    if (isHit(ok)) expect(result_slug(ok)).toBe('hello-world')

    const bad = trie.find('GET', '/posts/Hello123')
    expect(isHit(bad)).toBe(false)
  })

  it('constrained param coexists with deeper static segments', () => {
    const trie = new RouterTrie()
    register(trie, 'GET', '/users/:id(\\d+)/posts')
    const ok = trie.find('GET', '/users/5/posts')
    const bad = trie.find('GET', '/users/abc/posts')
    expect(isHit(ok)).toBe(true)
    if (isHit(ok)) expect(ok.params).toEqual({ id: '5' })
    expect(isHit(bad)).toBe(false)
  })

  it('throws on conflicting constraints for the same param name', () => {
    const trie = new RouterTrie()
    trie.insert('/users/:id(\\d+)')
    expect(() => trie.insert('/users/:id([a-z]+)')).toThrow(/Conflicting param constraints/)
  })

  it('throws when one registration constrains a param and another does not', () => {
    const trie = new RouterTrie()
    trie.insert('/users/:id(\\d+)')
    expect(() => trie.insert('/users/:id')).toThrow(/Conflicting param constraints/)
  })

  it('allows re-registering the identical constraint (idempotent)', () => {
    const trie = new RouterTrie()
    trie.insert('/users/:id(\\d+)')
    expect(() => trie.insert('/users/:id(\\d+)/posts')).not.toThrow()
    const result = trie.find('GET', '/users/9')
    // no GET handler attached, but the path structure must remain valid digits-only
    expect(!isHit(result) && result.kind).toBe('not-found')
  })

  it('unconstrained param behavior is unchanged', () => {
    const trie = new RouterTrie()
    register(trie, 'GET', '/users/:id')
    const numeric = trie.find('GET', '/users/42')
    const alpha = trie.find('GET', '/users/abc')
    // Both match — no constraint enforced.
    expect(isHit(numeric) && numeric.params).toEqual({ id: '42' })
    expect(isHit(alpha) && alpha.params).toEqual({ id: 'abc' })
  })

  // SECURITY: the constraint must govern the SAME string the handler receives —
  // the DECODED value — so a constraint used as an input filter can't be
  // bypassed by percent-encoding the forbidden characters.
  it('enforces the constraint against the DECODED value, blocking %2f traversal', () => {
    const trie = new RouterTrie()
    // `[^/]+` is the idiomatic "single path segment" guard. It must reject a
    // value that DECODES to contain a slash, even though the raw encoded
    // segment has no literal '/'.
    register(trie, 'GET', '/files/:name([^/]+)')
    const result = trie.find('GET', '/files/..%2f..%2fetc%2fpasswd')
    expect(isHit(result)).toBe(false)
    expect(!isHit(result) && result.kind).toBe('not-found')
  })

  it('runs the constraint on the decoded value AND stores the decoded value', () => {
    const trie = new RouterTrie()
    // Space is in the class, so the decoded "hello world" matches and is exactly
    // what the handler receives — proving the test and the capture use one string.
    register(trie, 'GET', '/q/:term([a-z ]+)')
    const result = trie.find('GET', '/q/hello%20world')
    expect(isHit(result)).toBe(true)
    if (isHit(result)) expect(result.params).toEqual({ term: 'hello world' })
  })

  it('blocks a NUL byte smuggled via %00 in the decoded value', () => {
    const trie = new RouterTrie()
    // Raw "abc%00def" passes [a-z%0-9]+, but the decoded value contains a NUL
    // the class forbids — the decoded-value check rejects it.
    register(trie, 'GET', '/seg/:s([a-z%0-9]+)')
    const result = trie.find('GET', '/seg/abc%00def')
    expect(isHit(result)).toBe(false)
  })
})

function result_slug(r: MatchResult): string {
  return r.params.slug!
}

describe('ExtractParams — constrained params type as string', () => {
  it('constrained required param is string', () => {
    type P = ExtractParams<'/users/:id(\\d+)'>
    expectTypeOf<P>().toEqualTypeOf<{ id: string }>()
  })

  it('constrained optional param is optional string', () => {
    type P = ExtractParams<'/users/:id(\\d+)?'>
    expectTypeOf<P>().toEqualTypeOf<{ id?: string }>()
  })

  it('non-numeric constrained param is still string', () => {
    type P = ExtractParams<'/posts/:slug([a-z-]+)'>
    expectTypeOf<P>().toEqualTypeOf<{ slug: string }>()
  })

  it('mixed constrained + plain params', () => {
    type P = ExtractParams<'/users/:id(\\d+)/posts/:slug'>
    expectTypeOf<P['id']>().toEqualTypeOf<string>()
    expectTypeOf<P['slug']>().toEqualTypeOf<string>()
  })
})
