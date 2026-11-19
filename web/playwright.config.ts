import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.DOCKET_BASE_URL ?? 'http://127.0.0.1:7420';
/** The kit gallery is dev and test builds only, so its spec runs against a Vite dev server. */
const kitPort = Number(process.env.DOCKET_KIT_PORT ?? 5179);
const kitURL = `http://127.0.0.1:${kitPort}`;
const ci = !!process.env.CI;
/**
 * Decision 32: the default run is local trust. `DOCKET_E2E_PROTECTED=1` runs
 * only the `@protected` specs, against an instance with DOCKET_PROTECTED_MODE=on.
 */
const protectedRun = process.env.DOCKET_E2E_PROTECTED === '1';

/**
 * End-to-end tests run against the container, never a dev server (the
 * `chromium` project). The global setup starts the seeded container if
 * nothing answers at baseURL (see e2e/global-setup.ts); CI starts it
 * explicitly before running.
 *
 * Spec files reset the container's sample seed (fixtures/container.ts), so
 * files run one at a time: `workers: 1`.
 *
 * The `kit` project runs web/e2e/kit.spec.ts against `vite` (dev mode), the
 * only place `/dev/kit` exists; production images never route it.
 */
export default defineConfig({
  testDir: './e2e',
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  workers: 1,
  fullyParallel: false,
  reporter: ci ? [['list'], ['html', { open: 'never' }]] : [['list']],
  ...(protectedRun ? { grep: /@protected/ } : { grepInvert: /@protected/ }),
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: /kit\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'], baseURL, viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'kit',
      testMatch: /kit\.spec\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: kitURL,
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
  webServer: {
    command: `pnpm exec vite --port ${kitPort} --strictPort --host 127.0.0.1`,
    url: `${kitURL}/dev/kit`,
    reuseExistingServer: !ci,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
