import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { runScenario } from './_runner.ts'
import { buildPayload, PAYLOAD_1KB } from './_servers/_payload.ts'

const here = dirname(fileURLToPath(import.meta.url))
const srv = (name: string) => resolve(here, '_servers', name)

// Deterministic ~1KB JSON request body, built in-process (no committed fixture).
const payload = buildPayload(PAYLOAD_1KB)
const body = payload.json
const headers = { 'content-type': 'application/json' }

console.log(`### payload-1kb body size: ${payload.bytes} bytes (${payload.object.items.length} items)`)

await runScenario(
  'payload-1kb (POST /echo, ~1KB JSON body)',
  [
    { name: 'Express', file: srv('express-payload-1kb.ts'), path: '/echo', method: 'POST', body, headers },
    { name: 'Fastify', file: srv('fastify-payload-1kb.ts'), path: '/echo', method: 'POST', body, headers },
    { name: 'Hono', file: srv('hono-payload-1kb.ts'), path: '/echo', method: 'POST', body, headers },
    { name: 'Ingenium', file: srv('rift-payload-1kb.ts'), path: '/echo', method: 'POST', body, headers },
  ],
)
