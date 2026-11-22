/**
 * What is really left in a worktree (owner decision 41; BUILD_SPEC §5.16).
 *
 * "Unpushed work" used to repeat what the agent last reported, so a commit
 * already on main could still read "1 commit not pushed". This check asks git,
 * with the radar's read-only rules (radar.ts): no fetch, no checkout, nothing
 * written (`GIT_OPTIONAL_LOCKS=0`), and only inside `DOCKET_PUSH_ROOT`.
 *
 * It runs with the radar, never on a read, because git is slow and the
 * Problems are computed on every read. The result is stored on the run as
 * bookkeeping (`runs.worktree_check`, no event). A repository Docket can't
 * read clears it, so the Problem says its state is unverified and gives the
 * last reported one.
 *
 * A linked worktree's `.git` file names its folder as the host sees it, so
 * inside the container git can't follow it. The worktree is found from the
 * main repository (`git worktree list`), and `git status` is pointed at its
 * admin folder with `GIT_DIR`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { RunRow } from './model.js';
import { git, probeRepo, resolveRepoPath, validBranch } from './radar.js';
import {
  pathKey,
  storedWorkspace,
  unpushedRisks,
  type StoredWorkspace,
  type WorktreeCheck,
} from './recovery-model.js';

const samePath = (a: string, b: string) => pathKey(a).toLowerCase() === pathKey(b).toLowerCase();

interface Tree {
  path: string;
  head: string | null;
}

/** `git worktree list --porcelain`; the main worktree comes first. */
function listTrees(dir: string): Tree[] {
  const r = git(dir, ['worktree', 'list', '--porcelain']);
  if (r.status !== 0) return [];
  const out: Tree[] = [];
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) out.push({ path: line.slice(9).trim(), head: null });
    else if (line.startsWith('HEAD ') && out.length > 0) {
      out[out.length - 1]!.head = line.slice(5).trim();
    }
  }
  return out;
}

/** The admin folder (`.git/worktrees/<name>`) of the linked worktree at `path`. */
function adminDir(common: string, path: string): string | null {
  const base = join(common, 'worktrees');
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      const gitFile = readFileSync(join(base, name, 'gitdir'), 'utf8').trim();
      if (samePath(dirname(gitFile), path)) return join(base, name);
    } catch {
      // A broken entry is another worktree's problem.
    }
  }
  return null;
}

/**
 * `-c` overrides that switch off the repository's content filters. `git status`
 * runs a configured `clean` filter on changed files, and agents can write the
 * repository's config, so without this a check could run a command they chose
 * inside Docket's container. Null when the config can't be read: no status then.
 */
function filtersOff(folder: string, env: Record<string, string>): string[] | null {
  const r = git(folder, ['config', '--name-only', '--get-regexp', '^filter\\.'], env);
  // Exit 1 means no key matched.
  if (r.status !== 0 && r.status !== 1) return null;
  const names = new Set<string>();
  for (const key of r.stdout.split('\n')) {
    const m = /^filter\.(.+)\.[^.]+$/.exec(key.trim());
    if (m) names.add(m[1]!);
  }
  return [...names].flatMap((name) => [
    '-c',
    `filter.${name}.clean=`,
    '-c',
    `filter.${name}.smudge=`,
    '-c',
    `filter.${name}.process=`,
    '-c',
    `filter.${name}.required=false`,
  ]);
}

/** How many files `git status` lists; null when the folder can't be read. */
function uncommittedFiles(
  config: Config,
  common: string,
  trees: readonly Tree[],
  tree: Tree,
): number | null {
  let folder: string;
  try {
    folder = resolveRepoPath(config, tree.path);
  } catch {
    return null;
  }
  const gitDir = tree === trees[0] ? common : adminDir(common, tree.path);
  if (!gitDir) return null;
  const env = { GIT_DIR: gitDir, GIT_WORK_TREE: folder };
  const off = filtersOff(folder, env);
  if (!off) return null;
  // The host's line-ending and file-mode settings aren't visible here; without
  // these, every file checked out on Windows could read as modified. Submodules
  // are skipped because status would run git inside them with their own config.
  const r = git(
    folder,
    [
      ...off,
      '-c',
      'core.fileMode=false',
      '-c',
      'core.autocrlf=input',
      'status',
      '--porcelain',
      '--untracked-files=all',
      '--ignore-submodules=all',
    ],
    env,
  );
  if (r.status !== 0) return null;
  return r.stdout.split('\n').filter(Boolean).length;
}

