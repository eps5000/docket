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
 * last reported one. A git read with no answer (B52: timed out or cancelled)
 * leaves the stored check as it was.
 *
 * A linked worktree's `.git` file names its folder as the host sees it, so
 * inside the container git can't follow it. The worktree is found from the
 * main repository (`git worktree list`), and `git status` is pointed at its
 * admin folder with `GIT_DIR`.
 */
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { RunRow } from './model.js';
import { git, GitUnknown, known } from './git-read.js';
import { probeRepo, resolveRepoPath, validBranch } from './radar.js';
import {
  pathKey,
  storedWorkspace,
  unpushedRisks,
  type StoredWorkspace,
  type WorktreeCheck,
} from './recovery-model.js';

const samePath = (a: string, b: string) => treeKey(a) === treeKey(b);

export interface Tree {
  path: string;
  head: string | null;
  /** Short branch name; null on a detached HEAD. */
  branch: string | null;
  /** `git worktree lock` was used on it. */
  locked: boolean;
  bare: boolean;
}

/** `git worktree list --porcelain`; the main worktree comes first. */
export async function listTrees(dir: string, signal?: AbortSignal): Promise<Tree[]> {
  const r = known(await git(dir, ['worktree', 'list', '--porcelain'], {}, signal));
  if (r.status !== 0) return [];
  const out: Tree[] = [];
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      out.push({
        path: line.slice(9).trim(),
        head: null,
        branch: null,
        locked: false,
        bare: false,
      });
      continue;
    }
    const tree = out[out.length - 1];
    if (!tree) continue;
    if (line.startsWith('HEAD ')) tree.head = line.slice(5).trim();
    else if (line.startsWith('branch refs/heads/')) tree.branch = line.slice(18).trim();
    else if (line === 'locked' || line.startsWith('locked ')) tree.locked = true;
    else if (line === 'bare') tree.bare = true;
  }
  return out;
}

/** How two spellings of one worktree path compare. */
export const treeKey = (path: string) => pathKey(path).toLowerCase();

/** Every linked worktree's admin folder (`.git/worktrees/<name>`), by `treeKey`. */
export async function adminDirs(common: string): Promise<Map<string, string>> {
  const base = join(common, 'worktrees');
  const out = new Map<string, string>();
  let names: string[];
  try {
    names = await readdir(base);
  } catch {
    return out;
  }
  for (const name of names) {
    try {
      const gitFile = (await readFile(join(base, name, 'gitdir'), 'utf8')).trim();
      out.set(treeKey(dirname(gitFile)), join(base, name));
    } catch {
      // A broken entry is another worktree's problem.
    }
  }
  return out;
}

/**
 * `-c` overrides that switch off the repository's content filters. `git status`
 * runs a configured `clean` filter on changed files, and agents can write the
 * repository's config, so without this a check could run a command they chose
 * inside Docket's container. Null when the config can't be read: no status then.
 */
async function filtersOff(
  folder: string,
  env: Record<string, string>,
  signal?: AbortSignal,
): Promise<string[] | null> {
  const r = known(
    await git(folder, ['config', '--name-only', '--get-regexp', '^filter\\.'], env, signal),
  );
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
async function uncommittedFiles(
  config: Config,
  common: string,
  trees: readonly Tree[],
  tree: Tree,
  signal?: AbortSignal,
): Promise<number | null> {
  let folder: string;
  try {
    folder = resolveRepoPath(config, tree.path);
  } catch {
    return null;
  }
  const gitDir = tree === trees[0] ? common : (await adminDirs(common)).get(treeKey(tree.path));
  if (!gitDir) return null;
  return statusCount(folder, gitDir, signal);
}

/**
 * How many files `git status` lists for the worktree at `folder`, whose admin
 * folder is `gitDir`; null when it can't be read. Throws `GitUnknown` on no answer.
 */
export async function statusCount(
  folder: string,
  gitDir: string,
  signal?: AbortSignal,
): Promise<number | null> {
  const env = { GIT_DIR: gitDir, GIT_WORK_TREE: folder };
  const off = await filtersOff(folder, env, signal);
  if (!off) return null;
  // The host's line-ending and file-mode settings aren't visible here; without
  // these, every file checked out on Windows could read as modified. Submodules
  // are skipped because status would run git inside them with their own config.
  const r = known(
    await git(
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
      signal,
    ),
  );
  if (r.status !== 0) return null;
  return r.stdout.split('\n').filter(Boolean).length;
}

/** The main branch's refs that exist, local and origin's. */
export async function mainRefs(dir: string, main: string, signal?: AbortSignal): Promise<string[]> {
  if (!validBranch(main)) return [];
  const out: string[] = [];
  for (const ref of [`refs/heads/${main}`, `refs/remotes/origin/${main}`]) {
    const r = known(
      await git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {}, signal),
    );
    if (r.status === 0) out.push(ref);
  }
  return out;
}

