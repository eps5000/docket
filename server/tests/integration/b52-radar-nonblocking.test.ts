/**
 * B52: the conflict radar never freezes the server, never applies a stale run,
 * and an answer it doesn't have changes nothing.
 *
 * Since B76 Docket runs no git: the helper on the host reads the repository
 * and Docket judges from its facts, so a slow repository slows the helper, not
 * the server. These tests keep B52's rules over the facts: a run in flight is
 * joined, a run whose project or items changed before it records applies
 * nothing stale, and a read the helper had no answer for keeps what's there.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readContext } from '../../src/domain/contracts.js';
import { planRadar, recordRadar } from '../../src/domain/radar.js';
import { checkProjectWorktrees } from '../../src/domain/worktree-check.js';
import { OWNER_ACTOR, SYSTEM_ACTOR, type Actor } from '../../src/domain/write.js';
import { radarRunOnce, runActivityOnce, startRadar, sweepOnce } from '../../src/jobs/sweeper.js';
import { git, makeLargeRadarRepo, makeRadarRepo, type RadarRepo } from '../fixtures/radar-repo.js';
import { insertItem, insertProject, tempDir, type TempDir } from '../helpers.js';
import { helperEnv, hostGitPass } from '../host-git.js';
import { minutes, startDomain, type Domain } from '../us1-helpers.js';

const HAS_GIT = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const gitLib = (await import(
  /* @vite-ignore */ pathToFileURL(
    join(fileURLToPath(new URL('../../../tools/docket-sync/lib/git.mjs', import.meta.url))),
  ).href
)) as { createGit(o: { env: Record<string, string> }): GitReader };

interface GitReader {
  read(dir: string, args: string[], options?: Record<string, unknown>): Promise<unknown>;
}

let tmp: TempDir | undefined;
let d: Domain | undefined;

afterEach(async () => {
  await d?.cleanup();
  d = undefined;
  tmp?.cleanup();
  tmp = undefined;
});

const AT = '2026-11-06T10:00:00.000Z';
const UNKNOWN = { status: null, stdout: '', count: 0, unknown: true };

/** The real git on this machine, except calls with an argument matching `word` have no answer. */
function noAnswerFor(word: string | RegExp, home: string): GitReader {
  const real = gitLib.createGit({ env: helperEnv(home) });
  const hit = (a: string) => (typeof word === 'string' ? a.includes(word) : word.test(a));
  return {
    read: (dir, args, options) =>
      args.some(hit) ? Promise.resolve(UNKNOWN) : real.read(dir, args, options),
  };
}

/** Two in-flight items on the fixture's conflicting branches. */
function radarOnFixture(root: string): { domain: Domain; repo: RadarRepo } {
  const repo = makeRadarRepo(root);
  const domain = startDomain();
  domain.sql
    .prepare("UPDATE projects SET repo_path = ?, main_branch = 'main' WHERE key = 'RCP'")
    .run(repo.repo);
  const report = domain.sql.prepare(
    "UPDATE items SET status = 'progress', branches = ? WHERE id = ?",
  );
  report.run(JSON.stringify([{ name: 'feat/a', by: 'test', at: AT }]), 'RCP-17');
  report.run(JSON.stringify([{ name: 'feat/b', by: 'test', at: AT }]), 'RCP-25');
  return { domain, repo };
}

const openFindings = (domain: Domain) =>
  domain
    .rows<{ branch_a: string; branch_b: string }>(
      'SELECT branch_a, branch_b FROM radar_findings WHERE cleared_at IS NULL ORDER BY branch_a, branch_b',
    )
    .map((f) => `${f.branch_a}|${f.branch_b}`);
const eventCount = (domain: Domain) =>
  domain.row<{ n: number }>('SELECT count(*) AS n FROM events').n;
const projectRadar = (domain: Domain) =>
  domain.row<{
    radar_last_run_at: string | null;
    radar_off_reason: string | null;
    radar_last_duration_ms: number | null;
  }>(
    "SELECT radar_last_run_at, radar_off_reason, radar_last_duration_ms FROM projects WHERE key = 'RCP'",
  );

