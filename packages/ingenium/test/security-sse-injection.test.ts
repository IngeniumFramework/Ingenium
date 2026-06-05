import { describe, it, expect } from 'vitest'
import type { Readable } from 'node:stream'
import { IngeniumContext } from '../src/context/context.ts'
import { sse } from '../src/sse/sse.ts'

/**
 * Regression: SSE framing fields must not let attacker-controlled values inject
 * extra SSE lines/events. A CR/LF in `event`/`id` (or a lone CR in `data`)
 * would terminate the current field and forge a new one — the EventSource
 * analog of HTTP response splitting.
 */

function makeCtx(): IngeniumContext {
  const ctx = new IngeniumContext()
  ctx.method = 'GET'
  ctx.headers = {}
  return ctx
}

/** Collect everything written to the SSE PassThrough until it ends. */
function drain(ctx: IngeniumContext): Promise<string> {
  const body = ctx._body as { kind: 'stream'; data: Readable }
  const chunks: Buffer[] = []
  return new Promise((resolve) => {
    body.data.on('data', (c: Buffer) => chunks.push(Buffer.from(c)))
    body.data.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

describe('SSE field injection', () => {
  it('strips CR/LF from event and id so no extra fields can be injected', async () => {
    const ctx = makeCtx()
    const stream = sse(ctx)
    const collected = drain(ctx)

    stream.send({
      event: 'msg\nevent: admin-command',
      id: '1\r\ndata: forged',
      data: 'hello',
    })
    stream.close()
    const out = await collected

    // No injected field may appear on its own line.
    expect(out).not.toMatch(/\nevent: admin-command/)
    expect(out).not.toMatch(/\ndata: forged/)
    // The newline was stripped, collapsing the value onto a single field line.
    expect(out).toContain('event: msgevent: admin-command\n')
    expect(out).toContain('id: 1data: forged\n')
    // Exactly one data line (the real payload).
    expect(out.match(/^data: /gm)?.length).toBe(1)
  })

  it('normalizes CR / CRLF in data so a lone CR cannot terminate a frame', async () => {
    const ctx = makeCtx()
    const stream = sse(ctx)
    const collected = drain(ctx)

    stream.send({ data: 'line1\r\nline2\rline3' })
    stream.close()
    const out = await collected

    // Three data lines, no raw CR left in the body.
    expect(out.match(/^data: /gm)?.length).toBe(3)
    expect(out).toContain('data: line1\n')
    expect(out).toContain('data: line2\n')
    expect(out).toContain('data: line3\n')
    expect(out).not.toContain('\r')
  })

  it('ignores a non-finite retry value instead of emitting it', async () => {
    const ctx = makeCtx()
    const stream = sse(ctx)
    const collected = drain(ctx)

    stream.send({ data: 'x', retry: Number.POSITIVE_INFINITY })
    stream.send({ data: 'y', retry: 3000 })
    stream.close()
    const out = await collected

    expect(out).not.toContain('retry: Infinity')
    expect(out).toContain('retry: 3000\n')
  })

  it('strips CR/LF from comment text', async () => {
    const ctx = makeCtx()
    const stream = sse(ctx)
    const collected = drain(ctx)

    stream.comment('keep\nevent: sneaky')
    stream.close()
    const out = await collected

    expect(out).not.toMatch(/\nevent: sneaky/)
    expect(out).toContain(': keepevent: sneaky\n')
  })
})
