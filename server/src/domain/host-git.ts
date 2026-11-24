/**
 * Git facts from the host helper (B76; BUILD_SPEC §5.35). Docket runs no git:
 * `tools/docket-sync/sources/git.mjs` reads the repository on the host and
 * posts what it found here. The radar, branch discovery, commit activity, the
 * worktree check and the install's main-branch manifest all judge from these.
 *
 * The latest pass per project is bookkeeping in `sync_sources.detail`, like the
 * worktree facts (host-worktrees.ts): it changes on every pass, so it records no
 * event and takes no migration.
 *
 * **Safety.**
 * - A pass for a repository or main branch the project no longer points at is
 *   ignored, and so is one older than what's stored or from the future.
 * - What a pass didn't reach is simply absent, and an absent fact is unknown:
 *   callers keep what they have. A pair absent from a pass whose `pairs_done`
 *   holds (and whose pair records all arrived) was judged unrelated.
 * - Facts past `FACTS_FRESH_MS` (about three passes) are stale: callers say so
 *   and decide nothing from them.
 */
import type { HostGitPassRecord, HostGitRecord } from '@docket/shared';
import type { Db } from '../db/client.js';
import { FACTS_FRESH_MS, isFresh, type HostProject } from './host-worktrees.js';

export const HOST_GIT_SOURCE = 'git';
export { FACTS_FRESH_MS };
/** A little clock drift between host and container is normal. Further ahead can't be trusted. */
const MAX_FUTURE_MS = 2 * 60_000;

export type MergeState = 'clean' | 'conflict' | 'failed' | 'unknown';

export interface HostGitBranch {
  read: 'ok' | 'missing' | 'unknown';
  ref: 'heads' | 'origin' | null;
  merged: boolean | null;
  main: MergeState;
  files: string[];
  /** Some conflicting files weren't sent (the helper's caps): the list isn't the whole answer. */
  more?: boolean;
}

export interface HostGitPair {
  state: MergeState;
  files: string[];
  more?: boolean;
}

export interface HostGitCommits {
  since: string;
  read: 'ok' | 'unknown';
  commits: { sha: string; at: string }[];
}

export interface HostGitHead {
  head: string | null;
  read: 'ok' | 'missing' | 'unknown';
  on_main: boolean | null;
  on_remote: boolean | null;
  unpushed: number | null;
}

export interface HostGitManifest {
  state: 'present' | 'absent' | 'unknown';
  install_id: string | null;
  files: { key: string; version_id: string; sha256: string }[];
}

export interface HostGitFacts {
  repo_path: string;
  main_branch: string;
  pass_id: string;
  checked_at: string;
  status: 'ok' | 'unreadable';
  main_ref: 'heads' | 'origin' | null;
  complete: boolean;
  /** Every related pair was sent and arrived: a pair not listed is unrelated. */
  pairs_done: boolean;
  items: Record<string, { read: 'ok' | 'unknown'; matches: string[] }>;
  branches: Record<string, HostGitBranch>;
  /** By `pairKey(a, b)`, `a` < `b`. */
  pairs: Record<string, HostGitPair>;
  commits: Record<string, HostGitCommits>;
  /** By the commit as Docket asked for it, lower-case. */
  heads: Record<string, HostGitHead>;
  manifests: Record<string, HostGitManifest>;
}

export const pairKey = (a: string, b: string) => `${a}\u0000${b}`;

type SubRecord = Exclude<HostGitRecord, HostGitPassRecord>;

interface Detail {
  projects: Record<string, HostGitFacts>;
  /** Records of a pass whose closing record hasn't arrived. */
  pending: Record<string, { pass_id: string; records: SubRecord[] }>;
}

/** Records one pass may hold before its close; past this the pass is ignored. */
const MAX_PENDING = 5_000;

function readDetail(previous: Record<string, unknown>): Detail {
  return {
    projects: (previous.projects ?? {}) as Detail['projects'],
    pending: (previous.pending ?? {}) as Detail['pending'],
  };
}

