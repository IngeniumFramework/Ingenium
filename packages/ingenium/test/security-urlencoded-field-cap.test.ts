import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import { Buffer } from 'node:buffer'
import { IngeniumBody } from '../src/context/body.ts'
import { IngeniumBadRequestError } from '../src/errors.ts'

const MAX_URLENCODED_FIELDS = 1000

function bodyWith(raw: string): IngeniumBody {
  const body = new IngeniumBody()
  body._attach(Readable.from([Buffer.from(raw)]), 'application/x-www-form-urlencoded', undefined)
  return body
}

describe('security: urlencoded field count cap', () => {
  it('rejects a body with more than the field cap', async () => {
    const raw = Array.from({ length: MAX_URLENCODED_FIELDS + 1 }, (_, i) => `k${i}=v`).join('&')
    await expect(bodyWith(raw).urlencoded()).rejects.toBeInstanceOf(IngeniumBadRequestError)
  })

  it('exactly at the cap still parses', async () => {
    const raw = Array.from({ length: MAX_URLENCODED_FIELDS }, (_, i) => `k${i}=v`).join('&')
    const out = await bodyWith(raw).urlencoded()
    expect(Object.keys(out).length).toBe(MAX_URLENCODED_FIELDS)
    expect(out.k0).toBe('v')
  })

  it('a small body works normally', async () => {
    const out = await bodyWith('a=1&b=hello%20world&c=').urlencoded()
    expect(out).toEqual({ a: '1', b: 'hello world', c: '' })
  })

  it('honors a custom maxFields override', async () => {
    const raw = 'a=1&b=2&c=3'
    await expect(bodyWith(raw).urlencoded(undefined, 2)).rejects.toBeInstanceOf(
      IngeniumBadRequestError,
    )
    const out = await bodyWith('a=1&b=2').urlencoded(undefined, 2)
    expect(out).toEqual({ a: '1', b: '2' })
  })
})