/** The main branch's refs that exist, local and origin's. */
function mainRefs(dir: string, main: string): string[] {
  if (!validBranch(main)) return [];
  return [`refs/heads/${main}`, `refs/remotes/origin/${main}`].filter(
    (ref) => git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status === 0,
  );
}

/** Read one worktree's real state. Null when its commit isn't in this repository. */
export function checkWorktree(
  config: Config,
  repo: { dir: string; common: string; main: string },
  ws: StoredWorkspace,
  now: string,
): WorktreeCheck | null {
  const trees = listTrees(repo.dir);
  const tree = ws.path ? trees.find((t) => samePath(t.path, ws.path!)) : undefined;
  const head = tree?.head ?? ws.head_sha ?? null;
  if (!head || !/^[0-9a-f]{7,64}$/i.test(head)) return null;
  const resolved = git(repo.dir, ['rev-parse', '--verify', '--quiet', `${head}^{commit}`]);
  if (resolved.status !== 0) return null;
  const sha = resolved.stdout.trim();
  const mains = mainRefs(repo.dir, repo.main);
  const on_main = mains.some(
    (ref) => git(repo.dir, ['merge-base', '--is-ancestor', sha, ref]).status === 0,
  );
  const remote = git(repo.dir, [
    'for-each-ref',
    '--count=1',
    '--format=%(refname)',
    `--contains=${sha}`,
    'refs/remotes',
  ]);
  const count = git(repo.dir, ['rev-list', '--count', sha, '--not', '--remotes', ...mains]);
  const unpushed = count.status === 0 ? Number(count.stdout.trim()) : NaN;
  return {
    checked_at: now,
    head_sha: sha,
    on_main,
    on_remote: remote.status === 0 ? remote.stdout.trim() !== '' : null,
    unpushed_commits: Number.isInteger(unpushed) ? unpushed : null,
    uncommitted_files: tree ? uncommittedFiles(config, repo.common, trees, tree) : null,
  };
}

/**
 * Check the worktrees of a project's ended runs that left work behind, and
 * store what git says. Returns how many it read. With no readable repository
 * it clears their last check, so they show as unverified.
 */
export function checkProjectWorktrees(
  db: Db,
  config: Config,
  project: string,
  now: string,
): number {
  const runs = db.sqlite
    .prepare(
      `SELECT r.* FROM runs r JOIN items i ON i.id = r.item_id
       WHERE i.project_key = ? AND r.state IN ('finished', 'failed', 'interrupted')
         AND r.workspace IS NOT NULL AND r.unpushed_handled_at IS NULL`,
    )
    .all(project) as RunRow[];
  const risks = unpushedRisks(db, runs);
  if (risks.length === 0) return 0;
  const store = db.sqlite.prepare('UPDATE runs SET worktree_check = ? WHERE id = ?');
  const save = (run: RunRow, check: WorktreeCheck | null) =>
    store.run(check ? JSON.stringify(check) : null, run.id);

  const p = db.sqlite
    .prepare('SELECT repo_path, main_branch FROM projects WHERE key = ? AND deleted_at IS NULL')
    .get(project) as { repo_path: string | null; main_branch: string } | undefined;
  let repo: { dir: string; common: string; main: string } | null = null;
  if (p?.repo_path) {
    try {
      const dir = resolveRepoPath(config, p.repo_path);
      const probe = probeRepo(dir);
      if (probe.ok) repo = { dir, common: dirname(probe.objects), main: p.main_branch };
    } catch {
      repo = null;
    }
  }
  let read = 0;
  for (const risk of risks) {
    const ws = storedWorkspace(risk.run);
    const check = repo && ws ? checkWorktree(config, repo, ws, now) : null;
    if (check) read += 1;
    save(risk.run, check);
  }
  return read;
}
