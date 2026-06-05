import autocannon from 'autocannon'
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Methodology disclaimer printed for every v2 run. Echoed in stdout (not just
 * the README) so anyone scrolling a CI log sees it before reading the table.
 */
export const DISCLAIMER =
  'These are local-developer-machine numbers. They are NOT publishable performance claims. ' +
  'Treat as regression detectors. For comparable production numbers, use isolated hardware ' +
  'with CPU pinning, multiple sample sizes, baseline + warmup phases, and pinned framework ' +
  'versions, all under continuous monitoring across runs.'

export interface FrameworkSpec {
  /** Display name, used for the table header. */
  name: string
  /** Absolute or relative path to the server entry file. */
  file: string
  /**
   * Path the autocannon HTTP request hits, e.g. `/` or `/echo`. Defaults to `/`.
   */
  path?: string
  /** HTTP method. Default GET. */
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Request body for POST/PUT/PATCH. */
  body?: string
  /** Request headers. */
  headers?: Record<string, string>
}

export interface RunOptions {
  /** Connections passed to autocannon (-c). Default 100. */
  connections?: number
  /** Duration per run in seconds passed to autocannon (-d). Default 5. */
  duration?: number
  /** How many independent autocannon runs to take per framework. Default 5. */
  samples?: number
  /** Warmup run discarded from stats. Default true. */
  warmup?: boolean
}

interface SampleStats {
  mean: number
  stdDev: number
  median: number
  p99: number
  min: number
  max: number
  samples: number[]
}

interface FrameworkResult {
  framework: string
  rps: SampleStats
  latencyP99Ms: SampleStats
  /**
   * Resident set size of the SERVER child process, in MB, sampled at steady
   * state (right after the last autocannon sample, before SIGTERM). This is the
   * actual framework-under-test process — not the harness — so it is comparable
   * across the matrix. NaN if the OS query failed (it is best-effort).
   */
  rssMb: number
}

/**
 * Boot a framework server in its own Node child process, run autocannon
 * against it `samples` times, then SIGTERM it. Each framework runs in a fresh
 * process so V8 deopt state, JIT caches, and module-init costs are isolated.
 */
export async function runScenario(
  scenarioName: string,
  frameworks: FrameworkSpec[],
  options: RunOptions = {},
): Promise<void> {
  const connections = options.connections ?? 100
  const duration = options.duration ?? 5
  const samples = options.samples ?? 5
  const warmup = options.warmup ?? true

  console.log('')
  console.log(`### Scenario: ${scenarioName}`)
  console.log(`### autocannon: -c ${connections} -d ${duration}, samples=${samples}, warmup=${warmup}`)
  console.log(`### Node ${process.version} on ${process.platform} ${process.arch}`)
  console.log('')
  console.log(`DISCLAIMER: ${DISCLAIMER}`)
  console.log('')

  const results: FrameworkResult[] = []

  for (const fw of frameworks) {
    console.log(`--- ${fw.name} ---`)
    const proc = await bootServer(fw.file)
    try {
      const url = `http://127.0.0.1:${proc.port}${fw.path ?? '/'}`

      if (warmup) {
        console.log(`  warmup run (discarded)...`)
        await runAutocannonOnce(url, {
          connections,
          duration,
          method: fw.method,
          body: fw.body,
          headers: fw.headers,
        })
      }

      const rpsSamples: number[] = []
      const p99Samples: number[] = []

      for (let s = 1; s <= samples; s++) {
        process.stdout.write(`  sample ${s}/${samples}... `)
        const r = await runAutocannonOnce(url, {
          connections,
          duration,
          method: fw.method,
          body: fw.body,
          headers: fw.headers,
        })
        rpsSamples.push(r.rps)
        p99Samples.push(r.latencyP99Ms)
        console.log(`rps=${r.rps.toFixed(0)}, p99=${r.latencyP99Ms.toFixed(2)}ms`)
      }

      // Sample the SERVER child's RSS at steady state (after load, before kill).
      const rssMb = await readChildRssMb(proc.child.pid)
      console.log(`  server RSS: ${Number.isFinite(rssMb) ? rssMb.toFixed(1) + ' MB' : 'n/a'}`)

      results.push({
        framework: fw.name,
        rps: stats(rpsSamples),
        latencyP99Ms: stats(p99Samples),
        rssMb,
      })
    } finally {
      await killServer(proc.child)
    }
  }

  printTable(scenarioName, results)
  console.log('')
  console.log(`DISCLAIMER: ${DISCLAIMER}`)
  console.log('')
}

interface BootedServer {
  child: ChildProcessWithoutNullStreams
  port: number
}

/**
 * Spawn `node --experimental-strip-types <file>` and wait for the server to
 * print `READY:<port>` to stdout. Stderr is forwarded so server errors are
 * visible. The child must `process.on('SIGTERM', () => process.exit(0))` for
 * clean shutdown.
 */
