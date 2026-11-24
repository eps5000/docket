/**
 * B76: Docket runs no git, so a spec that needs the radar plays the helper on
 * the host: it builds a fixture repository on this machine, runs the real
 * helper's git source (`tools/docket-sync/sources/git.mjs`) with the settings
 * Docket gives it, and posts the records to `/api/sync/git`, as the installed
 * helper would. Every repository and branch here is made up.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { APIRequestContext } from '@playwright/test';
import { expect } from '@playwright/test';

const SOURCE = fileURLToPath(
  new URL('../../../tools/docket-sync/sources/git.mjs', import.meta.url),
);

type Rec = Record<string, unknown>;
interface GitSource {
  batchSize: number;
  collect(ctx: Rec, options: Rec): Promise<{ records: Rec[] }>;
}

let loaded: GitSource | null = null;
const source = async () =>
  (loaded ??= (await import(/* @vite-ignore */ pathToFileURL(SOURCE).href)) as GitSource);

/** A neutral git environment: no user or system config from the machine. */
function gitEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? process.env.Path ?? '',
    SYSTEMROOT: process.env.SYSTEMROOT ?? '',
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
  };
}

/** A folder on this machine for fixture repositories; `remove` deletes it. */
export function hostFolder(prefix: string): { dir: string; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix)).replace(/\\/g, '/');
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Run git on this machine with a neutral identity. */
export function hostGit(cwd: string, home: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=e2e',
      '-c',
      'user.email=e2e@docket.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.autocrlf=false',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...gitEnv(home), GIT_CONFIG_NOSYSTEM: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

/**
 * One pass of the real git source, posted to Docket. `ageMs` dates the pass
 * that much in the past (a stale pass for the stale state).
 */
export async function hostGitPass(
  request: APIRequestContext,
  home: string,
  opts: { ageMs?: number } = {},
): Promise<Rec[]> {
  const res = await request.get('/api/sync/git');
  expect(res.status(), await res.text()).toBe(200);
  const { settings } = (await res.json()) as { settings: Rec };
  const at = Date.now() - (opts.ageMs ?? 0);
  const src = await source();
  const { records } = await src.collect(
    { state: {}, settings },
    { now: () => at, env: gitEnv(home) },
  );
  const total = Math.max(1, Math.ceil(records.length / src.batchSize));
  for (let i = 0; i < total; i += 1) {
    const sent = await request.post('/api/sync/git', {
      data: {
        records: records.slice(i * src.batchSize, (i + 1) * src.batchSize),
        run: { ok: i === total - 1, partial: i < total - 1, interval_ms: 180_000 },
      },
    });
    expect(sent.status(), await sent.text()).toBe(200);
  }
  return records;
}
