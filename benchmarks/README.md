# Ingenium Benchmarks

Local regression benchmarks comparing Ingenium against Express, Fastify, and
Hono on identical workloads, runs `autocannon` against each, and prints a
side-by-side comparison.

There are two suites:

- **v2 (use this)** — each framework runs in its own child process; 1 warmup +
  5 sampled runs per framework; mean / std-dev / median / p99 reported; Express,
  Fastify, Hono, and Ingenium compared. Lives in [`scenarios/v2/`](scenarios/v2)
  with its own [methodology README](scenarios/v2/README.md). Run with the
  `*-v2` scripts below.
- **v1 (deprecated)** — booted Express and Ingenium in the *same* Node process
  and took a single 10s shot, so the second framework was effectively
  benchmarking the steady-state of the first. Kept only for historical
  comparison; prefer v2 for any new measurement.

## Mandatory disclaimer

> These benchmarks are run on a developer machine and are NOT publishable
> performance claims. Production-grade comparison numbers require dedicated
> isolated hardware (no other processes), thermal-stable environment, multiple
> runs with std-dev reported, and Express/Fastify/Hono baselines pinned to
> deliberate, reviewable versions (see the `//competitor-pins` note in
> `package.json`). Treat these scenarios as regression detectors during
> development, not marketing material.

## Scenarios (v2 — recommended)

Separate-process, multi-sample, four-framework matrix (Express, Fastify, Hono,
Ingenium). See [`scenarios/v2/README.md`](scenarios/v2/README.md) for the full
methodology and the server contract.

| Scenario        | Command                       | What it measures                                       |
| --------------- | ----------------------------- | ------------------------------------------------------ |
| `hello`         | `npm run bench:hello-v2`      | `GET /` returning a tiny JSON object.                  |
| `body`          | `npm run bench:body-v2`       | `POST /echo` echoing a small JSON body.                |
| `middleware`    | `npm run bench:middleware-v2` | `GET /` through 10 middleware layers.                  |
| `payload-1kb`   | `npm run bench:payload-1kb-v2`   | `POST /echo` echoing a deterministic ~1KB JSON body.   |
| `payload-100kb` | `npm run bench:payload-100kb-v2` | `POST /echo` echoing a deterministic ~100KB JSON body. |

Run all v2 scenarios sequentially:

```sh
npm run bench:v2
```

The payload bodies are built in-process from a fixed seed (no committed
fixtures), so every framework echoes byte-identical bytes; the actual byte size
is printed before each run.

## Scenarios (v1 — deprecated, same-process)

| Script                | Command                    | What it measures                                      |
| --------------------- | -------------------------- | ----------------------------------------------------- |
| `hello.ts`            | `npm run bench:hello`      | Bare `GET /` JSON response — router + serializer.     |
| `body-json.ts`        | `npm run bench:body`       | `POST /echo` with JSON parsing + echo timestamp.      |
| `middleware-stack.ts` | `npm run bench:middleware` | 10-layer middleware chain overhead per request.       |
| `error-path.ts`       | `npm run bench:errors`     | Cost of routing through the framework error boundary. |

Run all v1 scenarios sequentially:

```sh
npm run bench:all
```

## autocannon configuration

- **v2**: `-c 100 -d 5` per run, with one discarded warmup run plus 5 sampled
  runs per framework. Each framework runs in its own child process bound to
  `127.0.0.1:0`; the runner reads `READY:<port>` from the child's stdout, then
  drives autocannon against it.
- **v1**: `-c 100 -d 10`, single shot, both frameworks in the same process,
  bound to `127.0.0.1` on an OS-assigned ephemeral port (`port: 0`).

Reported metrics per scenario:

- v2 reports, across the 5 sampled runs per framework: requests/sec
  (mean, std-dev, median), latency p99, and best-effort `server RSS (MB)`
  sampled from the framework's own child process. A delta smaller than 1
  std-dev is noise; a run with std-dev wider than ~5% of the mean should not be
  quoted.
- v1 reports a single run's `Requests/sec (avg)`, `Latency p50`/`p99`/`avg`
  (ms), `Throughput` (bytes/sec), `Total requests`/`Errors`/`Non-2xx`/
  `Timeouts`, and an Ingenium-vs-Express ratio column.

## Methodology

### Hardware spec template (fill in before sharing any numbers)

```
CPU:           <model, base GHz, core count>
Memory:        <GB, type, speed>
OS:            <name + version>
Node version:  <e.g. 20.18.0>
Ingenium:   <commit SHA from packages/ingenium>
Express:       <version pinned in benchmarks/package.json>
Background load: <what else was running on the machine>
Power profile: <e.g. plugged in, performance mode, no throttling>
```

### How to interpret results

- **Single-run numbers are noisy.** Run each scenario at least 3-5 times and
  look at trends, not point values. autocannon's own averages already smooth
  within a run, but run-to-run variance on a developer machine is real.
- **Latency p99 matters more than requests/sec** for tail-sensitive workloads.
  A higher mean throughput with a worse p99 is often a regression in disguise.
- **Throughput differences in the `body-json` scenario** primarily reflect
  body-parser overhead, not raw routing — interpret accordingly.
- **The `error-path` scenario produces non-2xx responses on purpose.** Both
  frameworks return `500` from their error boundary; autocannon's `Non-2xx`
  counter is expected to roughly equal `Total requests`.
- **A `Rift / Express` ratio of `1.000x` means parity.** Above 1.0 means Rift
  did more (or had higher latency, depending on the metric). Read the metric
  name carefully — for latency, lower is better; for throughput, higher is
  better.

### What this suite is for

- Catching regressions in the Ingenium core during development.
- Sanity-checking that a change didn't accidentally make the hot path slower.
- Comparing two Ingenium commits against each other (run the suite on
  baseline, then on the change branch, diff the tables).

### What this suite is NOT for

- Marketing claims.
- Cross-framework leaderboards.
- Decisions about adopting Ingenium in production.

For any of those, use a dedicated benchmark harness on isolated hardware with
multiple frameworks at their latest pinned versions, multiple runs, std-dev
reporting, and warmup phases that this suite does not perform.

## Files

```
benchmarks/
  package.json
  README.md
  scenarios/
    _shared.ts              # v1 autocannon runner + comparison printer
    hello.ts                # v1 (deprecated, same-process)
    body-json.ts
    middleware-stack.ts
    error-path.ts
    v2/                     # v2 (recommended, separate-process, multi-sample)
      README.md             # v2 methodology + server contract
      _runner.ts            # spawns each framework, samples 5 runs, prints table
      run-all.ts            # bench:v2 entry — runs every scenario
      hello.ts
      body.ts
      middleware.ts
      payload-1kb.ts
      payload-100kb.ts
      _servers/             # one server file per framework × scenario
        _payload.ts         # deterministic in-process payload builder
        {express,fastify,hono,rift}-{hello,body,middleware,payload-1kb,payload-100kb}.ts
```

(The Ingenium server files are named `rift-*.ts` — a holdover from the
framework's former name.)
