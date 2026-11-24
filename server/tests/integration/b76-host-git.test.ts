/**
 * B76: every git read moves to the host helper. The helper's git source runs
 * against real temporary repositories with linked worktrees; Docket stores
 * what it posts and judges from it. Every repository, branch and file name
 * here is made up.
 *
 * - The helper: each read, read-only (`.git` hashed before and after, no temp
 *   folder left), bounded (merges per pass, reads with no answer, two at a
 *   time), an incomplete pass, and file names only for a real conflict, capped.
 * - Docket: the ingest of each fact, what it refuses, waiting and stale, and
 *   both orders of upgrade (a new Docket with an old helper, and the reverse).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostGitFactsFor } from '../../src/domain/host-git.js';
import { OWNER_ACTOR } from '../../src/domain/write.js';
import { radarRunOnce } from '../../src/jobs/sweeper.js';
import { git, hashGitDir } from '../fixtures/radar-repo.js';
import { insertItem, insertProject, tempDir, type TempDir } from '../helpers.js';
import { gitSettings, gitSource, helperEnv, hostGitPass, ingestGit } from '../host-git.js';
import { startDomain, type Domain } from '../us1-helpers.js';

const HAS_GIT = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const TOOL = join(fileURLToPath(new URL('../../../tools/docket-sync', import.meta.url)));
const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(join(TOOL, file)).href);
const gitLib = (await load('lib/git.mjs')) as {
  createGit(o: { env: Record<string, string> }): Reader;
  gitEnv(env: Record<string, string>): Record<string, string>;
};
const runnerLib = (await load('lib/runner.mjs')) as {
  createRunner(o: Record<string, unknown>): {
    runSource(s: unknown, o?: Record<string, unknown>): Promise<string>;
  };
};

interface Reader {
  read(dir: string, args: string[], options?: Record<string, unknown>): Promise<GitAnswer>;
}
interface GitAnswer {
  status: number | null;
  stdout: string;
  unknown: boolean;
}
type Rec = Record<string, unknown>;

const PLANTED = 'PLANTED-name-4c1e';
const lines = (n: number, tag = '') =>
  `${Array.from({ length: n }, (_, i) => `line ${i + 1}${i === 1 ? tag : ''}`).join('\n')}\n`;

/**
 * `<root>/app`: `main`, and two items' branches in linked worktrees.
 * - `xy-1-left` (wt-left) changes line 2 of `shared.txt` and adds a file named
 *   PLANTED…-left.txt;
 * - `xy-2-right` (wt-right) changes line 2 of `shared.txt` differently, adds
 *   PLANTED…-right.txt, and has an uncommitted PLANTED…-dirty.txt;
 * - `xy-3-many` changes 60 files that `main` also changes: 60 conflicts;
 * - main moves on in `other.txt` only.
 */
function makeApp(root: string) {
  const repo = join(root, 'app');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'shared.txt'), lines(5));
  writeFileSync(join(repo, 'other.txt'), lines(3));
  mkdirSync(join(repo, 'many'));
  for (let i = 0; i < 60; i += 1) writeFileSync(join(repo, 'many', `f${i}.txt`), lines(3));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Start');
  for (const b of ['xy-1-left', 'xy-2-right', 'xy-3-many']) git(repo, 'branch', b);
  writeFileSync(join(repo, 'other.txt'), lines(3, ' on main'));
  for (let i = 0; i < 60; i += 1) writeFileSync(join(repo, 'many', `f${i}.txt`), lines(3, ' main'));
  git(repo, 'commit', '-q', '-am', 'Main moves on');

  const left = join(root, 'wt-left');
  const right = join(root, 'wt-right');
  git(repo, 'worktree', 'add', '-q', left, 'xy-1-left');
  git(repo, 'worktree', 'add', '-q', right, 'xy-2-right');
  writeFileSync(join(left, 'shared.txt'), lines(5, ' from left'));
  writeFileSync(join(left, `${PLANTED}-left.txt`), 'x\n');
  git(left, 'add', '-A');
  git(left, 'commit', '-q', '-m', 'Left');
  writeFileSync(join(right, 'shared.txt'), lines(5, ' from right'));
  writeFileSync(join(right, `${PLANTED}-right.txt`), 'x\n');
  git(right, 'add', '-A');
  git(right, 'commit', '-q', '-m', 'Right');
  writeFileSync(join(right, `${PLANTED}-dirty.txt`), 'never committed\n');

  git(repo, 'checkout', '-q', 'xy-3-many');
  for (let i = 0; i < 60; i += 1) writeFileSync(join(repo, 'many', `f${i}.txt`), lines(3, ' many'));
  git(repo, 'commit', '-q', '-am', 'Many');
  git(repo, 'checkout', '-q', 'main');
  return { repo, left, right };
}

