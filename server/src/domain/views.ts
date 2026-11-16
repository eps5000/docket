/**
 * The owner's read models (UI_SPEC §6; BUILD_SPEC §7): the `views` service.
 *
 * US2 (T080) fills `bootstrap`, `needsYou`, `work`, `itemDetail` and
 * `agents`. `labelPage` (US7) and `settings` (US10) are still stubs.
 *
 * Every view is a fixed number of bounded queries over the scope, never a
 * query per item (SC-013): items in scope are read once, blocked state comes
 * from one `BlockIndex`, and summaries from one `summarize` call. Derived
 * values reuse B7's model helpers (`displayRunState`, `runView`, `eventRow`),
 * so the owner sees exactly what agents see (Principle II).
 *
 * Owner attention (Principle V): only packets ready and open questions are
 * "for you". Problems never are.
 *
 * Not yet built here: recovery Problems rows (orphaned resources, unpushed
 * work, parked too long, ready to resume unattended) are US11's, and the
 * timeline section of `work` is US8's (`forecast.timeline`).
 */
import { statSync } from 'node:fs';
import {
  OPEN_STATUSES,
  UI_FILTER_KEYS,
  type ActivityRow,
  type AgentRow,
  type AgentsResponse,
  type BootstrapResponse,
  type DecisionRecord,
  type DeferredRow,
  type EpicCard,
  type EventType,
  type ForYouRow,
  type Item,
  type ItemDetailResponse,
  type ItemSummary,
  type LinkEdge,
  type NeedsYouResponse,
  type PlanVersion,
  type Problem,
  type RunState,
  type Status,
  type WorkItem,
  type WorkResponse,
} from '@tasklite/shared';
import { migrationStatus, type Db } from '../db/client.js';
import { APP_VERSION } from '../version.js';
import {
  isNotImplemented,
  notImplemented,
  type ReadContext,
  type ServiceDeps,
  type ViewsService,
} from './contracts.js';
import {
  BlockIndex,
  EVENT_COLUMNS,
  EVENT_FROM,
  OPEN_STORED_SQL,
  displayRunState,
  eventRow,
  isRunOpen,
  ms,
  requireItem,
  summarize,
  windowsOf,
  type ItemRow,
  type RunRow,
  type RunWindows,
  type StoredEvent,
} from './model.js';
import { UNDO_WINDOW_MS } from './undo.js';

type UiFilter = (typeof UI_FILTER_KEYS)[number];
type Scope = 'all' | string;

const isOpenStatus = (s: string) => (OPEN_STATUSES as readonly string[]).includes(s);

/** Activity rows the item page loads at once ("small enough to load at once"). */
export const ACTIVITY_LIMIT = 200;
/** Ended runs and subagent log entries the Agents table shows, newest first. */
export const AGENTS_ENDED_LIMIT = 50;

