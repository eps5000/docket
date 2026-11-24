/**
 * The worktrees source (owner decision 48; B68; BUILD_SPEC §5.32). Docket runs
 * in a container, where git can't follow a worktree whose `.git` file names a
 * Windows path. Here on the host it can, so this reads each project's worktrees
 * and reports the facts.
 *
 * - **Read-only** (lib/git.mjs). No fetch, no content filters, no signature
 *   checks, nothing written.
 * - **Only** paths, branch names, SHAs, counts, booleans and timestamps leave
 *   this file. `git status` output is counted and dropped, so a file name is
 *   never held, sent, stored or logged.
 * - **Bounded:** two worktrees at a time, 20 seconds each, two minutes a pass. A
 *   read with no answer is `timed_out`. What a pass didn't reach is left out and
 *   the scan is marked incomplete, so Docket removes nothing because of it, and
 *   the next pass starts where this one stopped.
 *
 * Each project sends its worktrees, then one `scan` record that closes them.
 */
import { createHash, randomBytes } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createGit } from '../lib/git.mjs';

export const name = 'worktrees';
export const intervalMs = 3 * 60_000;

/** At least one project has a repository the host can reach. */
export const enabled = (settings) =>
  settings?.enabled === true && Array.isArray(settings.projects) && settings.projects.length > 0;

/** B60's limits, so the two reads behave alike. */
export const DEFAULT_LIMITS = Object.freeze({
  perWorktreeMs: 20_000,
  perCallMs: 60_000,
  passMs: 120_000,
  workers: 2,
  headsPerCall: 200,
  countCap: 1_000,
  maxTrees: 5_000,
});

const MAX_PATH = 1024;
const SHA = /^[0-9a-f]{40,64}$/i;
const ZERO = /^0+$/;

const hasControl = (text) =>
  [...text].some((c) => {
    const code = c.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });

/**
 * An absolute local path. A UNC or device path is refused before anything
 * touches it: reading one would make Windows connect to that host.
 */
export function safeHostPath(path, platform = process.platform) {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH) return false;
  if (hasControl(path) || /^[\\/]{2}/.test(path)) return false;
  if (path.split(/[\\/]/).includes('..')) return false;
  return platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(path) : path.startsWith('/');
}

const validBranch = (branch) =>
  /^[A-Za-z0-9._/@+-]+$/.test(branch) &&
  !branch.startsWith('-') &&
  !branch.includes('..') &&
  !branch.startsWith('/') &&
  !branch.endsWith('/') &&
  !branch.endsWith('.lock');

/** `git worktree list --porcelain`. A lock's reason is free text and is never kept. */
export function parseWorktreeList(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('worktree ')) {
      out.push({ path: line.slice(9), head: null, branch: null, locked: false, bare: false });
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

const pathId = (path) =>
  createHash('sha256')
    .update(path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase())
    .digest('hex')
    .slice(0, 24);

/** Commits reachable from `head` inside the off-remote graph, up to the cap. */
function countFrom(head, parents, cap) {
  if (!parents.has(head)) return 0;
  const seen = new Set([head]);
  const stack = [head];
  while (stack.length > 0 && seen.size < cap) {
    for (const parent of parents.get(stack.pop()) ?? []) {
      if (seen.has(parent) || !parents.has(parent)) continue;
      seen.add(parent);
      stack.push(parent);
    }
  }
  return Math.min(seen.size, cap);
}

async function mainRefs(git, dir, main, options) {
  if (!validBranch(main)) return { refs: [], unknown: false };
  const refs = [];
  for (const ref of [`refs/heads/${main}`, `refs/remotes/origin/${main}`]) {
    const r = await git.read(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], options);
    if (r.unknown) return { refs: [], unknown: true };
    if (r.status === 0) refs.push(ref);
  }
  return { refs, unknown: false };
}

