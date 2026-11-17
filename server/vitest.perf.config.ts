import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * On-demand performance check at scale (tasks.md T143; SC-013):
 * `pnpm --filter @tasklite/server perf`. Not part of `pnpm test` or CI.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@tasklite/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/perf/**/*.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    // Print the timing table even when everything passes.
    silent: false,
  },
});
