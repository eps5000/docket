/**
 * The read model US1's services share (BUILD_SPEC §5.1–§5.4, §13): actor
 * names, displayed run state, blocked state, item summaries and the run
 * view. Pure derivations over the database; nothing here writes.
 *
 * Not a contract file: services use these helpers so that every adapter
 * shows the same derived values (Principle II). Later slices may reuse
 * them (US4's `links.blockState`, US2's views).
 */
import {
  OPEN_STATUSES,
  ToolError,
  type Check,
  type WorkStep,
  type EndReason,
  type ItemSummary,
  type Run,
  type RunState,
  type SatisfiedWhen,
  type SignalKind,
  type Status,
  type StoredRunState,
  type WaitingOn,
  type Workspace,
} from '@docket/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { BlockState } from './contracts.js';
import type { Actor } from './write.js';
import { needsShapingOf } from './shaping.js';

// ---- Actors ----

/** How an actor is written in stored attributions and events: `owner`, `system`, `claude · orca-w3`. */
export function actorName(actor: Pick<Actor, 'kind' | 'client' | 'label'>): string {
  // Decision 39: an automatic outcome is recorded as Docket, not as a nameless system.
  if (actor.kind === 'system' && actor.label === 'Docket') return 'docket';
  if (actor.kind !== 'agent') return actor.kind;
  const client = actor.client ?? 'agent';
  return actor.label ? `${client} · ${actor.label}` : client;
}

/**
 * The actor's name, with the label of the run it names when the call gave
 * none (`agent_label` is passed only on a few tools; the run knows it).
 */
export function callerName(db: Db, actor: Actor): string {
  if (actor.kind === 'agent' && !actor.label && actor.run_id) {
    const run = db.sqlite.prepare('SELECT label FROM runs WHERE id = ?').get(actor.run_id) as
      { label: string | null } | undefined;
    if (run?.label) return actorName({ ...actor, label: run.label });
  }
  return actorName(actor);
}

/** Stored `added_by` (`owner` or an agent actor) as the shared enum. */
export const addedBy = (stored: string): 'owner' | 'agent' =>
  stored === 'owner' ? 'owner' : 'agent';

// ---- Time ----

export const ms = (iso: string) => new Date(iso).getTime();
export const isoPlus = (now: string, plus: number) => new Date(ms(now) + plus).toISOString();

/** `11:13 UTC` on the same day as `now`, else `11-06 11:13 UTC` (error messages). */
export function utcTime(iso: string, now: string): string {
  const d = new Date(iso);
  const hm = d.toISOString().slice(11, 16);
  return iso.slice(0, 10) === now.slice(0, 10) ? `${hm} UTC` : `${iso.slice(5, 10)} ${hm} UTC`;
}

// ---- Runs ----

/** Stored states of a run that hasn't ended. A parked run keeps its claim (§5.16). */
export const OPEN_STORED = ['open', 'needs_input', 'parked'] as const;
export const isRunOpen = (state: string) => (OPEN_STORED as readonly string[]).includes(state);
export const OPEN_STORED_SQL = `('open', 'needs_input', 'parked')`;

export interface RunWindows {
  liveWindowMs: number;
  staleAfterMs: number;
}

/**
 * Displayed run state (BUILD_SPEC §5.4). Live needs a *session* signal
 * within the live window; any signal within STALE_AFTER is *reported*;
 * older is *stale*. "Within" is inclusive. Parked is never stale.
 */
export function displayRunState(
  run: {
    state: StoredRunState | string;
    last_signal_at: string;
    last_signal_kind: SignalKind | string;
  },
  windows: RunWindows,
  now: Date | string,
): RunState {
  switch (run.state) {
    case 'finished':
    case 'failed':
    case 'interrupted':
    case 'parked':
    case 'needs_input':
      return run.state;
  }
  const age = Math.max(
    0,
    (typeof now === 'string' ? ms(now) : now.getTime()) - ms(run.last_signal_at),
  );
  if (run.last_signal_kind === 'session' && age <= windows.liveWindowMs) return 'live';
  if (age <= windows.staleAfterMs) return 'reported';
  return 'stale';
}

