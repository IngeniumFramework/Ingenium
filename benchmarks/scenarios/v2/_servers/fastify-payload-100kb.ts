import Fastify from 'fastify'

const app = Fastify({ logger: false, bodyLimit: 1_048_576 })
app.post('/echo', async (req) => {
  const body = req.body as { items?: unknown[] } | undefined
  return { items: body?.items, processedAt: Date.now() }
})

app.listen({ port: 0, host: '127.0.0.1' })
  .then((address) => {
    const port = Number(address.split(':').pop())
    process.stdout.write(`READY:${port}\n`)
  })
  .catch((err) => {
    process.stderr.write(`fastify failed to listen: ${err}\n`)
    process.exit(1)
  })

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
