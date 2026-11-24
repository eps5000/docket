/**
 * The recovery read model (owner decision 26; BUILD_SPEC §5.16; MCP_SPEC §3
 * "Workspaces, briefs and resources"): derived workspace state per worktree
 * path, `resume_ready` for parked runs, when a run ended, unpushed work at
 * risk and orphaned resources. Pure derivations over what agents reported and
 * the last stored read-only git check (decision 41; worktree-check.ts):
 * nothing here looks at the host (FR-117), and nothing here writes.
 *
 * Not a contract file. The runs and recovery services, `get_item` and the
 * owner's views use these helpers, so agents and the owner see the same
 * derived values (Principle II).
 */
import type {
  EndReason,
  Resource,
  ResourceLocator,
  Run,
  WaitingOn,
  Workspace,
  WorkspaceState,
} from '@docket/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { agingFrom, decisionHold, heldByOwner } from './decision-hold.js';
import { BlockIndex, ms, runView, type RunRow, type RunWindows } from './model.js';

// ---- Stored JSON ----

/** `runs.workspace` as stored: what the agent reported, plus when. */
export interface StoredWorkspace {
  host?: string | null;
  repo?: string | null;
  path?: string | null;
  branch?: string | null;
  base_ref?: string | null;
  base_sha?: string | null;
  head_sha?: string | null;
  pushed_sha?: string | null;
  dirty?: boolean | null;
  updated_at?: string | null;
}

export function parseJson<T>(text: string | null | undefined): T | null {
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export const storedWorkspace = (run: Pick<RunRow, 'workspace'>): StoredWorkspace | null =>
  parseJson<StoredWorkspace>(run.workspace);

/** One worktree path, whatever slashes the agent used (`C:\w\x\` = `C:/w/x`). */
export const pathKey = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '');

/** A short SHA matches its long form. */
export const sameSha = (a: string, b: string) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
};

// ---- Run end time ----

/** Run states that hold the claim (or, for a child run, are still going). */
const ACTIVE = new Set(['open', 'needs_input']);
const isEnded = (state: string) => !ACTIVE.has(state) && state !== 'parked';

/**
 * When each ended run ended: the event that ended it (`run.ended` or
 * `claim.released`, which name the run in their data), else the row's last
 * update. Later changes to the row (a pushed commit, the owner's *Handled*)
 * don't move it.
 */
export function endedAt(db: Db, runs: readonly RunRow[]): Map<string, string> {
  const ended = runs.filter((r) => isEnded(r.state));
  const out = new Map<string, string>();
  if (ended.length === 0) return out;
  const ids = new Set(ended.map((r) => r.id));
  const rows = db.sqlite
    .prepare(
      `SELECT json_extract(data, '$.run_id') AS run_id, min(at) AS at FROM events
       WHERE type IN ('run.ended', 'claim.released') AND json_extract(data, '$.run_id') IN (SELECT value FROM json_each(?))
       GROUP BY json_extract(data, '$.run_id')`,
    )
    .all(JSON.stringify([...ids])) as { run_id: string; at: string }[];
  for (const r of rows) out.set(r.run_id, r.at);
  for (const r of ended) if (!out.has(r.id)) out.set(r.id, r.updated_at);
  return out;
}

// ---- Resources ----

export interface ResourceRow {
  id: string;
  run_id: string;
  kind: Resource['kind'];
  label: string;
  locator: string;
  started_at: string;
  released_at: string | null;
  released_by: string | null;
  release_note: string | null;
}

export const resourceView = (r: ResourceRow): Resource => ({
  id: r.id,
  kind: r.kind,
  label: r.label,
  locator: parseJson<ResourceLocator>(r.locator) ?? {},
  started_at: r.started_at,
  released_at: r.released_at,
  release_note: r.release_note,
});

/** How to find a resource again: `port 5173`, `pid 4242`, `container web-1`. */
export function locatorText(locator: ResourceLocator): string {
  const parts: string[] = [];
  if (locator.host) parts.push(`host ${locator.host}`);
  if (locator.pid !== undefined) parts.push(`pid ${locator.pid}`);
  if (locator.port !== undefined) parts.push(`port ${locator.port}`);
  if (locator.session_id) parts.push(`session ${locator.session_id}`);
  if (locator.container) parts.push(`container ${locator.container}`);
  if (locator.path) parts.push(`path ${locator.path}`);
  return parts.join(', ');
}

