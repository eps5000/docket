/**
 * A fixture repository for the conflict radar (decision 36; tasks.md T184):
 * a `main` branch and three worktree branches, built with the git CLI in a
 * temporary folder (never a real repository).
 *
 * `shared.txt` has five lines. After the branches leave `main`:
 * - `main` changes line 5;
 * - `feat/a` (worktree `wt-a`) changes line 2: clean against `main`;
 * - `feat/b` (worktree `wt-b`) changes lines 2 and 5: it conflicts with
 *   `main` (line 5) and with `feat/a` (line 2);
 * - `feat/c` (worktree `wt-c`) adds `other.txt`: clean against everything.
 *
 * `hashGitDir` hashes every file under `.git` (path and bytes), so a test can
 * prove a radar run left the repository byte-for-byte unchanged.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Run git in `cwd` with a neutral identity and no user or system config; throws on failure. */
export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync(
    'git',
    [
      '-c',
      'user.name=Docket Test',
      '-c',
      'user.email=test@docket.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.autocrlf=false',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull() },
    },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

const devNull = () => (process.platform === 'win32' ? 'NUL' : '/dev/null');

const LINES = ['one', 'two', 'three', 'four', 'five'];
const text = (lines: string[]) => `${lines.join('\n')}\n`;

export interface RadarRepo {
  /** The main checkout: `<root>/recipe-app`. */
  repo: string;
  /** Worktree folders by branch. */
  worktrees: Record<'feat/a' | 'feat/b' | 'feat/c', string>;
}

/** Build the fixture under `root` (a temporary push root). */
export function makeRadarRepo(root: string): RadarRepo {
  const repo = join(root, 'recipe-app');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'shared.txt'), text(LINES));
  git(repo, 'add', 'shared.txt');
  git(repo, 'commit', '-q', '-m', 'Start');
  for (const b of ['feat/a', 'feat/b', 'feat/c']) git(repo, 'branch', b);

  // main moves on: line 5.
  writeFileSync(join(repo, 'shared.txt'), text([...LINES.slice(0, 4), 'five on main']));
  git(repo, 'commit', '-q', '-am', 'Main changes line 5');

  const worktrees = {
    'feat/a': join(root, 'wt-a'),
    'feat/b': join(root, 'wt-b'),
    'feat/c': join(root, 'wt-c'),
  } as const;
  for (const [branch, dir] of Object.entries(worktrees)) {
    git(repo, 'worktree', 'add', '-q', dir, branch);
  }
  writeFileSync(
    join(worktrees['feat/a'], 'shared.txt'),
    text(['one', 'two from a', ...LINES.slice(2)]),
  );
  git(worktrees['feat/a'], 'commit', '-q', '-am', 'A changes line 2');
  writeFileSync(
    join(worktrees['feat/b'], 'shared.txt'),
    text(['one', 'two from b', 'three', 'four', 'five from b']),
  );
  git(worktrees['feat/b'], 'commit', '-q', '-am', 'B changes lines 2 and 5');
  writeFileSync(join(worktrees['feat/c'], 'other.txt'), 'other\n');
  git(worktrees['feat/c'], 'add', 'other.txt');
  git(worktrees['feat/c'], 'commit', '-q', '-m', 'C adds a file');
  return { repo, worktrees };
}

/** Every file under `<repo>/.git` with the SHA-256 of its bytes, by repo-relative path. */
export function hashGitDir(repo: string): Map<string, string> {
  const base = join(repo, '.git');
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const rel = relative(base, full).replace(/\\/g, '/');
        out.set(rel, createHash('sha256').update(readFileSync(full)).digest('hex'));
      }
    }
  };
  walk(base);
  return out;
}

/**
 * B40: a fixture for branch discovery, `<root>/gf-app`, built like
 * `makeRadarRepo`. After the branches leave `main`, `main` changes line 5 of
 * `shared.txt`, and:
 * - `eps5000/gf-239-visual-shell` (worktree `wt-239`) changes line 5: it
 *   names GF-239 and conflicts with `main`;
 * - `feature/GAMEFLOW-280-x` (worktree `wt-280`) adds `other.txt`: it names
 *   GF-280's Jira key, GAMEFLOW-280, and is clean;
 * - `gf-281-a` (worktree `wt-281`) changes line 5, and `gf-281-b` is a plain
 *   branch: both name GF-281, so the radar uses neither until one is
 *   reported;
 * - `gf-2390-decoy` names GF-2390, not GF-239, and `spike/shell-rework`
 *   names no item (both clean).
 */
