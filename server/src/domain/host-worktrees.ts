/**
 * Worktree facts from the host helper (owner decision 48; B68; BUILD_SPEC
 * §5.32). Docket runs no git (B76): `tools/docket-sync/sources/worktrees.mjs`
 * reads every worktree on the host, where git can follow a `.git` file that
 * names a Windows path, and posts the facts here.
 *
 * The latest facts per project are bookkeeping in `sync_sources.detail`: they
 * change on every pass, so they record no event and take no migration.
 *
 * **Safety.** These facts only ever feed `worktreeVerdict`, and:
 * - a fact past `FACTS_FRESH_MS` becomes an Unknown row with its numbers and
 *   lock cleared;
 * - a partial scan updates what it read and removes nothing;
 * - a worktree leaves only when a newer *complete* scan doesn't list it;
 * - a scan for a repository the project no longer points at is ignored.
 */
import {
  hasControlChars,
  type HostScanRecord,
  type HostTreeRecord,
  type HostWorktreeRecord,
  type WorktreeHostState,
} from '@docket/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { rootSegments } from './push-root.js';
import { treeKey, type WorktreeCheck } from './recovery-model.js';
import type { ScannedTree } from './worktree-cleanup.js';

export const HOST_SOURCE = 'worktrees';
/** Older git facts no longer count as known. */
export const FACTS_FRESH_MS = 10 * 60_000;
const MAX_STORED_TREES = 5_000;
/** A little clock drift between host and container is normal. Further ahead can't be trusted. */
const MAX_FUTURE_MS = 2 * 60_000;

/** Recent enough to rely on, and not claiming to come from the future. */
export function isFresh(at: string, nowMs: number): boolean {
  const age = nowMs - Date.parse(at);
  return age <= FACTS_FRESH_MS && age >= -MAX_FUTURE_MS;
}

export type HostTree = ScannedTree & { checked_at: string };

export interface HostProjectFacts {
  repo_path: string;
  main_branch: string;
  scan_id: string;
  /** When the newest scan applied here started. */
  checked_at: string;
  /** When the newest *complete* scan started. */
  complete_at: string | null;
  main_path: string | null;
  trees: HostTree[];
}

type PendingTree = Omit<HostTree, 'checked_at'>;

interface HostDetail {
  projects: Record<string, HostProjectFacts>;
  /** Trees of a scan whose closing record hasn't arrived. */
  pending: Record<string, { scan_id: string; trees: PendingTree[] }>;
}

export interface HostProject {
  key: string;
  repo_path: string;
  main_branch: string;
}

/** The live projects with a repository folder. */
export function hostProjects(db: Db): HostProject[] {
  return db.sqlite
    .prepare(
      `SELECT key, repo_path, main_branch FROM projects
       WHERE deleted_at IS NULL AND repo_path IS NOT NULL ORDER BY key`,
    )
    .all() as HostProject[];
}

/** The repository folder as the host sees it; null when that can't be told. */
export function hostRepoPath(config: Config, repoPath: string): string | null {
  const p = repoPath.trim().replace(/\\/g, '/');
  if (p === '' || hasControlChars(p) || p.startsWith('//')) return null;
  if (config.pushRoot && config.pushHostPath) {
    try {
      const segs = rootSegments(p, config.pushRoot, config.pushHostPath);
      const host = config.pushHostPath.replace(/\\/g, '/').replace(/\/+$/, '');
      return segs.length > 0 ? `${host}/${segs.join('/')}` : host;
    } catch {
      // Not under the push folder: it can still be a path on the host.
    }
  } else if (config.pushRoot) {
    // A container path means nothing on the host without the mapping.
    const root = config.pushRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    if (p === root || p.startsWith(`${root}/`)) return null;
  }
  if (p.split('/').includes('..')) return null;
  return /^(?:[A-Za-z]:\/|\/)/.test(p) ? p : null;
}

function readDetail(previous: Record<string, unknown>): HostDetail {
  return {
    projects: (previous.projects ?? {}) as HostDetail['projects'],
    pending: (previous.pending ?? {}) as HostDetail['pending'],
  };
}