/** Unreleased resources, by run. */
export function unreleasedByRun(db: Db): Map<string, ResourceRow[]> {
  const out = new Map<string, ResourceRow[]>();
  for (const r of db.sqlite
    .prepare('SELECT * FROM run_resources WHERE released_at IS NULL ORDER BY started_at, id')
    .all() as ResourceRow[]) {
    out.set(r.run_id, [...(out.get(r.run_id) ?? []), r]);
  }
  return out;
}

// ---- Unpushed commits ----

interface CommitRow {
  sha: string;
  pushed: number;
  run_id: string | null;
  reported_at: string;
}

/**
 * How many reported commits are not on the remote ("n behind"), for a
 * worktree whose reported head is `head` and pushed commit is `pushed`.
 * Null when it can't be told (no head reported). At least 1 when the head
 * is ahead even if the commits weren't reported one by one.
 */
export function unpushedCount(
  db: Db,
  runIds: readonly string[],
  head: string | null | undefined,
  pushed: string | null | undefined,
): number | null {
  if (!head) return null;
  if (pushed && sameSha(head, pushed)) return 0;
  const commits = db.sqlite
    .prepare(
      `SELECT sha, pushed, run_id, reported_at FROM commits WHERE run_id IN (SELECT value FROM json_each(?))
       ORDER BY reported_at, id`,
    )
    .all(JSON.stringify(runIds)) as CommitRow[];
  const at = pushed ? commits.findIndex((c) => sameSha(c.sha, pushed)) : -1;
  const after = commits.slice(at + 1).filter((c) => !c.pushed).length;
  return Math.max(1, after);
}

// ---- Workspace state (MCP_SPEC §3; BUILD_SPEC §5.16) ----

export interface WorkspaceFacts {
  /** The path as the latest run reported it. */
  path: string;
  state: WorkspaceState;
  /** Field by field, the latest value any run in this worktree reported. */
  merged: StoredWorkspace;
  /** The latest run in this worktree. */
  latest: RunRow;
  runs: RunRow[];
  unreleased: ResourceRow[];
  unpushed_commits: number | null;
  /** The owner marked its unpushed work handled, and nothing newer was reported since. */
  handled: boolean;
  /** The owner chose *Keep for later*, and nothing newer was reported since (B56). */
  kept: boolean;
}

const FIELDS = [
  'host',
  'repo',
  'path',
  'branch',
  'base_ref',
  'base_sha',
  'head_sha',
  'pushed_sha',
  'dirty',
] as const;

/** Oldest first, by when each run last reported its workspace. */
const byReport = (a: RunRow, b: RunRow) => {
  const wa = storedWorkspace(a)?.updated_at ?? a.created_at;
  const wb = storedWorkspace(b)?.updated_at ?? b.created_at;
  return wa < wb ? -1 : wa > wb ? 1 : a.created_at < b.created_at ? -1 : 1;
};

/**
 * Derive one worktree's state from its runs (all with this path):
 * - `in_use`: an open run;
 * - `parked`: a parked run (and no open one);
 * - `at_risk`: no open run, but unpushed commits, uncommitted changes or
 *   unreleased resources;
 * - `safe_to_prune`: every run ended, the head pushed, clean, and every
 *   resource released (or the owner marked its unpushed work handled);
 * - `unknown`: not enough reported to tell. Never safe to prune.
 */
