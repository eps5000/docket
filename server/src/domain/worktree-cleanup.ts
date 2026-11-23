/**
 * The worktree cleanup view (owner decision 48; BUILD_SPEC §5.30; UI_SPEC
 * §6.6): every worktree of a project's repository, with a plain verdict.
 *
 * **Docket never deletes or prunes a worktree.** This file only reads, with
 * the bounded async git (git-read.ts) and worktree-check.ts's rules: no fetch,
 * nothing written (`GIT_OPTIONAL_LOCKS=0`), content filters off, and only
 * inside `DOCKET_PUSH_ROOT`. For a *Safe to remove* row it offers a command
 * for the owner to check and run, without `--force`, so git itself still
 * refuses a worktree that changed since.
 *
 * Git facts come from a background scan, because a large repository takes too
 * long for a request. The verdict is worked out on every read from the last
 * scan and the live runs, so a run that starts is *In use* at once. A read
 * with no answer is *Unknown*, and *Unknown* is never safe.
 */
import { existsSync, realpathSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { WorktreeVerdict } from '@docket/shared';
import type { Config } from '../config.js';
import { git, GitUnknown, known } from './git-read.js';
import { isInside, rootSegments } from './push-root.js';
import { probeRepo, resolveRepoPath } from './radar.js';
import type { WorkspaceFacts } from './recovery-model.js';
import {
  adminDirs,
  listTrees,
  mainRefs,
  statusCount,
  treeKey,
  type Tree,
} from './worktree-check.js';

export const cleanupLimits = {
  /** All of one worktree's reads. */
  perWorktreeMs: 20_000,
  /** A whole scan; whatever is left then is Unknown. */
  scanMs: 5 * 60_000,
  /** Worktrees read at once, so a scan leaves git slots for the radar and others. */
  workers: 2,
  /** Heads per git call, well inside Windows' command-line limit. */
  headsPerCall: 200,
  /** Commits counted per worktree; more reads as this number. */
  countCap: 1_000,
  /** Older git facts no longer count as known. */
  freshMs: 10 * 60_000,
  /** A read starts a new scan when the last one is this old. */
  rescanAfterMs: 2 * 60_000,
  /** Something Docket has no run for may still be in use if it changed this recently. */
  untrackedQuietMs: 24 * 3_600_000,
};

export type TreeRead = 'ok' | 'outside' | 'missing' | 'timed_out' | 'unreadable';

export interface ScannedTree {
  path: string;
  branch: string | null;
  head: string | null;
  is_main: boolean;
  locked: boolean;
  read: TreeRead;
  uncommitted_files: number | null;
  unpushed_commits: number | null;
  merged: boolean | null;
  /** The latest of the head commit and the worktree's own git activity. */
  last_git_at: string | null;
}

export interface RepoScan {
  status: 'ok' | 'unreadable';
  checked_at: string;
  /** The main checkout as the host sees it, for the command. */
  main_path: string | null;
  trees: ScannedTree[];
}

/** A container path under the push root, as the host sees it. */
function hostPathOf(config: Config, path: string): string {
  if (!config.pushRoot || !config.pushHostPath) return path;
  let root: string;
  try {
    root = realpathSync(config.pushRoot);
  } catch {
    return path;
  }
  if (!isInside(root, path)) return path;
  const rel = relative(root, path).replace(/\\/g, '/');
  const host = config.pushHostPath.replace(/[\\/]+$/, '');
  return rel ? `${host}/${rel}` : host;
}

/** Where a worktree is, from inside the container. */
function locate(config: Config, path: string): { read: TreeRead; dir?: string } {
  if (!config.pushRoot) return { read: 'outside' };
  let segs: string[];
  try {
    segs = rootSegments(path, config.pushRoot, config.pushHostPath);
  } catch {
    return { read: 'outside' };
  }
  try {
    return { read: 'ok', dir: resolveRepoPath(config, path) };
  } catch {
    // Inside by name: either it's gone, or a link leads out of the root.
    try {
      return existsSync(join(realpathSync(config.pushRoot), ...segs))
        ? { read: 'outside' }
        : { read: 'missing' };
    } catch {
      return { read: 'outside' };
    }
  }
}

interface CommitFacts {
  unpushed: Map<string, number>;
  /** Heads with commits that aren't on main. */
  offMain: Set<string>;
  dates: Map<string, string>;
}

/** Commits reachable from `head` inside the off-remote graph, up to the cap. */
function countFrom(head: string, parents: ReadonlyMap<string, readonly string[]>): number {
  if (!parents.has(head)) return 0;
  const seen = new Set([head]);
  const stack = [head];
  while (stack.length > 0 && seen.size < cleanupLimits.countCap) {
    for (const p of parents.get(stack.pop()!) ?? []) {
      if (seen.has(p) || !parents.has(p)) continue;
      seen.add(p);
      stack.push(p);
    }
  }
  return Math.min(seen.size, cleanupLimits.countCap);
}

/** The commit facts for `heads`, in three git calls; null when one had no usable answer. */
async function commitFacts(
  dir: string,
  heads: readonly string[],
  mains: readonly string[],
  signal: AbortSignal,
): Promise<CommitFacts | null> {
  const read = async (args: string[]) => {
    const r = known(await git(dir, args, {}, signal));
    return r.status === 0 ? r.stdout : null;
  };
  const off = await read(['rev-list', '--parents', ...heads, '--not', '--remotes', ...mains]);
  if (off === null) return null;
  const parents = new Map<string, string[]>();
  for (const line of off.split('\n')) {
    const [sha, ...rest] = line.trim().split(' ');
    if (sha) parents.set(sha, rest);
  }
  const offMain = new Set<string>();
  if (mains.length > 0) {
    const list = await read(['rev-list', ...heads, '--not', ...mains]);
    if (list === null) return null;
    const wanted = new Set(heads);
    for (const line of list.split('\n')) {
      const sha = line.trim();
      if (wanted.has(sha)) offMain.add(sha);
    }
  }
  // A repository's config could ask `log` to verify signatures, which runs its `gpg.program`.
  const log = await read([
    '-c',
    'log.showSignature=false',
    'log',
    '--no-walk=unsorted',
    '--format=%H %cI',
    ...heads,
  ]);
  if (log === null) return null;
  const dates = new Map<string, string>();
  for (const line of log.split('\n')) {
    const [sha, at] = line.trim().split(' ');
    if (sha && at) dates.set(sha, new Date(at).toISOString());
  }
  return {
    unpushed: new Map(heads.map((h) => [h, countFrom(h, parents)])),
    offMain,
    dates,
  };
}

/** When git last touched this worktree's own files in its admin folder. */
async function adminActivity(gitDir: string): Promise<string | null> {
  let latest = 0;
  for (const name of ['index', 'HEAD', join('logs', 'HEAD')]) {
    try {
      latest = Math.max(latest, (await stat(join(gitDir, name))).mtimeMs);
    } catch {
      // Not every worktree has every file.
    }
  }
  return latest > 0 ? new Date(latest).toISOString() : null;
}

const latestOf = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);

