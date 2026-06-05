import { describe, it, expect } from 'vitest'
import { Buffer } from 'node:buffer'
import { parseMultipart } from '../src/body/multipart.ts'
import { IngeniumPayloadTooLargeError } from '../src/errors.ts'

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

describe('multipart per-field size cap (security)', () => {
  it('rejects a non-file field larger than maxFieldSize', () => {
    const buf = build([{ name: 'bio', value: 'x'.repeat(64) }])
    expect(() => parseMultipart(buf, CT, { maxFieldSize: 16 })).toThrow(
      IngeniumPayloadTooLargeError,
    )
  })

  it('accepts a non-file field at or under maxFieldSize', () => {
    // Exactly at the cap.
    const atCap = build([{ name: 'bio', value: 'x'.repeat(16) }])
    const r1 = parseMultipart(atCap, CT, { maxFieldSize: 16 })
    expect((r1.fields as Record<string, string>).bio).toBe('x'.repeat(16))

    // Comfortably under the cap.
    const underCap = build([{ name: 'bio', value: 'x'.repeat(8) }])
    const r2 = parseMultipart(underCap, CT, { maxFieldSize: 16 })
    expect((r2.fields as Record<string, string>).bio).toBe('x'.repeat(8))
  })

  it('enforces the field cap independently of a generous maxBytes/maxFileSize', () => {
    // A large maxBytes / maxFileSize must NOT let an oversized text field through:
    // the per-field cap is the binding limit for non-file parts.
    const buf = build([{ name: 'bio', value: 'x'.repeat(64) }])
    expect(() =>
      parseMultipart(buf, CT, {
        maxFieldSize: 16,
        maxBytes: 10 * 1024 * 1024,
        maxFileSize: 10 * 1024 * 1024,
      }),
    ).toThrow(IngeniumPayloadTooLargeError)
  })

  it('does not apply the field cap to file parts (file uses maxFileSize)', () => {
    // A file part larger than maxFieldSize but under maxFileSize is accepted —
    // proving the field cap is scoped to non-file parts only.
    const buf = build([
      { name: 'upload', filename: 'big.bin', value: 'x'.repeat(64) },
    ])
    const result = parseMultipart(buf, CT, { maxFieldSize: 16, maxFileSize: 1024 })
    const file = (result.files as Record<string, { size: number }>).upload
    expect(file!.size).toBe(64)
  })
})