/**
 * Read one worktree's real state. Null when its commit isn't in this
 * repository. Throws `GitUnknown` when a read had no answer.
 */
export async function checkWorktree(
  config: Config,
  repo: { dir: string; common: string; main: string },
  trees: readonly Tree[],
  ws: StoredWorkspace,
  now: string,
  signal?: AbortSignal,
): Promise<WorktreeCheck | null> {
  const read = async (args: string[]) => known(await git(repo.dir, args, {}, signal));
  const tree = ws.path ? trees.find((t) => samePath(t.path, ws.path!)) : undefined;
  const head = tree?.head ?? ws.head_sha ?? null;
  if (!head || !/^[0-9a-f]{7,64}$/i.test(head)) return null;
  const resolved = await read(['rev-parse', '--verify', '--quiet', `${head}^{commit}`]);
  if (resolved.status !== 0) return null;
  const sha = resolved.stdout.trim();
  const mains = await mainRefs(repo.dir, repo.main, signal);
  let on_main = false;
  for (const ref of mains) {
    if ((await read(['merge-base', '--is-ancestor', sha, ref])).status === 0) {
      on_main = true;
      break;
    }
  }
  const remote = await read([
    'for-each-ref',
    '--count=1',
    '--format=%(refname)',
    `--contains=${sha}`,
    'refs/remotes',
  ]);
  const count = await read(['rev-list', '--count', sha, '--not', '--remotes', ...mains]);
  const unpushed = count.status === 0 ? Number(count.stdout.trim()) : NaN;
  const uncommitted_files = tree
    ? await uncommittedFiles(config, repo.common, trees, tree, signal)
    : null;
  return {
    checked_at: now,
    head_sha: sha,
    on_main,
    on_remote: remote.status === 0 ? remote.stdout.trim() !== '' : null,
    unpushed_commits: Number.isInteger(unpushed) ? unpushed : null,
    uncommitted_files,
  };
}

/**
 * Check the worktrees of a project's ended runs that left work behind, and
 * store what git says. Returns how many it read. With no readable repository
 * it clears their last check, so they show as unverified. A read with no
 * answer changes nothing, and a run that changed during the read isn't written.
 */
export async function checkProjectWorktrees(
  db: Db,
  config: Config,
  project: string,
  now: string,
  signal?: AbortSignal,
): Promise<number> {
  const runs = db.sqlite
    .prepare(
      `SELECT r.* FROM runs r JOIN items i ON i.id = r.item_id
       WHERE i.project_key = ? AND r.state IN ('finished', 'failed', 'interrupted')
         AND r.workspace IS NOT NULL AND r.unpushed_handled_at IS NULL`,
    )
    .all(project) as RunRow[];
  const risks = unpushedRisks(db, runs);
  if (risks.length === 0) return 0;
  const store = db.sqlite.prepare(
    `UPDATE runs SET worktree_check = @check WHERE id = @id AND state = @state
       AND workspace IS @workspace AND unpushed_handled_at IS NULL`,
  );
  const save = (run: RunRow, check: WorktreeCheck | null) =>
    store.run({
      check: check ? JSON.stringify(check) : null,
      id: run.id,
      state: run.state,
      workspace: run.workspace,
    });

  const p = db.sqlite
    .prepare('SELECT repo_path, main_branch FROM projects WHERE key = ? AND deleted_at IS NULL')
    .get(project) as { repo_path: string | null; main_branch: string } | undefined;
  let repo: { dir: string; common: string; main: string } | null = null;
  if (p?.repo_path) {
    try {
      const dir = resolveRepoPath(config, p.repo_path);
      const probe = await probeRepo(dir, signal);
      if (!probe.ok && probe.unknown) return 0;
      if (probe.ok) repo = { dir, common: dirname(probe.objects), main: p.main_branch };
    } catch {
      repo = null;
    }
  }
  let trees: Tree[] = [];
  if (repo) {
    try {
      trees = await listTrees(repo.dir, signal);
    } catch (err) {
      if (err instanceof GitUnknown) return 0;
      throw err;
    }
  }
  let read = 0;
  for (const risk of risks) {
    if (signal?.aborted) break;
    const ws = storedWorkspace(risk.run);
    let check: WorktreeCheck | null;
    try {
      check = repo && ws ? await checkWorktree(config, repo, trees, ws, now, signal) : null;
    } catch (err) {
      if (err instanceof GitUnknown) continue;
      throw err;
    }
    if (signal?.aborted) break;
    if (check) read += 1;
    save(risk.run, check);
  }
  return read;
}
