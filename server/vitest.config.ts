import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Test against the shared package's source, not its build output.
    alias: {
      '@docket/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    // The scale check runs on demand only: `pnpm perf` (vitest.perf.config.ts).
    exclude: ['tests/perf/**', '**/node_modules/**'],
  },
});