const isTree = (r: HostWorktreeRecord): r is HostTreeRecord => r.kind === 'tree';

function toPending(r: HostTreeRecord): PendingTree {
  return {
    path: r.path,
    branch: r.branch,
    head: r.head,
    is_main: r.is_main,
    locked: r.locked,
    read: r.read,
    uncommitted_files: r.uncommitted_files,
    unpushed_commits: r.unpushed_commits,
    merged: r.merged,
    last_git_at: r.last_git_at,
  };
}

function closeScan(
  old: HostProjectFacts | undefined,
  record: HostScanRecord,
  received: readonly PendingTree[],
): HostProjectFacts {
  const stamped = received.map((t) => ({ ...t, checked_at: record.checked_at }));
  const whole = record.complete && stamped.length > 0 && stamped.length === record.tree_count;
  let trees: HostTree[];
  if (whole) {
    trees = stamped;
  } else {
    // Partial: update what it read, and keep the rest with their own older times.
    const merged = new Map((old?.trees ?? []).map((t) => [treeKey(t.path), t]));
    for (const t of stamped) merged.set(treeKey(t.path), t);
    trees = [...merged.values()];
  }
  return {
    repo_path: record.repo_path,
    main_branch: record.main_branch,
    scan_id: record.scan_id,
    checked_at: record.checked_at,
    complete_at: whole ? record.checked_at : (old?.complete_at ?? null),
    main_path: record.main_path ?? old?.main_path ?? null,
    trees: trees.slice(0, MAX_STORED_TREES),
  };
}

/**
 * The stored facts after one batch. Applying a batch again changes nothing: a
 * scan already closed is ignored, and so is one older than what's stored.
 */
export function applyHostRecords(
  previous: Record<string, unknown>,
  records: readonly HostWorktreeRecord[],
  projects: readonly HostProject[],
  now: string,
): Record<string, unknown> {
  const nowMs = Date.parse(now);
  const before = readDetail(previous);
  const live = new Map(projects.map((p) => [p.key, p]));
  // A project that's gone or moved to another repository loses its facts.
  const current = Object.fromEntries(
    Object.entries(before.projects).filter(([key, f]) => {
      const p = live.get(key);
      return p && p.repo_path === f.repo_path && p.main_branch === f.main_branch;
    }),
  );
  const pending = Object.fromEntries(
    Object.entries(before.pending).filter(([key]) => live.has(key)),
  );
  for (const record of records) {
    const project = live.get(record.project);
    if (!project || current[record.project]?.scan_id === record.scan_id) continue;
    if (isTree(record)) {
      let open = pending[record.project];
      if (open?.scan_id !== record.scan_id) {
        open = { scan_id: record.scan_id, trees: [] };
        pending[record.project] = open;
      }
      const key = treeKey(record.path);
      const at = open.trees.findIndex((t) => treeKey(t.path) === key);
      if (at >= 0) open.trees[at] = toPending(record);
      else if (open.trees.length < MAX_STORED_TREES) open.trees.push(toPending(record));
      continue;
    }
    const open = pending[record.project];
    const received = open?.scan_id === record.scan_id ? open.trees : [];
    if (open?.scan_id === record.scan_id) delete pending[record.project];
    if (record.repo_path !== project.repo_path || record.main_branch !== project.main_branch) {
      continue;
    }
    // Stored, a time from the future would stay fresh and block every real scan after it.
    if (Date.parse(record.checked_at) > nowMs + MAX_FUTURE_MS) continue;
    const old = current[record.project];
    if (old && record.checked_at < old.checked_at) continue;
    // An unreadable repository says nothing new: what's stored ages out by itself.
    if (record.status !== 'ok') continue;
    current[record.project] = closeScan(old, record, received);
  }
  return { projects: current, pending };
}

