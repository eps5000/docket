import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Bundle the shared package from source, so the web build needs no prior shared build.
    alias: {
      '@tasklite/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    // During `pnpm dev`, the API and health endpoints live on the server.
    proxy: {
      '/api': 'http://127.0.0.1:7420',
      '/mcp': 'http://127.0.0.1:7420',
      '/healthz': 'http://127.0.0.1:7420',
      '/readyz': 'http://127.0.0.1:7420',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
