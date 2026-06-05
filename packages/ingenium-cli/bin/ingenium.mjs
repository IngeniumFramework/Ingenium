#!/usr/bin/env node
// Shim entry for `ingenium`. Spawns Node 22+ with native TS stripping pointed at
// the source CLI. This avoids a build step entirely.
//
// Requires Node >= 22 (for --experimental-strip-types).

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import process from 'node:process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const cliPath = resolve(__dirname, '..', 'src', 'cli.ts')

const args = process.argv.slice(2)
const child = spawn(
  process.execPath,
  ['--experimental-strip-types', '--no-warnings=ExperimentalWarning', cliPath, ...args],
  { stdio: 'inherit' },
)

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})

child.on('error', (err) => {
  console.error('ingenium: failed to launch CLI:', err.message)
  process.exit(1)
})
