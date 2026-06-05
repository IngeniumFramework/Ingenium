import { describe, it, expect } from 'vitest'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { NodeAdapter } from '../src/transport/node.ts'
import { IngeniumContext } from '../src/context/context.ts'
import type { ListeningServer, TransportHooks } from '../src/transport/types.ts'
import { sse, type SseStream } from '../src/sse/sse.ts'
import { startKeepAlive } from '../src/sse/keep-alive.ts'

/** Spin up a NodeAdapter on an ephemeral port wired to `dispatch`. */
async function startServer(
  dispatch: (ctx: IngeniumContext) => Promise<void> | void,
): Promise<ListeningServer> {
  const adapter = new NodeAdapter()
  const hooks: TransportHooks = {
    acquire: () => new IngeniumContext(),
    release: () => {
      /* no-op */
    },
    dispatch: async (ctx) => {
      await dispatch(ctx)
    },
  }
  adapter.attach(hooks)
  return adapter.listen(0, '127.0.0.1')
}

/** Open a GET / request and return the IncomingMessage when headers arrive. */
function getRequest(server: ListeningServer): {
  req: ReturnType<typeof httpRequest>
  res: Promise<IncomingMessage>
} {
  const req = httpRequest({
    host: server.host,
    port: server.port,
    method: 'GET',
    path: '/',
  })
  const res = new Promise<IncomingMessage>((resolve, reject) => {
    req.once('response', resolve)
    req.once('error', reject)
  })
  req.end()
  return { req, res }
}

/** Read up to `n` bytes (or until the response ends), then resolve. */
function readChunk(res: IncomingMessage, n: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = ''
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('utf8')
      if (buf.length >= n) {
        cleanup()
        resolve(buf)
      }
    }
    const onEnd = (): void => {
      cleanup()
      resolve(buf)
    }
    const onErr = (err: Error): void => {
      cleanup()
      reject(err)
    }
    const cleanup = (): void => {
      res.off('data', onData)
      res.off('end', onEnd)
      res.off('error', onErr)
    }
    res.on('data', onData)
    res.on('end', onEnd)
    res.on('error', onErr)
  })
}

// (no `delay` helper — tests await stream events directly)

