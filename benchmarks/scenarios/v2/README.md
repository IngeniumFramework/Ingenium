# Bench v2 methodology

This directory replaces v1's same-process, single-shot, two-framework comparison
with a methodology that is at least defensible as a *local regression detector*.

## What v2 does differently

1. **Separate child processes per framework.** Each framework's server runs in
   its own `node --experimental-strip-types` child process spawned by the
   runner. v1 booted Express and Ingenium in the same Node process, which
   meant their V8 hidden classes, JIT caches, GC pressure, and module-init
   timing were entangled. The second framework was effectively benchmarking
   the steady-state of the first.
2. **5 samples per framework, plus one warmup.** v1 took a single 10s shot.
   v2 takes one warmup run (discarded) then 5 independent runs and reports
   mean, std-dev, median, and p99 across them. A run with a std-dev wider than
   ~5% of the mean should not be quoted as a comparison.
3. **Std-dev reported.** A delta smaller than 1 std-dev across runs is noise.
   The table makes that visible.
4. **Four frameworks compared.** Express, Fastify, Hono, and Ingenium.
   Comparing only against Express makes any "win" trivial; including Fastify
   and Hono prevents that.
5. **Frameworks pinned at EXACT versions in `benchmarks/package.json`.** v1
   would silently drift if Express minor-bumped. v2 dependencies are now pinned
   with no `^`/`~` (see the `//competitor-pins` note in `package.json`): a silent
   minor bump of a competitor would shift the baseline and make a regression
   indistinguishable from an upstream change. Comparative numbers are only
   meaningful against pinned deps. Bump competitor versions deliberately, in
   their own commit, so the version delta is reviewable alongside any movement.
6. **Server RSS reported per framework.** The table includes a `server RSS (MB)`
   column. The runner samples the SERVER child process's resident set size via
   `ps -o rss= -p <pid>` at steady state (right after the last autocannon
   sample, before SIGTERM). Because each framework runs in its own child
   process, this is the framework-under-test's memory — not the harness's — so
   it is comparable across the matrix. It is best-effort: on any failure (no
   `ps`, Windows, race with process exit) the cell prints `n/a` and the run is
   not failed. RSS is a coarse signal — it reflects V8 heap + native + GC
   timing, not steady-state working set — so treat it the same way as the
   throughput numbers: a regression detector, not a publishable claim.

## What v2 still does NOT do

These are the reasons numbers from v2 are still **not** publishable:

- No CPU pinning (`taskset` / Windows affinity).
- No isolated hardware — laptop runs include browser tabs, Slack, Spotlight, etc.
- The autocannon driver, the framework, and the OS scheduler all share cores.
- No P-state / turbo boost lockdown.
- Single sample size (`-c 100 -d 5`) — production-grade benchmarks sweep
  connection counts and durations.
- No baseline phase that re-measures the same framework periodically across the
  run to detect drift.
- No statistical significance testing (no t-test, no confidence intervals).

## The mandatory disclaimer

> These are local-developer-machine numbers. They are NOT publishable
> performance claims. Treat as regression detectors. For comparable production
> numbers, use isolated hardware with CPU pinning, multiple sample sizes,
> baseline + warmup phases, and pinned framework versions, all under
> continuous monitoring across runs.

This paragraph is also printed to stdout at the start and end of every v2 run
so anyone reading a CI log sees it before reading the numbers.

## Running

```
# All scenarios:
npm run bench:v2

# One scenario:
npm run bench:hello-v2
npm run bench:body-v2
npm run bench:middleware-v2
npm run bench:payload-1kb-v2
npm run bench:payload-100kb-v2
```

## Scenarios

| Scenario      | Shape                                              |
| ------------- | -------------------------------------------------- |
| `hello`       | `GET /` returning a tiny JSON object.              |
| `body`        | `POST /echo` echoing a small JSON body.            |
| `middleware`  | `GET /` through 10 middleware layers.              |
| `payload-1kb` | `POST /echo` echoing a deterministic ~1KB JSON body.   |
| `payload-100kb` | `POST /echo` echoing a deterministic ~100KB JSON body. |

The payload scenarios build their request bodies in-process from a fixed seed
(`_servers/_payload.ts`) — no fixture file is committed. The builder repeats a
known record until the serialized JSON crosses the target byte size, so every
framework echoes byte-identical bytes and the only variable is the framework.
The actual byte size (always slightly over the target, e.g. ~1087 / ~102443
bytes) is printed before each run.

## Server contract

Each `_servers/*.ts` file:

1. Boots its framework on `127.0.0.1:0` (ephemeral port).
2. Prints exactly `READY:<port>\n` to stdout once listening.
3. Registers `process.on('SIGTERM', () => process.exit(0))` for graceful exit.

The runner reads stdout line-by-line until it sees the `READY:` line, then
runs autocannon against `http://127.0.0.1:<port>`. After the last sample it
sends `SIGTERM` and waits for the child to exit (with a 3s `SIGKILL` fallback).