// ---- Small formatting helpers (server-side text is UTC-free: dates and durations only) ----

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-11-09` → `Nov 9`. */
export function dayLabel(date: string): string {
  const [, m, d] = date.slice(0, 10).split('-');
  return `${MONTHS[Number(m) - 1] ?? m} ${Number(d)}`;
}

/** A duration in words: `40s`, `47m`, `16h`, `3d`. */
export function durationLabel(msValue: number): string {
  const s = Math.max(0, Math.round(msValue / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** One line, ending in a full stop (Problems rows are one truncated line). */
const sentence = (text: string) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return /[.?!]$/.test(line) ? line : `${line}.`;
};

/** `RCP-9` before `RCP-10`. */
function compareIds(a: string, b: string): number {
  const [pa, na] = a.split('-');
  const [pb, nb] = b.split('-');
  return pa === pb ? Number(na) - Number(nb) : pa! < pb! ? -1 : 1;
}

const byPriorityThenId = (a: { priority: number; id: string }, b: typeof a) =>
  a.priority - b.priority || compareIds(a.id, b.id);

const placeholders = (n: number) => `(${Array.from({ length: n }, () => '?').join(', ')})`;

// ---- The scope ----

export interface Scoped {
  db: Db;
  now: string;
  windows: RunWindows;
  index: BlockIndex;
  /** Items in scope (live projects only), by ID. */
  items: Map<string, ItemRow>;
  inScope: (projectKey: string | null | undefined) => boolean;
}

export function scoped(r: ReadContext, windows: RunWindows, scope: Scope): Scoped {
  const sql = r.db.sqlite;
  const rows = (
    scope === 'all'
      ? sql
          .prepare(
            'SELECT i.* FROM items i JOIN projects p ON p.key = i.project_key WHERE p.deleted_at IS NULL',
          )
          .all()
      : sql
          .prepare(
            'SELECT i.* FROM items i JOIN projects p ON p.key = i.project_key WHERE p.deleted_at IS NULL AND i.project_key = ?',
          )
          .all(scope)
  ) as ItemRow[];
  return {
    db: r.db,
    now: r.now,
    windows,
    index: new BlockIndex(r.db),
    items: new Map(rows.map((row) => [row.id, row])),
    inScope: (key) => !!key && (scope === 'all' || key === scope),
  };
}

// ---- Attention: packets and questions ----

export interface OpenPacket {
  id: string;
  item_id: string;
  round: number;
  estimate: string | null;
  built_from_commit: string | null;
  created_at: string;
  stale: boolean;
  to_verify: number;
}

const sameSha = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

/**
 * Open packets on `itemIds`, with staleness (BUILD_SPEC §5.6: a commit
 * reported after the packet with another SHA; for an epic-level packet, a
 * commit on any child) and how many items it asks you to verify.
 */
export function openPackets(db: Db, itemIds: string[]): Map<string, OpenPacket> {
  const out = new Map<string, OpenPacket>();
  if (itemIds.length === 0) return out;
  const sql = db.sqlite;
  const rows = sql
    .prepare(
      `SELECT id, item_id, round, estimate, built_from_commit, created_at FROM packets
       WHERE state = 'open' AND item_id IN ${placeholders(itemIds.length)}`,
    )
    .all(...itemIds) as Omit<OpenPacket, 'stale' | 'to_verify'>[];
  if (rows.length === 0) return out;
  const packetItems = rows.map((p) => p.item_id);
  const list = placeholders(packetItems.length);
  const commits = sql
    .prepare(
      `SELECT c.item_id, i.epic_id, c.sha, c.reported_at FROM commits c JOIN items i ON i.id = c.item_id
       WHERE c.item_id IN ${list} OR i.epic_id IN ${list}`,
    )
    .all(...packetItems, ...packetItems) as {
    item_id: string;
    epic_id: string | null;
    sha: string;
    reported_at: string;
  }[];
  const ready = new Map(
    (
      sql
        .prepare(
          `SELECT item_id, count(*) AS n FROM hr_items WHERE state = 'ready' AND item_id IN ${list} GROUP BY item_id`,
        )
        .all(...packetItems) as { item_id: string; n: number }[]
    ).map((x) => [x.item_id, x.n]),
  );
  for (const p of rows) {
    const built = (p.built_from_commit ?? '').toLowerCase();
    const stale = commits.some(
      (c) =>
        (c.item_id === p.item_id || c.epic_id === p.item_id) &&
        ms(c.reported_at) > ms(p.created_at) &&
        !sameSha(c.sha.toLowerCase(), built),
    );
    out.set(p.item_id, { ...p, stale, to_verify: ready.get(p.item_id) ?? 0 });
  }
  return out;
}

interface OpenQuestion {
  id: string;
  item_id: string;
  text: string;
  asked_by: string;
  created_at: string;
}

/** Unanswered questions (at most one per item). */
function openQuestions(db: Db, itemIds: string[]): Map<string, OpenQuestion> {
  const out = new Map<string, OpenQuestion>();
  if (itemIds.length === 0) return out;
  for (const q of db.sqlite
    .prepare(
      `SELECT id, item_id, text, asked_by, created_at FROM questions
       WHERE answered_at IS NULL AND item_id IN ${placeholders(itemIds.length)}`,
    )
    .all(...itemIds) as OpenQuestion[]) {
    out.set(q.item_id, q);
  }
  return out;
}

// ---- Runs ----

/** Open runs (any), and each item's latest lead run, for the items in scope. */
function scopeRuns(s: Scoped) {
  const sql = s.db.sqlite;
  const open = (
    sql.prepare(`SELECT * FROM runs WHERE state IN ${OPEN_STORED_SQL}`).all() as RunRow[]
  ).filter((r) => s.items.has(r.item_id));
  // The latest lead run per item (the failed-run Problem looks at it).
  const latestLead = new Map<string, RunRow>();
  for (const r of sql
    .prepare(
      `SELECT r.* FROM runs r WHERE r.is_lead = 1 AND r.created_at = (
         SELECT max(r2.created_at) FROM runs r2 WHERE r2.item_id = r.item_id AND r2.is_lead = 1)`,
    )
    .all() as RunRow[]) {
    if (s.items.has(r.item_id)) latestLead.set(r.item_id, r);
  }
  return { open, latestLead };
}

/**
 * A failed lead run that still needs someone: the item is In progress with
 * no active lead and its latest lead run failed (BUILD_SPEC §5.3: "It shows
 * under Problems (failed)"). Returning it to Ready or a new claim clears it.
 */
function failedRuns(s: Scoped, runs: ReturnType<typeof scopeRuns>): RunRow[] {
  const leading = new Set(runs.open.filter((r) => r.is_lead === 1).map((r) => r.item_id));
  return [...runs.latestLead.values()].filter(
    (r) =>
      r.state === 'failed' &&
      s.items.get(r.item_id)?.status === 'progress' &&
      !leading.has(r.item_id),
  );
}

/** Counts per displayed run state: open runs, plus failed runs that still need someone. */
function runCounts(s: Scoped, runs: ReturnType<typeof scopeRuns>) {
  const counts: Partial<Record<RunState, number>> = {};
  for (const r of runs.open) {
    const state = displayRunState(r, s.windows, s.now);
    counts[state] = (counts[state] ?? 0) + 1;
  }
  const failed = failedRuns(s, runs).length;
  if (failed > 0) counts.failed = failed;
  return counts;
}

// ---- Problems (UI_SPEC §6.1; BUILD_SPEC §5.2) ----

/** Strongly connected components of the `blocks` graph larger than one node (Tarjan). */
export function cyclesOf(index: BlockIndex, nodes: Iterable<string>): string[][] {
  const order = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let counter = 0;
  const next = (id: string) => (index.dependents.get(id) ?? []).map((l) => l.to_id);
  // Iterative, so a long imported chain can't overflow the call stack.
  for (const root of nodes) {
    if (order.has(root)) continue;
    const work: { id: string; edges: string[]; i: number }[] = [];
    const visit = (id: string) => {
      order.set(id, counter);
      low.set(id, counter);
      counter++;
      stack.push(id);
      onStack.add(id);
      work.push({ id, edges: next(id), i: 0 });
    };
    visit(root);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      if (frame.i < frame.edges.length) {
        const to = frame.edges[frame.i++]!;
        if (!order.has(to)) visit(to);
        else if (onStack.has(to)) low.set(frame.id, Math.min(low.get(frame.id)!, order.get(to)!));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.id, Math.min(low.get(parent.id)!, low.get(frame.id)!));
      if (low.get(frame.id) === order.get(frame.id)) {
        const component: string[] = [];
        for (;;) {
          const x = stack.pop()!;
          onStack.delete(x);
          component.push(x);
          if (x === frame.id) break;
        }
        if (component.length > 1) out.push(component.sort(compareIds));
      }
    }
  }
  return out;
}

interface ProblemsInput {
  s: Scoped;
  runs: ReturnType<typeof scopeRuns>;
  /** Items with a deferred human review item, and how many. */
  deferredCounts: Map<string, number>;
  /** Extra backup copy errors, when the backup service reports them (US10). */
  backupError: string | null;
}

function problemsOf({ s, runs, deferredCounts, backupError }: ProblemsInput): Problem[] {
  const { index, items, now } = s;
  const base = { related: [] as string[], link_id: null, run_id: null, resource_ids: [] };
  const list: { p: Problem; holds: number }[] = [];
  const holds = (id: string | null) => (id ? index.unblocks(id).length : 0);
  const push = (p: Problem) => list.push({ p, holds: holds(p.item_id) });
  const title = (id: string) => items.get(id)?.title ?? null;
  const sql = s.db.sqlite;

  // Stale lead runs: unknown, never finished (Principle III).
  const staleRuns = runs.open.filter(
    (r) => r.is_lead === 1 && displayRunState(r, s.windows, now) === 'stale',
  );
  const rejected = new Map<string, string>();
  if (staleRuns.length > 0) {
    const ids = staleRuns.map((r) => r.item_id);
    for (const e of sql
      .prepare(
        `SELECT item_id, max(at) AS at FROM events WHERE type = 'claim.rejected' AND item_id IN ${placeholders(ids.length)} GROUP BY item_id`,
      )
      .all(...ids) as { item_id: string; at: string }[]) {
      rejected.set(e.item_id, e.at);
    }
  }
  for (const r of staleRuns) {
    const silent = durationLabel(ms(now) - ms(r.last_signal_at));
    const lease = r.lease_expires_at
      ? ms(r.lease_expires_at) > ms(now)
        ? `the lease expires in ${durationLabel(ms(r.lease_expires_at) - ms(now))}`
        : 'the lease has run out'
      : 'it holds no lease';
    const rej = rejected.get(r.item_id);
    const claim =
      rej && ms(rej) >= ms(r.created_at)
        ? ` Another agent's claim was rejected ${durationLabel(ms(now) - ms(rej))} ago.`
        : '';
    push({
      ...base,
      kind: 'stale_run',
      item_id: r.item_id,
      title: title(r.item_id),
      reason: `Lead run silent for ${silent}; ${lease}. Treated as unknown, not finished.${claim}`,
      run_id: r.id,
    });
  }

  // Failed lead runs nobody has picked up.
  for (const r of failedRuns(s, runs)) {
    push({
      ...base,
      kind: 'failed_run',
      item_id: r.item_id,
      title: title(r.item_id),
      reason: `${r.error ? `Run failed: ${sentence(r.error)}` : 'Run failed.'} Nothing retries automatically.`,
      run_id: r.id,
    });
  }

  for (const item of items.values()) {
    if (!isOpenStatus(item.status)) continue;
    const block = index.state(item.id);

    // Date risk: planned to start before an unresolved blocker is planned to finish.
    if (item.planned_start && item.type !== 'Epic') {
      const risky = block.blocked_by.filter((b) => {
        const end = index.status(b) !== undefined ? plannedEnd(s, b) : null;
        return end !== null && end >= item.planned_start!;
      });
      if (risky.length > 0) {
        const b = risky[0]!;
        push({
          ...base,
          kind: 'date_risk',
          item_id: item.id,
          title: item.title,
          reason: `Planned start ${dayLabel(item.planned_start)} is before its blocker ${b} is planned to finish (${dayLabel(plannedEnd(s, b)!)}).`,
          related: risky,
        });
      }
    }

    for (const link of index.blockers.get(item.id) ?? []) {
      const blocker = link.from_id;
      // A canceled blocker never clears (§5.2): the owner removes the link.
      if (index.status(blocker) === 'canceled') {
        push({
          ...base,
          kind: 'canceled_blocker',
          item_id: item.id,
          title: item.title,
          reason: `Blocked by canceled ${blocker}. Remove the link, or reopen ${blocker}.`,
          related: [blocker],
          link_id: link.id,
        });
        continue;
      }
      // A verified blocker that closed with deferred checks stays unresolved (§5.2).
      const deferred = deferredCounts.get(blocker) ?? 0;
      if (index.waitingFor(link) === 'verification' && deferred > 0) {
        push({
          ...base,
          kind: 'deferred_verified_blocker',
          item_id: item.id,
          title: item.title,
          reason: `${item.id} needs ${blocker} verified, but ${deferred} ${deferred === 1 ? 'check was' : 'checks were'} deferred.`,
          related: [blocker],
          link_id: link.id,
        });
      }
    }
  }

  // Cycles (imported data can hold them; `link_items` refuses new ones).
  for (const cycle of cyclesOf(index, [...items.keys()])) {
    const members = cycle.filter((id) => items.has(id));
    if (members.length === 0 || !members.some((id) => isOpenStatus(items.get(id)!.status))) {
      continue;
    }
    const imported = cycle.every((id) => {
      const row = items.get(id) as (ItemRow & { imported?: number }) | undefined;
      return !!row?.imported;
    });
    const path = cycle.length === 2 ? cycle.join(' ⇄ ') : [...cycle, cycle[0]].join(' → ');
    push({
      ...base,
      kind: 'cycle',
      item_id: members[0]!,
      title: title(members[0]!),
      reason: `Dependency cycle${imported ? ' in imported data' : ''}: ${path}. None of them can start until one link is removed.`,
      related: cycle,
    });
  }

  if (backupError) {
    push({
      ...base,
      kind: 'extra_backup_failed',
      item_id: null,
      title: null,
      reason: `The extra backup copy failed: ${sentence(backupError)}`,
    });
  }

  // What holds up the most work first; otherwise in the order found.
  return list
    .map((x, i) => ({ ...x, i }))
    .sort((a, b) => b.holds - a.holds || a.i - b.i)
    .map((x) => x.p);
}

