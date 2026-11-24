/**
 * What is really left in a worktree (owner decision 41; BUILD_SPEC §5.16),
 * against a real git repository read by the real helper sources on this
 * machine (B76: Docket runs no git): a commit on main is never "unpushed",
 * commits and uncommitted files are reported separately, no facts from the
 * helper say "unverified" and that it waits for the helper, and nothing in
 * `.git` changes.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkProjectWorktrees } from '../../src/domain/worktree-check.js';
import type { Actor } from '../../src/domain/write.js';
import { sweepOnce } from '../../src/jobs/sweeper.js';
import { git, hashGitDir, makeRadarRepo, type RadarRepo } from '../fixtures/radar-repo.js';
import { tempDir, type TempDir } from '../helpers.js';
import { hostGitPass, hostWorktreesPass } from '../host-git.js';
import { minutes, startDomain, type Domain } from '../us1-helpers.js';

const HAS_GIT = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;

let tmp: TempDir;
let d: Domain;
let repo: RadarRepo;
let claude: Actor;

beforeEach(() => {
  tmp = tempDir('docket-b49-git-');
  if (!HAS_GIT) return;
  repo = makeRadarRepo(tmp.dir);
  d = startDomain();
  d.sql
    .prepare("UPDATE projects SET repo_path = ?, main_branch = 'main' WHERE key = 'RCP'")
    .run(repo.repo);
  claude = d.agent('claude', { label: 'orca-w1' });
});
afterEach(async () => {
  await d?.cleanup();
  rmSync(tmp.dir, { recursive: true, force: true });
});

/** An ended lead run on RCP-17 whose agent last reported a head that isn't pushed. */
function endedRun(worktree: string, head: string, dirty: boolean) {
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
  d.services.runs.heartbeat(d.read({ ...claude, run_id }), { run_id, workspace: { dirty } });
  d.clock.advance(d.server.runtime.config.leaseMs + minutes(1));
  sweepOnce(d.server.runtime);
  return run_id;
}
/** The helper's two sources read the repository, then Docket checks from their facts. */
const check = async (passes = true) => {
  if (passes) {
    await hostWorktreesPass(d.server, { home: tmp.dir });
    await hostGitPass(d.server, { home: tmp.dir });
  }
  return checkProjectWorktrees(
    d.server.runtime.db,
    d.server.runtime.config,
    'RCP',
    d.clock.now().toISOString(),
  );
};
const stored = (run_id: string) =>
  JSON.parse(
    d.row<{ worktree_check: string }>('SELECT worktree_check FROM runs WHERE id = ?', run_id)
      .worktree_check,
  ) as Record<string, unknown>;
const row = (run_id: string) => {
  const v = d.services.views.needsYou(d.read(), { scope: 'all' });
  return [...v.problems, ...(v.agent_problems ?? [])].find(
    (p) => p.id === `unpushed_work:${run_id}`,
  );
};
const headOf = (cwd: string) => git(cwd, 'rev-parse', 'HEAD').trim();