/** Commit facts for `heads` in three calls. `null`: no usable answer; `unknown`: no answer. */
async function commitFacts(git, dir, heads, mains, limits, options) {
  const read = async (args) => {
    const r = await git.read(dir, args, options);
    if (r.unknown) throw new GitNoAnswer();
    return r.status === 0 ? r.stdout : null;
  };
  const off = await read(['rev-list', '--parents', ...heads, '--not', '--remotes', ...mains]);
  if (off === null) return null;
  const parents = new Map();
  for (const line of off.split('\n')) {
    const [sha, ...rest] = line.trim().split(' ');
    if (sha) parents.set(sha, rest);
  }
  const offMain = new Set();
  if (mains.length > 0) {
    const list = await read(['rev-list', ...heads, '--not', ...mains]);
    if (list === null) return null;
    const wanted = new Set(heads);
    for (const line of list.split('\n')) {
      const sha = line.trim();
      if (wanted.has(sha)) offMain.add(sha);
    }
  }
  const log = await read(['log', '--no-walk=unsorted', '--format=%H %cI', ...heads]);
  if (log === null) return null;
  const dates = new Map();
  for (const line of log.split('\n')) {
    const [sha, at] = line.trim().split(' ');
    const ms = at ? Date.parse(at) : Number.NaN;
    if (sha && !Number.isNaN(ms)) dates.set(sha, new Date(ms).toISOString());
  }
  return new Map(
    heads.map((h) => [
      h,
      {
        unpushed: countFrom(h, parents, limits.countCap),
        merged: mains.length > 0 ? !offMain.has(h) : null,
        date: dates.get(h) ?? null,
      },
    ]),
  );
}

class GitNoAnswer extends Error {}

/** Facts for every head. A batch that fails is asked again one commit at a time. */
async function allCommitFacts(git, dir, heads, mains, limits, options) {
  const facts = new Map();
  let unknown = false;
  for (let i = 0; i < heads.length; i += limits.headsPerCall) {
    if (options.signal?.aborted) return { facts, unknown: true };
    const batch = heads.slice(i, i + limits.headsPerCall);
    try {
      const found = await commitFacts(git, dir, batch, mains, limits, options);
      if (found) {
        for (const [h, f] of found) facts.set(h, f);
        continue;
      }
      for (const h of batch) {
        const one = await commitFacts(git, dir, [h], mains, limits, options);
        if (one) facts.set(h, one.get(h));
      }
    } catch (err) {
      if (!(err instanceof GitNoAnswer)) throw err;
      unknown = true;
    }
  }
  return { facts, unknown };
}

/** `-c` overrides that switch off each configured content filter; null if that can't be done. */
async function filtersOff(git, dir, options) {
  const r = await git.read(dir, ['config', '--name-only', '--get-regexp', '^filter\\.'], options);
  if (r.unknown) throw new GitNoAnswer();
  // Exit 1 means no key matched.
  if (r.status !== 0 && r.status !== 1) return null;
  const names = new Set();
  for (const key of r.stdout.split('\n')) {
    const match = /^filter\.(.+)\.[^.]+$/.exec(key.trim());
    if (match) names.add(match[1]);
  }
  // `-c` splits at the first `=`, so such a name couldn't be switched off.
  if ([...names].some((n) => n.includes('=') || hasControl(n))) return null;
  return [...names].flatMap((n) => [
    '-c',
    `filter.${n}.clean=`,
    '-c',
    `filter.${n}.smudge=`,
    '-c',
    `filter.${n}.process=`,
    '-c',
    `filter.${n}.required=false`,
  ]);
}

/** How many entries `git status` lists, up to the cap. The names are never kept. */
async function statusCount(git, dir, limits, options) {
  const off = await filtersOff(git, dir, options);
  if (!off) return null;
  const r = await git.read(
    dir,
    [
      ...off,
      'status',
      '--porcelain=v1',
      '-z',
      '--no-renames',
      '--untracked-files=all',
      '--ignore-submodules=all',
    ],
    { ...options, countNul: limits.countCap },
  );
  if (r.unknown) throw new GitNoAnswer();
  return r.status === 0 ? r.count : null;
}

