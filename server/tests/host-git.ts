/**
 * B76: Docket runs no git, so tests that need git facts run the real helper's
 * git source (`tools/docket-sync/sources/git.mjs`) against a fixture repository
 * and ingest what it posts, as the helper on the host would. The source reads
 * the settings Docket gives it, so the request and the facts are both the real
 * thing. Its clock is the test server's, so the facts are as fresh as the test
 * says.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readContext } from '../src/domain/contracts.js';
import { SYSTEM_ACTOR } from '../src/domain/write.js';
import type { TestServer } from './integration/harness.js';

const TOOL = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'docket-sync');

type Rec = Record<string, unknown>;

export interface GitSource {
  name: string;
  batchSize: number;
  DEFAULT_LIMITS: Record<string, number>;
  collect(
    ctx: {
      state: Rec;
      settings: Rec;
      log?: (event: string, data?: Rec) => void;
      signal?: AbortSignal;
    },
    options?: Rec,
  ): Promise<{ records: Rec[]; state: Rec }>;
  keyPattern(key: string): RegExp | null;
  branchesNaming(keys: string[], branches: string[]): string[];
  conflictFiles(stdout: string, limits?: Rec): { files: string[]; more: boolean };
  parseManifest(text: string): { install_id: string | null; files: Rec[] } | null;
}

export const gitSource = (await import(
  /* @vite-ignore */ pathToFileURL(join(TOOL, 'sources', 'git.mjs')).href
)) as GitSource;

/** A neutral environment for the helper's git: no user or system config from the machine. */
export function helperEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? process.env.Path ?? '',
    SYSTEMROOT: process.env.SYSTEMROOT ?? '',
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
  };
}

const worktreesSource = (await import(
  /* @vite-ignore */ pathToFileURL(join(TOOL, 'sources', 'worktrees.mjs')).href
)) as Pick<GitSource, 'collect'>;

/** One pass of the real worktrees source (B68), ingested: uncommitted files, locks, heads. */
export async function hostWorktreesPass(server: TestServer, opts: { home?: string } = {}) {
  const r = readContext(server.runtime.db, SYSTEM_ACTOR, server.clock.now());
  const settings = server.runtime.services.sync.source(r, 'worktrees').settings;
  const at = server.clock.now().getTime();
  const { records } = await worktreesSource.collect(
    { state: {}, settings },
    { now: () => at, ...(opts.home ? { env: helperEnv(opts.home) } : {}) },
  );
  for (let i = 0; i < Math.max(1, Math.ceil(records.length / 200)); i += 1) {
    server.runtime.services.sync.ingest(server.runtime.write, 'worktrees', {
      records: records.slice(i * 200, (i + 1) * 200) as { key: string }[],
      run: { ok: true, interval_ms: 180_000 },
    });
  }
  return records;
}

/** What Docket asks the git source to read now. */
export function gitSettings(server: TestServer): Rec {
  const r = readContext(server.runtime.db, SYSTEM_ACTOR, server.clock.now());
  return server.runtime.services.sync.source(r, 'git').settings;
}

/** Post records as the helper's runner does: in batches, the last one closing the run. */
export function ingestGit(server: TestServer, records: Rec[], batch = gitSource.batchSize): void {
  const total = Math.max(1, Math.ceil(records.length / batch));
  for (let i = 0; i < total; i += 1) {
    server.runtime.services.sync.ingest(server.runtime.write, 'git', {
      records: records.slice(i * batch, (i + 1) * batch) as { key: string }[],
      run: { ok: i === total - 1, partial: i < total - 1, interval_ms: 180_000 },
    });
  }
}

/**
 * One pass of the real git source over what Docket asks for, ingested.
 * `ageMs` makes the pass that much older than the server's clock.
 */
export async function hostGitPass(
  server: TestServer,
  opts: {
    home?: string;
    ageMs?: number;
    limits?: Rec;
    git?: unknown;
    transform?: (r: Rec[]) => Rec[];
  } = {},
): Promise<Rec[]> {
  const settings = gitSettings(server);
  const at = server.clock.now().getTime() - (opts.ageMs ?? 0);
  const { records } = await gitSource.collect(
    { state: {}, settings },
    {
      now: () => at,
      ...(opts.home ? { env: helperEnv(opts.home) } : {}),
      ...(opts.limits ? { limits: opts.limits } : {}),
      ...(opts.git ? { git: opts.git } : {}),
    },
  );
  const sent = opts.transform ? opts.transform(records) : records;
  ingestGit(server, sent);
  return sent;
}