describe.runIf(HAS_GIT)('the worktree check (decision 41)', () => {
  it('a HEAD already on main is not unpushed; uncommitted files are counted separately', async () => {
    const wt = repo.worktrees['feat/a'];
    git(wt, 'reset', '-q', '--hard', 'main');
    const run_id = endedRun(wt, headOf(wt), false);
    writeFileSync(join(wt, 'one.txt'), 'x');
    writeFileSync(join(wt, 'two.txt'), 'x');
    writeFileSync(join(wt, 'shared.txt'), 'changed\n');
    expect(await check()).toBe(1);
    expect(stored(run_id)).toMatchObject({
      on_main: true,
      unpushed_commits: 0,
      uncommitted_files: 3,
    });
    const p = row(run_id)!;
    expect(p.reason).toContain('3 uncommitted files');
    expect(p.reason).toContain('commits already on main');
    expect(p.reason).not.toContain('not pushed');
    expect(p.explanation!.what).toContain('Its commits are already on main.');
    expect(p.explanation!.what).not.toContain('unverified');
  });

  it('counts commits on neither a remote nor main', async () => {
    const wt = repo.worktrees['feat/a'];
    const run_id = endedRun(wt, headOf(wt), false);
    await check();
    expect(stored(run_id)).toMatchObject({ on_main: false, on_remote: false });
    expect(stored(run_id).unpushed_commits).toBeGreaterThan(0);
    expect(row(run_id)!.reason).toMatch(/\d+ commits? not pushed/);
  });

  it('a commit on a remote ref is not unpushed, and a clean one clears the Problem', async () => {
    const wt = repo.worktrees['feat/a'];
    const head = headOf(wt);
    git(repo.repo, 'update-ref', 'refs/remotes/origin/feat/a', head);
    const run_id = endedRun(wt, head, false);
    expect(row(run_id)).toBeDefined(); // As last reported, before git has looked.
    await check();
    expect(stored(run_id)).toMatchObject({ on_remote: true, unpushed_commits: 0 });
    expect(row(run_id)).toBeUndefined();
  });

  it('writes nothing to the repository', async () => {
    const wt = repo.worktrees['feat/a'];
    const run_id = endedRun(wt, headOf(wt), true);
    writeFileSync(join(wt, 'one.txt'), 'x');
    const before = hashGitDir(repo.repo);
    await check();
    expect(stored(run_id).uncommitted_files).toBe(1);
    expect(hashGitDir(repo.repo)).toEqual(before);
  });

  it("never runs a content filter from the repository's config", async () => {
    const wt = repo.worktrees['feat/a'];
    const marker = join(tmp.dir, 'filter-ran');
    const script = join(tmp.dir, 'filter.js');
    writeFileSync(
      script,
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');process.stdin.pipe(process.stdout);`,
    );
    const command = `"${process.execPath.replace(/\\/g, '/')}" "${script.replace(/\\/g, '/')}"`;
    git(repo.repo, 'config', 'filter.evil.clean', command);
    git(repo.repo, 'config', 'filter.evil.required', 'true');
    writeFileSync(join(wt, '.gitattributes'), 'shared.txt filter=evil\n');
    writeFileSync(join(wt, 'shared.txt'), 'changed\n');
    const run_id = endedRun(wt, headOf(wt), true);
    await check();
    expect(existsSync(marker)).toBe(false);
    expect(stored(run_id).uncommitted_files).toBe(2);
  });

  it('B76: without facts from the helper it says unverified, that it waits for the helper, and keeps the last report', async () => {
    const wt = repo.worktrees['feat/a'];
    const run_id = endedRun(wt, headOf(wt), true);
    await check();
    expect(row(run_id)!.explanation!.what).not.toContain('unverified');
    // Another repository: the helper hasn't read it, so nothing vouches for this run's work.
    d.sql
      .prepare("UPDATE projects SET repo_path = ? WHERE key = 'RCP'")
      .run(join(tmp.dir, 'no-such-folder'));
    await check(false);
    const p = row(run_id)!;
    expect(p.reason).toContain('unverified');
    expect(p.reason).toContain('uncommitted changes');
    expect(p.explanation!.what).toContain('Waiting for the host helper');
    expect(p.explanation!.what).toContain('last reported state (unverified)');
  });

  it('B76: stale facts from the helper never confirm anything', async () => {
    const wt = repo.worktrees['feat/a'];
    git(wt, 'reset', '-q', '--hard', 'main');
    const run_id = endedRun(wt, headOf(wt), true);
    await check();
    expect(row(run_id)).toBeUndefined(); // git says clean and on main.
    d.sql.prepare('UPDATE runs SET worktree_check = NULL WHERE id = ?').run(run_id);
    d.clock.advance(minutes(11));
    await check(false);
    expect(row(run_id)!.reason).toContain('unverified');
  });

  it('B76: a worktree that is gone is still checked by its commit', async () => {
    const wt = repo.worktrees['feat/a'];
    const head = headOf(wt);
    const run_id = endedRun(wt, head, false);
    git(repo.repo, 'worktree', 'remove', '--force', wt);
    await check();
    expect(stored(run_id)).toMatchObject({
      head_sha: head,
      on_main: false,
      on_remote: false,
      uncommitted_files: null,
    });
    expect(stored(run_id).unpushed_commits).toBeGreaterThan(0);
  });

  it('a check more than a day old no longer counts', async () => {
    const wt = repo.worktrees['feat/a'];
    git(wt, 'reset', '-q', '--hard', 'main');
    const run_id = endedRun(wt, headOf(wt), true);
    await check();
    expect(row(run_id)).toBeUndefined(); // git says clean and on main.
    d.clock.advance(25 * 60 * minutes(1));
    expect(row(run_id)!.reason).toContain('unverified');
  });
});