/**
 * Read every worktree of the repository at `repoPath`. Never writes. A read
 * that times out leaves that worktree `timed_out`, and the scan goes on.
 */
export async function scanRepoWorktrees(
  config: Config,
  repo: { path: string; main: string },
  now: () => string,
  signal: AbortSignal,
  progress: (done: number, total: number) => void = () => {},
): Promise<RepoScan> {
  // The start, not the end: a folder read early in a long scan is only known as of then.
  const startedAt = now();
  const unreadable: RepoScan = {
    status: 'unreadable',
    checked_at: startedAt,
    main_path: null,
    trees: [],
  };
  let dir: string;
  try {
    dir = resolveRepoPath(config, repo.path);
  } catch {
    return unreadable;
  }
  const probe = await probeRepo(dir, signal);
  if (!probe.ok) return unreadable;
  const common = dirname(probe.objects);

  let trees: Tree[];
  let mains: string[];
  try {
    trees = (await listTrees(dir, signal)).filter((t) => !t.bare);
    mains = await mainRefs(dir, repo.main, signal);
  } catch (err) {
    if (err instanceof GitUnknown) return unreadable;
    throw err;
  }
  if (trees.length === 0) return unreadable;
  progress(0, trees.length);

  // ---- Commits: a few calls for the whole repository ----
  // An unborn branch's HEAD is all zeros: it has no commits to ask about.
  const heads = [...new Set(trees.map((t) => t.head).filter((h): h is string => !!h))].filter(
    (h) => /^[0-9a-f]{40,64}$/i.test(h) && !/^0+$/.test(h),
  );
  let commitsUnknown = false;
  const facts = new Map<
    string,
    { unpushed: number; merged: boolean | null; date: string | null }
  >();
  const record = (batch: readonly string[], f: CommitFacts) => {
    for (const h of batch) {
      facts.set(h, {
        unpushed: f.unpushed.get(h) ?? 0,
        merged: mains.length > 0 ? !f.offMain.has(h) : null,
        date: f.dates.get(h) ?? null,
      });
    }
  };
  for (let i = 0; i < heads.length; i += cleanupLimits.headsPerCall) {
    if (signal.aborted) break;
    const batch = heads.slice(i, i + cleanupLimits.headsPerCall);
    try {
      const f = await commitFacts(dir, batch, mains, signal);
      if (f) {
        record(batch, f);
        continue;
      }
      // One bad commit fails a whole call, so ask for each on its own.
      for (const h of batch) {
        if (signal.aborted) break;
        const one = await commitFacts(dir, [h], mains, signal);
        if (one) record([h], one);
      }
    } catch (err) {
      if (!(err instanceof GitUnknown)) throw err;
      // No answer says nothing: these rows stay Unknown, without a slow retry per commit.
      commitsUnknown = true;
    }
  }

  // ---- Each worktree's folder ----
  const admins = await adminDirs(common);
  const out = new Array<ScannedTree>(trees.length);
  const readOne = async (tree: Tree, index: number): Promise<ScannedTree> => {
    const isMain = index === 0;
    const path = isMain ? hostPathOf(config, tree.path) : tree.path;
    const fact = tree.head ? facts.get(tree.head) : undefined;
    const base: ScannedTree = {
      path,
      branch: tree.branch,
      head: tree.head,
      is_main: isMain,
      locked: tree.locked,
      read: 'ok',
      uncommitted_files: null,
      unpushed_commits: null,
      merged: null,
      last_git_at: fact?.date ?? null,
    };
    const where = locate(config, tree.path);
    if (where.read !== 'ok') return { ...base, read: where.read, last_git_at: null };
    const gitDir = isMain ? common : admins.get(treeKey(tree.path));
    if (!gitDir) return { ...base, read: 'unreadable' };
    const withFacts = {
      ...base,
      unpushed_commits: fact?.unpushed ?? null,
      merged: fact?.merged ?? null,
      last_git_at: latestOf(fact?.date ?? null, await adminActivity(gitDir)),
    };
    if (signal.aborted) return { ...withFacts, read: 'timed_out' };
    try {
      const files = await statusCount(
        where.dir!,
        gitDir,
        AbortSignal.any([signal, AbortSignal.timeout(cleanupLimits.perWorktreeMs)]),
      );
      if (files === null) return { ...withFacts, read: 'unreadable' };
      // Without its commit facts the row can't be judged, whatever its files say.
      const read = fact ? 'ok' : commitsUnknown || signal.aborted ? 'timed_out' : 'unreadable';
      return { ...withFacts, uncommitted_files: files, read };
    } catch (err) {
      if (err instanceof GitUnknown) return { ...withFacts, read: 'timed_out' };
      throw err;
    }
  };

  let next = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= trees.length) return;
      out[i] = await readOne(trees[i]!, i);
      done += 1;
      progress(done, trees.length);
    }
  };
  await Promise.all(Array.from({ length: cleanupLimits.workers }, worker));
  return {
    status: 'ok',
    checked_at: startedAt,
    main_path: hostPathOf(config, trees[0]!.path),
    trees: out,
  };
}