export function workspaceFacts(
  db: Db,
  runs: readonly RunRow[],
  unreleased: Map<string, ResourceRow[]>,
): WorkspaceFacts {
  const ordered = [...runs].sort(byReport);
  const merged: StoredWorkspace = {};
  for (const run of ordered) {
    const ws = storedWorkspace(run) ?? {};
    for (const f of FIELDS) {
      const v = ws[f];
      if (v !== undefined && v !== null) (merged as Record<string, unknown>)[f] = v;
    }
    if (ws.updated_at) merged.updated_at = ws.updated_at;
  }
  const latest = ordered[ordered.length - 1]!;
  const left = ordered.flatMap((r) => unreleased.get(r.id) ?? []);
  const head = merged.head_sha ?? null;
  let pushed = merged.pushed_sha ?? null;
  if (head && (!pushed || !sameSha(head, pushed))) {
    // The head was reported pushed later, by another run or with no run (a later push catches up).
    const items = [...new Set(ordered.map((r) => r.item_id))];
    const pushedShas = db.sqlite
      .prepare(
        'SELECT sha FROM commits WHERE pushed = 1 AND item_id IN (SELECT value FROM json_each(?))',
      )
      .all(JSON.stringify(items)) as { sha: string }[];
    if (pushedShas.some((c) => sameSha(c.sha, head))) pushed = merged.pushed_sha = head;
  }
  const unpushed_commits = unpushedCount(
    db,
    ordered.map((r) => r.id),
    head,
    pushed,
  );
  // Decision 41: *Keep for later* leaves the worktree at risk, so nothing prunes it.
  const handledAt = ordered
    .filter((r) => r.unpushed_outcome !== 'keep')
    .map((r) => r.unpushed_handled_at)
    .filter((t): t is string => !!t)
    .sort()
    .pop();
  const handled = !!handledAt && handledAt >= (merged.updated_at ?? '');
  const keptAt = ordered
    .filter((r) => r.unpushed_outcome === 'keep')
    .map((r) => r.unpushed_handled_at)
    .filter((t): t is string => !!t)
    .sort()
    .pop();
  const kept = !!keptAt && keptAt >= (merged.updated_at ?? '');

  let state: WorkspaceState;
  if (ordered.some((r) => ACTIVE.has(r.state))) state = 'in_use';
  else if (ordered.some((r) => r.state === 'parked')) state = 'parked';
  else {
    const unpushed = !!head && (!pushed || !sameSha(head, pushed));
    const risky = !handled && (merged.dirty === true || unpushed);
    if (risky || left.length > 0 || awaitsRestart(db, ordered)) state = 'at_risk';
    else if (handled || (merged.dirty === false && !!head && !!pushed)) state = 'safe_to_prune';
    else state = 'unknown';
  }
  return {
    path: storedWorkspace(latest)?.path ?? merged.path ?? '',
    state,
    merged,
    latest,
    runs: ordered,
    unreleased: left,
    unpushed_commits,
    handled,
    kept,
  };
}

/** The coordinator named on a run (`orchestrator.name`), if it was dispatched by one. */
export function coordinatorOf(run: RunRow): string | null {
  return parseJson<{ name?: string }>(run.orchestrator)?.name ?? null;
}

/** End reasons after which an interrupted run's work waits to be restarted. */
const AWAITS_RESTART: readonly EndReason[] = ['lease_expired', 'service_restart', 'owner_released'];

/**
 * In-flight work that hasn't been picked up again (coordinator ruling on B10
 * Q1): a run here ended unexpectedly (lease expired, service restart, owner
 * release), its item is still open, and no newer lead run has claimed it.
 * Its worktree is at risk even when clean and pushed, so it is never pruned
 * before the work restarts. Once a newer run claims the item, or the item is
 * done or canceled, the normal rules apply.
 */
export function awaitsRestart(db: Db, runs: readonly RunRow[]): boolean {
  return runs.some((run) => {
    if (run.state !== 'interrupted' || !run.end_reason) return false;
    if (!AWAITS_RESTART.includes(run.end_reason)) return false;
    const item = db.sqlite.prepare('SELECT status FROM items WHERE id = ?').get(run.item_id) as
      { status: string } | undefined;
    if (!item || item.status === 'done' || item.status === 'canceled') return false;
    const newer = db.sqlite
      .prepare(
        'SELECT 1 FROM runs WHERE item_id = ? AND is_lead = 1 AND id <> ? AND (created_at > ? OR (created_at = ? AND id > ?)) LIMIT 1',
      )
      .get(run.item_id, run.id, run.created_at, run.created_at, run.id);
    return !newer;
  });
}

/** Every run that reported a workspace, grouped by worktree path (runs without a path stand alone). */
export function workspaceGroups(db: Db): Map<string, RunRow[]> {
  const out = new Map<string, RunRow[]>();
  for (const run of db.sqlite
    .prepare('SELECT * FROM runs WHERE workspace IS NOT NULL ORDER BY created_at, id')
    .all() as RunRow[]) {
    const ws = storedWorkspace(run);
    if (!ws) continue;
    const key = ws.path ? pathKey(ws.path) : `run:${run.id}`;
    out.set(key, [...(out.get(key) ?? []), run]);
  }
  return out;
}