/** When git last touched this worktree's own admin files. Only their times are read. */
async function adminActivity(gitDir) {
  let latest = 0;
  for (const file of ['index', 'HEAD', join('logs', 'HEAD')]) {
    try {
      latest = Math.max(latest, (await stat(join(gitDir, file))).mtimeMs);
    } catch {
      // Not every worktree has every file.
    }
  }
  return latest > 0 ? new Date(latest).toISOString() : null;
}

const latestOf = (a, b) => (!a ? b : !b ? a : a > b ? a : b);

async function readTree(git, tree, isMain, fact, commitsUnknown, limits, signal) {
  const base = {
    path: tree.path,
    branch: tree.branch,
    head: tree.head && SHA.test(tree.head) ? tree.head.toLowerCase() : null,
    is_main: isMain,
    locked: tree.locked,
    read: 'ok',
    uncommitted_files: null,
    unpushed_commits: null,
    merged: null,
    last_git_at: null,
  };
  let info;
  try {
    info = await stat(tree.path);
  } catch (err) {
    return {
      ...base,
      read: err.code === 'ENOENT' || err.code === 'ENOTDIR' ? 'missing' : 'unreadable',
    };
  }
  if (!info.isDirectory()) return { ...base, read: 'unreadable' };
  const withFacts = {
    ...base,
    unpushed_commits: fact?.unpushed ?? null,
    merged: fact?.merged ?? null,
    last_git_at: fact?.date ?? null,
  };
  const timed = AbortSignal.timeout(limits.perWorktreeMs);
  const options = {
    signal: signal ? AbortSignal.any([signal, timed]) : timed,
    timeoutMs: limits.perWorktreeMs,
  };
  try {
    const dir = await git.read(tree.path, ['rev-parse', '--absolute-git-dir'], options);
    if (dir.unknown) return { ...withFacts, read: 'timed_out' };
    if (dir.status !== 0) return { ...withFacts, read: 'unreadable' };
    const activity = await adminActivity(dir.stdout.trim());
    const files = await statusCount(git, tree.path, limits, options);
    const last_git_at = latestOf(fact?.date ?? null, activity);
    if (files === null) return { ...withFacts, last_git_at, read: 'unreadable' };
    // Without its commit facts the row can't be judged, whatever its files say.
    const read = fact ? 'ok' : commitsUnknown ? 'timed_out' : 'unreadable';
    return { ...withFacts, last_git_at, uncommitted_files: files, read };
  } catch (err) {
    if (err instanceof GitNoAnswer) return { ...withFacts, read: 'timed_out' };
    throw err;
  }
}

/** A partial clone would fetch a missing object on demand if git is too old to refuse. */
async function lazyFetchRisk(git, dir, options) {
  const version = await git.read(dir, ['version'], options);
  const match = /(\d+)\.(\d+)/.exec(version.stdout ?? '');
  if (match && (Number(match[1]) > 2 || (Number(match[1]) === 2 && Number(match[2]) >= 45))) {
    return false;
  }
  const r = await git.read(
    dir,
    [
      'config',
      '--name-only',
      '--get-regexp',
      '^(remote\\..*\\.promisor|extensions\\.partialclone)$',
    ],
    options,
  );
  return r.unknown || r.status === 0;
}

