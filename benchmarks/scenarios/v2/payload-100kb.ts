import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { runScenario } from './_runner.ts'
import { buildPayload, PAYLOAD_100KB } from './_servers/_payload.ts'

const here = dirname(fileURLToPath(import.meta.url))
const srv = (name: string) => resolve(here, '_servers', name)

// Deterministic ~100KB JSON request body, built in-process (no committed fixture).
const payload = buildPayload(PAYLOAD_100KB)
const body = payload.json
const headers = { 'content-type': 'application/json' }

console.log(`### payload-100kb body size: ${payload.bytes} bytes (${payload.object.items.length} items)`)

await runScenario(
  'payload-100kb (POST /echo, ~100KB JSON body)',
  [
    { name: 'Express', file: srv('express-payload-100kb.ts'), path: '/echo', method: 'POST', body, headers },
    { name: 'Fastify', file: srv('fastify-payload-100kb.ts'), path: '/echo', method: 'POST', body, headers },
    { name: 'Hono', file: srv('hono-payload-100kb.ts'), path: '/echo', method: 'POST', body, headers },
    { name: 'Ingenium', file: srv('rift-payload-100kb.ts'), path: '/echo', method: 'POST', body, headers },
  ],
)