export const groupKey = (run: RunRow): string | null => {
  const ws = storedWorkspace(run);
  if (!ws) return null;
  return ws.path ? pathKey(ws.path) : `run:${run.id}`;
};

/** The workspace as agents see it (MCP_SPEC §4 Workspace), with its derived state. */
export function workspaceView(ws: StoredWorkspace, state: WorkspaceState, at: string): Workspace {
  return {
    host: ws.host ?? null,
    repo: ws.repo ?? null,
    path: ws.path ?? null,
    branch: ws.branch ?? null,
    base_ref: ws.base_ref ?? null,
    base_sha: ws.base_sha ?? null,
    head_sha: ws.head_sha ?? null,
    pushed_sha: ws.pushed_sha ?? null,
    dirty: ws.dirty ?? null,
    state,
    updated_at: ws.updated_at ?? at,
  };
}

// ---- Parking (BUILD_SPEC §5.16) ----

export interface ParkInfo {
  resume_ready: boolean;
  /** When it became ready to resume; null while it isn't. */
  ready_since: string | null;
}

/** The `blocks` link from a waited-on item to the run's item, else the project default's. */
export const waitLink = (index: BlockIndex, itemId: string, blockerId: string) =>
  index.blockers.get(itemId)?.find((l) => l.from_id === blockerId) ?? {
    id: '',
    from_id: blockerId,
    to_id: itemId,
    type: 'blocks' as const,
    satisfied_when: null,
  };

/**
 * `resume_ready`: every `waiting_on.items` entry cleared, or `until` passed.
 * An item clears by the data model's "blocker cleared?" rule: through the
 * `blocks` link from it to the parked run's item when there is one (its own
 * `satisfied_when`), else the parked item's project default; a canceled item
 * never clears. A run parked only on the coordinator or a person stays false
 * until it is resumed. Decision 48: a run held by an active owner decision
 * stays false until the owner lifts it, and its unattended clock starts then.
 */
export function parkInfo(
  db: Db,
  run: Pick<RunRow, 'state' | 'item_id' | 'waiting_on' | 'parked_at' | 'updated_at'> & {
    parked_reason?: string | null;
  },
  now: string,
  index: BlockIndex = new BlockIndex(db),
): ParkInfo {
  if (run.state !== 'parked') return { resume_ready: false, ready_since: null };
  const hold = decisionHold(db, run);
  if (heldByOwner(hold)) return { resume_ready: false, ready_since: null };
  const waiting = parseJson<WaitingOn>(run.waiting_on) ?? {};
  const parkedAt = run.parked_at ?? run.updated_at;
  const times: string[] = [];
  const items = waiting.items ?? [];
  if (items.length > 0) {
    let all = true;
    let last = parkedAt;
    for (const id of items) {
      const link = waitLink(index, run.item_id, id);
      if (!index.cleared(link)) {
        all = false;
        break;
      }
      const at = clearedAt(db, id, index.rule(link));
      if (at && at > last) last = at;
    }
    if (all) times.push(last);
  }
  if (waiting.until && ms(waiting.until) <= ms(now)) {
    times.push(waiting.until > parkedAt ? waiting.until : parkedAt);
  }
  times.sort();
  return {
    resume_ready: times.length > 0,
    ready_since: times[0] ? agingFrom(times[0], hold) : null,
  };
}

/** Decision 42: the `waiting_on.items` that cleared after `since`. */
export function clearedSince(
  db: Db,
  run: Pick<RunRow, 'item_id'>,
  waiting: WaitingOn,
  since: string,
  index: BlockIndex,
): string[] {
  return (waiting.items ?? []).filter((id) => {
    const link = waitLink(index, run.item_id, id);
    if (!index.cleared(link)) return false;
    const at = clearedAt(db, id, index.rule(link));
    return !!at && ms(at) > ms(since);
  });
}