function bootServer(file: string): Promise<BootedServer> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--experimental-strip-types', file], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    }) as ChildProcessWithoutNullStreams

    let resolved = false
    const rl = createInterface({ input: child.stdout })

    const fail = (err: Error) => {
      if (resolved) return
      resolved = true
      try {
        child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      reject(err)
    }

    rl.on('line', (line) => {
      if (resolved) return
      const m = /^READY:(\d+)$/.exec(line)
      if (m) {
        resolved = true
        rl.close()
        resolve({ child, port: Number(m[1]) })
      }
    })

    child.stderr.on('data', (chunk) => {
      // Surface server errors to the test runner stdout for debuggability.
      process.stderr.write(`[child stderr] ${chunk}`)
    })

    child.once('exit', (code, signal) => {
      if (!resolved) {
        fail(new Error(`Server process exited before READY (code=${code}, signal=${signal})`))
      }
    })

    child.once('error', fail)

    // Generous boot timeout — if a server can't bind in 15s, it's broken.
    setTimeout(() => fail(new Error(`Timed out waiting for READY from ${file}`)), 15_000).unref()
  })
}

/**
 * Read the resident set size (RSS) of the server child process via the OS.
 *
 * WHY shell out to `ps` instead of `process.memoryUsage()`: the server runs in
 * its OWN child process, so the harness's `process.memoryUsage()` would report
 * the harness's memory, not the framework-under-test's. `ps -o rss= -p <pid>`
 * gives the child's actual RSS. This works on linux + darwin (CI is ubuntu),
 * where `ps` reports RSS in kilobytes. Best-effort: on any failure (no `ps`,
 * Windows, race with exit) it returns NaN and the table prints `n/a` rather
 * than failing the run — RSS is a nice-to-have signal, not a gate.
 */
async function readChildRssMb(pid: number | undefined): Promise<number> {
  if (!pid) return NaN
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', String(pid)])
    const kb = Number.parseInt(stdout.trim(), 10)
    if (!Number.isFinite(kb)) return NaN
    return kb / 1024
  } catch {
    return NaN
  }
}

function killServer(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    const onExit = () => resolve()
    child.once('exit', onExit)
    try {
      child.kill('SIGTERM')
    } catch {
      resolve()
      return
    }
    // Forced fallback if the child ignores SIGTERM (shouldn't happen with our shutdown handler).
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }
    }, 3_000).unref()
  })
}

interface SingleRun {
  rps: number
  latencyP99Ms: number
}

async function runAutocannonOnce(
  url: string,
  opts: {
    connections: number
    duration: number
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    body?: string
    headers?: Record<string, string>
  },
): Promise<SingleRun> {
  const result = await autocannon({
    url,
    connections: opts.connections,
    duration: opts.duration,
    method: opts.method ?? 'GET',
    body: opts.body,
    headers: opts.headers,
  })
  return {
    rps: result.requests.average,
    latencyP99Ms: result.latency.p99,
  }
}

function stats(values: number[]): SampleStats {
  const n = values.length
  if (n === 0) {
    return { mean: NaN, stdDev: NaN, median: NaN, p99: NaN, min: NaN, max: NaN, samples: [] }
  }
  const sorted = [...values].sort((a, b) => a - b)
  const mean = values.reduce((a, b) => a + b, 0) / n
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n
  const stdDev = Math.sqrt(variance)
  const median = sorted[Math.floor(n / 2)]!
  const p99 = sorted[Math.min(n - 1, Math.floor(n * 0.99))]!
  return {
    mean,
    stdDev,
    median,
    p99,
    min: sorted[0]!,
    max: sorted[n - 1]!,
    samples: values,
  }
}

function fmt(n: number, decimals = 2): string {
  if (!Number.isFinite(n)) return 'n/a'
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

function printTable(scenario: string, results: FrameworkResult[]): void {
  const header: string[] = [
    'Framework',
    'RPS mean',
    'RPS stddev',
    'RPS median',
    'RPS p99',
    'p99 lat (ms) mean',
    'server RSS (MB)',
  ]
  const rows: string[][] = [header]
  for (const r of results) {
    rows.push([
      r.framework,
      fmt(r.rps.mean, 0),
      fmt(r.rps.stdDev, 0),
      fmt(r.rps.median, 0),
      fmt(r.rps.p99, 0),
      fmt(r.latencyP99Ms.mean),
      fmt(r.rssMb, 1),
    ])
  }
  const widths = header.map((_, c) => rows.reduce((m, row) => Math.max(m, row[c]!.length), 0))
  const sep = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+'
  const render = (row: string[]) =>
    '| ' + row.map((cell, i) => cell.padEnd(widths[i]!)).join(' | ') + ' |'

  console.log('')
  console.log(`=== ${scenario} ===`)
  console.log(sep)
  console.log(render(rows[0]!))
  console.log(sep)
  for (let i = 1; i < rows.length; i++) console.log(render(rows[i]!))
  console.log(sep)
}