function storedDetail(db: Db): HostDetail | null {
  const row = db.sqlite
    .prepare('SELECT detail FROM sync_sources WHERE name = ?')
    .get(HOST_SOURCE) as { detail: string | null } | undefined;
  if (!row?.detail) return null;
  try {
    const parsed = JSON.parse(row.detail) as unknown;
    return parsed !== null && typeof parsed === 'object'
      ? readDetail(parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The stored facts, if they're for the repository this project points at now. */
export function hostFactsFor(
  db: Db,
  project: { key: string; repo_path: string; main_branch: string },
): HostProjectFacts | null {
  const facts = storedDetail(db)?.projects[project.key];
  return facts && facts.repo_path === project.repo_path && facts.main_branch === project.main_branch
    ? facts
    : null;
}

/** A deleted project's folder names don't outlive it. */
export function forgetHostFacts(db: Db, key: string): void {
  const detail = storedDetail(db);
  if (!detail || (!detail.projects[key] && !detail.pending[key])) return;
  delete detail.projects[key];
  delete detail.pending[key];
  db.sqlite
    .prepare('UPDATE sync_sources SET detail = ? WHERE name = ?')
    .run(JSON.stringify(detail), HOST_SOURCE);
}

// ---- The view ----

export interface JudgedTree {
  tree: ScannedTree;
  checkedAt: string;
  /** Always the helper since B76: Docket's container reads no git. */
  source: 'host';
}

export interface MergedScan {
  trees: JudgedTree[];
  main_path: string | null;
  checked_at: string | null;
  host: { state: WorktreeHostState; checked_at: string | null };
}

/** Old facts can't vouch for anything, so neither their numbers nor their lock are used. */
const staleTree = (t: HostTree): ScannedTree => ({
  path: t.path,
  branch: t.branch,
  head: t.head,
  is_main: t.is_main,
  locked: false,
  read: 'stale',
  uncommitted_files: null,
  unpushed_commits: null,
  merged: null,
  last_git_at: t.last_git_at,
});

/**
 * The host's facts as rows to judge. Null when it has reported nothing for
 * this repository. A row whose facts are too old becomes an Unknown row with
 * its numbers and lock cleared; a newer complete scan removes what it no
 * longer lists.
 */
export function hostScanView(host: HostProjectFacts | null, now: string): MergedScan | null {
  if (!host) return null;
  const nowMs = Date.parse(now);
  const fresh = (at: string) => isFresh(at, nowMs);
  const state: WorktreeHostState = fresh(host.checked_at) ? 'fresh' : 'stale';
  const out = new Map<string, JudgedTree>();
  for (const t of host.trees) {
    const { checked_at: checkedAt, ...tree } = t;
    out.set(treeKey(t.path), {
      tree: fresh(checkedAt) ? tree : staleTree(t),
      checkedAt,
      source: 'host',
    });
  }
  return {
    trees: [...out.values()],
    main_path: host.main_path,
    checked_at: host.checked_at,
    host: { state, checked_at: host.checked_at },
  };
}

// ---- B49's unpushed and uncommitted checks ----

/** Each fresh, fully read worktree as a check, by `treeKey`. */
export function hostChecks(
  db: Db,
  project: { key: string; repo_path: string | null; main_branch: string },
  now: string,
): Map<string, WorktreeCheck> {
  const out = new Map<string, WorktreeCheck>();
  if (!project.repo_path) return out;
  const facts = hostFactsFor(db, { ...project, repo_path: project.repo_path });
  const nowMs = Date.parse(now);
  for (const t of facts?.trees ?? []) {
    if (!isFresh(t.checked_at, nowMs)) continue;
    if (t.read !== 'ok' || !t.head) continue;
    if (t.uncommitted_files === null || t.unpushed_commits === null || t.merged === null) continue;
    out.set(treeKey(t.path), {
      checked_at: t.checked_at,
      head_sha: t.head,
      on_main: t.merged,
      // The helper counts commits on no remote, and doesn't ask this separately.
      on_remote: null,
      unpushed_commits: t.unpushed_commits,
      uncommitted_files: t.uncommitted_files,
    });
  }
  return out;
}