describe.skipIf(!HAS_GIT)('B52: an answer the helper didn’t have changes nothing', () => {
  it('without facts the radar decides nothing and keeps its time and reason', async () => {
    tmp = tempDir('docket-b52-');
    const { domain } = radarOnFixture(tmp.dir);
    d = domain;
    await hostGitPass(d.server, { home: tmp.dir });
    await radarRunOnce(d.server.runtime, 'RCP');
    const findings = openFindings(d);
    expect(findings).toEqual(['feat/a|feat/b', 'feat/b|main']);
    const before = projectRadar(d);
    const events = eventCount(d);

    // Past three passes with no new one: stale, so the run is unknown throughout.
    d.clock.advance(minutes(11));
    const run = await radarRunOnce(d.server.runtime, 'RCP');
    expect(run.plan.unknown.all).toBe(true);
    expect(run.plan.off).toBeNull();
    expect(openFindings(d)).toEqual(findings);
    expect(eventCount(d)).toBe(events);
    expect(projectRadar(d).radar_last_run_at).toBe(before.radar_last_run_at);
    expect(projectRadar(d).radar_off_reason).toBeNull();
  }, 30_000);

  it('a trial merge with no answer keeps its finding, and a real answer clears it later', async () => {
    tmp = tempDir('docket-b52-');
    const { domain, repo } = radarOnFixture(tmp.dir);
    d = domain;
    await hostGitPass(d.server, { home: tmp.dir });
    await radarRunOnce(d.server.runtime, 'RCP');
    expect(openFindings(d)).toContain('feat/a|feat/b');

    // feat/b really stops conflicting, but the helper's merge-tree has no answer.
    git(repo.worktrees['feat/b'], 'reset', '-q', '--hard', 'main');
    const events = eventCount(d);
    await hostGitPass(d.server, { git: noAnswerFor('merge-tree', tmp.dir) });
    const run = await radarRunOnce(d.server.runtime, 'RCP');
    expect(run.plan.unknown.branches.length).toBeGreaterThan(0);
    expect(openFindings(d)).toEqual(['feat/a|feat/b', 'feat/b|main']);
    expect(eventCount(d)).toBe(events);

    await hostGitPass(d.server, { home: tmp.dir });
    await radarRunOnce(d.server.runtime, 'RCP');
    expect(openFindings(d)).toEqual([]);
  }, 30_000);

  it('a commit check with no answer keeps the stored worktree check', async () => {
    tmp = tempDir('docket-b52-');
    const repo = makeRadarRepo(tmp.dir);
    d = startDomain();
    d.sql
      .prepare("UPDATE projects SET repo_path = ?, main_branch = 'main' WHERE key = 'RCP'")
      .run(repo.repo);
    const claude: Actor = d.agent('claude', { label: 'orca-w1' });
    const worktree = repo.worktrees['feat/a'];
    const head = git(worktree, 'rev-parse', 'HEAD').trim();
    const { run_id } = d.write(claude, (w, s) =>
      s.runs.claim(w, {
        id: 'RCP-17',
        agent_label: 'orca-w1',
        workspace: { path: worktree, branch: 'feat/a' },
      }),
    );
    d.write({ ...claude, run_id }, (w, s) =>
      s.evidence.reportCommit(w, { id: 'RCP-17', sha: head, pushed: false }),
    );
    d.clock.advance(d.server.runtime.config.leaseMs + minutes(1));
    sweepOnce(d.server.runtime);
    const { db, config } = d.server.runtime;
    const check = () => checkProjectWorktrees(db, config, 'RCP', d!.clock.now().toISOString());
    await hostGitPass(d.server, { home: tmp.dir });
    expect(await check()).toBe(1);
    const stored = () =>
      d!.row<{ worktree_check: string }>('SELECT worktree_check FROM runs WHERE id = ?', run_id)
        .worktree_check;
    const before = stored();

    d.clock.advance(minutes(5));
    await hostGitPass(d.server, { git: noAnswerFor(/^[0-9a-f]{7,64}\^\{commit\}$/, tmp.dir) });
    expect(await check()).toBe(0);
    expect(stored()).toBe(before);
  }, 30_000);

  it('a commit log with no answer flags nothing, and the next pass does', async () => {
    tmp = tempDir('docket-b52-');
    const repo = makeRadarRepo(tmp.dir);
    d = startDomain();
    d.sql
      .prepare("UPDATE projects SET repo_path = ?, main_branch = 'main' WHERE key = 'RCP'")
      .run(repo.repo);
    const worker: Actor = d.agent('claude', { label: 'worker-1' });
    const { run_id } = d.write(worker, (w, s) =>
      s.runs.claim(w, {
        id: 'RCP-17',
        agent_label: 'worker-1',
        workspace: { path: repo.worktrees['feat/a'], branch: 'feat/a' },
      }),
    );
    d.write({ ...worker, run_id }, (w, s) =>
      s.runs.park(w, { run_id, reason: 'Waiting', waiting_on: { orchestrator: true } }),
    );
    d.clock.advance(minutes(30));
    const at = d.clock.now().toISOString();
    const commit = spawnSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@docket.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'Newer work',
      ],
      {
        cwd: repo.worktrees['feat/a'],
        env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
      },
    );
    expect(commit.status).toBe(0);
    d.clock.advance(minutes(2));

    // Waiting for the helper: no commits are known, so nothing is flagged.
    expect(await runActivityOnce(d.server.runtime)).toEqual([]);
    await hostGitPass(d.server, { git: noAnswerFor('--since', tmp.dir) });
    expect(await runActivityOnce(d.server.runtime)).toEqual([]);

    await hostGitPass(d.server, { home: tmp.dir });
    expect(await runActivityOnce(d.server.runtime)).toEqual([run_id]);
  }, 30_000);
});

