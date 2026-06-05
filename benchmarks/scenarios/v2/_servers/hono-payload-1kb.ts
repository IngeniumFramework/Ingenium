import { serve } from '@hono/node-server'
import { Hono } from 'hono'

const app = new Hono()
app.post('/echo', async (c) => {
  const body = await c.req.json<{ items?: unknown[] }>().catch(() => ({}))
  return c.json({ items: body?.items, processedAt: Date.now() })
})

const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
  process.stdout.write(`READY:${info.port}\n`)
})

process.on('SIGTERM', () => {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1_000).unref()
})
process.on('SIGINT', () => process.exit(0))
