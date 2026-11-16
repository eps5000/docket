/**
 * The seeded container (tasks.md T062). The global setup makes sure one
 * answers at baseURL (e2e/global-setup.ts); these helpers talk to it:
 * - `ownerKey()` / `agentToken()` read the secrets with the in-container CLI;
 * - `resetSeededContainer()` gives a test file a fresh sample seed: stop the
 *   container, delete the database and documents (the secrets stay, so keys
 *   and tokens don't change), start it again, and wait for /readyz. The
 *   server reloads the sample seed into the empty database on boot
 *   (TASKLITE_SEED=sample).
 *
 * Call `useSeededContainer()` at the top of a spec file to reset once before
 * its tests. Files run one at a time (playwright.config.ts `workers: 1`), so
 * a reset never pulls the database out from under another file.
 *
 * TASKLITE_E2E_CONTAINER names the container (default `tasklite`, the
 * compose `container_name`). TASKLITE_E2E_NO_RESET=1 skips resets.
 */
import { execFileSync } from 'node:child_process';
import { test } from '@playwright/test';
import { baseURL } from '../container';

export const CONTAINER = process.env.TASKLITE_E2E_CONTAINER ?? 'tasklite';

function docker(args: string[]): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

let cachedOwnerKey: string | null = process.env.TASKLITE_OWNER_KEY ?? null;
let cachedAgentToken: string | null = process.env.TASKLITE_TOKEN ?? null;

/** The owner key (`tasklite owner-key`), for the Unlock screen. */
export function ownerKey(): string {
  cachedOwnerKey ??= docker(['exec', CONTAINER, 'tasklite', 'owner-key']);
  return cachedOwnerKey;
}

/** The agent bearer token (`tasklite agent-token`), for /mcp. */
export function agentToken(): string {
  cachedAgentToken ??= docker(['exec', CONTAINER, 'tasklite', 'agent-token']);
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
  throw new Error(`Task Lite did not become ready at ${baseURL}: ${last}`);
}

/** A fresh sample seed in the running container. */
export async function resetSeededContainer(): Promise<void> {
  if (process.env.TASKLITE_E2E_NO_RESET === '1') return;
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
    'rm -rf /data/tasklite.db /data/tasklite.db-wal /data/tasklite.db-shm /data/docs',
  ]);
  docker(['start', CONTAINER]);
  await waitReady();
}

/** Reset the container once before this file's tests. */
export function useSeededContainer(): void {
  test.beforeAll(async () => {
    test.setTimeout(120_000);
    await resetSeededContainer();
  });
}
