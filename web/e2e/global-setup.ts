import { E2E_CONTAINER, STARTED_FLAG, baseURL, compose, isHealthy } from './container';

/**
 * Fixture: make sure a seeded Task Lite container answers at baseURL.
 *
 * If one is already running (CI starts it before Playwright, or a developer
 * started a disposable one), use it. Otherwise build and start the
 * disposable e2e instance (docker/compose.e2e.yaml: container
 * `tasklite-e2e`, volume `tasklite-e2e-data`, DOCKET_SEED=sample) and
 * wait for the healthcheck. Set DOCKET_E2E_NO_START=1 to fail instead of
 * starting one. Resets refuse your real `tasklite-data` volume
 * (fixtures/container.ts).
 *
 * The sample seed is loaded from Phase 2 (T031) on; until then the variable
 * is passed through and ignored.
 */
export default async function globalSetup(): Promise<void> {
  if (await isHealthy()) return;
  if (process.env.DOCKET_E2E_NO_START === '1') {
    throw new Error(`Nothing answers at ${baseURL}/healthz and DOCKET_E2E_NO_START=1`);
  }
  // A disposable instance (docker/compose.e2e.yaml), never the tasklite-data volume.
  compose('up', '-d', '--build', '--wait', '--wait-timeout', '120');
  process.env[STARTED_FLAG] = '1';
  process.env.DOCKET_E2E_CONTAINER ??= E2E_CONTAINER;
  if (!(await isHealthy())) throw new Error(`Container started but ${baseURL}/healthz fails`);
}
