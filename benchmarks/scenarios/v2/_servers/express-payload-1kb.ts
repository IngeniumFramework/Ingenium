import express from 'express'

const app = express()
app.use(express.json({ limit: '1mb' }))
app.post('/echo', (req, res) => {
  const body = req.body as { items?: unknown[] }
  res.json({ items: body?.items, processedAt: Date.now() })
})

const server = app.listen(0, '127.0.0.1', () => {
  const addr = server.address()
  if (!addr || typeof addr === 'string') {
    process.stderr.write('failed to bind ephemeral port\n')
    process.exit(1)
  }
  process.stdout.write(`READY:${addr.port}\n`)
})

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
