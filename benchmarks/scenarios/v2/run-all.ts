import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { DISCLAIMER, runScenario } from './_runner.ts'
import { buildPayload, PAYLOAD_1KB, PAYLOAD_100KB } from './_servers/_payload.ts'

const here = dirname(fileURLToPath(import.meta.url))
const srv = (name: string) => resolve(here, '_servers', name)

console.log('')
console.log('=========================================================================')
console.log(' Ingenium bench v2 — multi-framework, multi-process, multi-sample')
console.log('=========================================================================')
console.log('')
console.log(`DISCLAIMER: ${DISCLAIMER}`)
console.log('')

const body = JSON.stringify({ name: 'world' })
const headers = { 'content-type': 'application/json' }

await runScenario(
  'hello (GET / -> {ok:true})',
  [
    { name: 'Express', file: srv('express-hello.ts') },
    { name: 'Fastify', file: srv('fastify-hello.ts') },
    { name: 'Hono', file: srv('hono-hello.ts') },
    { name: 'Ingenium', file: srv('rift-hello.ts') },
  ],
)

await runScenario(
  'body-json (POST /echo with JSON body)',
  [
    { name: 'Express', file: srv('express-body.ts'), path: '/echo', method: 'POST', body, headers },
    { name: 'Fastify', file: srv('fastify-body.ts'), path: '/echo', method: 'POST', body, headers },
    { name: 'Hono', file: srv('hono-body.ts'), path: '/echo', method: 'POST', body, headers },
    { name: 'Ingenium', file: srv('rift-body.ts'), path: '/echo', method: 'POST', body, headers },
  ],
)

await runScenario(
  'middleware-stack (10 mw layers, GET /)',
  [
    { name: 'Express', file: srv('express-middleware.ts') },
    { name: 'Fastify', file: srv('fastify-middleware.ts') },
    { name: 'Hono', file: srv('hono-middleware.ts') },
    { name: 'Ingenium', file: srv('rift-middleware.ts') },
  ],
)

// Deterministic, in-process payloads (no committed fixtures).
const payload1kb = buildPayload(PAYLOAD_1KB)
console.log(`### payload-1kb body size: ${payload1kb.bytes} bytes (${payload1kb.object.items.length} items)`)

await runScenario(
  'payload-1kb (POST /echo, ~1KB JSON body)',
  [
    { name: 'Express', file: srv('express-payload-1kb.ts'), path: '/echo', method: 'POST', body: payload1kb.json, headers },
    { name: 'Fastify', file: srv('fastify-payload-1kb.ts'), path: '/echo', method: 'POST', body: payload1kb.json, headers },
    { name: 'Hono', file: srv('hono-payload-1kb.ts'), path: '/echo', method: 'POST', body: payload1kb.json, headers },
    { name: 'Ingenium', file: srv('rift-payload-1kb.ts'), path: '/echo', method: 'POST', body: payload1kb.json, headers },
  ],
)

const payload100kb = buildPayload(PAYLOAD_100KB)
console.log(`### payload-100kb body size: ${payload100kb.bytes} bytes (${payload100kb.object.items.length} items)`)

await runScenario(
  'payload-100kb (POST /echo, ~100KB JSON body)',
  [
    { name: 'Express', file: srv('express-payload-100kb.ts'), path: '/echo', method: 'POST', body: payload100kb.json, headers },
    { name: 'Fastify', file: srv('fastify-payload-100kb.ts'), path: '/echo', method: 'POST', body: payload100kb.json, headers },
    { name: 'Hono', file: srv('hono-payload-100kb.ts'), path: '/echo', method: 'POST', body: payload100kb.json, headers },
    { name: 'Ingenium', file: srv('rift-payload-100kb.ts'), path: '/echo', method: 'POST', body: payload100kb.json, headers },
  ],
)

console.log('')
console.log(`DISCLAIMER: ${DISCLAIMER}`)
console.log('')