describe.skipIf(!HAS_GIT)('B52: one run at a time, and never a stale one', () => {
  it('a second run joins the one in flight', async () => {
    tmp = tempDir('docket-b52-');
    const { domain } = radarOnFixture(tmp.dir);
    d = domain;
    await hostGitPass(d.server, { home: tmp.dir });
    const first = radarRunOnce(d.server.runtime, 'RCP');
    expect(d.services.sharedChanges.radarRunning('RCP')).toBe(true);
    const [one, again] = await Promise.all([first, radarRunOnce(d.server.runtime, 'RCP')]);
    expect(again.joined).toBe(true);
    expect(again.mutation_id).toBe(one.mutation_id);
    expect(d.services.sharedChanges.radarRunning('RCP')).toBe(false);
  }, 30_000);

  it('Not an active branch between the plan and its record stays applied (B45)', async () => {
    tmp = tempDir('docket-b52-');
    const { domain } = radarOnFixture(tmp.dir);
    d = domain;
    await hostGitPass(d.server, { home: tmp.dir });
    const events = eventCount(d);
    const read = () => readContext(d!.server.runtime.db, SYSTEM_ACTOR, d!.clock.now());
    const plan = await planRadar(read(), d.server.runtime.config, 'RCP');
    d.write(OWNER_ACTOR, (w, s) =>
      s.sharedChanges.ownerBranches(w, {
        id: 'RCP-25',
        op: 'remove',
        branch: 'feat/b',
        not_active: true,
      }),
    );
    const applied = d.write(SYSTEM_ACTOR, (w) => recordRadar(w, plan));
    expect(applied.stale).toEqual(['RCP-25']);
    // Nothing the plan saw about feat/b came back.
    expect(openFindings(d).filter((f) => f.includes('feat/b'))).toEqual([]);
    expect(
      d.row<{ radar_branch: string | null }>("SELECT radar_branch FROM items WHERE id = 'RCP-25'")
        .radar_branch,
    ).toBeNull();
    expect(
      d
        .rows<{ type: string }>('SELECT type FROM events WHERE seq > ?', events)
        .filter((e) => e.type === 'radar.found'),
    ).toEqual([]);
  }, 30_000);

  it('a repository changed between the plan and its record discards the whole run', async () => {
    tmp = tempDir('docket-b52-');
    const { domain } = radarOnFixture(tmp.dir);
    d = domain;
    await hostGitPass(d.server, { home: tmp.dir });
    const read = () => readContext(d!.server.runtime.db, SYSTEM_ACTOR, d!.clock.now());
    const plan = await planRadar(read(), d.server.runtime.config, 'RCP');
    d.sql.prepare("UPDATE projects SET main_branch = 'develop' WHERE key = 'RCP'").run();
    const applied = d.write(SYSTEM_ACTOR, (w) => recordRadar(w, plan));
    expect(applied.discarded).toBe(true);
    expect(openFindings(d)).toEqual([]);
  }, 30_000);
});

