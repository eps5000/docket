/**
 * The seeded container (tasks.md T062). The global setup makes sure one
 * answers at baseURL (e2e/global-setup.ts); these helpers talk to it:
 * - `ownerKey()` / `agentToken()` read the secrets with the in-container CLI;
 * - `resetSeededContainer()` gives a test file a fresh sample seed: stop the
 *   container, delete the database and documents (the secrets stay, so keys
 *   and tokens don't change), start it again, and wait for /readyz. The
 *   server reloads the sample seed into the empty database on boot
 *   (DOCKET_SEED=sample).
 *
 * Call `useSeededContainer()` at the top of a spec file to reset once before
 * its tests. Files run one at a time (playwright.config.ts `workers: 1`), so
 * a reset never pulls the database out from under another file.
 *
 * DOCKET_E2E_CONTAINER names the container (default `docket`, the
 * compose `container_name`; the global setup sets `docket-e2e` when it
 * starts the disposable instance). DOCKET_E2E_NO_RESET=1 skips resets.
 * Resets refuse a possibly real instance (`assertDisposable`).
 */
import { execFileSync } from 'node:child_process';
import { test } from '@playwright/test';
import { baseURL } from '../container';

export const CONTAINER = process.env.DOCKET_E2E_CONTAINER ?? 'docket';

function docker(args: string[]): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

let cachedOwnerKey: string | null = process.env.DOCKET_OWNER_KEY ?? null;
let cachedAgentToken: string | null = process.env.DOCKET_TOKEN ?? null;

/** The owner key (`docket owner-key`), for the Unlock screen. */
export function ownerKey(): string {
  cachedOwnerKey ??= docker(['exec', CONTAINER, 'docket', 'owner-key']);
  return cachedOwnerKey;
}

/** The agent bearer token (`docket agent-token`), for /mcp. */
export function agentToken(): string {
  cachedAgentToken ??= docker(['exec', CONTAINER, 'docket', 'agent-token']);
  return cachedAgentToken;
}

async function waitReady(timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < until) {
    try {
      const res = await fetch(new URL('/readyz', baseURL));
      last = `${res.status} ${await res.text()}`;
      if (res.ok) return;
    } catch (err) {
      last = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Docket did not become ready at ${baseURL}: ${last}`);
}

/** A fresh sample seed in the running container. */
export async function resetSeededContainer(): Promise<void> {
  if (process.env.DOCKET_E2E_NO_RESET === '1') return;
  assertDisposable();
  docker(['stop', '--time', '10', CONTAINER]);
  // The image's entrypoint is the server; run the cleanup in a throwaway
  // container that shares the volume, as the same non-root user.
  const volumes = docker([
    'inspect',
    '--format',
    '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}',
    CONTAINER,
  ]);
  const image = docker(['inspect', '--format', '{{.Config.Image}}', CONTAINER]);
  docker([
    'run',
    '--rm',
    '--entrypoint',
    'sh',
    '-v',
    `${volumes}:/data`,
    image,
    '-c',
    'rm -rf /data/docket.db /data/docket.db-wal /data/docket.db-shm /data/docs',
  ]);
  docker(['start', CONTAINER]);
  await waitReady();
}

/**
 * A reset deletes the container's database and documents, so refuse anything that may
 * be the owner's real instance (B18, T149): the default `docket-data` volume (or
 * `tasklite-data`, its name before the rename, B28), unless
 * DOCKET_E2E_ALLOW_RESET=1 says it is disposable (CI's fresh runner), and a container
 * without DOCKET_SEED=sample (its reset would leave an empty database, not the seed).
 */
const REAL_VOLUMES = ['docket-data', 'tasklite-data'];

function assertDisposable(): void {
  const volume = docker([
    'inspect',
    '--format',
    '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}',
    CONTAINER,
  ]);
  const env = docker(['inspect', '--format', '{{json .Config.Env}}', CONTAINER]);
  if (REAL_VOLUMES.includes(volume) && process.env.DOCKET_E2E_ALLOW_RESET !== '1') {
    throw new Error(
      `Refusing to reset "${CONTAINER}": it uses the ${volume} volume, which may hold your real data. ` +
        'Stop it and let the tests start their own disposable instance (docker/compose.e2e.yaml), ' +
        'or set DOCKET_E2E_ALLOW_RESET=1 if this volume is disposable.',
    );
  }
  if (!(JSON.parse(env) as string[]).includes('DOCKET_SEED=sample')) {
    throw new Error(
      `Refusing to reset "${CONTAINER}": it wasn't started with DOCKET_SEED=sample, so it may be a real instance.`,
    );
  }
}

/** Reset the container once before this file's tests. */
export function useSeededContainer(): void {
  test.beforeAll(async () => {
    test.setTimeout(120_000);
    await resetSeededContainer();
  });
}