function closePass(record: HostGitPassRecord, received: readonly SubRecord[]): HostGitFacts {
  const facts: HostGitFacts = {
    repo_path: record.repo_path,
    main_branch: record.main_branch,
    pass_id: record.pass_id,
    checked_at: record.checked_at,
    status: record.status === 'ok' ? 'ok' : 'unreadable',
    main_ref: record.main_ref,
    complete: record.complete,
    pairs_done: false,
    items: {},
    branches: {},
    pairs: {},
    commits: {},
    heads: {},
    manifests: {},
  };
  let pairs = 0;
  for (const r of received) {
    switch (r.kind) {
      case 'item':
        facts.items[r.item] = { read: r.read, matches: r.matches };
        break;
      case 'branch':
        facts.branches[r.name] = {
          read: r.read,
          ref: r.ref,
          merged: r.merged,
          main: r.main,
          files: r.files,
          more: r.more,
        };
        break;
      case 'pair': {
        const [a, b] = r.a < r.b ? [r.a, r.b] : [r.b, r.a];
        if (!facts.pairs[pairKey(a, b)]) pairs += 1;
        facts.pairs[pairKey(a, b)] = { state: r.state, files: r.files, more: r.more };
        break;
      }
      case 'commits':
        facts.commits[r.branch] = { since: r.since, read: r.read, commits: r.commits };
        break;
      case 'head':
        facts.heads[r.sha.toLowerCase()] = {
          head: r.head?.toLowerCase() ?? null,
          read: r.read,
          on_main: r.on_main,
          on_remote: r.on_remote,
          unpushed: r.unpushed,
        };
        break;
      case 'manifest':
        facts.manifests[r.client] = { state: r.state, install_id: r.install_id, files: r.files };
        break;
    }
  }
  // A pair record that was refused or lost would otherwise read as "unrelated".
  facts.pairs_done = record.status === 'ok' && record.pairs_done && pairs === record.pairs;
  return facts;
}

/**
 * The stored facts after one batch. Applying a batch again changes nothing: a
 * pass already closed is ignored, and so is one older than what's stored.
 */
export function applyHostGitRecords(
  previous: Record<string, unknown>,
  records: readonly HostGitRecord[],
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
    if (!project || current[record.project]?.pass_id === record.pass_id) continue;
    if (record.kind !== 'pass') {
      let open = pending[record.project];
      if (open?.pass_id !== record.pass_id) {
        open = { pass_id: record.pass_id, records: [] };
        pending[record.project] = open;
      }
      const at = open.records.findIndex((r) => r.key === record.key);
      if (at >= 0) open.records[at] = record;
      else if (open.records.length < MAX_PENDING) open.records.push(record);
      continue;
    }
    const open = pending[record.project];
    const received = open?.pass_id === record.pass_id ? open.records : [];
    if (open?.pass_id === record.pass_id) delete pending[record.project];
    if (record.repo_path !== project.repo_path || record.main_branch !== project.main_branch) {
      continue;
    }
    // Stored, a time from the future would stay fresh and block every real pass after it.
    if (Date.parse(record.checked_at) > nowMs + MAX_FUTURE_MS) continue;
    const old = current[record.project];
    if (old && record.checked_at < old.checked_at) continue;
    // No answer says nothing new: what's stored ages out by itself.
    if (record.status === 'unknown') continue;
    current[record.project] = closePass(record, received);
  }
  return { projects: current, pending };
}

function storedDetail(db: Db): Detail | null {
  const row = db.sqlite
    .prepare('SELECT detail FROM sync_sources WHERE name = ?')
    .get(HOST_GIT_SOURCE) as { detail: string | null } | undefined;
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
export function hostGitFactsFor(
  db: Db,
  project: { key: string; repo_path: string | null; main_branch: string },
): HostGitFacts | null {
  if (!project.repo_path) return null;
  const facts = storedDetail(db)?.projects[project.key];
  return facts && facts.repo_path === project.repo_path && facts.main_branch === project.main_branch
    ? facts
    : null;
}

export type HostGitState = 'fresh' | 'stale' | 'none';

/** `none` until the helper has reported this repository; `stale` past `FACTS_FRESH_MS`. */
export function hostGitState(facts: HostGitFacts | null, now: string): HostGitState {
  if (!facts) return 'none';
  return isFresh(facts.checked_at, Date.parse(now)) ? 'fresh' : 'stale';
}

/** The facts when they're recent enough to rely on; null otherwise. */
export function freshHostGit(
  db: Db,
  project: { key: string; repo_path: string | null; main_branch: string },
  now: string,
): HostGitFacts | null {
  const facts = hostGitFactsFor(db, project);
  return hostGitState(facts, now) === 'fresh' ? facts : null;
}

/** Each project's latest pass, for the radar scheduler to notice a new one. */
export function hostGitPasses(db: Db): Map<string, string> {
  const detail = storedDetail(db);
  return new Map(Object.entries(detail?.projects ?? {}).map(([key, f]) => [key, f.pass_id]));
}

/** A deleted project's facts don't outlive it. */
export function forgetHostGitFacts(db: Db, key: string): void {
  const detail = storedDetail(db);
  if (!detail || (!detail.projects[key] && !detail.pending[key])) return;
  delete detail.projects[key];
  delete detail.pending[key];
  db.sqlite
    .prepare('UPDATE sync_sources SET detail = ? WHERE name = ?')
    .run(JSON.stringify(detail), HOST_GIT_SOURCE);
}