// ---- Scans in the background ----

export interface ScanProgress {
  done: number;
  total: number;
}

interface ScanEntry {
  repoKey: string;
  last: RepoScan | null;
  running: { progress: ScanProgress; finished: Promise<void>; stop: AbortController } | null;
}

/** One scan per project at a time, kept in memory. Nothing here is stored. */
export class WorktreeScans {
  private readonly entries = new Map<string, ScanEntry>();
  private stopped = false;

  constructor(
    private readonly config: Config,
    private readonly now: () => string,
    private readonly log: (line: string) => void,
  ) {}

  /** The last scan and any running one. Starts a scan when there's none recent. */
  read(
    project: string,
    repo: { path: string; main: string },
    refresh: boolean,
  ): { scan: RepoScan | null; running: ScanProgress | null } {
    const repoKey = `${repo.path}\n${repo.main}`;
    let entry = this.entries.get(project);
    if (!entry || entry.repoKey !== repoKey) {
      entry?.running?.stop.abort();
      entry = { repoKey, last: null, running: null };
      this.entries.set(project, entry);
    }
    const age = entry.last
      ? Date.parse(this.now()) - Date.parse(entry.last.checked_at)
      : Number.POSITIVE_INFINITY;
    if (!entry.running && !this.stopped && (refresh || age >= cleanupLimits.rescanAfterMs)) {
      this.start(entry, repo);
    }
    return { scan: entry.last, running: entry.running?.progress ?? null };
  }

