/**
 * B52: the conflict radar must never freeze the server.
 *
 * A `git` shim on PATH makes git slow, so these tests drive the real server
 * path. Each probe is timed from when it was *due*, not from when it was sent:
 * a blocked event loop delays the send too, and timing from the send would
 * hide the stall. The shim is a POSIX script, so this file runs on CI's Linux.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { CSRF_HEADER_NAME } from '@docket/shared';
import { serve, type ServerType } from '@hono/node-server';
import { afterEach, describe, expect, it } from 'vitest';
import { git as gitRead, gitLimits } from '../../src/domain/git-read.js';
import { checkProjectWorktrees } from '../../src/domain/worktree-check.js';
import { OWNER_ACTOR, type Actor } from '../../src/domain/write.js';
import { radarRunOnce, runActivityOnce, startRadar, sweepOnce } from '../../src/jobs/sweeper.js';
import {
  git,
  hashGitDir,
  makeLargeRadarRepo,
  makeRadarRepo,
  type RadarRepo,
} from '../fixtures/radar-repo.js';
import { insertItem, insertProject, tempDir, type TempDir } from '../helpers.js';
import { ORIGIN, parseSetCookies } from './harness.js';
import { minutes, startDomain, type Domain } from '../us1-helpers.js';

/** A request during a radar run must answer within this. */
const RESPONSIVE_MS = 250;

const REAL_GIT =
  process.platform === 'win32'
    ? null
    : spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim() || null;

const realPath = process.env.PATH;
const realTmp = process.env.TMPDIR;
const limits = { ...gitLimits };
let tmp: TempDir | undefined;
let d: Domain | undefined;
let listener: ServerType | undefined;

