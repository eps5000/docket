/**
 * B68 (owner decision 48): worktree facts from the host helper. The collector
 * runs against real temporary repositories with linked worktrees. The server
 * side uses made-up Windows paths, the case the container can't read itself.
 * Stale, partial or missing facts are never Safe to remove, and nothing in
 * `.git` changes.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { HostWorktreeRecord, RepoWorktreeRow } from '@docket/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostRepoPath, hostScanView } from '../../src/domain/host-worktrees.js';
import { checkProjectWorktrees } from '../../src/domain/worktree-check.js';
import { sweepOnce } from '../../src/jobs/sweeper.js';
import { OWNER_ACTOR } from '../../src/domain/write.js';
import { git, hashGitDir, makeRadarRepo, type RadarRepo } from '../fixtures/radar-repo.js';
import { tempDir, type TempDir } from '../helpers.js';
import { addProject, forceStatus, minutes, startDomain, type Domain } from '../us1-helpers.js';

const HAS_GIT = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const TOOL = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'tools',
  'docket-sync',
);
const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(join(TOOL, file)).href);

const source = await load('sources/worktrees.mjs');
const gitLib = await load('lib/git.mjs');

const DAY = 24 * 3_600_000;
const RUN = { ok: true, interval_ms: 180_000 };
const SHA = 'a'.repeat(40);
const PLANTED = 'PLANTED-file-name-7f3a.txt';

type Rec = Record<string, unknown>;

describe('reading the list of worktrees', () => {
  it('parses Windows paths, locks, detached heads and bare entries', () => {
    const out = source.parseWorktreeList(
      [
        'worktree C:/work/app',
        `HEAD ${SHA}`,
        'branch refs/heads/main',
        '',
        'worktree C:/Users/sample/wt one',
        `HEAD ${SHA}`,
        'detached',
        'locked a private reason',
        '',
        'worktree D:/bare.git',
        'bare',
        '',
      ].join('\r\n'),
    );
    expect(out).toEqual([
      { path: 'C:/work/app', head: SHA, branch: 'main', locked: false, bare: false },
      { path: 'C:/Users/sample/wt one', head: SHA, branch: null, locked: true, bare: false },
      { path: 'D:/bare.git', head: null, branch: null, locked: false, bare: true },
    ]);
    expect(JSON.stringify(out)).not.toContain('private reason');
  });

  it.each([
    ['C:/work/app', 'win32', true],
    ['C:\\work\\app', 'win32', true],
    ['/work/app', 'linux', true],
    ['/work/app', 'win32', false],
    ['\\\\host\\share\\wt', 'win32', false],
    ['//host/share/wt', 'win32', false],
    ['//host/share/wt', 'linux', false],
    ['\\\\?\\C:\\wt', 'win32', false],
    ['C:/work/../other', 'win32', false],
    ['relative/wt', 'linux', false],
    ['/work/a\nb', 'linux', false],
    ['', 'linux', false],
  ])('%j on %s is usable: %s', (path, platform, ok) => {
    expect(source.safeHostPath(path, platform)).toBe(ok);
  });

  it('finds git only on absolute PATH entries, and passes on no git settings', () => {
    expect(gitLib.findGit({ PATH: 'relative-folder' })).toBeNull();
    const env = gitLib.gitEnv({
      PATH: '/bin',
      GIT_DIR: '/elsewhere',
      GIT_SSH_COMMAND: 'x',
      GIT_EXTERNAL_DIFF: 'x',
      NODE_OPTIONS: 'x',
    });
    expect(env).toMatchObject({ PATH: '/bin', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' });
    for (const key of ['GIT_DIR', 'GIT_SSH_COMMAND', 'GIT_EXTERNAL_DIFF', 'NODE_OPTIONS']) {
      expect(env[key]).toBeUndefined();
    }
  });
});

describe.skipIf(!HAS_GIT)('the collector, on a real repository', () => {
  let tmp: TempDir;
  let repo: RadarRepo;
  let wt: Record<'merged' | 'dirty' | 'locked' | 'detached' | 'gone', string>;
  const env = () => ({
    PATH: process.env.PATH ?? process.env.Path ?? '',
    SYSTEMROOT: process.env.SYSTEMROOT ?? '',
    HOME: tmp.dir,
    USERPROFILE: tmp.dir,
    XDG_CONFIG_HOME: tmp.dir,
  });
  const project = () => ({
    key: 'RCP',
    repo_path: repo.repo,
    main_branch: 'main',
    host_path: repo.repo,
  });
  const collect = (over: Rec = {}, state: Rec = {}) =>
    source.collect(
      { state, log: over.log, settings: { enabled: true, projects: [project()] } },
      { env: env(), ...over },
    ) as Promise<{ records: Rec[]; state: Rec }>;
  const treeAt = (records: Rec[], path: string) => {
    const key = realpathSync(path).replace(/\\/g, '/').toLowerCase();
    const found = records.find(
      (r) => r.kind === 'tree' && String(r.path).replace(/\\/g, '/').toLowerCase() === key,
    );
    expect(found, path).toBeDefined();
    return found!;
  };

  beforeEach(() => {
    tmp = tempDir('docket-b68-git-');
    repo = makeRadarRepo(tmp.dir);
    const origin = join(tmp.dir, 'origin.git');
    git(tmp.dir, 'init', '-q', '--bare', '-b', 'main', origin);
    git(repo.repo, 'remote', 'add', 'origin', origin);
    git(repo.repo, 'push', '-q', 'origin', 'main', 'feat/c');
    wt = {
      merged: join(tmp.dir, 'wt-merged'),
      dirty: join(tmp.dir, 'wt-dirty'),
      locked: join(tmp.dir, 'wt-locked'),
      detached: join(tmp.dir, 'wt-detached'),
      gone: join(tmp.dir, 'wt-gone'),
    };
    git(repo.repo, 'worktree', 'add', '-q', wt.merged, '-b', 'feat/merged', 'main');
    git(repo.repo, 'worktree', 'add', '-q', wt.dirty, '-b', 'feat/dirty', 'main');
    git(repo.repo, 'worktree', 'add', '-q', wt.locked, '-b', 'feat/locked', 'main');
    git(repo.repo, 'worktree', 'lock', '--reason', 'a private reason', wt.locked);
    git(repo.repo, 'worktree', 'add', '-q', '--detach', wt.detached, 'main');
    git(repo.repo, 'worktree', 'add', '-q', wt.gone, '-b', 'feat/gone', 'main');
    writeFileSync(join(wt.dirty, PLANTED), 'not saved\n');
  });
  afterEach(() => rmSync(tmp.dir, { recursive: true, force: true }));

  it('reports clean, dirty, unpushed, merged, locked, detached and missing', async () => {
    const realGone = realpathSync(wt.gone);
    rmSync(wt.gone, { recursive: true, force: true });
    const { records } = await collect();
    const scan = records.find((r) => r.kind === 'scan')!;
    expect(scan).toMatchObject({ status: 'ok', complete: true, project: 'RCP' });
    expect(scan.tree_count).toBe(records.length - 1);

    expect(treeAt(records, repo.repo)).toMatchObject({ is_main: true, read: 'ok' });
    expect(treeAt(records, wt.merged)).toMatchObject({
      read: 'ok',
      branch: 'feat/merged',
      uncommitted_files: 0,
      unpushed_commits: 0,
      merged: true,
    });
    expect(treeAt(records, wt.dirty)).toMatchObject({ read: 'ok', uncommitted_files: 1 });
    expect(treeAt(records, repo.worktrees['feat/a'])).toMatchObject({
      read: 'ok',
      unpushed_commits: 1,
      merged: false,
    });
    expect(treeAt(records, repo.worktrees['feat/c'])).toMatchObject({
      read: 'ok',
      unpushed_commits: 0,
      merged: false,
    });
    expect(treeAt(records, wt.locked)).toMatchObject({ locked: true, read: 'ok' });
    expect(treeAt(records, wt.detached)).toMatchObject({ branch: null, read: 'ok' });

    const gone = records.find(
      (r) =>
        r.kind === 'tree' &&
        String(r.path).replace(/\\/g, '/').toLowerCase() ===
          realGone.replace(/\\/g, '/').toLowerCase(),
    )!;
    expect(gone).toMatchObject({ read: 'missing', uncommitted_files: null, merged: null });
  });

  it('writes nothing, and no file name reaches a record, the state or the log', async () => {
    const before = hashGitDir(repo.repo);
    const lines: string[] = [];
    const out = await collect({ log: (e: string, f: Rec) => lines.push(e, JSON.stringify(f)) });
    await collect();
    expect(hashGitDir(repo.repo)).toEqual(before);
    const everything = JSON.stringify([out.records, out.state, lines]);
    expect(everything).not.toContain(PLANTED);
    expect(everything).not.toContain('private reason');
    const allowed = new Set([
      'key',
      'kind',
      'project',
      'scan_id',
      'path',
      'branch',
      'head',
      'is_main',
      'locked',
      'read',
      'uncommitted_files',
      'unpushed_commits',
      'merged',
      'last_git_at',
      'repo_path',
      'main_branch',
      'status',
      'complete',
      'tree_count',
      'checked_at',
      'main_path',
    ]);
    for (const record of out.records) {
      for (const field of Object.keys(record)) expect(allowed.has(field), field).toBe(true);
    }
  });

  it('runs no filter or filesystem monitor the repository’s config names', async () => {
    const marker = join(tmp.dir, 'ran').replace(/\\/g, '/');
    git(repo.repo, 'config', 'filter.evil.clean', `sh -c 'touch "${marker}-filter"; cat'`);
    git(repo.repo, 'config', 'core.fsmonitor', `sh -c 'touch "${marker}-monitor"'`);
    writeFileSync(join(wt.merged, '.gitattributes'), '*.txt filter=evil\n');
    writeFileSync(join(wt.merged, 'new.txt'), 'x\n');
    await collect();
    expect(existsSync(`${marker}-filter`)).toBe(false);
    expect(existsSync(`${marker}-monitor`)).toBe(false);
  });

  it('counts files without keeping them, and stops at the cap', async () => {
    const many = join(wt.dirty, 'many');
    mkdirSync(many);
    for (let i = 0; i < 6; i += 1) writeFileSync(join(many, `f${i}.txt`), 'x');
    const { records } = await collect({ limits: { countCap: 3 } });
    expect(treeAt(records, wt.dirty).uncommitted_files).toBe(3);
  });

  it('a timed-out read is timed_out, never ok', async () => {
    const real = gitLib.createGit({ env: env() });
    const slow = {
      read: (dir: string, args: string[], options: Rec) =>
        args.includes('status')
          ? Promise.resolve({ status: null, stdout: '', count: 0, unknown: true })
          : real.read(dir, args, options),
    };
    const { records } = await collect({ git: slow });
    const trees = records.filter((r) => r.kind === 'tree' && r.read !== 'missing');
    expect(trees.length).toBeGreaterThan(0);
    for (const t of trees) {
      expect(t.read).toBe('timed_out');
      expect(t.uncommitted_files).toBeNull();
    }
  });

  // A real child process that never answers, so the time limit always wins. Real git with a
  // 1 ms limit raced its own exit and failed now and then (B77, B78, B82). The fake is a POSIX
  // script, and findGit only takes git.exe on Windows, so it runs where CI runs.
  it.skipIf(process.platform === 'win32')(
    'a git call past its time limit is stopped and has no answer',
    async () => {
      const bin = join(tmp.dir, 'silent-bin');
      mkdirSync(bin);
      const fake = join(bin, 'git');
      const started = join(tmp.dir, 'silent-git-started');
      writeFileSync(fake, ['#!/bin/sh', `touch '${started}'`, 'exec sleep 30', ''].join('\n'), {
        mode: 0o755,
      });
      const base = env();
      const silent = gitLib.createGit({ env: { ...base, PATH: `${bin}${delimiter}${base.PATH}` } });
      const began = Date.now();
      // Long enough for the script to start under load; it never answers, so the limit decides.
      const r = await silent.read(repo.repo, ['status', '--porcelain'], { timeoutMs: 1_000 });
      expect(r).toEqual({ status: null, stdout: '', count: 0, unknown: true });
      // It really ran, and was stopped at the limit rather than waited out.
      expect(existsSync(started)).toBe(true);
      const took = Date.now() - began;
      expect(took).toBeGreaterThanOrEqual(900);
      expect(took).toBeLessThan(10_000);
    },
  );

  it('a pass out of time is partial, and the next one carries on', async () => {
    let clock = 1_000_000_000_000;
    const real = gitLib.createGit({ env: env() });
    const ticking = {
      read: (dir: string, args: string[], options: Rec) => {
        if (args.includes('status')) clock += 40_000;
        return real.read(dir, args, options);
      },
    };
    const options = { git: ticking, now: () => clock, limits: { workers: 1, passMs: 100_000 } };
    const first = await collect(options);
    const closed = first.records.find((r) => r.kind === 'scan')!;
    expect(closed.complete).toBe(false);
    const firstPaths = first.records.filter((r) => r.kind === 'tree').map((r) => r.path);
    expect(firstPaths.length).toBeLessThan(9);

    const second = await collect(options, first.state);
    const secondPaths = second.records.filter((r) => r.kind === 'tree').map((r) => r.path);
    expect(secondPaths.some((p) => !firstPaths.includes(p))).toBe(true);
  });

  it('a folder that isn’t a repository closes its scan as unreadable', async () => {
    const plain = join(tmp.dir, 'plain');
    mkdirSync(plain);
    const { records } = (await source.collect(
      {
        state: {},
        settings: {
          enabled: true,
          projects: [{ ...project(), repo_path: plain, host_path: plain }],
        },
      },
      { env: env() },
    )) as { records: Rec[] };
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: 'scan', status: 'unreadable', complete: false });
  });

  it('is off with no project, and opens nothing', async () => {
    const out = await source.collect(
      { state: {}, settings: { enabled: false, projects: [] } },
      { git: { read: () => expect.unreachable() } },
    );
    expect(out.records).toEqual([]);
  });
});

// ---- The server side: made-up Windows paths the container can't reach ----

const MAIN = 'C:/work/app';
const WT = 'C:/Users/sample/worktrees/feature-one';
const OTHER = 'C:/Users/sample/worktrees/feature-two';

describe('host facts on the server', () => {
  let d: Domain;
  let seq = 0;

  beforeEach(() => {
    d = startDomain({ seed: false, now: new Date('2026-11-23T12:00:00.000Z') });
    addProject(d, 'GF');
    d.sql
      .prepare("UPDATE projects SET repo_path = ?, main_branch = 'main' WHERE key = 'GF'")
      .run(MAIN);
  });
  afterEach(async () => {
    await d.cleanup();
  });

  const old = () => new Date(d.clock.now().getTime() - 3 * DAY).toISOString();
  const treeRec = (id: string, path: string, over: Partial<Rec> = {}) => ({
    key: `tree:GF:${id}:${path.length}-${path.at(-1)}`,
    kind: 'tree',
    project: 'GF',
    scan_id: id,
    path,
    branch: 'feature/one',
    head: SHA,
    is_main: path === MAIN,
    locked: false,
    read: 'ok',
    uncommitted_files: 0,
    unpushed_commits: 0,
    merged: true,
    last_git_at: old(),
    ...over,
  });
  const scanRec = (id: string, count: number, over: Partial<Rec> = {}) => ({
    key: `scan:GF:${id}`,
    kind: 'scan',
    project: 'GF',
    scan_id: id,
    repo_path: MAIN,
    main_branch: 'main',
    status: 'ok',
    complete: true,
    tree_count: count,
    checked_at: d.clock.now().toISOString(),
    main_path: MAIN,
    ...over,
  });
  const post = (records: unknown[]) =>
    d.services.sync.ingest(d.server.runtime.write, 'worktrees', {
      records: records as never,
      run: RUN,
    });
  const scanOf = (paths: string[], over: Partial<Rec> = {}, tree: Partial<Rec> = {}) => {
    seq += 1;
    const id = `scan-${seq}`;
    return [...paths.map((p) => treeRec(id, p, tree)), scanRec(id, paths.length, over)];
  };
  const view = async () => d.services.recovery.worktreeCleanup(d.read(), { project: 'GF' });
  const rowOf = (rows: RepoWorktreeRow[], path: string) => rows.find((r) => r.path === path);
  const detail = () =>
    d.row<{ detail: string }>("SELECT detail FROM sync_sources WHERE name = 'worktrees'").detail;

  it('tells the helper each project’s repository as the host sees it', () => {
    const out = d.services.sync.source(d.read(), 'worktrees');
    expect(out.settings).toMatchObject({
      enabled: true,
      projects: [{ key: 'GF', repo_path: MAIN, main_branch: 'main', host_path: MAIN }],
    });
  });

  it('maps a push-folder path to the host, and refuses what can’t be told', () => {
    const config = {
      ...d.server.runtime.config,
      pushRoot: '/push',
      pushHostPath: 'C:\\Users\\sample\\repos',
    };
    expect(hostRepoPath(config, 'app')).toBe('C:/Users/sample/repos/app');
    expect(hostRepoPath(config, '/push/app')).toBe('C:/Users/sample/repos/app');
    expect(hostRepoPath(config, 'D:/elsewhere/app')).toBe('D:/elsewhere/app');
    expect(hostRepoPath(config, '//server/share/app')).toBeNull();
    const unmapped = { ...config, pushHostPath: null };
    expect(hostRepoPath(unmapped, '/push/app')).toBeNull();
    expect(hostRepoPath(unmapped, 'app')).toBeNull();
  });

  it('uses fresh facts for a folder the container can’t read', async () => {
    post(scanOf([MAIN, WT]));
    const out = await view();
    expect(out).toMatchObject({ repo: 'ok', host: { state: 'fresh' } });
    expect(rowOf(out.rows, MAIN)).toMatchObject({ verdict: 'in_use', source: 'host' });
    const row = rowOf(out.rows, WT)!;
    expect(row).toMatchObject({ verdict: 'safe_to_remove', source: 'host', uncommitted_files: 0 });
    expect(row.command).toBe(`git -C '${MAIN}' worktree remove '${WT}'`);
  });

  it('holds work and locks count as they do from the container', async () => {
    post(scanOf([MAIN, WT], {}, { uncommitted_files: 2 }));
    expect(rowOf((await view()).rows, WT)).toMatchObject({ verdict: 'holds_work', command: null });
    post(scanOf([MAIN, WT], {}, { locked: true }));
    expect(rowOf((await view()).rows, WT)!.verdict).toBe('kept_for_later');
  });

  it('applying the same batch twice changes nothing and records no event', async () => {
    const batch = scanOf([MAIN, WT]);
    post(batch);
    const once = detail();
    const events = d.rows('SELECT seq FROM events').length;
    post(batch);
    post(batch.slice(0, 1));
    expect(detail()).toBe(once);
    expect(d.rows('SELECT seq FROM events')).toHaveLength(events);
  });

  it('takes a scan split across batches', async () => {
    const records = scanOf([MAIN, WT, OTHER]);
    post(records.slice(0, 2));
    post(records.slice(2));
    expect((await view()).rows).toHaveLength(3);
  });

  it('stale facts are Unknown, never safe, and don’t vouch for a lock', async () => {
    post(scanOf([MAIN, WT], {}, { locked: true }));
    d.clock.advance(minutes(11));
    const out = await view();
    expect(out.host.state).toBe('stale');
    const row = rowOf(out.rows, WT)!;
    expect(row).toMatchObject({
      verdict: 'unknown',
      uncommitted_files: null,
      unpushed_commits: null,
      merged: null,
      command: null,
    });
    expect(row.why).toContain('too old');
    expect(rowOf(out.rows, MAIN)!.verdict).toBe('in_use');
  });

  it.each([
    ['timed out', { read: 'timed_out', uncommitted_files: null }],
    ['missing', { read: 'missing', uncommitted_files: null, unpushed_commits: null }],
    ['unreadable', { read: 'unreadable', merged: null }],
    ['a missing count', { uncommitted_files: null }],
    ['a missing merge fact', { merged: null }],
  ])('%s is Unknown, never safe', async (_name, over) => {
    post(scanOf([MAIN, WT], {}, over));
    expect(rowOf((await view()).rows, WT)).toMatchObject({ verdict: 'unknown', command: null });
  });

  it('a live run is In use at once, whatever the facts say', async () => {
    post(scanOf([MAIN, WT]));
    const item = d.write(OWNER_ACTOR, (w, s) =>
      s.items.create(w, {
        project: 'GF',
        type: 'Task',
        title: 'A task',
        priority: 2,
        status: 'planning',
      }),
    ).id;
    forceStatus(d, item, 'ready');
    const agent = d.agent('claude', { label: 'w1' });
    d.write(agent, (w, s) =>
      s.runs.claim(w, {
        id: item,
        agent_label: 'w1',
        workspace: { path: WT.toUpperCase(), branch: 'feature/one' },
      }),
    );
    expect(rowOf((await view()).rows, WT)).toMatchObject({
      verdict: 'in_use',
      tracked: true,
      command: null,
    });
    d.clock.advance(minutes(11));
    expect(rowOf((await view()).rows, WT)!.verdict).not.toBe('safe_to_remove');
  });

  it('a worktree missing from the newest complete scan drops out', async () => {
    post(scanOf([MAIN, WT, OTHER]));
    d.clock.advance(minutes(1));
    post(scanOf([MAIN, WT]));
    const out = await view();
    expect(rowOf(out.rows, OTHER)).toBeUndefined();
    expect(out.rows).toHaveLength(2);
  });

  it('a partial scan removes nothing', async () => {
    post(scanOf([MAIN, WT, OTHER]));
    d.clock.advance(minutes(1));
    post(scanOf([MAIN], { complete: false }));
    expect((await view()).rows).toHaveLength(3);
  });

  it('a scan short of its own count is partial', async () => {
    post(scanOf([MAIN, WT, OTHER]));
    d.clock.advance(minutes(1));
    seq += 1;
    const id = `scan-${seq}`;
    post([treeRec(id, MAIN), scanRec(id, 2)]);
    expect((await view()).rows).toHaveLength(3);
  });

  it('what a partial scan didn’t reach goes Unknown when its own facts age', async () => {
    post(scanOf([MAIN, WT, OTHER]));
    d.clock.advance(minutes(9));
    post(scanOf([MAIN, WT], { complete: false }));
    d.clock.advance(minutes(2));
    const out = await view();
    expect(rowOf(out.rows, WT)!.verdict).toBe('safe_to_remove');
    expect(rowOf(out.rows, OTHER)).toMatchObject({ verdict: 'unknown', command: null });
  });

  it('an unreadable scan removes nothing and freshens nothing', async () => {
    post(scanOf([MAIN, WT]));
    const before = detail();
    d.clock.advance(minutes(1));
    seq += 1;
    post([scanRec(`scan-${seq}`, 0, { status: 'unreadable', complete: false, main_path: null })]);
    expect(detail()).toBe(before);
  });

  it('an older scan can’t replace a newer one', async () => {
    const older = scanOf([MAIN, WT, OTHER]);
    d.clock.advance(minutes(1));
    post(scanOf([MAIN, WT]));
    post(older);
    expect((await view()).rows).toHaveLength(2);
  });

  it('a scan dated in the future is refused, and can’t block the real ones', async () => {
    const ahead = new Date(d.clock.now().getTime() + DAY).toISOString();
    post(scanOf([MAIN, WT], { checked_at: ahead }));
    expect((await view()).host.state).toBe('none');
    post(scanOf([MAIN, WT]));
    expect((await view()).host.state).toBe('fresh');
  });

  it('a time with an offset is stored in one spelling', () => {
    post(scanOf([MAIN, WT], { checked_at: '2026-11-23T13:00:00.000+01:00' }));
    expect(detail()).toContain('"checked_at":"2026-11-23T12:00:00.000Z"');
  });

  it('ignores facts for a repository the project no longer points at', async () => {
    post(scanOf([MAIN, WT]));
    d.sql.prepare("UPDATE projects SET repo_path = 'D:/moved' WHERE key = 'GF'").run();
    expect((await view()).host.state).toBe('none');
    post(scanOf([MAIN, WT]));
    expect((await view()).rows).toEqual([]);
  });

  it('refuses a record with any extra field, such as a file name', () => {
    seq += 1;
    const id = `scan-${seq}`;
    const out = post([{ ...treeRec(id, WT), files: [PLANTED] }, scanRec(id, 1)]);
    expect(out.ignored).toBe(1);
    expect(detail()).not.toContain(PLANTED);
  });

  it.each(['//server/share/wt', 'relative/wt', '\\\\server\\share\\wt'])(
    'refuses the path %s',
    (path) => {
      seq += 1;
      const id = `scan-${seq}`;
      expect(post([treeRec(id, path)]).ignored).toBe(1);
    },
  );

  it('withholds a secret-looking branch, and leaves out a secret-looking path', async () => {
    const token = `ghp_${'a1B2'.repeat(9)}`;
    post(scanOf([MAIN, WT]));
    d.clock.advance(minutes(1));
    seq += 1;
    const id = `scan-${seq}`;
    const out = post([
      treeRec(id, MAIN),
      treeRec(id, WT, { branch: `feature/${token}` }),
      treeRec(id, `C:/work/${token}`),
      scanRec(id, 3),
    ]);
    expect(out.ignored).toBe(1);
    expect(detail()).not.toContain(token);
    expect(rowOf((await view()).rows, WT)!.branch).toBe('withheld');
  });

  it('a deleted project’s folder names are forgotten', () => {
    post(scanOf([MAIN, WT]));
    d.write(OWNER_ACTOR, (w, s) => s.projects.delete(w, { key: 'GF', confirm_key: 'GF' }));
    expect(detail()).not.toContain('feature-one');
  });

  describe('B76: the helper’s facts are the only read', () => {
    const stored = (paths: string[], at: string) => ({
      repo_path: MAIN,
      main_branch: 'main',
      scan_id: 'x',
      checked_at: at,
      complete_at: at,
      main_path: MAIN,
      trees: paths.map((path) => ({
        path,
        branch: 'feature/one',
        head: SHA,
        is_main: path === MAIN,
        locked: path !== MAIN,
        read: 'ok' as const,
        uncommitted_files: 0,
        unpushed_commits: 0,
        merged: true,
        last_git_at: old(),
        checked_at: at,
      })),
    });
    const NOW = '2026-11-23T12:00:00.000Z';
    const ago = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString();

    it('fresh facts are the rows, all from the host', () => {
      const view = hostScanView(stored([MAIN, WT], ago(5)), NOW)!;
      expect(view.host).toEqual({ state: 'fresh', checked_at: ago(5) });
      expect(view.trees.map((t) => t.source)).toEqual(['host', 'host']);
      expect(view.trees.find((t) => t.tree.path === WT)!.tree.locked).toBe(true);
    });

    it('stale facts are Unknown rows that vouch for nothing, not even a lock', () => {
      const view = hostScanView(stored([MAIN, WT], ago(30)), NOW)!;
      expect(view.host.state).toBe('stale');
      expect(view.trees.find((t) => t.tree.path === WT)!.tree).toMatchObject({
        read: 'stale',
        locked: false,
        uncommitted_files: null,
        unpushed_commits: null,
        merged: null,
      });
    });

    it('nothing from the helper is null', () => {
      expect(hostScanView(null, NOW)).toBeNull();
    });
  });
});

describe.skipIf(!HAS_GIT)('from the helper to the view', () => {
  let tmp: TempDir;
  let blind: TempDir;
  let d: Domain;
  let repo: RadarRepo;

  beforeEach(() => {
    tmp = tempDir('docket-b68-e2e-');
    // The container's push folder holds none of this repository, as in the pilot.
    blind = tempDir('docket-b68-mount-');
    repo = makeRadarRepo(tmp.dir);
    const origin = join(tmp.dir, 'origin.git');
    git(tmp.dir, 'init', '-q', '--bare', '-b', 'main', origin);
    git(repo.repo, 'remote', 'add', 'origin', origin);
    git(repo.repo, 'push', '-q', 'origin', 'main', 'feat/c');
    d = startDomain({ now: new Date(), env: { DOCKET_PUSH_ROOT: blind.dir } });
    d.sql
      .prepare("UPDATE projects SET repo_path = ?, main_branch = 'main' WHERE key = 'RCP'")
      .run(repo.repo.replace(/\\/g, '/'));
  });
  afterEach(async () => {
    await d.cleanup();
    rmSync(tmp.dir, { recursive: true, force: true });
    rmSync(blind.dir, { recursive: true, force: true });
  });

  const syncOnce = async () => {
    const info = d.services.sync.source(d.read(), 'worktrees');
    const { records } = (await source.collect(
      { state: {}, settings: info.settings },
      {
        now: () => d.clock.now().getTime(),
        env: {
          PATH: process.env.PATH ?? process.env.Path ?? '',
          SYSTEMROOT: process.env.SYSTEMROOT ?? '',
          HOME: tmp.dir,
          USERPROFILE: tmp.dir,
          XDG_CONFIG_HOME: tmp.dir,
        },
      },
    )) as { records: HostWorktreeRecord[] };
    return d.services.sync.ingest(d.server.runtime.write, 'worktrees', {
      records: records as never,
      run: RUN,
    });
  };
  const view = async () => d.services.recovery.worktreeCleanup(d.read(), { project: 'RCP' });
  const key = (p: string) => realpathSync(p).replace(/\\/g, '/').toLowerCase();
  const rowOf = (rows: RepoWorktreeRow[], p: string) =>
    rows.find((r) => r.path.replace(/\\/g, '/').toLowerCase() === key(p));

  it('gives real verdicts for worktrees the container can’t reach', async () => {
    d.clock.advance(DAY * 2);
    const sent = await syncOnce();
    expect(sent.ignored).toBe(0);
    const out = await view();
    expect(out.host.state).toBe('fresh');
    expect(rowOf(out.rows, repo.worktrees['feat/a'])).toMatchObject({
      verdict: 'holds_work',
      unpushed_commits: 1,
      source: 'host',
    });
    expect(rowOf(out.rows, repo.worktrees['feat/c'])).toMatchObject({
      verdict: 'safe_to_remove',
      source: 'host',
    });
  });

  it('feeds the unpushed check for a run in a worktree the container can’t reach', async () => {
    const wt = repo.worktrees['feat/a'].replace(/\\/g, '/');
    writeFileSync(join(wt, 'left-behind.txt'), 'x\n');
    const head = git(wt, 'rev-parse', 'HEAD').trim();
    const claude = d.agent('claude', { label: 'orca-w1' });
    const { run_id } = d.write(claude, (w, s) =>
      s.runs.claim(w, {
        id: 'RCP-17',
        agent_label: 'orca-w1',
        workspace: { path: realpathSync(wt).replace(/\\/g, '/'), branch: 'feat/a' },
      }),
    );
    d.write({ ...claude, run_id }, (w, s) =>
      s.evidence.reportCommit(w, { id: 'RCP-17', sha: head, pushed: false }),
    );
    d.clock.advance(d.server.runtime.config.leaseMs + minutes(1));
    sweepOnce(d.server.runtime);

    const now = () => d.clock.now().toISOString();
    await checkProjectWorktrees(d.server.runtime.db, d.server.runtime.config, 'RCP', now());
    const stored = () =>
      d.row<{ worktree_check: string | null }>(
        'SELECT worktree_check FROM runs WHERE id = ?',
        run_id,
      ).worktree_check;
    // Without the helper Docket can't tell: it reads no git itself (B76).
    expect(stored()).toBeNull();

    await syncOnce();
    await checkProjectWorktrees(d.server.runtime.db, d.server.runtime.config, 'RCP', now());
    expect(JSON.parse(stored()!)).toMatchObject({
      head_sha: head,
      on_main: false,
      unpushed_commits: 1,
      uncommitted_files: 1,
    });
    expect(stored()).not.toContain('left-behind');
  });
});
