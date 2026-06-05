import { describe, it, expect, afterEach, vi } from 'vitest'
import type { IngeniumContext } from '../src/context/context.ts'
import type { ResolvedProblemDetailsOptions } from '../src/problem/types.ts'

/**
 * Regression: an UNKNOWN (non-IngeniumError) error must not leak its raw
 * `message` (which can carry DB DSNs, hostnames, credentials, file paths) into
 * the 500 ProblemDetails `detail` in production. IngeniumError messages are
 * developer-authored and intentionally preserved.
 *
 * `IS_DEV` in serialize.ts is read once at module load, so each NODE_ENV case
 * resets the module registry and re-imports a fresh instance. `IngeniumError`
 * is pulled from the SAME freshly-reset graph so the `instanceof` check inside
 * serialize.ts matches the error we construct here.
 */

const baseOpts: ResolvedProblemDetailsOptions = {
  typeBaseUrl: 'about:blank',
  includeStack: false,
  instance: () => undefined,
}

const ctx = {} as IngeniumContext

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function loadFresh(env: string) {
  vi.resetModules()
  vi.stubEnv('NODE_ENV', env)
  // Import serialize first (which pulls in errors.ts), then read the same
  // cached errors.ts instance so the two share one IngeniumError class.
  const mod = await import('../src/problem/serialize.ts')
  const errMod = await import('../src/errors.ts')
  return { toProblemDetails: mod.toProblemDetails, IngeniumError: errMod.IngeniumError }
}

describe('security: unknown-error message leak in ProblemDetails', () => {
  const SECRET = 'connect ECONNREFUSED postgres://admin:hunter2@10.0.0.5:5432/prod'

  it('hides the raw message in production', async () => {
    const { toProblemDetails } = await loadFresh('production')
    const problem = toProblemDetails(new Error(SECRET), baseOpts, ctx)
    expect(problem.status).toBe(500)
    expect(problem.detail).toBe('Internal Server Error')
    expect(JSON.stringify(problem)).not.toContain('hunter2')
  })

  it('surfaces the raw message in production when includeStack is enabled', async () => {
    const { toProblemDetails } = await loadFresh('production')
    const problem = toProblemDetails(new Error(SECRET), { ...baseOpts, includeStack: true }, ctx)
    expect(problem.detail).toBe(SECRET)
  })

  it('surfaces the raw message in development', async () => {
    const { toProblemDetails } = await loadFresh('development')
    const problem = toProblemDetails(new Error(SECRET), baseOpts, ctx)
    expect(problem.detail).toBe(SECRET)
  })

  it('still exposes developer-authored IngeniumError messages in production', async () => {
    const { toProblemDetails, IngeniumError } = await loadFresh('production')
    const devMessage = 'Account is locked'
    const err = new IngeniumError(403, 'ACCOUNT_LOCKED', devMessage)
    const problem = toProblemDetails(err, baseOpts, ctx)
    expect(problem.status).toBe(403)
    expect(problem.detail).toBe(devMessage)
  })
})