export function makeBranchRepo(root: string): { repo: string } {
  const repo = join(root, 'gf-app');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'shared.txt'), text(LINES));
  git(repo, 'add', 'shared.txt');
  git(repo, 'commit', '-q', '-m', 'Start');
  const branches = [
    'eps5000/gf-239-visual-shell',
    'feature/GAMEFLOW-280-x',
    'gf-281-a',
    'gf-281-b',
    'gf-2390-decoy',
    'spike/shell-rework',
  ];
  for (const b of branches) git(repo, 'branch', b);
  writeFileSync(join(repo, 'shared.txt'), text([...LINES.slice(0, 4), 'five on main']));
  git(repo, 'commit', '-q', '-am', 'Main changes line 5');

  const wt239 = join(root, 'wt-239');
  const wt280 = join(root, 'wt-280');
  const wt281 = join(root, 'wt-281');
  git(repo, 'worktree', 'add', '-q', wt239, 'eps5000/gf-239-visual-shell');
  git(repo, 'worktree', 'add', '-q', wt280, 'feature/GAMEFLOW-280-x');
  git(repo, 'worktree', 'add', '-q', wt281, 'gf-281-a');
  writeFileSync(join(wt239, 'shared.txt'), text([...LINES.slice(0, 4), 'five from 239']));
  git(wt239, 'commit', '-q', '-am', 'GF-239 changes line 5');
  writeFileSync(join(wt280, 'other.txt'), 'other\n');
  git(wt280, 'add', 'other.txt');
  git(wt280, 'commit', '-q', '-m', 'GAMEFLOW-280 adds a file');
  writeFileSync(join(wt281, 'shared.txt'), text([...LINES.slice(0, 4), 'five from 281']));
  git(wt281, 'commit', '-q', '-am', 'GF-281 changes line 5');
  return { repo };
}

/**
 * B41: an epic with several branches, `<root>/gf-epics`, built like
 * `makeRadarRepo`. `shared.txt` and `api.txt` have five lines each. After
 * the branches leave `main`, `main` adds `main.txt` (clean against every
 * branch), and:
 * - `gf-217-api` (worktree `wt-217-api`) changes line 2 of `shared.txt` and
 *   line 3 of `api.txt`;
 * - `gf-217-web` (worktree `wt-217-web`) changes line 3 of `api.txt`
 *   differently: it conflicts with `gf-217-api`, a pair of the same item
 *   (GF-217), which the radar doesn't flag;
 * - `gf-235-b` (worktree `wt-235`) changes line 2 of `shared.txt`
 *   differently: it conflicts with `gf-217-api`, a cross-item pair, and
 *   shares no file with `gf-217-web`.
 */
export function makeEpicRepo(root: string): { repo: string } {
  const repo = join(root, 'gf-epics');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'shared.txt'), text(LINES));
  writeFileSync(join(repo, 'api.txt'), text(LINES));
  git(repo, 'add', 'shared.txt', 'api.txt');
  git(repo, 'commit', '-q', '-m', 'Start');
  for (const b of ['gf-217-api', 'gf-217-web', 'gf-235-b']) git(repo, 'branch', b);
  writeFileSync(join(repo, 'main.txt'), 'main\n');
  git(repo, 'add', 'main.txt');
  git(repo, 'commit', '-q', '-m', 'Main adds a file');

  const wt = {
    api: join(root, 'wt-217-api'),
    web: join(root, 'wt-217-web'),
    b: join(root, 'wt-235'),
  };
  git(repo, 'worktree', 'add', '-q', wt.api, 'gf-217-api');
  git(repo, 'worktree', 'add', '-q', wt.web, 'gf-217-web');
  git(repo, 'worktree', 'add', '-q', wt.b, 'gf-235-b');
  writeFileSync(join(wt.api, 'shared.txt'), text(['one', 'two from 217 api', ...LINES.slice(2)]));
  writeFileSync(
    join(wt.api, 'api.txt'),
    text(['one', 'two', 'three from 217 api', 'four', 'five']),
  );
  git(wt.api, 'commit', '-q', '-am', 'GF-217 api changes shared line 2 and api line 3');
  writeFileSync(
    join(wt.web, 'api.txt'),
    text(['one', 'two', 'three from 217 web', 'four', 'five']),
  );
  git(wt.web, 'commit', '-q', '-am', 'GF-217 web changes api line 3');
  writeFileSync(join(wt.b, 'shared.txt'), text(['one', 'two from 235', ...LINES.slice(2)]));
  git(wt.b, 'commit', '-q', '-am', 'GF-235 changes shared line 2');
  return { repo };
}