/** What Docket would ask for this fixture. */
const settingsFor = (repo: string, over: Rec = {}) => ({
  enabled: true,
  projects: [
    {
      key: 'XY',
      repo_path: repo,
      host_path: repo,
      main_branch: 'main',
      items: [
        { id: 'XY-1', keys: [], branches: ['xy-1-left'], removed: [], parts: [], files: [] },
        { id: 'XY-2', keys: [], branches: ['xy-2-right'], removed: [], parts: [], files: [] },
      ],
      commits: [],
      heads: [],
      manifests: [],
      ...over,
    },
  ],
});

describe.skipIf(!HAS_GIT)('the helper’s git source, on real repositories', () => {
  let tmp: TempDir;
  let app: ReturnType<typeof makeApp>;
  beforeEach(() => {
    tmp = tempDir('docket-b76-');
    app = makeApp(tmp.dir);
  });
  afterEach(() => tmp.cleanup());

  const collect = (settings: Rec, options: Rec = {}) =>
    gitSource.collect({ state: {}, settings }, { env: helperEnv(tmp.dir), ...options });
  const ofKind = (records: Rec[], kind: string) => records.filter((r) => r.kind === kind);

  it('reads each branch, its trial merge with main, and the related pair', async () => {
    const { records } = await collect(settingsFor(app.repo));
    const branches = Object.fromEntries(ofKind(records, 'branch').map((r) => [r.name, r]));
    expect(branches['xy-1-left']).toMatchObject({
      read: 'ok',
      ref: 'heads',
      merged: false,
      main: 'clean',
      files: [],
    });
    expect(ofKind(records, 'pair')).toMatchObject([
      { a: 'xy-1-left', b: 'xy-2-right', state: 'conflict', files: ['shared.txt'], more: false },
    ]);
    expect(records.at(-1)).toMatchObject({
      kind: 'pass',
      status: 'ok',
      main_ref: 'heads',
      complete: true,
      pairs_done: true,
      pairs: 1,
    });
  });

  it('sends no file name outside a real conflict: not a changed file, not an uncommitted one', async () => {
    const { records } = await collect(
      settingsFor(app.repo, {
        commits: [{ branch: 'xy-1-left', since: '2020-01-01T00:00:00.000Z' }],
        heads: [git(app.left, 'rev-parse', 'HEAD').trim()],
      }),
    );
    const sent = JSON.stringify(records);
    expect(sent).not.toContain(PLANTED);
    expect(sent).not.toContain('other.txt');
    // The only file names are the conflicting ones.
    const names = records.flatMap((r) => (Array.isArray(r.files) ? (r.files as string[]) : []));
    expect(names).toEqual(['shared.txt']);
  });

  it('caps conflicting files at 50 a merge and says there were more', async () => {
    const { records } = await collect(
      settingsFor(app.repo, {
        items: [
          { id: 'XY-3', keys: [], branches: ['xy-3-many'], removed: [], parts: [], files: [] },
        ],
      }),
    );
    const many = ofKind(records, 'branch')[0]!;
    expect(many).toMatchObject({ main: 'conflict', more: true });
    expect(many.files as string[]).toHaveLength(50);
    expect(gitSource.conflictFiles(`tree\n${'a'.repeat(301)}\nshort.txt\n`)).toEqual({
      files: ['short.txt'],
      more: true,
    });
    expect(gitSource.conflictFiles('tree\nbad\u0007name\nok.txt\n')).toEqual({
      files: ['ok.txt'],
      more: true,
    });
  });

  it('discovers branches by key, skipping one the owner said is not active', async () => {
    git(app.repo, 'branch', 'feature/XY-9-thing');
    git(app.repo, 'branch', 'xy9-old');
    const item = (removed: string[]) => [
      { id: 'XY-9', keys: ['JIRA-9'], branches: [], removed, parts: [], files: [] },
    ];
    let { records } = await collect(settingsFor(app.repo, { items: item([]) }));
    expect(ofKind(records, 'item')).toMatchObject([
      { item: 'XY-9', read: 'ok', matches: ['feature/XY-9-thing', 'xy9-old'] },
    ]);
    expect(ofKind(records, 'branch')).toEqual([]);
    ({ records } = await collect(settingsFor(app.repo, { items: item(['xy9-old']) })));
    expect(ofKind(records, 'item')).toMatchObject([{ matches: ['feature/XY-9-thing'] }]);
    // One match is read in the same pass.
    expect(ofKind(records, 'branch')).toMatchObject([{ name: 'feature/XY-9-thing', read: 'ok' }]);
  });

  it('reads commits since a time, a commit’s standing, and Docket’s manifest on main', async () => {
    const head = git(app.left, 'rev-parse', 'HEAD').trim();
    mkdirSync(join(app.repo, '.claude'));
    writeFileSync(
      join(app.repo, '.claude', '.docket-manifest.json'),
      JSON.stringify({
        install_id: 'ins_01TEST',
        note: `${PLANTED} free text is never sent`,
        files: [
          { key: 'skill:docket-worker', version_id: 'afv_1', sha256: 'a'.repeat(64), x: 1 },
          { key: '../escape', version_id: 'afv_2', sha256: 'b'.repeat(64) },
        ],
      }),
    );
    git(app.repo, 'add', '-A');
    git(app.repo, 'commit', '-q', '-m', 'Docket install');
    const { records } = await collect(
      settingsFor(app.repo, {
        items: [],
        commits: [{ branch: 'xy-1-left', since: '2020-01-01T00:00:00.000Z' }],
        heads: [head, head.slice(0, 10), 'deadbeef00'],
        manifests: [
          { client: 'claude', paths: ['.claude/.docket-manifest.json'] },
          { client: 'codex', paths: ['.codex/.docket-manifest.json', '../outside.json'] },
        ],
      }),
    );
    const commits = ofKind(records, 'commits')[0]!;
    expect(commits).toMatchObject({ branch: 'xy-1-left', read: 'ok' });
    expect((commits.commits as Rec[]).map((c) => c.sha)).toContain(head);
    const heads = ofKind(records, 'head');
    expect(heads).toMatchObject([
      { sha: head, head, read: 'ok', on_main: false, on_remote: false, unpushed: 1 },
      { sha: head.slice(0, 10), head, read: 'ok' },
      { sha: 'deadbeef00', head: null, read: 'missing' },
    ]);
    const manifests = ofKind(records, 'manifest');
    expect(manifests).toMatchObject([
      {
        client: 'claude',
        state: 'present',
        install_id: 'ins_01TEST',
        files: [{ key: 'skill:docket-worker', version_id: 'afv_1', sha256: 'a'.repeat(64) }],
      },
      { client: 'codex', state: 'absent' },
    ]);
    expect(JSON.stringify(manifests)).not.toContain(PLANTED);
    expect(JSON.stringify(manifests)).not.toContain('escape');
  });

  it('writes nothing to the repository, and leaves no temporary folder', async () => {
    const scratch = join(tmp.dir, 'scratch');
    mkdirSync(scratch);
    const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    const before = hashGitDir(app.repo);
    Object.assign(process.env, { TMPDIR: scratch, TEMP: scratch, TMP: scratch });
    try {
      await collect(
        settingsFor(app.repo, {
          items: [
            { id: 'XY-1', keys: [], branches: ['xy-1-left'], removed: [], parts: [], files: [] },
            { id: 'XY-2', keys: [], branches: ['xy-2-right'], removed: [], parts: [], files: [] },
            { id: 'XY-3', keys: [], branches: ['xy-3-many'], removed: [], parts: [], files: [] },
            { id: 'XY-4', keys: [], branches: [], removed: [], parts: [], files: [] },
          ],
          commits: [{ branch: 'xy-1-left', since: '2020-01-01T00:00:00.000Z' }],
          heads: [git(app.right, 'rev-parse', 'HEAD').trim()],
          manifests: [{ client: 'claude', paths: ['.claude/.docket-manifest.json'] }],
        }),
      );
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(hashGitDir(app.repo)).toEqual(before);
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('a trial merge passes only the two object-folder settings to git', () => {
    const env = gitLib.gitEnv({ PATH: '/bin', GIT_DIR: '/x', GIT_OBJECT_DIRECTORY: '/y' });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_OBJECT_DIRECTORY).toBeUndefined();
    expect(env).toMatchObject({ GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' });
  });

  it('at most two reads run at once', async () => {
    const real = gitLib.createGit({ env: helperEnv(tmp.dir) });
    let now = 0;
    let most = 0;
    const counting: Reader = {
      async read(dir, args, options) {
        now += 1;
        most = Math.max(most, now);
        await new Promise((done) => setTimeout(done, 10));
        try {
          return await real.read(dir, args, options);
        } finally {
          now -= 1;
        }
      },
    };
    const items = ['xy-1-left', 'xy-2-right', 'xy-3-many'].map((b, i) => ({
      id: `XY-${i + 1}`,
      keys: [],
      branches: [b],
      removed: [],
      parts: [],
      files: [],
    }));
    await collect(settingsFor(app.repo, { items }), { git: counting });
    expect(most).toBe(2);
  });

  it('a pass past its merge budget is incomplete and says its pairs aren’t all judged', async () => {
    const { records } = await collect(settingsFor(app.repo), { limits: { maxPairMerges: 0 } });
    expect(ofKind(records, 'pair')).toEqual([]);
    expect(records.at(-1)).toMatchObject({ complete: false, pairs_done: false, pairs: 0 });
  });

  it('after three reads with no answer a project’s pass stops asking git', async () => {
    const real = gitLib.createGit({ env: helperEnv(tmp.dir) });
    let asked = 0;
    const noMerges: Reader = {
      read(dir, args, options) {
        if (!args.includes('merge-tree')) return real.read(dir, args, options);
        if (!(options?.signal as AbortSignal | undefined)?.aborted) asked += 1;
        return Promise.resolve({ status: null, stdout: '', unknown: true });
      },
    };
    const items = Array.from({ length: 6 }, (_, i) => {
      git(app.repo, 'branch', `xy-${i + 10}-extra`, 'xy-1-left');
      return {
        id: `XY-${i + 10}`,
        keys: [],
        branches: [`xy-${i + 10}-extra`],
        removed: [],
        parts: [],
        files: [],
      };
    });
    const { records } = await collect(settingsFor(app.repo, { items }), { git: noMerges });
    expect(asked).toBeLessThanOrEqual(4); // Two at a time: the third answer stops the rest.
    expect(ofKind(records, 'branch').every((r) => r.read === 'unknown')).toBe(true);
    expect(records.at(-1)).toMatchObject({ complete: false });
  });

  it('a folder that isn’t a repository, or a UNC path, is unreadable and never read', async () => {
    const empty = join(tmp.dir, 'empty');
    mkdirSync(empty);
    const calls: string[][] = [];
    const watching: Reader = {
      read(dir, args) {
        calls.push([dir, ...args]);
        return gitLib.createGit({ env: helperEnv(tmp.dir) }).read(dir, args);
      },
    };
    const { records } = await collect(
      {
        enabled: true,
        projects: [
          { key: 'XY', repo_path: empty, host_path: empty, main_branch: 'main' },
          {
            key: 'UN',
            repo_path: '//server/share',
            host_path: '//server/share',
            main_branch: 'main',
          },
        ],
      },
      { git: watching },
    );
    expect(ofKind(records, 'pass').map((r) => [r.project, r.status])).toEqual([
      ['XY', 'unreadable'],
      ['UN', 'unreadable'],
    ]);
    expect(calls.some((c) => c[0] === '//server/share')).toBe(false);
  });
});

describe('the helper’s git source, by itself', () => {
  it('matches keys as whole tokens, as Docket’s radar does', () => {
    expect(
      gitSource.branchesNaming(
        ['GF-239', 'GAMEFLOW-280'],
        ['eps5000/gf-239-x', 'GF239', 'gf-2390', 'xgf-239', 'feature/gameflow-280'],
      ),
    ).toEqual(['GF239', 'eps5000/gf-239-x', 'feature/gameflow-280']);
    expect(gitSource.keyPattern('not a key')).toBeNull();
  });

  it('keeps only Docket’s identifiers and hashes from a manifest', () => {
    expect(gitSource.parseManifest('not json')).toBeNull();
    expect(
      gitSource.parseManifest(
        JSON.stringify({
          install_id: 'bad id with spaces',
          files: [{ key: 'k', version_id: 'v', sha256: 'z' }],
        }),
      ),
    ).toEqual({ install_id: null, files: [] });
  });

  it('an older Docket’s settings, without what B76 asks for, read nothing but the pass', async () => {
    const ROOT = process.platform === 'win32' ? 'C:/repo' : '/repo';
    const calls: string[][] = [];
    const fake: Reader = {
      read(_dir, args) {
        calls.push(args);
        if (args.includes('--git-common-dir')) {
          return Promise.resolve({ status: 0, stdout: '/repo/.git\n', unknown: false });
        }
        if (args[0] === 'version') {
          return Promise.resolve({ status: 0, stdout: 'git version 2.47.0\n', unknown: false });
        }
        return Promise.resolve({ status: 0, stdout: '', unknown: false });
      },
    };
    const { records } = await gitSource.collect(
      {
        state: {},
        settings: {
          enabled: true,
          projects: [{ key: 'XY', repo_path: ROOT, host_path: ROOT, main_branch: 'main' }],
        },
      },
      { git: fake },
    );
    expect(records.map((r) => r.kind)).toEqual(['pass']);
    expect(records[0]).toMatchObject({ status: 'ok', complete: true });
    expect(calls.some((a) => a.includes('merge-tree') || a[0] === 'log')).toBe(false);
  });

  it('an older Docket that doesn’t know the source: the runner skips it and posts nothing', async () => {
    const posts: unknown[] = [];
    const store = {
      entries: new Map<string, Rec>(),
      source(name: string) {
        if (!this.entries.has(name)) {
          this.entries.set(name, {
            state: {},
            next_at: 0,
            failures: 0,
            last_error: null,
            records_sent: 0,
          });
        }
        return this.entries.get(name)!;
      },
      save() {},
    };
    let collected = 0;
    const runner = runnerLib.createRunner({
      docket: {
        readSource: async () => null,
        post: async (...args: unknown[]) => posts.push(args),
        reader: () => ({ get: async () => ({}) }),
      },
      sources: [
        {
          ...gitSource,
          collect: async () => {
            collected += 1;
            return { records: [] };
          },
        },
      ],
      store,
      log: () => {},
    });
    expect(await runner.runSource({ ...gitSource }, { force: true })).toBe('unknown');
    expect(collected).toBe(0);
    expect(posts).toEqual([]);
  });

  it('the runner sends a source’s smaller batches', async () => {
    const posts: { records: unknown[] }[] = [];
    const store = {
      e: { state: {}, next_at: 0, failures: 0, last_error: null, records_sent: 0 } as Rec,
      source() {
        return this.e;
      },
      save() {},
    };
    const records = Array.from({ length: 120 }, (_, i) => ({ key: `k${i}` }));
    const source = {
      name: 'git',
      intervalMs: 1000,
      batchSize: 50,
      enabled: () => true,
      collect: async () => ({ records, state: {} }),
    };
    const runner = runnerLib.createRunner({
      docket: {
        readSource: async () => ({ settings: {} }),
        post: async (_name: string, body: { records: unknown[] }) => {
          posts.push(body);
          return {};
        },
        reader: () => ({ get: async () => ({}) }),
      },
      sources: [source],
      store,
      log: () => {},
    });
    expect(await runner.runSource(source, { force: true })).toBe('ran');
    expect(posts.map((p) => p.records.length)).toEqual([50, 50, 20]);
  });
});

// ---- Docket's side ----

describe('Docket stores the helper’s facts', () => {
  let d: Domain;
  const REPO = 'C:/Users/sample/code/xy-app';
  const at = () => d.clock.now().toISOString();
  let seq = 0;

  beforeEach(() => {
    d = startDomain({ seed: false });
    insertProject(d.server.runtime.db, 'XY');
    d.sql
      .prepare("UPDATE projects SET repo_path = ?, main_branch = 'main' WHERE key = 'XY'")
      .run(REPO);
    insertItem(d.server.runtime.db, { id: 'XY-1', status: 'progress' });
    insertItem(d.server.runtime.db, { id: 'XY-2', status: 'progress' });
    const report = d.sql.prepare('UPDATE items SET branches = ? WHERE id = ?');
    report.run(JSON.stringify([{ name: 'xy-1-left', by: 'test', at: at() }]), 'XY-1');
    report.run(JSON.stringify([{ name: 'xy-2-right', by: 'test', at: at() }]), 'XY-2');
  });
  afterEach(async () => d.cleanup());

  /** A synthetic pass: the records, then the pass that closes them. */
  function pass(subs: Rec[], over: Rec = {}): Rec[] {
    seq += 1;
    const id = `p${seq}`;
    const base = (kind: string, n: number) => ({
      key: `${kind}:XY:${id}:${n}`,
      project: 'XY',
      pass_id: id,
      kind,
    });
    const pairs = subs.filter((s) => s.kind === 'pair').length;
    return [
      ...subs.map((s, i) => ({ ...base(String(s.kind), i), ...s })),
      {
        ...base('pass', 0),
        key: `pass:XY:${id}`,
        repo_path: REPO,
        main_branch: 'main',
        status: 'ok',
        main_ref: 'heads',
        checked_at: at(),
        complete: true,
        pairs_done: true,
        pairs,
        ...over,
      },
    ];
  }
  const branch = (name: string, over: Rec = {}) => ({
    kind: 'branch',
    name,
    read: 'ok',
    ref: 'heads',
    merged: false,
    main: 'clean',
    files: [],
    more: false,
    ...over,
  });
  const pair = (state: string, files: string[] = []) => ({
    kind: 'pair',
    a: 'xy-1-left',
    b: 'xy-2-right',
    state,
    files,
    more: false,
  });
  const facts = () =>
    hostGitFactsFor(d.server.runtime.db, { key: 'XY', repo_path: REPO, main_branch: 'main' });
  const radar = () => d.services.sharedChanges.radar(d.read(), { key: 'XY' });
  const open = () =>
    d.rows<{ branch_a: string; branch_b: string }>(
      'SELECT branch_a, branch_b FROM radar_findings WHERE cleared_at IS NULL',
    );

  it('asks the helper for the items, their branches, and nothing it would have to guess', () => {
    const settings = gitSettings(d.server);
    expect(settings).toMatchObject({
      enabled: true,
      projects: [
        {
          key: 'XY',
          host_path: REPO,
          main_branch: 'main',
          items: [
            { id: 'XY-1', branches: ['xy-1-left'] },
            { id: 'XY-2', branches: ['xy-2-right'] },
          ],
          commits: [],
          heads: [],
          manifests: [
            { client: 'claude', paths: ['.claude/.docket-manifest.json', expect.any(String)] },
            { client: 'codex', paths: ['.codex/.docket-manifest.json', expect.any(String)] },
          ],
        },
      ],
    });
  });

  it('waits for the helper, then finds and clears conflicts from its facts', async () => {
    expect(radar()).toMatchObject({ state: 'waiting', helper: { state: 'none' } });
    ingestGit(
      d.server,
      pass([branch('xy-1-left'), branch('xy-2-right'), pair('conflict', ['shared.txt'])]),
    );
    expect(facts()).toMatchObject({
      status: 'ok',
      pairs_done: true,
      branches: { 'xy-1-left': { read: 'ok', main: 'clean' } },
    });
    await radarRunOnce(d.server.runtime, 'XY');
    expect(open()).toEqual([{ branch_a: 'xy-1-left', branch_b: 'xy-2-right' }]);
    expect(radar()).toMatchObject({ state: 'ok', helper: { state: 'fresh' } });

    // A pass with the pair judged unrelated (not sent) clears it.
    ingestGit(d.server, pass([branch('xy-1-left'), branch('xy-2-right')]));
    await radarRunOnce(d.server.runtime, 'XY');
    expect(open()).toEqual([]);
  });

  it('an incomplete pass removes nothing: a pair it didn’t judge stays as it was', async () => {
    ingestGit(
      d.server,
      pass([branch('xy-1-left'), branch('xy-2-right'), pair('conflict', ['shared.txt'])]),
    );
    await radarRunOnce(d.server.runtime, 'XY');
    ingestGit(
      d.server,
      pass([branch('xy-1-left'), branch('xy-2-right')], { complete: false, pairs_done: false }),
    );
    const run = await radarRunOnce(d.server.runtime, 'XY');
    expect(run.plan.unknown.pairs).toEqual([['xy-1-left', 'xy-2-right']]);
    expect(open()).toHaveLength(1);
    // A branch the pass didn't reach is unknown too.
    ingestGit(d.server, pass([branch('xy-1-left')]));
    expect((await radarRunOnce(d.server.runtime, 'XY')).plan.unknown.branches).toEqual([
      'xy-2-right',
    ]);
    expect(open()).toHaveLength(1);
  });

  it('a pair record that didn’t arrive never reads as unrelated', async () => {
    ingestGit(
      d.server,
      pass([branch('xy-1-left'), branch('xy-2-right'), pair('conflict', ['shared.txt'])]),
    );
    await radarRunOnce(d.server.runtime, 'XY');
    // The pass says it sent one pair, but the record was refused (a field no schema allows).
    const records = pass([branch('xy-1-left'), branch('xy-2-right'), pair('clean')]);
    (records[2] as Rec).changed = ['src/secret-plans.ts'];
    ingestGit(d.server, records);
    expect(facts()!.pairs_done).toBe(false);
    await radarRunOnce(d.server.runtime, 'XY');
    expect(open()).toHaveLength(1);
  });

  it('stale facts are shown as stale and decide nothing', async () => {
    ingestGit(
      d.server,
      pass([branch('xy-1-left'), branch('xy-2-right'), pair('conflict', ['shared.txt'])]),
    );
    await radarRunOnce(d.server.runtime, 'XY');
    d.clock.advance(11 * 60_000);
    expect(radar()).toMatchObject({ state: 'stale', helper: { state: 'stale' } });
    const run = await radarRunOnce(d.server.runtime, 'XY');
    expect(run.plan.unknown.all).toBe(true);
    expect(open()).toHaveLength(1);
  });

  it('ignores a pass for another repository, from the future, older than the last, or with no answer', () => {
    ingestGit(d.server, pass([branch('xy-1-left')]));
    const first = facts()!.pass_id;
    ingestGit(d.server, pass([], { repo_path: 'C:/elsewhere' }));
    ingestGit(
      d.server,
      pass([], { checked_at: new Date(d.clock.now().getTime() + 3_600_000).toISOString() }),
    );
    ingestGit(
      d.server,
      pass([], { checked_at: new Date(d.clock.now().getTime() - 60_000).toISOString() }),
    );
    ingestGit(d.server, pass([], { status: 'unknown' }));
    expect(facts()!.pass_id).toBe(first);
  });

  it('the same batch twice changes nothing and records no event', () => {
    const batch = pass([branch('xy-1-left'), pair('conflict', ['shared.txt'])]);
    ingestGit(d.server, batch);
    const once = d.row<{ detail: string }>("SELECT detail FROM sync_sources WHERE name = 'git'");
    const events = d.rows('SELECT seq FROM events').length;
    ingestGit(d.server, batch);
    expect(d.row<{ detail: string }>("SELECT detail FROM sync_sources WHERE name = 'git'")).toEqual(
      once,
    );
    expect(d.rows('SELECT seq FROM events')).toHaveLength(events);
  });

  it('refuses a record with anything unexpected, and withholds a secret-looking file name', () => {
    const secret = `ghp_${'A1b2C3d4E5'.repeat(4)}.txt`;
    const records = pass([
      branch('xy-1-left', { main: 'conflict', files: [secret, 'shared.txt'] }),
      { ...branch('xy-2-right'), status_names: ['dirty.txt'] },
    ]);
    const out = d.services.sync.ingest(d.server.runtime.write, 'git', {
      records: records as { key: string }[],
      run: { ok: true, interval_ms: 180_000 },
    });
    expect(out.ignored).toBe(1);
    const stored = facts()!;
    expect(stored.branches['xy-2-right']).toBeUndefined();
    expect(stored.branches['xy-1-left']!.files).toHaveLength(2);
    expect(JSON.stringify(stored)).not.toContain('ghp_');
  });

  it('a deleted project’s facts go with it', () => {
    ingestGit(d.server, pass([branch('xy-1-left')]));
    d.write(OWNER_ACTOR, (w, s) => s.projects.delete(w, { key: 'XY', confirm_key: 'XY' }));
    expect(
      d.row<{ detail: string }>("SELECT detail FROM sync_sources WHERE name = 'git'").detail,
    ).not.toContain('xy-1-left');
  });
});

describe('a new Docket with an old helper', () => {
  it('worktree facts still work, and everything git-only says it waits for the helper', async () => {
    const d = startDomain({ seed: false });
    try {
      insertProject(d.server.runtime.db, 'XY');
      d.sql
        .prepare(
          "UPDATE projects SET repo_path = 'C:/Users/sample/code/xy', main_branch = 'main' WHERE key = 'XY'",
        )
        .run();
      // An old helper has only the worktrees source: it never asks for or posts git facts.
      const status = d.services.sync.source(d.read(), 'git').status;
      expect(status.last_success_at).toBeNull();
      expect(d.services.sharedChanges.radar(d.read(), { key: 'XY' })).toMatchObject({
        state: 'waiting',
        helper: { state: 'none', checked_at: null },
      });
      const install = await d.services.installs.state(d.read(), { project: 'XY' });
      expect(install.clients.every((c) => c.repo_main.state === 'unknown')).toBe(true);
    } finally {
      await d.cleanup();
    }
  });
});

describe.skipIf(!HAS_GIT)('from the helper to Docket, end to end', () => {
  it('the request, the real pass and the judgement agree, and the facts hold no other names', async () => {
    const tmp = tempDir('docket-b76-e2e-');
    const d = startDomain({ seed: false });
    try {
      const app = makeApp(tmp.dir);
      insertProject(d.server.runtime.db, 'XY');
      d.sql
        .prepare("UPDATE projects SET repo_path = ?, main_branch = 'main' WHERE key = 'XY'")
        .run(app.repo);
      insertItem(d.server.runtime.db, { id: 'XY-1', status: 'progress' });
      insertItem(d.server.runtime.db, { id: 'XY-2', status: 'progress' });
      const before = hashGitDir(app.repo);
      await hostGitPass(d.server, { home: tmp.dir });
      // Discovered by key, and the pair read in the same pass.
      await radarRunOnce(d.server.runtime, 'XY');
      expect(
        d.rows<{ branch_a: string; branch_b: string; files: string }>(
          'SELECT branch_a, branch_b, files FROM radar_findings WHERE cleared_at IS NULL',
        ),
      ).toEqual([{ branch_a: 'xy-1-left', branch_b: 'xy-2-right', files: '["shared.txt"]' }]);
      expect(hashGitDir(app.repo)).toEqual(before);
      const detail = d.row<{ detail: string }>(
        "SELECT detail FROM sync_sources WHERE name = 'git'",
      ).detail;
      expect(detail).not.toContain(PLANTED);
    } finally {
      await d.cleanup();
      tmp.cleanup();
    }
  });
});
