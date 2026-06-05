import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      // In dev, resolve workspace bare specifiers to source so we don't need a build step.
      'ingenium-compat': here('./packages/ingenium-compat/src/index.ts'),
      'ingenium-bun': here('./packages/ingenium-bun/src/index.ts'),
      'ingenium-cli': here('./packages/ingenium-cli/src/cli.ts'),
      'ingenium-redis': here('./packages/ingenium-redis/src/index.ts'),
      'ingenium-auth': here('./packages/ingenium-auth/src/index.ts'),
      ingenium: here('./packages/ingenium/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 10_000,
  },
})