/** When a cleared item cleared: closed, then merged or verified when the rule asks for it. */
export function clearedAt(db: Db, id: string, rule: 'done' | 'merged' | 'verified'): string | null {
  const row = db.sqlite.prepare('SELECT closed_at, updated_at FROM items WHERE id = ?').get(id) as
    { closed_at: string | null; updated_at: string } | undefined;
  if (!row) return null;
  let at = row.closed_at ?? row.updated_at;
  if (rule === 'merged') {
    const pr = db.sqlite
      .prepare(
        "SELECT max(updated_at) AS at FROM artifacts WHERE item_id = ? AND kind = 'pr' AND lower(state) = 'merged'",
      )
      .get(id) as { at: string | null };
    if (pr.at && pr.at > at) at = pr.at;
  }
  if (rule === 'verified') {
    const d = db.sqlite
      .prepare(
        'SELECT max(rd.decided_at) AS at FROM review_decisions rd JOIN hr_items h ON h.id = rd.hr_item_id WHERE h.item_id = ?',
      )
      .get(id) as { at: string | null };
    if (d.at && d.at > at) at = d.at;
  }
  return at;
}

// ---- Unpushed work at risk (BUILD_SPEC §5.16; FR-114) ----

export interface UnpushedRisk {
  run: RunRow;
  ended_at: string;
  workspace: StoredWorkspace;
  unpushed_commits: number | null;
  dirty: boolean;
}

/**
 * Ended runs (any end, `finish_run` included: coordinator ruling on B10 Q2,
 * after MCP_SPEC §10 test 20) that left work off the remote: `dirty`, or
 * `head_sha` ≠ `pushed_sha`. Cleared when the owner marks it *Handled*, or
 * when a pushed commit is reported for the item after the run ended (a later
 * run pushed, or the work was pushed and reported).
 */
export function unpushedRisks(db: Db, runs: readonly RunRow[]): UnpushedRisk[] {
  const candidates = runs.filter(
    (r) => isEnded(r.state) && !r.unpushed_handled_at && r.workspace !== null,
  );
  if (candidates.length === 0) return [];
  const ends = endedAt(db, candidates);
  const out: UnpushedRisk[] = [];
  for (const run of candidates) {
    const ws = storedWorkspace(run) ?? {};
    const head = ws.head_sha ?? null;
    const unpushed = !!head && (!ws.pushed_sha || !sameSha(head, ws.pushed_sha));
    if (!unpushed && ws.dirty !== true) continue;
    const ended = ends.get(run.id)!;
    const later = db.sqlite
      // `updated_at` moves when a known commit is marked pushed later.
      .prepare('SELECT 1 FROM commits WHERE item_id = ? AND pushed = 1 AND updated_at > ? LIMIT 1')
      .get(run.item_id, ended);
    if (later) continue;
    out.push({
      run,
      ended_at: ended,
      workspace: ws,
      unpushed_commits: unpushed ? unpushedCount(db, [run.id], head, ws.pushed_sha) : 0,
      dirty: ws.dirty === true,
    });
  }
  return out;
}

/** How two spellings of one worktree path compare. */
export const treeKey = (path: string) => pathKey(path).toLowerCase();

/** The last read-only git check of a run's worktree (decision 41; worktree-check.ts). */
export interface WorktreeCheck {
  checked_at: string;
  head_sha: string;
  /** HEAD is in the main branch, local or origin's. */
  on_main: boolean;
  /** HEAD is on a remote ref; null when git couldn't tell. */
  on_remote: boolean | null;
  /** Commits on HEAD that are on no remote ref and not in main; null when git couldn't tell. */
  unpushed_commits: number | null;
  /** Files `git status` lists; null when the worktree's folder can't be read. */
  uncommitted_files: number | null;
}

/** A check this old no longer counts: the worktree may have changed since. */
const CHECK_MAX_AGE_MS = 24 * 3_600_000;

/** What is really left in a worktree: commits and uncommitted changes, separately. */
export interface UnpushedTruth {
  commits: number;
  /** A file count from git; null when only the agent's "dirty" is known. */
  files: number | null;
  dirty: boolean;
  /** Git confirmed HEAD is in the main branch. */
  on_main: boolean;
  /** Some of this is the agent's last report, because git couldn't confirm it. */
  unverified: boolean;
}

/**
 * The risk as git last saw it, else as the agent last reported it (decision
 * 41). Null when git shows nothing is left: every commit is on a remote or in
 * main, and the worktree is clean.
 */
