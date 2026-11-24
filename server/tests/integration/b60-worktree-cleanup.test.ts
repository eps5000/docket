/**
 * B60 (owner decision 48): every worktree of a project's repository gets a
 * plain verdict, against real fixture repositories read by the real helper
 * source on this machine (B76: Docket runs no git). Unknown is never safe,
 * stale facts are Unknown, only Safe to remove has a command, and nothing in
 * `.git` changes.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RepoWorktreeRow } from '@docket/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupLimits,
  removeCommand,
  worktreeVerdict,
  type ScannedTree,
} from '../../src/domain/worktree-cleanup.js';
import type { Actor } from '../../src/domain/write.js';
import { git, hashGitDir, makeRadarRepo, type RadarRepo } from '../fixtures/radar-repo.js';
import { tempDir, type TempDir } from '../helpers.js';
import { hostWorktreesPass } from '../host-git.js';
import { minutes, startDomain, type Domain } from '../us1-helpers.js';

const HAS_GIT = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const DAY = 24 * 3_600_000;

const tree = (over: Partial<ScannedTree> = {}): ScannedTree => ({
  path: '/work/wt',
  branch: 'feat/x',
  head: 'a'.repeat(40),
  is_main: false,
  locked: false,
  read: 'ok',
  uncommitted_files: 0,
  unpushed_commits: 0,
  merged: true,
  last_git_at: '2026-11-01T00:00:00.000Z',
  ...over,
});
const NOW = '2026-11-23T12:00:00.000Z';
const verdict = (t: ScannedTree, facts: Parameters<typeof worktreeVerdict>[0]['facts'] = null) =>
  worktreeVerdict({ tree: t, facts, awaitsRestart: false, checkedAt: NOW, now: NOW });
const facts = (over: Record<string, unknown>) =>
  ({ state: 'safe_to_prune', kept: false, handled: false, unreleased: [], ...over }) as never;

describe('worktreeVerdict', () => {
  it('a clean, merged, quiet worktree is safe', () => {
    expect(verdict(tree()).verdict).toBe('safe_to_remove');
  });

  it('commits on a remote but not merged are still safe', () => {
    const out = verdict(tree({ merged: false }));
    expect(out.verdict).toBe('safe_to_remove');
    expect(out.why).toContain('on a remote');
  });

  it.each([
    ['uncommitted files', { uncommitted_files: 2 }, '2 uncommitted files'],
    ['unpushed commits', { unpushed_commits: 1 }, '1 commit not on a remote'],
  ])('%s hold work', (_n, over, text) => {
    const out = verdict(tree(over));
    expect(out.verdict).toBe('holds_work');
    expect(out.why).toContain(text);
  });

  it('something still running holds work, even when clean', () => {
    expect(verdict(tree(), facts({ unreleased: [{}] })).verdict).toBe('holds_work');
  });

  it('a run that ended unexpectedly holds work, even when clean', () => {
    const out = worktreeVerdict({
      tree: tree(),
      facts: facts({}),
      awaitsRestart: true,
      checkedAt: NOW,
      now: NOW,
    });
    expect(out.verdict).toBe('holds_work');
  });

  it('a discarded choice never hides what git still sees', () => {
    const out = verdict(tree({ uncommitted_files: 1 }), facts({ handled: true }));
    expect(out.verdict).toBe('holds_work');
    expect(out.why).toContain('You marked this safe to discard');
  });

  it.each(['in_use', 'parked'])('a %s run is In use, even when git can’t be read', (state) => {
    expect(verdict(tree({ read: 'timed_out' }), facts({ state })).verdict).toBe('in_use');
  });

  it('the main folder is In use', () => {
    expect(verdict(tree({ is_main: true })).verdict).toBe('in_use');
  });

  it('kept and locked are Kept for later', () => {
    expect(verdict(tree(), facts({ kept: true })).verdict).toBe('kept_for_later');
    expect(verdict(tree({ locked: true })).verdict).toBe('kept_for_later');
  });

  it.each(['outside', 'missing', 'timed_out', 'unreadable'] as const)(
    'a %s read is Unknown, never safe',
    (read) => {
      expect(verdict(tree({ read })).verdict).toBe('unknown');
    },
  );

  it.each([
    ['uncommitted_files', { uncommitted_files: null }],
    ['unpushed_commits', { unpushed_commits: null }],
    ['merged', { merged: null }],
  ])('a missing %s is Unknown', (_n, over) => {
    expect(verdict(tree(over)).verdict).toBe('unknown');
  });

  it('an old check is Unknown', () => {
    const out = worktreeVerdict({
      tree: tree(),
      facts: null,
      awaitsRestart: false,
      checkedAt: new Date(Date.parse(NOW) - cleanupLimits.freshMs - 1).toISOString(),
      now: NOW,
    });
    expect(out.verdict).toBe('unknown');
  });

  it('an untracked worktree that changed in the last day is Unknown', () => {
    const recent = new Date(Date.parse(NOW) - DAY + 60_000).toISOString();
    expect(verdict(tree({ last_git_at: recent })).verdict).toBe('unknown');
    expect(verdict(tree({ last_git_at: null })).verdict).toBe('unknown');
    // A run Docket knows has ended is enough, however recent.
    expect(verdict(tree({ last_git_at: recent }), facts({})).verdict).toBe('safe_to_remove');
  });
});

describe('removeCommand', () => {
  it('never forces, and quotes both paths', () => {
    const c = removeCommand('C:/repos/app', 'C:/repos/app-wt/feat x');
    expect(c).toBe(`git -C 'C:/repos/app' worktree remove 'C:/repos/app-wt/feat x'`);
    expect(c).not.toContain('force');
  });

  it.each([
    `/w/it's`,
    '/w/$(rm -rf x)',
    '/w/`x`',
    '/w/a;b',
    '/w/a&b',
    '/w/a|b',
    '/w/a"b',
    '/w/a\nb',
    'relative/path',
    '-f',
  ])('offers nothing for %j', (path) => {
    expect(removeCommand('/repos/app', path)).toBeNull();
    expect(removeCommand(path, '/repos/app-wt')).toBeNull();
  });
});

describe.skipIf(!HAS_GIT)('against a real repository', () => {
  let tmp: TempDir;
  let elsewhere: string;
  let d: Domain;
  let repo: RadarRepo;
  let claude: Actor;

  beforeEach(() => {
    tmp = tempDir('docket-b60-git-');
    elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'docket-b60-out-')));
    repo = makeRadarRepo(tmp.dir);
    // A bare "origin" holds main and feat/c, so those count as on a remote.
    const origin = join(tmp.dir, 'origin.git');
    git(tmp.dir, 'init', '-q', '--bare', '-b', 'main', origin);
    git(repo.repo, 'remote', 'add', 'origin', origin);
    git(repo.repo, 'push', '-q', 'origin', 'main', 'feat/c');
    // The real time: the fixture's commits and file times are from now.
    d = startDomain({ now: new Date() });
    d.sql
      .prepare("UPDATE projects SET repo_path = ?, main_branch = 'main' WHERE key = 'RCP'")
      .run(repo.repo);
    claude = d.agent('claude', { label: 'orca-w1' });
  });
  afterEach(async () => {
    await d.cleanup();
    rmSync(elsewhere, { recursive: true, force: true });
    rmSync(tmp.dir, { recursive: true, force: true });
  });

  /** One read of the view, after the helper's pass (B76: Docket reads no git itself). */
  async function view(pass = true) {
    if (pass) await hostWorktreesPass(d.server, { home: tmp.dir });
    return d.services.recovery.worktreeCleanup(d.read(), { project: 'RCP' });
  }
  const row = (rows: RepoWorktreeRow[], path: string) => {
    const key = path.replace(/\\/g, '/').toLowerCase();
    const found = rows.find((r) => r.path.replace(/\\/g, '/').toLowerCase() === key);
    expect(found, path).toBeDefined();
    return found!;
  };
  /** Past the "changed in the last day" window for worktrees Docket has no run for. */
  const quiet = () => d.clock.advance(DAY * 2);

  it('gives each worktree its verdict and offers a command only when safe', async () => {
    writeFileSync(join(repo.worktrees['feat/b'], 'scratch.txt'), 'not saved\n');
    quiet();
    const out = await view();
    expect(out.repo).toBe('ok');
    expect(out.rows).toHaveLength(4);

    const main = row(out.rows, repo.repo);
    expect(main.verdict).toBe('in_use');
    expect(main.command).toBeNull();

    // feat/a has a commit on no remote.
    const a = row(out.rows, repo.worktrees['feat/a']);
    expect(a).toMatchObject({
      verdict: 'holds_work',
      unpushed_commits: 1,
      uncommitted_files: 0,
      merged: false,
      tracked: false,
      command: null,
    });

    // feat/b has that too, and a file that was never committed.
    const b = row(out.rows, repo.worktrees['feat/b']);
    expect(b).toMatchObject({ verdict: 'holds_work', uncommitted_files: 1, command: null });

    // feat/c is clean and on origin.
    const c = row(out.rows, repo.worktrees['feat/c']);
    expect(c).toMatchObject({ verdict: 'safe_to_remove', unpushed_commits: 0, merged: false });
    expect(c.command).toContain('worktree remove');

    for (const r of out.rows) {
      if (r.verdict !== 'safe_to_remove') expect(r.command).toBeNull();
      else expect(r.command).toMatch(/^git -C '.+' worktree remove '.+'$/);
      expect(r.command ?? '').not.toContain('force');
    }
  });

  it('counts commits that are on no remote and not in main', async () => {
    const wt = repo.worktrees['feat/c'];
    writeFileSync(join(wt, 'more.txt'), 'x\n');
    git(wt, 'add', 'more.txt');
    git(wt, 'commit', '-q', '-m', 'One');
    writeFileSync(join(wt, 'more2.txt'), 'y\n');
    git(wt, 'add', 'more2.txt');
    git(wt, 'commit', '-q', '-m', 'Two');
    quiet();
    const c = row((await view()).rows, wt);
    expect(c.unpushed_commits).toBe(2);
    expect(c.merged).toBe(false);
    expect(c.verdict).toBe('holds_work');
  });

  it('is safe once a clean branch is on the remote, and says it isn’t merged', async () => {
    const wt = repo.worktrees['feat/c'];
    quiet();
    const c = row((await view()).rows, wt);
    expect(c).toMatchObject({ uncommitted_files: 0, unpushed_commits: 0 });
    expect(c.verdict).toBe('safe_to_remove');
    expect(c.command).toContain('worktree remove');
  });

  it('a live run is In use, with its ticket', async () => {
    const wt = repo.worktrees['feat/c'];
    d.write(claude, (w, s) =>
      s.runs.claim(w, {
        id: 'RCP-17',
        agent_label: 'orca-w1',
        workspace: { path: wt, branch: 'feat/c' },
      }),
    );
    const c = row((await view()).rows, wt);
    expect(c).toMatchObject({ verdict: 'in_use', tracked: true, item_id: 'RCP-17', command: null });
  });

  it('a locked worktree is Kept for later', async () => {
    git(repo.repo, 'worktree', 'lock', repo.worktrees['feat/c']);
    quiet();
    expect(row((await view()).rows, repo.worktrees['feat/c']).verdict).toBe('kept_for_later');
  });

  it('B76: a worktree in any folder on the host is read', async () => {
    const outside = join(elsewhere, 'wt-out');
    git(repo.repo, 'worktree', 'add', '-q', outside, '-b', 'feat/out', 'main');
    quiet();
    const r = row((await view()).rows, realpathSync(outside));
    expect(r).toMatchObject({ uncommitted_files: 0, unpushed_commits: 0, merged: true });
    expect(r.verdict).toBe('safe_to_remove');
  });

  it('a worktree whose folder is gone is Unknown', async () => {
    const wt = repo.worktrees['feat/c'];
    rmSync(wt, { recursive: true, force: true });
    quiet();
    const r = row((await view()).rows, wt);
    expect(r.verdict).toBe('unknown');
    expect(r.command).toBeNull();
  });

  it('B76: facts older than three passes are Unknown for every worktree, never safe', async () => {
    quiet();
    expect((await view()).rows.some((r) => r.verdict === 'safe_to_remove')).toBe(true);
    d.clock.advance(minutes(11));
    const stale = await view(false);
    expect(stale.host.state).toBe('stale');
    for (const r of stale.rows.filter((x) => !x.path.endsWith('recipe-app'))) {
      expect(r.verdict).toBe('unknown');
      expect(r.command).toBeNull();
    }
  });

  it('writes nothing to the repository or any worktree’s admin folder', async () => {
    writeFileSync(join(repo.worktrees['feat/b'], 'scratch.txt'), 'not saved\n');
    const before = hashGitDir(repo.repo);
    quiet();
    await view();
    d.clock.advance(minutes(5));
    await view();
    expect(hashGitDir(repo.repo)).toEqual(before);
  });

  it('runs no filter the repository’s config names', async () => {
    const marker = join(elsewhere, 'filter-ran');
    git(
      repo.repo,
      'config',
      'filter.evil.clean',
      `sh -c 'touch "${marker.replace(/\\/g, '/')}"; cat'`,
    );
    writeFileSync(join(repo.worktrees['feat/c'], '.gitattributes'), '*.txt filter=evil\n');
    writeFileSync(join(repo.worktrees['feat/c'], 'new.txt'), 'x\n');
    quiet();
    await view();
    expect(existsSync(marker)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'never runs a signature program the repository’s config names',
    async () => {
      const marker = join(elsewhere, 'gpg-ran');
      const script = join(elsewhere, 'fake-gpg');
      writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
      const wt = repo.worktrees['feat/c'];
      const tree_ = git(wt, 'rev-parse', 'HEAD^{tree}').trim();
      const parent = git(wt, 'rev-parse', 'HEAD').trim();
      const who = 'Docket Test <test@docket.invalid> 1790000000 +0000';
      const body = [
        `tree ${tree_}`,
        `parent ${parent}`,
        `author ${who}`,
        `committer ${who}`,
        'gpgsig -----BEGIN PGP SIGNATURE-----',
        ' fake',
        ' -----END PGP SIGNATURE-----',
        '',
        'Signed',
        '',
      ].join('\n');
      const file = join(elsewhere, 'commit.txt');
      writeFileSync(file, body);
      const signed = git(wt, 'hash-object', '-t', 'commit', '-w', file).trim();
      git(wt, 'reset', '-q', '--hard', signed);
      git(repo.repo, 'config', 'log.showSignature', 'true');
      git(repo.repo, 'config', 'gpg.program', script);
      quiet();
      await view();
      expect(existsSync(marker)).toBe(false);
    },
  );

  it('a project with no repository folder says so', () => {
    d.sql.prepare("UPDATE projects SET repo_path = NULL WHERE key = 'RCP'").run();
    expect(d.services.recovery.worktreeCleanup(d.read(), { project: 'RCP' })).toMatchObject({
      repo: 'not_set',
      rows: [],
    });
  });

  it('B76: before the helper reports a repository, the view waits for it', async () => {
    d.sql.prepare('UPDATE projects SET repo_path = ? WHERE key = ?').run(elsewhere, 'RCP');
    expect(await view(false)).toMatchObject({
      repo: 'ok',
      rows: [],
      host: { state: 'none', checked_at: null },
    });
  });

  it('handles hundreds of worktrees', { timeout: 120_000 }, async () => {
    for (let i = 0; i < 120; i += 1) {
      git(repo.repo, 'worktree', 'add', '-q', '--detach', join(tmp.dir, `many-${i}`), 'main');
    }
    quiet();
    const out = await view();
    expect(out.rows).toHaveLength(124);
    expect(out.rows.filter((r) => r.verdict === 'safe_to_remove').length).toBeGreaterThan(100);
  });
});