async function scanProject(git, project, offset, limits, signal, deadline, nowMs) {
  const checked_at = new Date(nowMs()).toISOString();
  const scan_id = `${nowMs().toString(36)}-${randomBytes(4).toString('hex')}`;
  const closing = (status, complete, count, main_path) => ({
    key: `scan:${project.key}:${scan_id}`,
    kind: 'scan',
    project: project.key,
    scan_id,
    repo_path: project.repo_path,
    main_branch: project.main_branch,
    status,
    complete,
    tree_count: count,
    checked_at,
    main_path,
  });
  const unreadable = {
    records: [closing('unreadable', false, 0, null)],
    offset: 0,
    read: 0,
    unknown: 0,
  };
  const dir = project.host_path;
  if (!safeHostPath(dir)) return unreadable;
  const options = { signal, timeoutMs: limits.perCallMs };

  const listed = await git.read(dir, ['worktree', 'list', '--porcelain'], options);
  if (listed.unknown || listed.status !== 0) return unreadable;
  if (await lazyFetchRisk(git, dir, options)) return unreadable;
  const all = parseWorktreeList(listed.stdout).filter((t) => !t.bare);
  if (all.length === 0) return unreadable;

  const { refs: mains, unknown: mainsUnknown } = await mainRefs(
    git,
    dir,
    project.main_branch,
    options,
  );
  const heads = [
    ...new Set(all.map((t) => t.head).filter((h) => h && SHA.test(h) && !ZERO.test(h))),
  ];
  const commits = mainsUnknown
    ? { facts: new Map(), unknown: true }
    : await allCommitFacts(git, dir, heads, mains, limits, options);

  // The first listed is the main checkout. One that isn't a plain local path is never read.
  const main_path = safeHostPath(all[0].path) ? all[0].path : null;
  const usable = all
    .map((tree, index) => ({ tree, isMain: index === 0 }))
    .filter(({ tree }) => safeHostPath(tree.path));
  const capped = usable.slice(0, limits.maxTrees);
  const start = capped.length > 0 ? offset % capped.length : 0;
  const order = [...capped.slice(start), ...capped.slice(0, start)];

  const out = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      if (signal?.aborted || nowMs() >= deadline) return;
      const i = next;
      next += 1;
      if (i >= order.length) return;
      const { tree, isMain } = order[i];
      const fact = tree.head ? commits.facts.get(tree.head) : undefined;
      out.push(await readTree(git, tree, isMain, fact, commits.unknown, limits, signal));
    }
  };
  await Promise.all(Array.from({ length: limits.workers }, worker));

  const reachedAll = out.length === order.length;
  const complete = reachedAll && usable.length === all.length && capped.length === usable.length;
  const records = out.map((tree) => ({
    key: `tree:${project.key}:${scan_id}:${pathId(tree.path)}`,
    kind: 'tree',
    project: project.key,
    scan_id,
    ...tree,
  }));
  records.push(closing('ok', complete, out.length, main_path));
  return {
    records,
    offset: reachedAll || capped.length === 0 ? 0 : (start + out.length) % capped.length,
    read: out.length,
    unknown: out.filter((t) => t.read !== 'ok').length,
  };
}

/**
 * One pass. `options` is for tests: `git`, `limits`, `now`, `env`. Returns
 * `{ records, state }`; the runner saves `state` once the records are posted.
 */
export async function collect(ctx, options = {}) {
  const { state, log, signal, settings } = ctx;
  const previous = state?.v === 1 ? state : { v: 1, next: 0, offsets: {} };
  if (!enabled(settings)) return { records: [], state: previous };

  const git = options.git ?? createGit(options.env ? { env: options.env } : {});
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const nowMs = options.now ?? Date.now;
  const deadline = nowMs() + limits.passMs;
  const projects = settings.projects;
  const first = (previous.next ?? 0) % projects.length;
  const offsets = {};
  const records = [];
  let done = 0;
  let trees = 0;
  let unknown = 0;
  for (let i = 0; i < projects.length; i += 1) {
    if (signal?.aborted || nowMs() >= deadline) break;
    const project = projects[(first + i) % projects.length];
    const result = await scanProject(
      git,
      project,
      previous.offsets?.[project.key] ?? 0,
      limits,
      signal,
      deadline,
      nowMs,
    );
    records.push(...result.records);
    if (result.offset > 0) offsets[project.key] = result.offset;
    trees += result.read;
    unknown += result.unknown;
    done += 1;
  }
  // Counts only: no path or branch reaches the log.
  log?.('worktrees_read', { projects: done, trees, unknown });
  return {
    records,
    state: {
      v: 1,
      next: done === projects.length ? 0 : (first + done) % projects.length,
      offsets: { ...(done === projects.length ? {} : previous.offsets), ...offsets },
    },
  };
}

export default { name, intervalMs, enabled, collect };