describe.skipIf(!HAS_GIT)('B52: starting and stopping', () => {
  it('the first pass waits for its delay', async () => {
    tmp = tempDir('docket-b52-');
    const { domain } = radarOnFixture(tmp.dir);
    d = domain;
    await hostGitPass(d.server, { home: tmp.dir });
    const radar = startRadar(d.server.runtime, {
      intervalMs: 60_000,
      debounceMs: null,
      firstMs: 150,
    });
    try {
      await new Promise((done) => setTimeout(done, 50));
      expect(projectRadar(d).radar_last_run_at).toBeNull();
      await expect
        .poll(() => projectRadar(d!).radar_last_run_at, { timeout: 10_000 })
        .not.toBeNull();
    } finally {
      await radar.stop();
    }
  }, 30_000);

  it('after shutdown no run starts', async () => {
    tmp = tempDir('docket-b52-');
    const { domain } = radarOnFixture(tmp.dir);
    d = domain;
    await d.services.sharedChanges.stopRadar();
    await expect(radarRunOnce(d.server.runtime, 'RCP')).rejects.toMatchObject({
      code: 'unavailable',
    });
  }, 30_000);
});

describe.skipIf(!HAS_GIT)('B52: a repository with hundreds of branches', () => {
  it('the helper reads it within its bounds and Docket judges it', async () => {
    tmp = tempDir('docket-b52-');
    const { branches } = makeLargeRadarRepo(tmp.dir, 600);
    d = startDomain({ seed: false });
    insertProject(d.server.runtime.db, 'BIG');
    d.sql
      .prepare("UPDATE projects SET repo_path = ?, main_branch = 'main' WHERE key = 'BIG'")
      .run(join(tmp.dir, 'large-app'));
    const report = d.sql.prepare('UPDATE items SET branches = ? WHERE id = ?');
    branches.slice(0, 40).forEach((name, i) => {
      const id = `BIG-${i + 1}`;
      insertItem(d!.server.runtime.db, { id, project: 'BIG', status: 'progress' });
      report.run(JSON.stringify([{ name, by: 'test', at: AT }]), id);
    });
    const records = await hostGitPass(d.server, { home: tmp.dir });
    expect(records.at(-1)).toMatchObject({ kind: 'pass', complete: true, pairs_done: true });
    const run = await radarRunOnce(d.server.runtime, 'BIG');
    console.log(`[b52] 600 branches, 40 in flight: run ${run.duration_ms} ms`);
    // Every fifth of the 40 branches changes shared.txt: 8 branches, 28 conflicting pairs.
    expect(
      d.rows("SELECT id FROM radar_findings WHERE project_key = 'BIG' AND cleared_at IS NULL"),
    ).toHaveLength(28);
  }, 120_000);
});

describe('B52, B76: nothing in the server runs a child process', () => {
  it('server/src starts no child process and imports none', () => {
    const src = fileURLToPath(new URL('../../src', import.meta.url));
    const offenders = (readdirSync(src, { recursive: true }) as string[])
      .filter((f) => f.endsWith('.ts'))
      .filter((f) =>
        /child_process|(?<![.\w])(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/.test(
          readFileSync(join(src, f), 'utf8'),
        ),
      );
    expect(offenders).toEqual([]);
  });
});
