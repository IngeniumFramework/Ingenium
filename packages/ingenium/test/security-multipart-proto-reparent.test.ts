import { describe, it, expect } from 'vitest'
import { Buffer } from 'node:buffer'
import { parseMultipart } from '../src/body/multipart.ts'

const BOUNDARY = '----IngeniumSecBoundary'
const CT = `multipart/form-data; boundary=${BOUNDARY}`

type SecPart =
  | { name: string; value: string }
  | { name: string; filename: string; contentType?: string; value: string }

function build(parts: SecPart[]): Buffer {
  const chunks: Buffer[] = []
  for (const p of parts) {
    chunks.push(Buffer.from(`--${BOUNDARY}\r\n`))
    if ('filename' in p) {
      const ct = p.contentType ?? 'application/octet-stream'
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\n` +
            `Content-Type: ${ct}\r\n\r\n`,
        ),
      )
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n`))
    }
    chunks.push(Buffer.from(p.value, 'utf8'))
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`))
  return Buffer.concat(chunks)
}

describe('multipart prototype reparenting (security)', () => {
  it('does not reparent files map when a file part is named "__proto__"', () => {
    const buf = build([{ name: '__proto__', filename: 'evil.bin', value: 'payload' }])
    const result = parseMultipart(buf, CT)
    // The file is stored as own-data, not via the __proto__ setter.
    expect(Object.getPrototypeOf(result.files)).toBe(null)
    expect(Object.prototype.hasOwnProperty.call(result.files, '__proto__')).toBe(true)
    const file = (result.files as Record<string, { filename: string }>)['__proto__']
    expect(Array.isArray(file) ? file[0]!.filename : file!.filename).toBe('evil.bin')
    // Global prototype is untouched.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('does not reparent fields map when a field is named "__proto__"', () => {
    const buf = build([{ name: '__proto__', value: 'x' }])
    const result = parseMultipart(buf, CT)
    expect(Object.getPrototypeOf(result.fields)).toBe(null)
    expect(Object.prototype.hasOwnProperty.call(result.fields, '__proto__')).toBe(true)
    expect((result.fields as Record<string, string>)['__proto__']).toBe('x')
  })

  it('stores "constructor" and "prototype" names as plain own-data', () => {
    const buf = build([
      { name: 'constructor', value: 'c' },
      { name: 'prototype', value: 'p' },
      { name: 'constructor', filename: 'ctor.bin', value: 'data' },
    ])
    const result = parseMultipart(buf, CT)
    expect((result.fields as Record<string, string>).constructor).toBe('c')
    expect((result.fields as Record<string, string>).prototype).toBe('p')
    expect(
      Object.prototype.hasOwnProperty.call(result.files, 'constructor'),
    ).toBe(true)
  })

  it('repeated reserved-name parts still collapse into arrays', () => {
    const buf = build([
      { name: '__proto__', value: 'a' },
      { name: '__proto__', value: 'b' },
    ])
    const result = parseMultipart(buf, CT)
    expect((result.fields as Record<string, string[]>)['__proto__']).toEqual(['a', 'b'])
  })
})