function plannedEnd(s: Scoped, id: string): string | null {
  const row = s.items.get(id);
  if (row) return row.planned_end;
  // A blocker in another project (blocking crosses projects).
  const other = s.db.sqlite.prepare('SELECT planned_end FROM items WHERE id = ?').get(id) as
    { planned_end: string | null } | undefined;
  return other?.planned_end ?? null;
}

// ---- Deferred, not verified (BUILD_SPEC §5.6) ----

export interface DeferredInfo {
  rows: DeferredRow[];
  /** Deferred items per item, for the Problems row about verified blockers. */
  counts: Map<string, number>;
  /** Items with at least one deferred item that isn't verified yet (the Work filter). */
  unverified: Set<string>;
}

/**
 * Deferred human review items whose follow-up isn't done with its own review
 * approved, or that have no follow-up. Newest first.
 */
export function deferredOf(s: Scoped): DeferredInfo {
  const rows = (
    s.db.sqlite
      .prepare(
        `SELECT h.id, h.item_id, h.text, h.last_decision, h.follow_up_item_id, h.updated_at,
                f.status AS follow_status,
                (SELECT count(*) FROM hr_items fh WHERE fh.item_id = f.id AND fh.state <> 'approved') AS follow_open
         FROM hr_items h LEFT JOIN items f ON f.id = h.follow_up_item_id
         WHERE h.state = 'deferred'`,
      )
      .all() as {
      id: string;
      item_id: string;
      text: string;
      last_decision: string | null;
      follow_up_item_id: string | null;
      updated_at: string;
      follow_status: Status | null;
      follow_open: number | null;
    }[]
  ).filter((h) => s.items.has(h.item_id));
  const counts = new Map<string, number>();
  const unverified = new Set<string>();
  const out: DeferredRow[] = [];
  for (const h of rows) {
    counts.set(h.item_id, (counts.get(h.item_id) ?? 0) + 1);
    const verified = h.follow_status === 'done' && (h.follow_open ?? 0) === 0;
    if (verified) continue;
    unverified.add(h.item_id);
    let last: { note?: string | null; at?: string } = {};
    try {
      last = h.last_decision ? (JSON.parse(h.last_decision) as typeof last) : {};
    } catch {
      last = {};
    }
    out.push({
      item_id: h.item_id,
      title: s.items.get(h.item_id)!.title,
      hr_item_id: h.id,
      text: h.text,
      note: last.note ?? null,
      deferred_at: last.at ?? h.updated_at,
      follow_up:
        h.follow_up_item_id && h.follow_status
          ? { id: h.follow_up_item_id, status: h.follow_status }
          : null,
    });
  }
  out.sort(
    (a, b) => b.deferred_at.localeCompare(a.deferred_at) || compareIds(a.item_id, b.item_id),
  );
  return { rows: out, counts, unverified };
}

