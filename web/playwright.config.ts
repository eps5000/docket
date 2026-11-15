import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.TASKLITE_BASE_URL ?? 'http://127.0.0.1:7420';
const ci = !!process.env.CI;

/**
 * End-to-end tests run against the container, never a dev server.
 * The global setup starts the seeded container if nothing answers at baseURL
 * (see e2e/global-setup.ts); CI starts it explicitly before running.
 */
export default defineConfig({
  testDir: './e2e',
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  workers: ci ? 2 : undefined,
  reporter: ci ? [['list'], ['html', { open: 'never' }]] : [['list']],
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