afterEach(async () => {
  process.env.PATH = realPath;
  if (realTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = realTmp;
  Object.assign(gitLimits, limits);
  if (listener) await new Promise((done) => listener!.close(done));
  listener = undefined;
  await d?.cleanup();
  d = undefined;
  tmp?.cleanup();
  tmp = undefined;
});

/**
 * Put a `git` on PATH that waits `delayMs`, then runs the real one. With
 * `only`, just the calls whose arguments hold that word wait. Every call is
 * logged: `+` as it starts and `-` as it hands over to the real git.
 */
function slowGit(root: string, delayMs: number, only?: string): { log: () => string[] } {
  const dir = join(root, 'slow-git-bin');
  mkdirSync(dir, { recursive: true });
  const logFile = join(dir, 'calls.log');
  writeFileSync(logFile, '');
  const wait = `sleep ${delayMs / 1000}`;
  const body = only ? `case "$*" in *${only}*) ${wait} ;; esac` : wait;
  const shim = join(dir, 'git');
  writeFileSync(
    shim,
    `#!/bin/sh\necho "+ $*" >> "${logFile}"\n${body}\necho "- $*" >> "${logFile}"\nexec "${REAL_GIT}" "$@"\n`,
  );
  chmodSync(shim, 0o755);
  process.env.PATH = `${dir}:${realPath}`;
  return { log: () => readFileSync(logFile, 'utf8').split('\n').filter(Boolean) };
}

const fastGit = () => {
  process.env.PATH = realPath;
};

/** Serve the app on a real socket, as the container does. */
async function listen(domain: Domain): Promise<string> {
  const port = await new Promise<number>((ready) => {
    listener = serve({ fetch: domain.server.app.fetch, hostname: '127.0.0.1', port: 0 }, (info) =>
      ready((info as AddressInfo).port),
    );
  });
  return `http://127.0.0.1:${port}/healthz`;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

interface Latency {
  run_ms: number;
  worst_request_ms: number;
  requests: number;
  worst_loop_ms: number;
}

/** Run `work` while a request is due every 50 ms; report the worst one. */
async function measure(url: string, work: () => unknown): Promise<Latency> {
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const started = performance.now();
  let finished = false;
  let runMs = 0;
  const running = (async () => {
    await sleep(60); // Let the first probes start.
    try {
      await work();
    } finally {
      runMs = performance.now() - started - 60;
      finished = true;
    }
  })();
  const latencies: number[] = [];
  let due = performance.now();
  while (!finished) {
    const wait = due - performance.now();
    if (wait > 0) await sleep(wait);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    await res.text();
    latencies.push(performance.now() - due);
    due += 50;
  }
  await running;
  loop.disable();
  return {
    run_ms: Math.round(runMs),
    worst_request_ms: Math.round(Math.max(...latencies)),
    requests: latencies.length,
    worst_loop_ms: Math.round(loop.max / 1e6),
  };
}

const AT = '2026-11-06T10:00:00.000Z';

/** Two in-flight items on the fixture's conflicting branches. */
function radarOnFixture(root: string): { domain: Domain; repo: RadarRepo } {
  const repo = makeRadarRepo(root);
  const domain = startDomain({ env: { DOCKET_PUSH_ROOT: root } });
  domain.sql
    .prepare("UPDATE projects SET repo_path = 'recipe-app', main_branch = 'main' WHERE key = 'RCP'")
    .run();
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

/** Wait until the shim has logged at least one call. */
async function untilGitRuns(shim: { log: () => string[] }): Promise<void> {
  await expect.poll(() => shim.log().length, { timeout: 5_000, interval: 5 }).toBeGreaterThan(0);
}

async function ownerCookies(domain: Domain) {
  const res = await domain.server.app.request(`${ORIGIN}/api/session/unlock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: domain.server.runtime.secrets.ownerKey() }),
  });
  const cookies = parseSetCookies(res);
  const csrf = cookies.docket_csrf!.value;
  return {
    cookie: `docket_owner=${cookies.docket_owner!.value}; docket_csrf=${csrf}`,
    'content-type': 'application/json',
    [CSRF_HEADER_NAME]: csrf,
  };
}

describe.skipIf(!REAL_GIT)('B52: the server answers during a radar run', () => {
  it('a request stays fast while every git call is slow', async () => {
    tmp = tempDir('docket-b52-');
    const { domain } = radarOnFixture(tmp.dir);
    d = domain;
    const url = await listen(d);
    slowGit(tmp.dir, 200);
    const runtime = d.server.runtime;
    const seen = await measure(url, () => radarRunOnce(runtime, 'RCP'));
    console.log(`[b52] slow git: ${JSON.stringify(seen)}`);
    expect(seen.run_ms).toBeGreaterThan(1_000); // The slow git really ran.
    expect(seen.worst_request_ms).toBeLessThan(RESPONSIVE_MS);
    // The same findings as a fast run, and the run's length on the project.
    expect(openFindings(d)).toEqual(['feat/a|feat/b', 'feat/b|main']);
    expect(projectRadar(d).radar_last_duration_ms).toBeGreaterThan(1_000);
  }, 60_000);

  it('a repository with hundreds of branches, with real git speed', async () => {
    tmp = tempDir('docket-b52-');
    const { branches } = makeLargeRadarRepo(tmp.dir, 600);
    d = startDomain({ seed: false, env: { DOCKET_PUSH_ROOT: tmp.dir } });
    insertProject(d.server.runtime.db, 'BIG');
    d.sql
      .prepare(
        "UPDATE projects SET repo_path = 'large-app', main_branch = 'main' WHERE key = 'BIG'",
      )
      .run();
    const report = d.sql.prepare('UPDATE items SET branches = ? WHERE id = ?');
    branches.slice(0, 40).forEach((name, i) => {
      const id = `BIG-${i + 1}`;
      insertItem(d!.server.runtime.db, { id, project: 'BIG', status: 'progress' });
      report.run(JSON.stringify([{ name, by: 'test', at: AT }]), id);
    });
    const url = await listen(d);
    const runtime = d.server.runtime;
    const seen = await measure(url, () => radarRunOnce(runtime, 'BIG'));
    console.log(`[b52] 600 branches, 40 in flight: ${JSON.stringify(seen)}`);
    expect(seen.worst_request_ms).toBeLessThan(RESPONSIVE_MS);
    // Every fifth of the 40 branches changes shared.txt: 8 branches, 28 conflicting pairs.
    expect(openFindings(d)).toHaveLength(28);
  }, 120_000);

  it('at most the configured number of git processes run at once', async () => {
    tmp = tempDir('docket-b52-');
    const repo = makeRadarRepo(tmp.dir).repo;
    const shim = slowGit(tmp.dir, 100);
    gitLimits.concurrency = 2;
    await Promise.all(Array.from({ length: 8 }, () => gitRead(repo, ['rev-parse', 'HEAD'])));
    let now = 0;
    let most = 0;
    for (const line of shim.log()) {
      now += line.startsWith('+') ? 1 : -1;
      most = Math.max(most, now);
    }
    expect(most).toBe(2);
  }, 30_000);
});

describe.skipIf(!REAL_GIT)('B52: a git read with no answer changes nothing', () => {
  it('a timed-out repository read keeps findings, time and off reason', async () => {
    tmp = tempDir('docket-b52-');
    const { domain } = radarOnFixture(tmp.dir);
    d = domain;
    await radarRunOnce(d.server.runtime, 'RCP');
    const findings = openFindings(d);
    expect(findings).toHaveLength(2);
    const before = projectRadar(d);
    const events = eventCount(d);
    d.clock.advance(minutes(5));

    slowGit(tmp.dir, 2_000);
    gitLimits.timeoutMs = 100;
    gitLimits.killGraceMs = 50;
    const run = await radarRunOnce(d.server.runtime, 'RCP');
    expect(run.plan.unknown.all).toBe(true);
    expect(run.plan.off).toBeNull();
    expect(openFindings(d)).toEqual(findings);
    expect(eventCount(d)).toBe(events);
    expect(projectRadar(d).radar_last_run_at).toBe(before.radar_last_run_at);
    expect(projectRadar(d).radar_off_reason).toBeNull();
  }, 30_000);

  it('a timed-out trial merge keeps its finding, and a real answer clears it later', async () => {
    tmp = tempDir('docket-b52-');
    const { domain, repo } = radarOnFixture(tmp.dir);
    d = domain;
    await radarRunOnce(d.server.runtime, 'RCP');
    expect(openFindings(d)).toContain('feat/a|feat/b');

    // feat/b really stops conflicting, but git can't say so yet.
    git(repo.worktrees['feat/b'], 'reset', '-q', '--hard', 'main');
    const events = eventCount(d);
    slowGit(tmp.dir, 2_000, 'merge-tree');
    gitLimits.timeoutMs = 100;
    gitLimits.killGraceMs = 50;
    const run = await radarRunOnce(d.server.runtime, 'RCP');
    expect(run.plan.unknown.branches.length).toBeGreaterThan(0);
    expect(openFindings(d)).toEqual(['feat/a|feat/b', 'feat/b|main']);
    expect(eventCount(d)).toBe(events);

    fastGit();
    Object.assign(gitLimits, limits);
    await radarRunOnce(d.server.runtime, 'RCP');
    expect(openFindings(d)).toEqual([]);
  }, 30_000);

  it('a timed-out worktree check keeps the stored check', async () => {
    tmp = tempDir('docket-b52-');
    const repo = makeRadarRepo(tmp.dir);
    d = startDomain({ env: { DOCKET_PUSH_ROOT: tmp.dir } });
    d.sql
      .prepare(
        "UPDATE projects SET repo_path = 'recipe-app', main_branch = 'main' WHERE key = 'RCP'",
      )
      .run();
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
    expect(await check()).toBe(1);
    const stored = () =>
      d!.row<{ worktree_check: string }>('SELECT worktree_check FROM runs WHERE id = ?', run_id)
        .worktree_check;
    const before = stored();

    d.clock.advance(minutes(5));
    slowGit(tmp.dir, 2_000);
    gitLimits.timeoutMs = 100;
    gitLimits.killGraceMs = 50;
    expect(await check()).toBe(0);
    expect(stored()).toBe(before);
  }, 30_000);

  it('a timed-out activity check flags nothing, and the next one does', async () => {
    tmp = tempDir('docket-b52-');
    const repo = makeRadarRepo(tmp.dir);
    d = startDomain({ env: { DOCKET_PUSH_ROOT: tmp.dir } });
    d.sql
      .prepare(
        "UPDATE projects SET repo_path = 'recipe-app', main_branch = 'main' WHERE key = 'RCP'",
      )
      .run();
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

    slowGit(tmp.dir, 2_000, ' log ');
    gitLimits.timeoutMs = 100;
    gitLimits.killGraceMs = 50;
    expect(await runActivityOnce(d.server.runtime)).toEqual([]);

    fastGit();
    Object.assign(gitLimits, limits);
    expect(await runActivityOnce(d.server.runtime)).toEqual([run_id]);
  }, 30_000);
});

describe.skipIf(!REAL_GIT)('B52: one run at a time, and never a stale one', () => {
  it('a second run joins the one in flight, over the route too', async () => {
    tmp = tempDir('docket-b52-');
    const { domain } = radarOnFixture(tmp.dir);
    d = domain;
    const headers = await ownerCookies(d);
    const shim = slowGit(tmp.dir, 100);
    const runNow = () =>
      d!.server.request('/api/projects/RCP/radar/run', { method: 'POST', headers, body: '{}' });
    const first = radarRunOnce(d.server.runtime, 'RCP');
    expect(d.services.sharedChanges.radarRunning('RCP')).toBe(true);
    const [one, viaRoute, again] = await Promise.all([
      first,
      runNow(),
      radarRunOnce(d.server.runtime, 'RCP'),
    ]);
    expect(viaRoute.status).toBe(200);
    const body = (await viaRoute.json()) as {
      mutation_id: string;
      radar: { last_duration_ms: number };
    };
    expect(body.mutation_id).toBe(one.mutation_id);
    expect(body.radar.last_duration_ms).toBeGreaterThan(0);
    expect(again.joined).toBe(true);
    expect(again.mutation_id).toBe(one.mutation_id);
    // One run: the repository was probed once.
    expect(
      shim.log().filter((l) => l.startsWith('+') && l.includes('--git-common-dir')),
    ).toHaveLength(1);
    expect(d.services.sharedChanges.radarRunning('RCP')).toBe(false);
  }, 30_000);

  it('Not an active branch during a run stays applied (B45)', async () => {
    tmp = tempDir('docket-b52-');
    const { domain } = radarOnFixture(tmp.dir);
    d = domain;
    const events = eventCount(d);
    const shim = slowGit(tmp.dir, 100);
    const running = radarRunOnce(d.server.runtime, 'RCP');
    await untilGitRuns(shim);
    d.write(OWNER_ACTOR, (w, s) =>
      s.sharedChanges.ownerBranches(w, {
        id: 'RCP-25',
        op: 'remove',
        branch: 'feat/b',
        not_active: true,
      }),
    );
    const run = await running;
    expect(run.applied.stale).toEqual(['RCP-25']);
    // Nothing the slow run saw about feat/b came back.
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

  it('a repository changed during a run discards the whole run', async () => {
    tmp = tempDir('docket-b52-');
    const { domain } = radarOnFixture(tmp.dir);
    d = domain;
    const shim = slowGit(tmp.dir, 100);
    const running = radarRunOnce(d.server.runtime, 'RCP');
    await untilGitRuns(shim);
    d.sql.prepare("UPDATE projects SET main_branch = 'develop' WHERE key = 'RCP'").run();
    const run = await running;
    expect(run.applied.discarded).toBe(true);
    expect(openFindings(d)).toEqual([]);
    expect(projectRadar(d).radar_last_run_at).toBeNull();
    expect(projectRadar(d).radar_last_duration_ms).toBeNull();
  }, 30_000);

  it('a report during a scheduled run gets another run after it', async () => {
    tmp = tempDir('docket-b52-');
    const { domain } = radarOnFixture(tmp.dir);
    d = domain;
    const shim = slowGit(tmp.dir, 60);
    const radar = startRadar(d.server.runtime, { intervalMs: null, debounceMs: 5, minGapMs: 0 });
    const report = (seq: string) =>
      d!.write(OWNER_ACTOR, (w) => {
        w.event({
          type: 'commit.reported',
          summary: `Test commit ${seq}`,
          item_id: 'RCP-17',
          project_key: 'RCP',
          data: {},
        });
      });
    try {
      report('one');
      await untilGitRuns(shim);
      report('two'); // Lands while the first run is reading git.
      await expect
        .poll(
          () =>
            shim.log().filter((l) => l.startsWith('+') && l.includes('--git-common-dir')).length,
          { timeout: 15_000, interval: 25 },
        )
        .toBeGreaterThanOrEqual(2);
    } finally {
      await radar.stop();
    }
  }, 30_000);
});

describe.skipIf(!REAL_GIT)('B52: starting and stopping', () => {
  it('the first pass waits for its delay', async () => {
    tmp = tempDir('docket-b52-');
    const { domain } = radarOnFixture(tmp.dir);
    d = domain;
    const radar = startRadar(d.server.runtime, {
      intervalMs: 60_000,
      debounceMs: null,
      firstMs: 150,
    });
    try {
      await sleep(50);
      expect(projectRadar(d).radar_last_run_at).toBeNull();
      await expect
        .poll(() => projectRadar(d!).radar_last_run_at, { timeout: 10_000 })
        .not.toBeNull();
    } finally {
      await radar.stop();
    }
  }, 30_000);

  it('shutdown cancels git, writes nothing, and leaves .git and the temp folder clean', async () => {
    tmp = tempDir('docket-b52-');
    const { domain, repo } = radarOnFixture(tmp.dir);
    d = domain;
    const scratch = join(tmp.dir, 'scratch');
    mkdirSync(scratch);
    const before = hashGitDir(repo.repo);
    const events = eventCount(d);
    const shim = slowGit(tmp.dir, 30_000, 'merge-tree');
    process.env.TMPDIR = scratch;
    gitLimits.killGraceMs = 100;
    const running = radarRunOnce(d.server.runtime, 'RCP');
    await expect
      .poll(() => shim.log().some((l) => l.includes('merge-tree')), { timeout: 10_000 })
      .toBe(true);
    const started = performance.now();
    await d.services.sharedChanges.stopRadar();
    expect(performance.now() - started).toBeLessThan(3_000);
    await expect(running).rejects.toMatchObject({ code: 'unavailable' });
    expect(eventCount(d)).toBe(events);
    expect(openFindings(d)).toEqual([]);
    expect(projectRadar(d).radar_last_run_at).toBeNull();
    expect(readdirSync(scratch)).toEqual([]);
    fastGit();
    expect(hashGitDir(repo.repo)).toEqual(before);
    await expect(radarRunOnce(d.server.runtime, 'RCP')).rejects.toMatchObject({
      code: 'unavailable',
    });
  }, 30_000);
});

describe('B52: nothing in the server blocks on a child process', () => {
  it('server/src has no synchronous child process call', () => {
    const src = fileURLToPath(new URL('../../src', import.meta.url));
    const offenders = (readdirSync(src, { recursive: true }) as string[])
      .filter((f) => f.endsWith('.ts'))
      .filter((f) =>
        /\b(spawnSync|execSync|execFileSync)\b/.test(readFileSync(join(src, f), 'utf8')),
      );
    expect(offenders).toEqual([]);
  });
});