export interface RunRow {
  id: string;
  item_id: string;
  parent_run_id: string | null;
  client: string;
  label: string | null;
  session_id: string | null;
  is_lead: number;
  state: StoredRunState;
  last_signal_at: string;
  last_signal_kind: SignalKind;
  lease_expires_at: string | null;
  /** Decision 41: a child run's deadline to signal after a restart; null otherwise. */
  restart_deadline_at: string | null;
  summary: string | null;
  error: string | null;
  current_step_id: string | null;
  end_reason: EndReason | null;
  parked_reason: string | null;
  waiting_on: string | null;
  parked_at: string | null;
  workspace: string | null;
  orchestrator: string | null;
  brief_document_version_id: string | null;
  external: string | null;
  unpushed_handled_at: string | null;
  /** Decision 41: what the owner chose for the work left behind. */
  unpushed_outcome: 'keep' | 'discard' | null;
  /** Decision 41: the last read-only git check of this run's worktree (worktree-check.ts). */
  worktree_check: string | null;
  /** Decision 42: the stable owner of the story across worker handoffs. */
  producer: string | null;
  /** Decision 42: on an ended lead, the story waits for this producer's next worker until then. */
  producer_hold_until: string | null;
  /** Decision 42: `{by, client, at}`, the coordinator who last set this run's status. */
  status_update: string | null;
  /** Decision 42: `{since, flag}`, activity newer than the run's last word (run-activity.ts). */
  park_activity: string | null;
  /** Decision 44: `{by, client, at, until, ended_at?}`, a coordinator's time-limited park. */
  coordinator_park: string | null;
  /** Decision 45: `{flags, resume_key?}`, the wait flags raised and the last resume told (wait.ts). */
  wait_flags: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export function getRun(db: Db, id: string): RunRow | undefined {
  return db.sqlite.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
}

/** The item's active lead run (open, needs input or parked), if any. */
export function activeLead(db: Db, itemId: string): RunRow | undefined {
  return db.sqlite
    .prepare(`SELECT * FROM runs WHERE item_id = ? AND is_lead = 1 AND state IN ${OPEN_STORED_SQL}`)
    .get(itemId) as RunRow | undefined;
}

/**
 * A run whose time has run out (and isn't parked), swept or not: a lead's lease,
 * or a child's deadline to signal after a restart (decision 41). A child has
 * no lease, so outside a restart this is never true for one.
 */
export function leaseExpired(run: RunRow, now: string): boolean {
  if (run.state === 'parked') return false;
  const until = run.is_lead === 1 ? run.lease_expires_at : run.restart_deadline_at;
  return !!until && ms(until) <= ms(now);
}

const parseJson = <T>(text: string | null): T | null => {
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

/** The coordinators the owner registered for a project. */
export function projectCoordinators(db: Db, project: string): string[] {
  const row = db.sqlite.prepare('SELECT coordinators FROM projects WHERE key = ?').get(project) as
    { coordinators: string | null } | undefined;
  const names = parseJson<unknown>(row?.coordinators ?? null);
  return Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : [];
}

/** Decision 44: the coordinator's park as it is shown (the calling client stays in the event). */
export function coordinatorParkOf(
  row: Pick<RunRow, 'coordinator_park'>,
): NonNullable<Run['coordinator_park']> | null {
  const park = parseJson<NonNullable<Run['coordinator_park']>>(row.coordinator_park);
  if (!park) return null;
  return {
    by: park.by,
    at: park.at,
    until: park.until,
    ...(park.ended_at ? { ended_at: park.ended_at } : {}),
  };
}

/**
 * A run as agents see it (MCP_SPEC §4 Run). The workspace (with its derived
 * state) and `resume_ready` come from the recovery read model
 * (recovery-model.ts, `RecoveryReader.runView`), which reads the worktree's
 * other runs; without them the workspace is not shown.
 */
export function runView(
  db: Db,
  row: RunRow,
  windows: RunWindows,
  now: string,
  opts: { external?: boolean; workspace?: Workspace | null; resumeReady?: boolean } = {},
): Run {
  const resources = (
    db.sqlite
      .prepare('SELECT * FROM run_resources WHERE run_id = ? ORDER BY started_at, id')
      .all(row.id) as {
      id: string;
      kind: Run['resources'][number]['kind'];
      label: string;
      locator: string;
      started_at: string;
      released_at: string | null;
      release_note: string | null;
    }[]
  ).map((r) => ({
    id: r.id,
    kind: r.kind,
    label: r.label,
    locator: parseJson<Run['resources'][number]['locator']>(r.locator) ?? {},
    started_at: r.started_at,
    released_at: r.released_at,
    release_note: r.release_note,
  }));
  const orch = parseJson<{
    name?: string;
    dispatch_id?: string;
    task_id?: string;
    run_id?: string;
  }>(row.orchestrator);
  const view: Run = {
    run_id: row.id,
    parent_run_id: row.parent_run_id,
    client: row.client,
    label: row.label,
    is_lead: row.is_lead === 1,
    run_state: displayRunState(row, windows, now),
    started_at: row.created_at,
    last_signal_at: row.last_signal_at,
    lease_expires_at: row.lease_expires_at,
    current_step_id: row.current_step_id,
    summary: row.summary,
    error: row.error,
    end_reason: row.end_reason,
    parked:
      row.state === 'parked'
        ? {
            reason: row.parked_reason ?? '',
            waiting_on: parseJson<WaitingOn>(row.waiting_on) ?? {},
            since: row.parked_at ?? row.updated_at,
            resume_ready: opts.resumeReady ?? false,
          }
        : null,
    workspace: opts.workspace ?? null,
    orchestrator: orch?.name
      ? {
          name: orch.name,
          dispatch_id: orch.dispatch_id ?? null,
          task_id: orch.task_id ?? null,
          run_id: orch.run_id ?? null,
        }
      : null,
    brief_document_version_id: row.brief_document_version_id,
    resources,
  };
  if (opts.external) view.external = parseJson<Record<string, unknown>>(row.external) ?? {};
  // Decision 42: present only when there is something to say, so other results stay as they were.
  if (row.producer) view.producer = row.producer;
  if (isRunOpen(row.state)) {
    const update = parseJson<NonNullable<Run['status_update']>>(row.status_update);
    if (update) view.status_update = update;
    const park = coordinatorParkOf(row);
    if (park) view.coordinator_park = park;
    const flag = parseJson<{ flag: Run['activity'] | null }>(row.park_activity)?.flag;
    if (flag) view.activity = flag;
  }
  return view;
}

export const windowsOf = (config: Pick<Config, 'liveWindowMs' | 'staleAfterMs'>): RunWindows => ({
  liveWindowMs: config.liveWindowMs,
  staleAfterMs: config.staleAfterMs,
});

// ---- Blocking (BUILD_SPEC §5.2) ----

interface LinkRow {
  id: string;
  from_id: string;
  to_id: string;
  type: 'blocks' | 'relates';
  satisfied_when: SatisfiedWhen | null;
}

interface ItemCore {
  id: string;
  project_key: string;
  status: Status;
}

/**
 * Everything blocked state depends on, read once: `blocks` links, item
 * statuses, project defaults, merged PRs and human review states.
 */
export class BlockIndex {
  private readonly items = new Map<string, ItemCore>();
  private readonly defaults = new Map<string, SatisfiedWhen>();
  private readonly merged = new Set<string>();
  private readonly review = new Map<string, { total: number; approved: number }>();
  /** blocked item → its `blocks` links. */
  readonly blockers = new Map<string, LinkRow[]>();
  /** blocker → its `blocks` links. */
  readonly dependents = new Map<string, LinkRow[]>();

  constructor(db: Db) {
    const sql = db.sqlite;
    for (const row of sql
      .prepare('SELECT id, project_key, status FROM items')
      .all() as ItemCore[]) {
      this.items.set(row.id, row);
    }
    for (const p of sql.prepare('SELECT key, default_satisfied_when FROM projects').all() as {
      key: string;
      default_satisfied_when: SatisfiedWhen;
    }[]) {
      this.defaults.set(p.key, p.default_satisfied_when);
    }
    for (const a of sql
      .prepare(
        "SELECT DISTINCT item_id FROM artifacts WHERE kind = 'pr' AND lower(state) = 'merged'",
      )
      .all() as { item_id: string }[]) {
      this.merged.add(a.item_id);
    }
    for (const r of sql
      .prepare(
        "SELECT item_id, count(*) AS total, sum(state = 'approved') AS approved FROM hr_items GROUP BY item_id",
      )
      .all() as { item_id: string; total: number; approved: number }[]) {
      this.review.set(r.item_id, { total: r.total, approved: r.approved });
    }
    for (const link of sql
      .prepare(
        "SELECT id, from_id, to_id, type, satisfied_when FROM links WHERE type = 'blocks' ORDER BY from_id, id",
      )
      .all() as LinkRow[]) {
      this.blockers.set(link.to_id, [...(this.blockers.get(link.to_id) ?? []), link]);
      this.dependents.set(link.from_id, [...(this.dependents.get(link.from_id) ?? []), link]);
    }
  }

  status(id: string): Status | undefined {
    return this.items.get(id)?.status;
  }

  project(id: string): string | undefined {
    return this.items.get(id)?.project_key;
  }

  /** The effective rule: the link's own, else the blocked item's project default, else done. */
  rule(link: LinkRow): SatisfiedWhen {
    const project = this.items.get(link.to_id)?.project_key;
    return link.satisfied_when ?? (project ? this.defaults.get(project) : undefined) ?? 'done';
  }

  /** What an unresolved blocker waits for, or null when it is cleared. */
  waitingFor(link: LinkRow): 'done' | 'merge' | 'verification' | null {
    const status = this.items.get(link.from_id)?.status;
    // A canceled blocker never clears (§5.2): it still waits to be done.
    if (status !== 'done') return 'done';
    const rule = this.rule(link);
    if (rule === 'merged' && !this.merged.has(link.from_id)) return 'merge';
    if (rule === 'verified') {
      const r = this.review.get(link.from_id);
      if (!r || r.total === 0 || r.approved < r.total) return 'verification';
    }
    return null;
  }

  cleared(link: LinkRow): boolean {
    return this.waitingFor(link) === null;
  }

  /** Blocked: open, with at least one unresolved `blocks` predecessor. */
  state(id: string): BlockState {
    const status = this.items.get(id)?.status;
    const open = status !== undefined && (OPEN_STATUSES as readonly string[]).includes(status);
    const waiting_for: BlockState['waiting_for'] = {};
    const blocked_by: string[] = [];
    if (open) {
      for (const link of this.blockers.get(id) ?? []) {
        const w = this.waitingFor(link);
        if (w) {
          blocked_by.push(link.from_id);
          waiting_for[link.from_id] = w;
        }
      }
    }
    return { blocked: blocked_by.length > 0, blocked_by, waiting_for };
  }

  /** Open items this one is an unresolved blocker of: what finishing it would unblock. */
  unblocks(id: string): string[] {
    return (this.dependents.get(id) ?? [])
      .filter((l) => {
        const s = this.items.get(l.to_id)?.status;
        return (
          s !== undefined && (OPEN_STATUSES as readonly string[]).includes(s) && !this.cleared(l)
        );
      })
      .map((l) => l.to_id);
  }
}

// ---- Date risk (BUILD_SPEC §5.9) ----

/**
 * Date risk: the item's unresolved blockers whose planned end falls on or
 * after the item's planned start. Open items only (blocked_by is empty
 * otherwise); epics are never flagged. Problems and the Timeline both call
 * this, and `dependency_subgraph` applies the same comparison after its slips.
 */
export function dateRiskBlockers(
  index: BlockIndex,
  item: { id: string; type: string; planned_start: string | null },
  plannedEnd: (id: string) => string | null,
): string[] {
  const start = item.planned_start;
  if (!start || item.type === 'Epic') return [];
  return index.state(item.id).blocked_by.filter((b) => {
    const end = index.status(b) !== undefined ? plannedEnd(b) : null;
    return end !== null && endsOnOrAfter(end, start);
  });
}

/** A blocker planned to end on `end` puts a start on `start` at risk (dates `YYYY-MM-DD`). */
export const endsOnOrAfter = (end: string, start: string): boolean => end >= start;

// ---- Resumable (BUILD_SPEC §13: `status:progress -has:lead`) ----

/**
 * Resumable: In progress with no active lead. An Epic counts only if it has
 * ever had a lead run (it was claimed, typically for an epic-level packet,
 * then sent back or interrupted): epic status is set by hand, so an epic
 * stays In progress while its children are worked, and agents told to take
 * resumable work first must not claim it. Stories, Tasks and Bugs follow the
 * literal rule. (Gate review of B7.) A story between workers under one
 * producer isn't resumable: it is held for that producer's next worker
 * (decision 42).
 *
 * The SQL condition for items aliased `alias`; pair it with "no active lead".
 */
export const RESUMABLE_SQL = (alias: string) =>
  `(${alias}.status = 'progress' AND NOT EXISTS (SELECT 1 FROM runs ra WHERE ra.item_id = ${alias}.id AND ra.is_lead = 1 AND ra.state IN ${OPEN_STORED_SQL})` +
  ` AND NOT EXISTS (SELECT 1 FROM runs rh WHERE rh.item_id = ${alias}.id AND rh.producer_hold_until IS NOT NULL)` +
  ` AND (${alias}.type <> 'Epic' OR EXISTS (SELECT 1 FROM runs rl WHERE rl.item_id = ${alias}.id AND rl.is_lead = 1)))`;

/** Whether one item is resumable (the same rule as `RESUMABLE_SQL`). */
export function isResumable(db: Db, itemId: string): boolean {
  return (
    db.sqlite
      .prepare(`SELECT 1 FROM items i WHERE i.id = ? AND ${RESUMABLE_SQL('i')}`)
      .get(itemId) !== undefined
  );
}

// ---- Item summaries (MCP_SPEC §4 ItemSummary) ----

export interface ItemRow {
  id: string;
  project_key: string;
  type: ItemSummary['type'];
  title: string;
  description_md: string;
  outcome_md: string;
  status: Status;
  priority: 1 | 2 | 3;
  epic_id: string | null;
  planned_start: string | null;
  planned_end: string | null;
  dates_set_by: string | null;
  dates_set_at: string | null;
  effort: number | null;
  closed_by: 'owner' | 'agent' | 'imported' | null;
  closed_at: string | null;
  archived_at: string | null;
  split_from: string | null;
  /** Decision 58: the stored known gaps (JSON text), or null. */
  known_gaps?: string | null;
  /** Decision 65: who asked for it to be shaped (JSON text), or null. */
  shaping?: string | null;
  jira_key: string | null;
  /** 1 when the Jira import created it (SQLite boolean). */
  imported?: number | boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

export function requireItem(db: Db, id: string): ItemRow {
  const row = db.sqlite
    .prepare(
      'SELECT i.* FROM items i JOIN projects p ON p.key = i.project_key WHERE i.id = ? AND p.deleted_at IS NULL',
    )
    .get(id) as ItemRow | undefined;
  if (!row) throw new ToolError('not_found', `No item ${id}. Check the ID with search_items.`);
  return row;
}

export interface SummaryContext {
  db: Db;
  windows: RunWindows;
  now: string;
  /** Reuse one index across many summaries. */
  index?: BlockIndex;
}

/** Item summaries for `rows`, in the same order. */
export function summarize(ctx: SummaryContext, rows: ItemRow[]): ItemSummary[] {
  if (rows.length === 0) return [];
  const { db } = ctx;
  const index = ctx.index ?? new BlockIndex(db);
  const ids = rows.map((r) => r.id);
  const inList = `(${ids.map(() => '?').join(', ')})`;
  const labels = new Map<string, string[]>();
  for (const l of db.sqlite
    .prepare(
      `SELECT il.item_id, l.name FROM item_labels il JOIN labels l ON l.id = il.label_id WHERE il.item_id IN ${inList} ORDER BY l.name`,
    )
    .all(...ids) as { item_id: string; name: string }[]) {
    labels.set(l.item_id, [...(labels.get(l.item_id) ?? []), l.name]);
  }
  const review = new Map<string, ItemSummary['human_review']>();
  for (const r of db.sqlite
    .prepare(
      `SELECT item_id, state, count(*) AS n FROM hr_items WHERE item_id IN ${inList} GROUP BY item_id, state`,
    )
    .all(...ids) as { item_id: string; state: keyof ItemSummary['human_review']; n: number }[]) {
    const counts = review.get(r.item_id) ?? { declared: 0, ready: 0, approved: 0, deferred: 0 };
    counts[r.state] = r.n;
    review.set(r.item_id, counts);
  }
  const leads = new Map<string, RunRow>();
  for (const run of db.sqlite
    .prepare(
      `SELECT * FROM runs WHERE is_lead = 1 AND state IN ${OPEN_STORED_SQL} AND item_id IN ${inList}`,
    )
    .all(...ids) as RunRow[]) {
    leads.set(run.item_id, run);
  }
  const epicIds = [...new Set(rows.map((r) => r.epic_id).filter((e): e is string => !!e))];
  const epicTitles = new Map<string, string>();
  if (epicIds.length > 0) {
    for (const e of db.sqlite
      .prepare(`SELECT id, title FROM items WHERE id IN (${epicIds.map(() => '?').join(', ')})`)
      .all(...epicIds) as { id: string; title: string }[]) {
      epicTitles.set(e.id, e.title);
    }
  }
  // Decision 65: only rows someone asked to have shaped cost a query.
  const shaping = needsShapingOf(db, rows);
  return rows.map((row) => {
    const block = index.state(row.id);
    const lead = leads.get(row.id);
    const shape = shaping.get(row.id);
    return {
      id: row.id,
      project: row.project_key,
      type: row.type,
      title: row.title,
      status: row.status,
      priority: row.priority,
      epic: row.epic_id,
      epic_title: row.epic_id ? (epicTitles.get(row.epic_id) ?? null) : null,
      labels: labels.get(row.id) ?? [],
      blocked: block.blocked,
      blocked_by: block.blocked_by,
      unblocks: index.unblocks(row.id).length,
      lead: lead
        ? {
            client: lead.client,
            label: lead.label,
            run_id: lead.id,
            run_state: displayRunState(lead, ctx.windows, ctx.now),
          }
        : null,
      human_review: review.get(row.id) ?? { declared: 0, ready: 0, approved: 0, deferred: 0 },
      planned_start: row.planned_start,
      planned_end: row.planned_end,
      effort: row.effort,
      archived: row.archived_at !== null,
      jira_key: row.jira_key,
      version: row.version,
      updated_at: row.updated_at,
      ...(shape ? { needs_shaping: shape } : {}),
    };
  });
}

export function summaryOf(ctx: SummaryContext, id: string): ItemSummary {
  return summarize(ctx, [requireItem(ctx.db, id)])[0]!;
}

// ---- Events (MCP_SPEC §4 EventRow) ----

export interface StoredEvent {
  seq: number;
  at: string;
  actor_kind: 'owner' | 'agent' | 'system';
  client: string | null;
  label: string | null;
  run_label: string | null;
  item_id: string | null;
  type: string;
  summary: string;
  /** `data.via` and `data.user_agent` of an owner event (decision 32); null otherwise. */
  via?: string | null;
  via_agent?: string | null;
}

/** Select columns for `eventRow`: events `e`, joined to their run `r` for the label. */
export const EVENT_COLUMNS =
  "e.seq, e.at, e.actor_kind, e.client, e.label, r.label AS run_label, e.item_id, e.type, e.summary, json_extract(e.data, '$.via') AS via, json_extract(e.data, '$.user_agent') AS via_agent";

/**
 * How an event's actor is shown: `actorName`, and for an owner action made by
 * a script (decision 32), "owner (script: curl/8.4.0)".
 */
export function eventActor(e: StoredEvent): string {
  if (e.actor_kind === 'owner' && e.via === 'script') {
    return `owner (script: ${e.via_agent || 'unknown'})`;
  }
  return actorName({ kind: e.actor_kind, client: e.client, label: e.label ?? e.run_label });
}
export const EVENT_FROM = 'events e LEFT JOIN runs r ON r.id = e.run_id';

export function eventRow(e: StoredEvent) {
  return {
    cursor: String(e.seq),
    at: e.at,
    actor: eventActor(e),
    item_id: e.item_id,
    type: e.type as never,
    summary: e.summary,
  };
}

// ---- The caller's run (BUILD_SPEC §5.3) ----

/** What a call naming an ended run is told: the run as it ended, and who leads the item now. */
export function endedRunState(db: Db, run: RunRow, now: string) {
  const lead = activeLead(db, run.item_id);
  const item = db.sqlite.prepare('SELECT status FROM items WHERE id = ?').get(run.item_id) as
    { status: Status } | undefined;
  return {
    run_id: run.id,
    item_id: run.item_id,
    state: run.state === 'open' && leaseExpired(run, now) ? 'interrupted' : run.state,
    end_reason:
      run.end_reason ??
      (leaseExpired(run, now) ? (run.is_lead === 1 ? 'lease_expired' : 'service_restart') : null),
    item_status: item?.status ?? null,
    lead:
      lead && lead.id !== run.id
        ? { client: lead.client, label: lead.label, run_id: lead.id }
        : null,
  };
}

/**
 * A mutation that names a run (`run_id`) needs that run to exist and still
 * be going: an unknown run is `not_found`; an ended run, or a lead whose
 * lease ran out, is `conflict` with the current state (§5.3: "its next call
 * naming the old run returns conflict"). Returns the run, if one was named.
 */
export function assertCallerRun(db: Db, actor: Actor, now: string): RunRow | undefined {
  if (!actor.run_id) return undefined;
  const run = getRun(db, actor.run_id);
  if (!run) {
    throw new ToolError(
      'not_found',
      `No run ${actor.run_id}. Use the run_id claim_lead or start_run gave you, or claim again.`,
    );
  }
  if (!isRunOpen(run.state) || leaseExpired(run, now)) {
    throw runEndedError(db, run, now);
  }
  return run;
}

export function runEndedError(db: Db, run: RunRow, now: string): ToolError {
  const current = endedRunState(db, run, now);
  const why = current.end_reason ? ` (${current.end_reason.replace(/_/g, ' ')})` : '';
  const lead = current.lead
    ? ` ${run.item_id} is now led by ${actorName({ kind: 'agent', ...current.lead })}.`
    : '';
  return new ToolError(
    'conflict',
    `Run ${run.id} has ended${why}.${lead} Stop work on it; claim the item again with claim_lead if it is free.`,
    { current },
  );
}

// ---- The checklist as agents see it (MCP_SPEC §4 WorkStep, Check) ----

/** The current plan version: the latest `plan_versions.version_no` (0 before the first plan). */
export function planVersion(db: Db, itemId: string): number {
  return (
    db.sqlite
      .prepare('SELECT coalesce(max(version_no), 0) AS v FROM plan_versions WHERE item_id = ?')
      .get(itemId) as { v: number }
  ).v;
}

export interface StepRow {
  id: string;
  item_id: string;
  plan_version_no: number;
  position: number;
  text: string;
  state: 'todo' | 'current' | 'done' | 'blocked' | 'skipped';
  was_text: string | null;
  change_reason: string | null;
  added_by: string;
  from_review: string | null;
  state_by: string | null;
  state_at: string | null;
  /** Decision 33 (BUILD_SPEC §5.5). */
  details_md: string | null;
  source: string | null;
  details_version: number;
  created_at: string;
}

/** The current plan's steps, in order. */
export function currentSteps(db: Db, itemId: string): StepRow[] {
  return db.sqlite
    .prepare(
      'SELECT * FROM work_steps WHERE item_id = ? AND plan_version_no = ? ORDER BY position, id',
    )
    .all(itemId, planVersion(db, itemId)) as StepRow[];
}

/**
 * Steps as agents and the owner read them. Each carries `source` and
 * `has_details`; `details: true` adds `details_md` and `details_version`
 * (get_step, get_item view 'full', the owner's item page; decision 33). Without
 * it the details text never leaves the server, so ordinary reads stay lean.
 */
export function stepView(db: Db, steps: StepRow[], opts: { details?: boolean } = {}): WorkStep[] {
  if (steps.length === 0) return [];
  const ids = steps.map((s) => s.id);
  const logs = db.sqlite
    .prepare(
      `SELECT work_step_id, name, outcome, evidence, provenance, child_run_id, created_at FROM subagent_logs
       WHERE work_step_id IN (${ids.map(() => '?').join(', ')}) ORDER BY created_at, id`,
    )
    .all(...ids) as {
    work_step_id: string;
    name: string;
    outcome: string;
    evidence: string | null;
    provenance: 'observed' | 'relayed';
    child_run_id: string | null;
    created_at: string;
  }[];
  return steps.map((s) => {
    const fr = parseJson<{ round?: number; hr_item_id?: string }>(s.from_review);
    return {
      id: s.id,
      text: s.text,
      state: s.state,
      was_text: s.was_text,
      change_reason: s.change_reason,
      added_by: addedBy(s.added_by),
      from_review: fr?.hr_item_id
        ? { round: Number(fr.round ?? 0), hr_item_id: fr.hr_item_id }
        : null,
      subagents: logs
        .filter((l) => l.work_step_id === s.id)
        .map((l) => ({
          name: l.name,
          outcome: l.outcome,
          evidence: l.evidence,
          provenance: l.provenance,
          child_run_id: l.child_run_id,
          at: l.created_at,
        })),
      state_by: s.state_by,
      state_at: s.state_at,
      source: s.source,
      has_details: s.details_md !== null,
      ...(opts.details ? { details_md: s.details_md, details_version: s.details_version } : {}),
    };
  });
}

export function workStepsOf(
  db: Db,
  itemId: string,
  opts: { details?: boolean } = {},
): { version: number; steps: WorkStep[] } {
  return {
    version: planVersion(db, itemId),
    steps: stepView(db, currentSteps(db, itemId), opts),
  };
}

export interface CheckRow {
  id: string;
  item_id: string;
  position: number;
  text: string;
  state: 'todo' | 'pass' | 'fail' | 'skipped';
  evidence: string | null;
  provenance: 'agent' | 'observed' | 'relayed' | 'ci';
  added_by: string;
}

export function checkRows(db: Db, itemId: string): CheckRow[] {
  return db.sqlite
    .prepare('SELECT * FROM agent_checks WHERE item_id = ? ORDER BY position, id')
    .all(itemId) as CheckRow[];
}

export const checkView = (c: CheckRow): Check => ({
  id: c.id,
  text: c.text,
  state: c.state,
  evidence: c.evidence,
  provenance: c.provenance,
  added_by: addedBy(c.added_by),
});

export function checksOf(db: Db, itemId: string): Check[] {
  return checkRows(db, itemId).map(checkView);
}