// ---- Links ----

function linkEdges(db: Db, index: BlockIndex, ids: Set<string>, mode: 'among' | 'touching') {
  if (ids.size === 0) return [];
  const list = [...ids];
  const rows = db.sqlite
    .prepare(
      `SELECT id, from_id, to_id, type, satisfied_when FROM links
       WHERE from_id IN ${placeholders(list.length)} OR to_id IN ${placeholders(list.length)}
       ORDER BY from_id, to_id, id`,
    )
    .all(...list, ...list) as {
    id: string;
    from_id: string;
    to_id: string;
    type: 'blocks' | 'relates';
    satisfied_when: 'done' | 'merged' | 'verified' | null;
  }[];
  const edges: LinkEdge[] = [];
  for (const l of rows) {
    if (mode === 'among' && !(ids.has(l.from_id) && ids.has(l.to_id))) continue;
    edges.push({
      link_id: l.id,
      from: l.from_id,
      to: l.to_id,
      type: l.type,
      satisfied_when: l.type === 'blocks' ? index.rule(l) : null,
      cleared: l.type === 'blocks' ? index.cleared(l) : null,
    });
  }
  return edges;
}

// ---- Health (`/readyz` checks, for the sidebar health line) ----

let migrationsCurrent: boolean | null = null;

function healthOf(r: ReadContext, deps: ServiceDeps): BootstrapResponse['health'] {
  const checks: Record<string, string> = {};
  const dir = (path: string) => {
    try {
      return statSync(path).isDirectory() ? 'ok' : 'missing';
    } catch (err) {
      return (err as NodeJS.ErrnoException).code ?? 'error';
    }
  };
  checks.data_dir = dir(deps.config.dataDir);
  checks.docs_dir = dir(deps.config.paths.docs);
  try {
    r.db.sqlite.prepare('SELECT 1').get();
    checks.database = 'ok';
  } catch (err) {
    checks.database = (err as { code?: string }).code ?? 'error';
  }
  try {
    // Migrations only change with a new build, so read the files once.
    migrationsCurrent ??= migrationStatus(r.db).current;
    checks.migrations = migrationsCurrent ? 'ok' : 'pending';
  } catch {
    checks.migrations = 'error';
  }
  const status = Object.values(checks).every((v) => v === 'ok') ? 'ready' : 'not_ready';
  // Agent clients with a signal in the last 24 hours ("Healthy · 3 clients").
  const clients = (
    r.db.sqlite
      .prepare('SELECT count(DISTINCT client) AS n FROM runs WHERE last_signal_at >= ?')
      .get(new Date(ms(r.now) - 86_400_000).toISOString()) as { n: number }
  ).n;
  if (clients > 0) checks.clients = String(clients);
  return { status, checks };
}

