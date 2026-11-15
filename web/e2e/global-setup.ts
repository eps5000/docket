import { STARTED_FLAG, baseURL, compose, isHealthy } from './container';

/**
 * Fixture: make sure a seeded Task Lite container answers at baseURL.
 *
 * If one is already running (CI starts it before Playwright, or a developer
 * ran `docker compose up`), use it. Otherwise build and start it with
 * TASKLITE_SEED=sample and wait for the healthcheck. Set
 * TASKLITE_E2E_NO_START=1 to fail instead of starting one.
 *
 * The sample seed is loaded from Phase 2 (T031) on; until then the variable
 * is passed through and ignored.
 */
export default async function globalSetup(): Promise<void> {
  if (await isHealthy()) return;
  if (process.env.TASKLITE_E2E_NO_START === '1') {
    throw new Error(`Nothing answers at ${baseURL}/healthz and TASKLITE_E2E_NO_START=1`);
  }
  compose('up', '-d', '--build', '--wait', '--wait-timeout', '120');
  process.env[STARTED_FLAG] = '1';
  if (!(await isHealthy())) throw new Error(`Container started but ${baseURL}/healthz fails`);
}