  private start(entry: ScanEntry, repo: { path: string; main: string }): void {
    const stop = new AbortController();
    const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(cleanupLimits.scanMs)]);
    const progress: ScanProgress = { done: 0, total: 0 };
    const finished = scanRepoWorktrees(this.config, repo, this.now, signal, (done, total) => {
      progress.done = done;
      progress.total = total;
    })
      .then((scan) => {
        if (!stop.signal.aborted) entry.last = scan;
      })
      .catch((err: unknown) => {
        this.log(`Worktree check failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!stop.signal.aborted) {
          entry.last = { status: 'unreadable', checked_at: this.now(), main_path: null, trees: [] };
        }
      })
      .finally(() => {
        entry.running = null;
      });
    entry.running = { progress, finished, stop };
  }

  /** Resolves when the project's running scan, if any, has ended. */
  async settled(project: string): Promise<void> {
    await this.entries.get(project)?.running?.finished;
  }

  /** Stop every scan, before the server closes. */
  async stop(): Promise<void> {
    this.stopped = true;
    const running = [...this.entries.values()].flatMap((e) => (e.running ? [e.running] : []));
    for (const r of running) r.stop.abort();
    await Promise.all(running.map((r) => r.finished));
  }
}

// ---- The verdict ----

/** Paths a single-quoted argument carries unchanged in both bash and PowerShell. */
const PLAIN_PATH = /^(?:[A-Za-z]:)?[\\/][A-Za-z0-9 _.,@+~\\/-]*$/;

/**
 * The command for a *Safe to remove* row, for the owner to check and run.
 * Never `--force`. Null when a path has characters a shell might act on.
 */
export function removeCommand(mainPath: string | null, path: string): string | null {
  if (!mainPath || !PLAIN_PATH.test(mainPath) || !PLAIN_PATH.test(path)) return null;
  return `git -C '${mainPath}' worktree remove '${path}'`;
}

const files = (n: number) => `${n} uncommitted ${n === 1 ? 'file' : 'files'}`;
const commits = (n: number) => `${n} ${n === 1 ? 'commit' : 'commits'} not on a remote`;

const UNREAD: Record<Exclude<TreeRead, 'ok'>, string> = {
  outside: 'It’s outside the folder Docket can read, so it can’t be checked.',
  missing: 'Git lists it, but its folder isn’t there, so it can’t be checked.',
  timed_out: 'Git didn’t answer in time, so it can’t be told what this holds.',
  unreadable: 'Docket couldn’t read it, so it can’t be told what this holds.',
};

export interface VerdictInput {
  tree: ScannedTree;
  /** Docket's runs in this worktree; null when it has none. */
  facts: WorkspaceFacts | null;
  /** A run here ended unexpectedly and its work hasn't been picked up. */
  awaitsRestart: boolean;
  /** When the git facts were read. */
  checkedAt: string;
  now: string;
}

/**
 * One worktree's verdict. What Docket knows is running comes first, because it
 * holds even when git can't be read; anything git couldn't answer is Unknown.
 */
export function worktreeVerdict(input: VerdictInput): { verdict: WorktreeVerdict; why: string } {
  const { tree, facts, now } = input;
  if (facts?.state === 'in_use') return { verdict: 'in_use', why: 'A run is working here.' };
  if (facts?.state === 'parked') {
    return { verdict: 'in_use', why: 'Its run is parked and will come back to it.' };
  }
  if (tree.is_main) {
    return { verdict: 'in_use', why: 'This is the repository’s main folder.' };
  }
  if (facts?.kept) return { verdict: 'kept_for_later', why: 'You chose to keep this for later.' };
  if (tree.locked) {
    return { verdict: 'kept_for_later', why: 'It’s locked in git, so someone wants it kept.' };
  }
  if (tree.read !== 'ok') return { verdict: 'unknown', why: UNREAD[tree.read] };
  if (Date.parse(now) - Date.parse(input.checkedAt) > cleanupLimits.freshMs) {
    return { verdict: 'unknown', why: 'The last check is too old to rely on.' };
  }
  const { uncommitted_files: dirty, unpushed_commits: ahead, merged } = tree;
  if (dirty === null || ahead === null || merged === null) {
    return { verdict: 'unknown', why: UNREAD.timed_out };
  }
  if (dirty > 0 || ahead > 0) {
    const held = [dirty > 0 ? files(dirty) : null, ahead > 0 ? commits(ahead) : null]
      .filter(Boolean)
      .join(' and ');
    return {
      verdict: 'holds_work',
      why: facts?.handled
        ? `You marked this safe to discard, but it still has ${held}.`
        : `It has ${held}.`,
    };
  }
  if (facts && facts.unreleased.length > 0) {
    return { verdict: 'holds_work', why: 'Something its run started is still listed as running.' };
  }
  if (input.awaitsRestart) {
    return {
      verdict: 'holds_work',
      why: 'Its run ended unexpectedly, and the work hasn’t been picked up again.',
    };
  }
  if (!facts) {
    const quiet =
      tree.last_git_at !== null &&
      Date.parse(now) - Date.parse(tree.last_git_at) >= cleanupLimits.untrackedQuietMs;
    if (!quiet) {
      return {
        verdict: 'unknown',
        why: 'It changed in the last day and Docket has no run for it, so something may be using it.',
      };
    }
  }
  return {
    verdict: 'safe_to_remove',
    why: merged
      ? 'Clean, merged to main, and nothing is running in it.'
      : 'Clean, its commits are on a remote, and nothing is running in it.',
  };
}
