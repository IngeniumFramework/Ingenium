import { describe, it, expect } from 'vitest'
import { RouterTrie, type MatchResult, type MatchMiss } from '../src/router/trie.ts'
import type { ComposedHandler } from '../src/middleware/types.ts'
import type { HttpMethod } from '../src/router/types.ts'

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

describe('RouterTrie', () => {
  it('insert + find roundtrip for a static path', () => {
    const trie = new RouterTrie()
    register(trie, 'GET', '/users')
    const result = trie.find('GET', '/users')
    expect(isHit(result)).toBe(true)
    if (isHit(result)) {
      expect(result.params).toEqual({})
      expect(result.allowed).toEqual(['GET'])
    }
  })

  it('matches single :param and returns its value', () => {
    const trie = new RouterTrie()
    register(trie, 'GET', '/users/:id')
    const result = trie.find('GET', '/users/42')
    expect(isHit(result)).toBe(true)
    if (isHit(result)) expect(result.params).toEqual({ id: '42' })
  })

  it('matches multiple :params in order', () => {
    const trie = new RouterTrie()
    register(trie, 'GET', '/users/:userId/posts/:postId')
    const result = trie.find('GET', '/users/7/posts/abc')
    expect(isHit(result)).toBe(true)
    if (isHit(result)) expect(result.params).toEqual({ userId: '7', postId: 'abc' })
  })

  it('captures wildcard tail under the wildcard name', () => {
    const trie = new RouterTrie()
    register(trie, 'GET', '/files/*path')
    const result = trie.find('GET', '/files/a/b/c.txt')
    expect(isHit(result)).toBe(true)
    if (isHit(result)) expect(result.params).toEqual({ path: 'a/b/c.txt' })
  })

  it('matches mixed static/param/wildcard', () => {
    const trie = new RouterTrie()
    register(trie, 'GET', '/users/:id/files/*rest')
    const result = trie.find('GET', '/users/9/files/img/cat.png')
    expect(isHit(result)).toBe(true)
    if (isHit(result)) expect(result.params).toEqual({ id: '9', rest: 'img/cat.png' })
  })

  it('precedence: static > :param > *wild at the same level', () => {
    const trie = new RouterTrie()
    const sHandler: ComposedHandler = async () => {}
    const pHandler: ComposedHandler = async () => {}
    const wHandler: ComposedHandler = async () => {}
    register(trie, 'GET', '/x/exact', sHandler)
    register(trie, 'GET', '/x/:id', pHandler)
    register(trie, 'GET', '/x/*rest', wHandler)

    const exact = trie.find('GET', '/x/exact')
    const param = trie.find('GET', '/x/other')
    const wild = trie.find('GET', '/x/a/b')

    expect(isHit(exact) && exact.handler).toBe(sHandler)
    expect(isHit(param) && param.handler).toBe(pHandler)
    expect(isHit(param) && param.params).toEqual({ id: 'other' })
    expect(isHit(wild) && wild.handler).toBe(wHandler)
    expect(isHit(wild) && wild.params).toEqual({ rest: 'a/b' })
  })

  it('returns 405-style miss with allowed list when path matches but method does not', () => {
    const trie = new RouterTrie()
    register(trie, 'GET', '/users/:id')
    register(trie, 'POST', '/users/:id')
    const result = trie.find('DELETE', '/users/1')
    expect('kind' in result && result.kind).toBe('method-not-allowed')
    if (!isHit(result) && result.kind === 'method-not-allowed') {
      expect([...result.allowed].sort()).toEqual(['GET', 'POST'])
    }
  })

  it('returns not-found miss when no path matches', () => {
    const trie = new RouterTrie()
    register(trie, 'GET', '/users')
    const result = trie.find('GET', '/teams')
    expect('kind' in result && result.kind).toBe('not-found')
  })

  it('URL-decodes param values', () => {
    const trie = new RouterTrie()
    register(trie, 'GET', '/q/:term')
    const result = trie.find('GET', '/q/hello%20world')
    expect(isHit(result)).toBe(true)
    if (isHit(result)) expect(result.params).toEqual({ term: 'hello world' })
  })

  it('throws on conflicting :param names at the same trie level', () => {
    const trie = new RouterTrie()
    trie.insert('/users/:id')
    expect(() => trie.insert('/users/:slug')).toThrow(/Conflicting param names/)
  })

  it('insert rejects paths not starting with /', () => {
    const trie = new RouterTrie()
    expect(() => trie.insert('users')).toThrow()
  })

  it('1000-route stress: every registered route is found correctly', () => {
    const trie = new RouterTrie()
    const handlers: ComposedHandler[] = []
    for (let i = 0; i < 1000; i++) {
      const h: ComposedHandler = async () => {}
      handlers.push(h)
      register(trie, 'GET', `/r/${i}/items/:itemId`, h)
    }
    for (let i = 0; i < 1000; i++) {
      const result = trie.find('GET', `/r/${i}/items/x${i}`)
      expect(isHit(result)).toBe(true)
      if (isHit(result)) {
        expect(result.handler).toBe(handlers[i])
        expect(result.params).toEqual({ itemId: `x${i}` })
      }
    }
  })

  it('caches the leaf `allowed` array across repeated hits (perf invariant)', () => {
    // find() memoizes Object.keys(handlers) on the node so the per-request hot
    // path doesn't reallocate the method list on every match. Two finds against
    // the same leaf must return the SAME array reference, and its contents must
    // still reflect every registered method.
    const trie = new RouterTrie()
    register(trie, 'GET', '/cached')
    register(trie, 'POST', '/cached')

    const first = trie.find('GET', '/cached')
    const second = trie.find('POST', '/cached')
    expect(isHit(first) && isHit(second)).toBe(true)
    if (isHit(first) && isHit(second)) {
      expect([...first.allowed].sort()).toEqual(['GET', 'POST'])
      // Same memoized reference reused — no fresh allocation on the second hit.
      expect(first.allowed).toBe(second.allowed)
    }

    // The 405 miss path reads the same cached list.
    const miss = trie.find('DELETE', '/cached')
    if (!isHit(miss) && miss.kind === 'method-not-allowed') {
      expect([...miss.allowed].sort()).toEqual(['GET', 'POST'])
      expect(miss.allowed).toBe(isHit(first) ? first.allowed : miss.allowed)
    }
  })
})