// ---- The service ----

export function createViewsService(deps: ServiceDeps): ViewsService {
  const windows = () => windowsOf(deps.config);

  /** The extra backup copy's last error, once the backup service exists (US10). */
  function backupError(r: ReadContext): string | null {
    try {
      const extra = deps
        .services()
        .backup.status(r)
        .find((b) => b.location === 'extra');
      return extra?.last_error ?? null;
    } catch (err) {
      if (isNotImplemented(err)) return null;
      throw err;
    }
  }

  function attention(s: Scoped) {
    const ids = [...s.items.keys()];
    return { packets: openPackets(s.db, ids), questions: openQuestions(s.db, ids) };
  }

  function forYouRows(s: Scoped, att: ReturnType<typeof attention>): ForYouRow[] {
    const packets: ForYouRow[] = [...att.packets.values()]
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((p) => ({
        kind: 'packet',
        item_id: p.item_id,
        title: s.items.get(p.item_id)!.title,
        project: s.items.get(p.item_id)!.project_key,
        packet_id: p.id,
        round: p.round,
        to_verify: p.to_verify,
        estimate: p.estimate ?? '10 min',
        stale: p.stale,
        built_from_commit: p.built_from_commit ?? '',
        submitted_at: p.created_at,
      }));
    const questions: ForYouRow[] = [...att.questions.values()]
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((q) => ({
        kind: 'question',
        item_id: q.item_id,
        title: s.items.get(q.item_id)!.title,
        project: s.items.get(q.item_id)!.project_key,
        question_id: q.id,
        asked_by: q.asked_by,
        text: q.text,
        asked_at: q.created_at,
      }));
    return [...packets, ...questions];
  }

  function needsYou(r: ReadContext, scope: Scope): NeedsYouResponse {
    const s = scoped(r, windows(), scope);
    const att = attention(s);
    const runs = scopeRuns(s);
    const deferred = deferredOf(s);
    const planning = [...s.items.values()]
      .filter((i) => i.status === 'planning' && i.archived_at === null)
      .sort(byPriorityThenId);
    return {
      for_you_now: forYouRows(s, att),
      problems: problemsOf({
        s,
        runs,
        deferredCounts: deferred.counts,
        backupError: backupError(r),
      }),
      deferred: deferred.rows,
      planning_queue: summarize(
        { db: s.db, windows: s.windows, now: s.now, index: s.index },
        planning,
      ),
      agent_counts: runCounts(s, runs),
    };
  }

  return {
    bootstrap(r) {
      const sql = r.db.sqlite;
      const config = deps.config;
      const projects = sql
        .prepare(
          'SELECT key, name, short_name, color, default_satisfied_when, version FROM projects WHERE deleted_at IS NULL ORDER BY key',
        )
        .all() as BootstrapResponse['projects'];
      const labels = (
        sql
          .prepare(
            `SELECT l.project_key, l.name, l.brief_md, l.brief_by, l.brief_at FROM labels l
             JOIN projects p ON p.key = l.project_key WHERE p.deleted_at IS NULL ORDER BY l.project_key, l.name`,
          )
          .all() as {
          project_key: string;
          name: string;
          brief_md: string;
          brief_by: string | null;
          brief_at: string | null;
        }[]
      ).map((l) => ({
        project: l.project_key,
        name: l.name,
        brief_md: l.brief_md === '' ? null : l.brief_md,
        brief_by: l.brief_by,
        brief_at: l.brief_at,
      }));
      const view = needsYou(r, 'all');
      return {
        server_version: APP_VERSION,
        server_time: r.now,
        projects,
        labels,
        counts: {
          for_you: view.for_you_now.length,
          problems: view.problems.length,
          planning: view.planning_queue.length,
          runs: view.agent_counts,
        },
        settings: {
          live_window_s: Math.round(config.liveWindowMs / 1000),
          stale_after_s: Math.round(config.staleAfterMs / 1000),
          lease_s: Math.round(config.leaseMs / 1000),
          undo_window_s: Math.round(UNDO_WINDOW_MS / 1000),
        },
        health: healthOf(r, deps),
      };
    },

    needsYou(r, input) {
      return needsYou(r, input.scope);
    },

    work(r, input): WorkResponse {
      const s = scoped(r, windows(), input.scope);
      const att = attention(s);
      const deferred = deferredOf(s);
      const ctx = { db: s.db, windows: s.windows, now: s.now, index: s.index };

      // Board, list and map: tickets, never epics; canceled items leave the views (§6.3).
      const base = [...s.items.values()].filter(
        (i) =>
          i.type !== 'Epic' && i.status !== 'canceled' && (!input.epic || i.epic_id === input.epic),
      );
      let summaries = summarize(ctx, base.sort(byPriorityThenId));
      if (input.label) summaries = summaries.filter((i) => i.labels.includes(input.label!));

      const lastActivity = new Map<string, string>();
      if (summaries.length > 0) {
        const ids = summaries.map((i) => i.id);
        for (const e of r.db.sqlite
          .prepare(
            `SELECT item_id, max(at) AS at FROM events WHERE item_id IN ${placeholders(ids.length)} GROUP BY item_id`,
          )
          .all(...ids) as { item_id: string; at: string }[]) {
          lastActivity.set(e.item_id, e.at);
        }
      }
      const rows: WorkItem[] = summaries.map((i) => {
        const packet_ready = att.packets.has(i.id);
        return {
          ...i,
          packet_ready,
          for_you: packet_ready || att.questions.has(i.id),
          last_activity_at: lastActivity.get(i.id) ?? i.updated_at,
        };
      });

      const matches: Partial<Record<UiFilter, (i: WorkItem) => boolean>> = {
        all: () => true,
        planning: (i) => i.status === 'planning',
        ready_to_start: (i) => i.status === 'ready' && !i.blocked && i.lead === null,
        blocked: (i) => i.blocked,
        for_you: (i) => i.for_you,
        human_review_later: (i) =>
          isOpenStatus(i.status) && !i.packet_ready && i.human_review.declared > 0,
        deferred_review: (i) => deferred.unverified.has(i.id),
        live_run: (i) => i.lead?.run_state === 'live',
        archived: (i) => i.archived,
      };
      const visible = rows.filter((i) => !i.archived);
      const filter_counts: WorkResponse['filter_counts'] = {};
      for (const key of UI_FILTER_KEYS) {
        const match = matches[key];
        if (match) filter_counts[key] = (key === 'archived' ? rows : visible).filter(match).length;
      }
      const items =
        input.filter === 'archived'
          ? rows.filter((i) => i.archived)
          : visible.filter(matches[input.filter] ?? (() => true));

      // The Epics row: non-archived epics in scope, with their children's progress.
      const epicRows = [...s.items.values()]
        .filter((i) => i.type === 'Epic' && i.archived_at === null && i.status !== 'canceled')
        .sort(byPriorityThenId);
      const children = new Map<string, ItemRow[]>();
      for (const i of s.items.values()) {
        if (i.epic_id && i.status !== 'canceled') {
          children.set(i.epic_id, [...(children.get(i.epic_id) ?? []), i]);
        }
      }
      const epics: EpicCard[] = summarize(ctx, epicRows).map((e) => {
        const kids = children.get(e.id) ?? [];
        const by_status: EpicCard['children']['by_status'] = {};
        for (const k of kids) by_status[k.status] = (by_status[k.status] ?? 0) + 1;
        return {
          ...e,
          children: {
            total: kids.length,
            done: kids.filter((k) => k.status === 'done').length,
            by_status,
            for_you: kids.filter((k) => att.packets.has(k.id) || att.questions.has(k.id)).length,
          },
        };
      });

      return {
        layout: input.layout,
        items,
        epics,
        filter_counts,
        links: linkEdges(r.db, s.index, new Set(items.map((i) => i.id)), 'among'),
        timeline: null,
      };
    },

    itemDetail(r, input): ItemDetailResponse {
      const sql = r.db.sqlite;
      const row = requireItem(r.db, input.id);
      // The same item agents read (view `full`); the owner reading it delivers nothing (§5.7).
      const item = deps.services().items.get(r, { id: row.id, view: 'full' }).item as Item;
      const index = new BlockIndex(r.db);

      const childRows =
        row.type === 'Epic'
          ? (sql.prepare('SELECT * FROM items WHERE epic_id = ?').all(row.id) as ItemRow[]).sort(
              byPriorityThenId,
            )
          : [];
      const childIds = childRows.map((c) => c.id);
      const childPackets = openPackets(r.db, childIds);
      const childQuestions = openQuestions(r.db, childIds);
      const children = summarize(
        { db: r.db, windows: windows(), now: r.now, index },
        childRows,
      ).map((c: ItemSummary) => ({
        ...c,
        for_you: childPackets.has(c.id) || childQuestions.has(c.id),
      }));

      // Decision records in scope (§6.3.5): an epic shows its own; a ticket everything that applies.
      type DecisionDbRow = {
        id: string;
        project_key: string;
        scope_kind: DecisionRecord['scope']['kind'];
        scope_id: string | null;
        title: string;
        decision_md: string;
        rationale_md: string | null;
        authority: DecisionRecord['authority'];
        author: string;
        status: DecisionRecord['status'];
        supersedes_id: string | null;
        superseded_by_id: string | null;
        confirmed_at: string | null;
        version: number;
        created_at: string;
      };
      const decisionRows = (
        row.type === 'Epic'
          ? sql
              .prepare(
                `SELECT d.*, (SELECT n.id FROM decision_records n WHERE n.supersedes_id = d.id LIMIT 1) AS superseded_by_id
                 FROM decision_records d WHERE d.project_key = ? AND d.scope_kind = 'epic' AND d.scope_id = ?`,
              )
              .all(row.project_key, row.id)
          : sql
              .prepare(
                `SELECT d.*, (SELECT n.id FROM decision_records n WHERE n.supersedes_id = d.id LIMIT 1) AS superseded_by_id
                 FROM decision_records d WHERE d.project_key = ? AND (
                   d.scope_kind = 'project'
                   OR (d.scope_kind = 'epic' AND d.scope_id = ?)
                   OR (d.scope_kind = 'item' AND d.scope_id = ?)
                   OR (d.scope_kind = 'label' AND d.scope_id IN (SELECT value FROM json_each(?))))`,
              )
              .all(row.project_key, row.epic_id ?? '', row.id, JSON.stringify(item.labels))
      ) as DecisionDbRow[];
      const decisions: DecisionRecord[] = decisionRows
        .sort(
          (a, b) =>
            (a.authority === 'owner' ? 0 : 1) - (b.authority === 'owner' ? 0 : 1) ||
            b.created_at.localeCompare(a.created_at) ||
            a.id.localeCompare(b.id),
        )
        .map((d) => ({
          id: d.id,
          project: d.project_key,
          scope: { kind: d.scope_kind, id: d.scope_id },
          title: d.title,
          decision_md: d.decision_md,
          rationale_md: d.rationale_md,
          authority: d.authority,
          author: d.author,
          status: d.status,
          supersedes_id: d.supersedes_id,
          superseded_by_id: d.superseded_by_id,
          created_at: d.created_at,
          confirmed_at: d.confirmed_at,
          version: d.version,
        }));

      // Checklist history: each plan version, with the step changes its event recorded.
      const versions = sql
        .prepare(
          'SELECT version_no, reason, created_by, created_at FROM plan_versions WHERE item_id = ? ORDER BY version_no',
        )
        .all(row.id) as Omit<PlanVersion, 'changes'>[];
      const planEvents = new Map<number, Record<string, unknown>>();
      for (const e of sql
        .prepare("SELECT data FROM events WHERE item_id = ? AND type = 'plan.updated' ORDER BY seq")
        .all(row.id) as { data: string | null }[]) {
        try {
          const data = e.data ? (JSON.parse(e.data) as Record<string, unknown>) : null;
          const v = (data?.plan_version as { new?: number } | undefined)?.new;
          if (data && typeof v === 'number') planEvents.set(v, data);
        } catch {
          // A malformed event carries no step changes.
        }
      }
      const stepText = new Map(
        (
          sql
            .prepare('SELECT id, text, was_text FROM work_steps WHERE item_id = ?')
            .all(row.id) as {
            id: string;
            text: string;
            was_text: string | null;
          }[]
        ).map((st) => [st.id, st]),
      );
      const plan_history: PlanVersion[] = versions.map((v) => {
        const data = planEvents.get(v.version_no);
        const changes: PlanVersion['changes'] = [];
        if (data) {
          for (const id of (data.added as string[] | undefined) ?? []) {
            changes.push({
              step_id: id,
              text: stepText.get(id)?.text ?? '',
              change: 'added',
              was_text: null,
            });
          }
          for (const id of (data.removed as string[] | undefined) ?? []) {
            changes.push({
              step_id: id,
              text: stepText.get(id)?.text ?? '',
              change: 'removed',
              was_text: null,
            });
          }
          for (const [id, c] of Object.entries(
            (data.changed as Record<string, { text?: string; was_text?: string | null }>) ?? {},
          )) {
            if (c.text === undefined) continue;
            changes.push({
              step_id: id,
              text: c.text,
              change: 'changed',
              was_text: c.was_text ?? stepText.get(id)?.was_text ?? null,
            });
          }
        }
        return { ...v, changes };
      });

      const activity: ActivityRow[] = (
        sql
          .prepare(
            `SELECT ${EVENT_COLUMNS}, e.project_key FROM ${EVENT_FROM} WHERE e.item_id = ? ORDER BY e.seq DESC LIMIT ?`,
          )
          .all(row.id, ACTIVITY_LIMIT) as (StoredEvent & { project_key: string | null })[]
      ).map((e) => ({
        ...eventRow(e),
        type: e.type as EventType,
        actor_kind: e.actor_kind,
        project: e.project_key,
      }));

      const packet = item.packets.find((p) => p.state === 'open');
      const open_packet = packet
        ? {
            packet_id: packet.packet_id,
            round: packet.round,
            stale: packet.stale,
            to_verify: item.checklist.human_review.filter((h) => h.state === 'ready').length,
          }
        : null;

      const question = sql
        .prepare(
          'SELECT answered_at, read_by_agent_at FROM questions WHERE item_id = ? ORDER BY created_at DESC LIMIT 1',
        )
        .get(row.id) as { answered_at: string | null; read_by_agent_at: string | null } | undefined;
      const notes = sql
        .prepare(
          'SELECT count(*) AS n FROM owner_notes WHERE item_id = ? AND read_by_agent_at IS NULL',
        )
        .get(row.id) as { n: number };

      const label_briefs = (
        sql
          .prepare(
            `SELECT name, brief_md FROM labels WHERE project_key = ? AND brief_md <> ''
             AND name IN (SELECT value FROM json_each(?)) ORDER BY name`,
          )
          .all(row.project_key, JSON.stringify(item.labels)) as { name: string; brief_md: string }[]
      ).map((l) => ({ name: l.name, brief_md: l.brief_md }));

      return {
        item,
        children,
        decisions,
        plan_history,
        activity,
        open_packet,
        answer_unread: !!question?.answered_at && question.read_by_agent_at === null,
        notes_unread: notes.n,
        label_briefs,
        links: linkEdges(r.db, index, new Set([row.id, ...childRows.map((c) => c.id)]), 'touching'),
      };
    },

    agents(r, input): AgentsResponse {
      const sql = r.db.sqlite;
      const s = scoped(r, windows(), input.scope);
      const w = s.windows;
      const runs = (
        sql
          .prepare(
            `SELECT * FROM runs WHERE state IN ${OPEN_STORED_SQL}
             UNION ALL
             SELECT * FROM (SELECT * FROM runs WHERE state NOT IN ${OPEN_STORED_SQL} ORDER BY updated_at DESC, id LIMIT ?)`,
          )
          .all(AGENTS_ENDED_LIMIT * 4) as RunRow[]
      ).filter((x) => s.items.has(x.item_id));
      const logs = (
        sql
          .prepare(
            `SELECT l.id, l.item_id, l.name, l.outcome, l.provenance, l.child_run_id, l.created_at
             FROM subagent_logs l ORDER BY l.created_at DESC, l.id LIMIT ?`,
          )
          .all(AGENTS_ENDED_LIMIT * 4) as {
          id: string;
          item_id: string;
          name: string;
          outcome: string;
          provenance: 'observed' | 'relayed';
          child_run_id: string | null;
          created_at: string;
        }[]
      ).filter((l) => s.items.has(l.item_id));

      // Current step text and position, for "work item 2 of 4: …": the step the run named in
      // a heartbeat, else the lead's plan step marked current (update_step).
      type StepInfo = {
        id: string;
        item_id: string;
        text: string;
        position: number;
        total: number;
      };
      const stepIds = runs.map((x) => x.current_step_id).filter((x): x is string => !!x);
      const leadItems = runs
        .filter((x) => x.is_lead === 1 && isRunOpen(x.state))
        .map((x) => x.item_id);
      const steps = new Map<string, StepInfo>();
      const currentByItem = new Map<string, StepInfo>();
      if (stepIds.length + leadItems.length > 0) {
        for (const st of sql
          .prepare(
            `SELECT ws.id, ws.item_id, ws.text, ws.position, ws.state,
                    (SELECT count(*) FROM work_steps o WHERE o.item_id = ws.item_id AND o.plan_version_no = ws.plan_version_no) AS total
             FROM work_steps ws
             WHERE ws.id IN ${placeholders(stepIds.length)}
                OR (ws.state = 'current' AND ws.item_id IN ${placeholders(leadItems.length)}
                    AND ws.plan_version_no = (SELECT max(version_no) FROM plan_versions pv WHERE pv.item_id = ws.item_id))
             ORDER BY ws.position`,
          )
          .all(...stepIds, ...leadItems) as (StepInfo & { state: string })[]) {
          steps.set(st.id, st);
          if (st.state === 'current' && !currentByItem.has(st.item_id))
            currentByItem.set(st.item_id, st);
        }
      }

      const ORDER: Partial<Record<RunState, number>> = {
        needs_input: 0,
        stale: 1,
        failed: 2,
        live: 3,
        reported: 4,
        parked: 5,
      };
      const ranked: { row: AgentRow; rank: number }[] = [];
      for (const x of runs) {
        const state = displayRunState(x, w, s.now);
        const open = isRunOpen(x.state);
        const step =
          (x.current_step_id ? steps.get(x.current_step_id) : undefined) ??
          (x.is_lead === 1 && isRunOpen(x.state) ? currentByItem.get(x.item_id) : undefined);
        const stepLine = step
          ? `work item ${step.position + 1} of ${step.total}: ${step.text}`
          : null;
        const role = x.is_lead === 1 ? 'Lead' : 'Child run';
        let doing: string | null;
        if (state === 'needs_input') doing = 'Waiting on your answer';
        else if (state === 'failed') doing = x.error ?? x.summary;
        else if (state === 'stale') doing = x.summary ? `Last said: “${x.summary}”` : stepLine;
        else if (state === 'parked')
          doing = x.parked_reason ? `Parked · ${x.parked_reason}` : 'Parked';
        else if (open) doing = [role, x.summary ?? stepLine].filter(Boolean).join(' · ');
        else doing = [role, x.summary].filter(Boolean).join(' · ');
        const provenance: AgentRow['provenance'] =
          x.parent_run_id !== null
            ? x.last_signal_kind === 'relayed'
              ? 'relayed'
              : 'observed'
            : x.last_signal_kind === 'report'
              ? 'agent'
              : x.last_signal_kind === 'relayed'
                ? 'relayed'
                : null;
        const lease: AgentRow['lease'] =
          x.is_lead !== 1
            ? 'none'
            : x.state === 'parked' || x.state === 'needs_input'
              ? 'paused'
              : !open
                ? 'released'
                : state === 'stale' ||
                    (x.lease_expires_at !== null && ms(x.lease_expires_at) <= ms(s.now))
                  ? 'expired'
                  : 'held';
        ranked.push({
          rank: ORDER[state] ?? 9,
          row: {
            row_kind: 'run',
            run_id: x.id,
            run_state: state,
            client: x.client,
            label: x.label,
            item_id: x.item_id,
            item_title: s.items.get(x.item_id)!.title,
            project: s.items.get(x.item_id)!.project_key,
            doing,
            last_signal_at: x.last_signal_at,
            last_signal_kind: x.last_signal_kind,
            lease_expires_at: x.lease_expires_at,
            lease,
            provenance,
            at: open ? x.last_signal_at : x.updated_at,
          },
        });
      }
      for (const l of logs) {
        ranked.push({
          rank: 9,
          row: {
            row_kind: 'subagent_log',
            run_id: l.child_run_id,
            run_state: null,
            client: l.name,
            label: null,
            item_id: l.item_id,
            item_title: s.items.get(l.item_id)!.title,
            project: s.items.get(l.item_id)!.project_key,
            doing: `Subagent log · ${l.outcome}`,
            last_signal_at: null,
            last_signal_kind: null,
            lease_expires_at: null,
            lease: 'none',
            provenance: l.provenance,
            at: l.created_at,
          },
        });
      }
      ranked.sort((a, b) => a.rank - b.rank || b.row.at.localeCompare(a.row.at));
      // Every open run, then the newest ended runs and log entries.
      const active = ranked.filter((x) => x.rank < 9);
      const ended = ranked.filter((x) => !active.includes(x)).slice(0, AGENTS_ENDED_LIMIT);
      return { rows: [...active, ...ended].map((x) => x.row) };
    },

    labelPage: notImplemented('views.labelPage'),
    settings: notImplemented('views.settings'),
  };
}
