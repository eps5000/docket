import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const baseURL = process.env.TASKLITE_BASE_URL ?? 'http://127.0.0.1:7420';
export const composeFile = fileURLToPath(new URL('../../docker/compose.yaml', import.meta.url));
/** The disposable e2e instance: its own container, image and volume (never your real data). */
export const e2eComposeFile = fileURLToPath(
  new URL('../../docker/compose.e2e.yaml', import.meta.url),
);
export const E2E_PROJECT = 'tasklite-e2e';
export const E2E_CONTAINER = 'tasklite-e2e';

/** Set by the global setup when it started the container, so teardown only stops what it started. */
export const STARTED_FLAG = 'TASKLITE_E2E_STARTED_CONTAINER';

export async function isHealthy(): Promise<boolean> {
  try {
    const res = await fetch(new URL('/healthz', baseURL));
    return res.ok;
  } catch {
    return false;
  }
}

export function compose(...args: string[]): void {
  execFileSync(
    'docker',
    ['compose', '-p', E2E_PROJECT, '-f', composeFile, '-f', e2eComposeFile, ...args],
    {
      stdio: 'inherit',
      env: { ...process.env, TASKLITE_SEED: process.env.TASKLITE_SEED ?? 'sample' },
    },
  );
}