export function unpushedTruth(risk: UnpushedRisk, now: string): UnpushedTruth | null {
  const stored = parseJson<WorktreeCheck>(risk.run.worktree_check);
  const check = stored && ms(now) - ms(stored.checked_at) <= CHECK_MAX_AGE_MS ? stored : null;
  const knownCommits = check?.unpushed_commits ?? null;
  const files = check?.uncommitted_files ?? null;
  const commits = knownCommits ?? risk.unpushed_commits ?? 0;
  const dirty = files !== null ? files > 0 : risk.dirty;
  if (commits === 0 && !dirty) return null;
  return {
    commits,
    files,
    dirty,
    on_main: check?.on_main === true,
    unverified: (commits > 0 && knownCommits === null) || (dirty && files === null),
  };
}

// ---- Orphaned resources (BUILD_SPEC §5.16; FR-113) ----

export interface Orphan {
  resource: ResourceRow;
  run: RunRow;
  ended_at: string;
}

/** Resources still unreleased `orphanAfterMs` after their run ended. */
export function orphans(db: Db, now: string, orphanAfterMs: number): Orphan[] {
  const rows = db.sqlite
    .prepare(
      `SELECT rr.id AS rid, r.* FROM run_resources rr JOIN runs r ON r.id = rr.run_id
       WHERE rr.released_at IS NULL AND r.state IN ('finished', 'failed', 'interrupted')
       ORDER BY rr.started_at, rr.id`,
    )
    .all() as (RunRow & { rid: string })[];
  if (rows.length === 0) return [];
  const runs = new Map(rows.map((r) => [r.id, r as RunRow]));
  const ends = endedAt(db, [...runs.values()]);
  const resources = new Map(
    (
      db.sqlite
        .prepare(`SELECT * FROM run_resources WHERE id IN (SELECT value FROM json_each(?))`)
        .all(JSON.stringify(rows.map((r) => r.rid))) as ResourceRow[]
    ).map((r) => [r.id, r]),
  );
  const out: Orphan[] = [];
  for (const row of rows) {
    const ended = ends.get(row.id)!;
    if (ms(now) - ms(ended) < orphanAfterMs) continue;
    out.push({ resource: resources.get(row.rid)!, run: runs.get(row.id)!, ended_at: ended });
  }
  return out;
}

// ---- The run as agents see it, with its recovery facts ----

export type RecoveryConfig = Pick<
  Config,
  | 'liveWindowMs'
  | 'staleAfterMs'
  | 'parkMaxMs'
  | 'resumeUnattendedMs'
  | 'orphanAfterMs'
  | 'agentProblemGraceMs'
  | 'restartGraceMs'
>;

/**
 * Builds `Run` views with their workspace state and `resume_ready`, reading
 * the worktree groups and blocked state once for many runs.
 */
export class RecoveryReader {
  private groups: Map<string, RunRow[]> | null = null;
  private unreleased: Map<string, ResourceRow[]> | null = null;
  private index: BlockIndex | null = null;
  private readonly facts = new Map<string, WorkspaceFacts>();

  constructor(
    readonly db: Db,
    readonly windows: RunWindows,
    readonly now: string,
  ) {}

  blockIndex(): BlockIndex {
    return (this.index ??= new BlockIndex(this.db));
  }

  allGroups(): Map<string, RunRow[]> {
    return (this.groups ??= workspaceGroups(this.db));
  }

  unreleasedByRun(): Map<string, ResourceRow[]> {
    return (this.unreleased ??= unreleasedByRun(this.db));
  }

  /** The derived facts for one worktree key. */
  factsOf(key: string): WorkspaceFacts | null {
    const cached = this.facts.get(key);
    if (cached) return cached;
    const runs = this.allGroups().get(key);
    if (!runs || runs.length === 0) return null;
    const f = workspaceFacts(this.db, runs, this.unreleasedByRun());
    this.facts.set(key, f);
    return f;
  }

  /** The workspace of one run, with the state of its worktree. */
  workspaceOf(run: RunRow): Workspace | null {
    const ws = storedWorkspace(run);
    if (!ws) return null;
    const key = groupKey(run)!;
    const state = this.factsOf(key)?.state ?? 'unknown';
    return workspaceView(ws, state, run.updated_at);
  }

  parkOf(run: RunRow): ParkInfo {
    return parkInfo(this.db, run, this.now, this.blockIndex());
  }

  runView(run: RunRow, opts: { external?: boolean } = {}): Run {
    return runView(this.db, run, this.windows, this.now, {
      ...opts,
      workspace: this.workspaceOf(run),
      resumeReady: this.parkOf(run).resume_ready,
    });
  }
}