describe('sse() — single helper', () => {
  it('writes one event with the right format', async () => {
    const server = await startServer((ctx) => {
      const stream = sse(ctx)
      stream.send({ data: 'hello' })
      // Close after a microtask so the chunk flushes.
      setTimeout(() => stream.close(), 5)
    })

    const { req, res } = getRequest(server)
    const response = await res
    expect(response.headers['content-type']).toMatch(/text\/event-stream/)
    expect(response.headers['cache-control']).toBe('no-cache')
    expect(response.headers['x-accel-buffering']).toBe('no')

    const body = await readChunk(response, 1)
    expect(body).toBe('data: hello\n\n')

    // Close the client socket so the server's keep-alive connection (Node
    // defaults keepAliveTimeout to 5s) doesn't hold server.close() open.
    req.destroy()
    await server.close()
  })

  it('splits multi-line data into multiple data: lines', async () => {
    const server = await startServer((ctx) => {
      const stream = sse(ctx)
      stream.send({ data: 'line one\nline two\nline three' })
      setTimeout(() => stream.close(), 5)
    })

    const { req, res } = getRequest(server)
    const response = await res
    const body = await readChunk(response, 1)
    expect(body).toBe('data: line one\ndata: line two\ndata: line three\n\n')

    // Close the client socket so the server's keep-alive connection (Node
    // defaults keepAliveTimeout to 5s) doesn't hold server.close() open.
    req.destroy()
    await server.close()
  })

  it('emits event-name and id fields', async () => {
    const server = await startServer((ctx) => {
      const stream = sse(ctx)
      stream.send({ event: 'ping', id: '42', data: 'pong' })
      setTimeout(() => stream.close(), 5)
    })

    const { req, res } = getRequest(server)
    const response = await res
    const body = await readChunk(response, 1)
    expect(body).toBe('event: ping\nid: 42\ndata: pong\n\n')

    // Close the client socket so the server's keep-alive connection (Node
    // defaults keepAliveTimeout to 5s) doesn't hold server.close() open.
    req.destroy()
    await server.close()
  })

  it('JSON-serializes object data', async () => {
    const server = await startServer((ctx) => {
      const stream = sse(ctx)
      stream.send({ data: { hello: 'world', n: 1 } })
      setTimeout(() => stream.close(), 5)
    })

    const { req, res } = getRequest(server)
    const response = await res
    const body = await readChunk(response, 1)
    expect(body).toBe(`data: ${JSON.stringify({ hello: 'world', n: 1 })}\n\n`)

    // Close the client socket so the server's keep-alive connection (Node
    // defaults keepAliveTimeout to 5s) doesn't hold server.close() open.
    req.destroy()
    await server.close()
  })

  it('close() ends the stream so the client sees EOF', async () => {
    const server = await startServer((ctx) => {
      const stream = sse(ctx)
      stream.send('bye')
      stream.close()
    })

    const { req, res } = getRequest(server)
    const response = await res
    let ended = false
    response.on('end', () => {
      ended = true
    })
    response.resume()
    await new Promise<void>((resolve) => response.once('end', resolve))
    expect(ended).toBe(true)

    // Close the client socket so the server's keep-alive connection (Node
    // defaults keepAliveTimeout to 5s) doesn't hold server.close() open.
    req.destroy()
    await server.close()
  })

  it('bare string send() shortcut', async () => {
    const server = await startServer((ctx) => {
      const stream = sse(ctx)
      stream.send('quick')
      setTimeout(() => stream.close(), 5)
    })

    const { req, res } = getRequest(server)
    const response = await res
    const body = await readChunk(response, 1)
    expect(body).toBe('data: quick\n\n')

    // Close the client socket so the server's keep-alive connection (Node
    // defaults keepAliveTimeout to 5s) doesn't hold server.close() open.
    req.destroy()
    await server.close()
  })
})

describe('startKeepAlive()', () => {
  it('emits :keepalive comments at the configured interval', async () => {
    let capturedStream: SseStream | null = null

    const server = await startServer((ctx) => {
      const stream = sse(ctx)
      capturedStream = stream
      const cancel = startKeepAlive(stream, 50)
      // Hold the stream open for the duration of the test.
      setTimeout(() => {
        cancel()
        stream.close()
      }, 250)
    })

    const { req, res } = getRequest(server)
    const response = await res

    let body = ''
    response.on('data', (c: Buffer) => {
      body += c.toString('utf8')
    })
    await new Promise<void>((resolve) => response.once('end', resolve))

    // 250ms / 50ms ≈ 4 ticks (allowing for jitter).
    const matches = body.match(/: keepalive\n\n/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(2)
    expect((capturedStream as SseStream | null)?.closed).toBe(true)

    // Close the client socket so the server's keep-alive connection (Node
    // defaults keepAliveTimeout to 5s) doesn't hold server.close() open.
    req.destroy()
    await server.close()
  })

  it('cancellation function stops further keepalives', async () => {
    const server = await startServer((ctx) => {
      const stream = sse(ctx)
      const cancel = startKeepAlive(stream, 30)
      // Cancel almost immediately, hold the stream open a bit, then close.
      setTimeout(cancel, 10)
      setTimeout(() => stream.close(), 200)
    })

    const { req, res } = getRequest(server)
    const response = await res

    let body = ''
    response.on('data', (c: Buffer) => {
      body += c.toString('utf8')
    })
    await new Promise<void>((resolve) => response.once('end', resolve))

    // We cancelled before the first 30ms tick fired — should be 0 or maybe 1.
    const matches = body.match(/: keepalive\n\n/g) ?? []
    expect(matches.length).toBeLessThanOrEqual(1)

    // Close the client socket so the server's keep-alive connection (Node
    // defaults keepAliveTimeout to 5s) doesn't hold server.close() open.
    req.destroy()
    await server.close()
  })
})
