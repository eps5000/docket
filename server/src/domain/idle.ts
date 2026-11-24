/**
 * Idle In progress tickets (owner decision 62; BUILD_SPEC §5.45).
 *
 * A ticket can sit In progress for days with no agent, no run and no
 * activity, carrying old branches. It is **idle** when it is In progress (an
 * epic never is), has no run that is open, parked or waiting for input, and
 * nobody (an agent or the owner) has touched it for `IDLE_AFTER_DAYS`. Docket's
 * own bookkeeping (the radar, the sweeper) isn't activity, and neither is the
 * owner acknowledging its problem.
 *
 * - **One problem for the owner** (`idle_ticket`): "GF-1 is In progress but
 *   nobody has worked on it since Nov 20", with the ways forward: move it to
 *   Planning, Ready or Inbox, cancel it, or clear its branches
 *   (`settleIdle`, `POST /api/items/:id/idle`, undoable).
 * - **No conflicts against it:** the radar doesn't check an idle ticket's
 *   branches (radar.ts `inFlightItems`), and a claim's overlap check doesn't
 *   count it as in flight (shared-changes.ts `inFlightFor`). The sweeper
 *   clears findings and undecided overlaps already open against it, saying
 *   why ("the other ticket is idle"; `clearIdleConflicts`).
 *
 * Any new activity, or a run, makes it live again; the radar picks its
 * branches up at its next run.
 */
import {
  IDLE_AFTER_MS,
  IDLE_CLEAR_REASON,
  ToolError,
  type IdleAction,
  type ItemSummary,
  type ProblemExplanation,
} from '@docket/shared';
import type { Db } from '../db/client.js';
import type { Services } from './contracts.js';
import { ms, requireItem, type ItemRow } from './model.js';
import { clearApproval } from './epic-readiness.js';
import { asDocket } from './overlap-policy.js';
import { clearUncheckedFindings, reportedBranches } from './radar.js';
import type { InverseOp, WriteContext } from './write.js';

export interface IdleTicket {
  id: string;
  /** The last activity by an agent or the owner, or when the row last changed. */
  since: string;
}

/** Activity: an agent's or the owner's event, other than acknowledging a problem about it. */
const ACTIVITY_SQL = `e.actor_kind <> 'system' AND e.type <> 'problem.acknowledged'`;

const IDLE_SQL = `
  SELECT i.id, coalesce(
    (SELECT max(e.at) FROM events e WHERE e.item_id = i.id AND ${ACTIVITY_SQL}),
    i.updated_at) AS since
  FROM items i
  WHERE i.status = 'progress' AND i.type <> 'Epic' AND i.archived_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.item_id = i.id
                    AND r.state IN ('open', 'needs_input', 'parked'))`;

/** Idle tickets, by ID: in one project, among `ids`, or everywhere. */
export function idleTickets(
  db: Db,
  now: string,
  opts: { project?: string; ids?: readonly string[] } = {},
): Map<string, IdleTicket> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.project !== undefined) {
    where.push('i.project_key = ?');
    args.push(opts.project);
  }
  if (opts.ids !== undefined) {
    if (opts.ids.length === 0) return new Map();
    where.push('i.id IN (SELECT value FROM json_each(?))');
    args.push(JSON.stringify(opts.ids));
  }
  const rows = db.sqlite
    .prepare(`${IDLE_SQL}${where.map((x) => ` AND ${x}`).join('')}`)
    .all(...args) as IdleTicket[];
  const cutoff = ms(now) - IDLE_AFTER_MS;
  return new Map(rows.filter((r) => ms(r.since) <= cutoff).map((r) => [r.id, r]));
}

export const isIdle = (db: Db, id: string, now: string) =>
  idleTickets(db, now, { ids: [id] }).has(id);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Nov 20". */
export const idleDay = (at: string) => {
  const [, m, d] = at.slice(0, 10).split('-');
  return `${MONTHS[Number(m) - 1] ?? m} ${Number(d)}`;
};

/** The problem's words: what's wrong, what fixes it, and that it's the owner's call. */
export function explainIdle(f: {
  item: string;
  since: string;
  branches: number;
}): ProblemExplanation {
  const branches =
    f.branches > 0
      ? ` It still lists ${f.branches === 1 ? '1 branch' : `${f.branches} branches`}, which the radar no longer checks.`
      : '';
  return {
    what: `${f.item} is In progress but nobody has worked on it since ${idleDay(f.since)}: no agent, no run and no activity.${branches}`,
    fix: `Move it to Planning, Ready or Inbox, cancel it, or clear its branches. If someone will pick it up again, acknowledge this.`,
    who: 'owner',
    who_text: 'You (nobody is working on it)',
  };
}

// ---- Clearing conflicts against idle tickets ----

/**
 * Clear open radar findings and undecided (or Docket-decided) overlaps that
 * involve an idle ticket, each with the reason on both tickets. Owner-decided
 * overlaps stay as the owner left them. Returns what it cleared.
 */
export function clearIdleConflicts(w: WriteContext): { findings: string[]; overlaps: string[] } {
  const idle = idleTickets(w.db, w.now);
  if (idle.size === 0) return { findings: [], overlaps: [] };
  const ids = JSON.stringify([...idle.keys()]);
  const findings = w.db.sqlite
    .prepare(
      `SELECT * FROM radar_findings WHERE cleared_at IS NULL
       AND (item_a IN (SELECT value FROM json_each(?)) OR item_b IN (SELECT value FROM json_each(?)))`,
    )
    .all(ids, ids) as Record<string, unknown>[];
  const docket = asDocket(w);
  for (const f of findings) {
    docket.update('radar_findings', f.id as string, { cleared_at: w.now });
    const items = [f.item_a, f.item_b].filter((x): x is string => typeof x === 'string');
    for (const self of items) {
      const other = items.find((x) => x !== self) ?? (f.branch_b as string);
      const why = idle.has(self) ? 'this ticket is idle' : IDLE_CLEAR_REASON;
      docket.event({
        type: 'radar.cleared',
        summary: `No longer heading for a conflict with ${other}: ${why}`,
        item_id: self,
        project_key: f.project_key as string,
        data: {
          finding_id: f.id,
          branch_a: f.branch_a,
          branch_b: f.branch_b,
          reason: 'idle',
          idle: items.filter((x) => idle.has(x)),
        },
        objects: [{ kind: 'radar_finding', id: f.id as string }],
      });
    }
  }
  const overlaps = w.db.sqlite
    .prepare(
      `SELECT * FROM part_overlaps WHERE state <> 'resolved'
       AND (state = 'open' OR decided_by = 'docket')
       AND (item_a IN (SELECT value FROM json_each(?)) OR item_b IN (SELECT value FROM json_each(?)))`,
    )
    .all(ids, ids) as Record<string, unknown>[];
  for (const o of overlaps) {
    const id = o.id as string;
    docket.update('part_overlaps', id, { state: 'resolved' });
    const pair = [o.item_a as string, o.item_b as string];
    for (const self of pair) {
      const other = pair.find((x) => x !== self)!;
      docket.event({
        type: 'overlap.decided',
        summary: `Docket: no longer an overlap with ${other}: ${idle.has(self) ? 'this ticket is idle' : IDLE_CLEAR_REASON}`,
        item_id: self,
        project_key: o.project_key as string,
        data: { overlap_id: id, decision: 'resolved', reason: 'idle' },
        objects: [
          { kind: 'overlap', id },
          { kind: 'item', id: other },
        ],
      });
    }
    // A sequence Docket added for the pair goes with it.
    if (o.link_id) {
      const link = w.get('links', o.link_id as string);
      if (link) {
        docket.remove('links', o.link_id as string);
        docket.event({
          type: 'link.removed',
          summary: `Docket removed ${String(link.from_id)} blocks ${String(link.to_id)}: ${IDLE_CLEAR_REASON}`,
          item_id: String(link.to_id),
          project_key: o.project_key as string,
          data: { link_id: o.link_id, from: link.from_id, to: link.to_id, type: link.type },
          objects: [{ kind: 'link', id: o.link_id as string }],
        });
      }
    }
  }
  return {
    findings: findings.map((f) => f.id as string),
    overlaps: overlaps.map((o) => o.id as string),
  };
}

// ---- The owner's ways forward ----

/**
 * `POST /api/items/:id/idle`: move an idle ticket to Ready, Planning or Inbox,
 * cancel it, or clear its branches (marked not active, so the radar doesn't
 * find them again by name). Refused once it has a live run again. Every write
 * carries its inverse: one undo.
 */
export function settleIdle(
  w: WriteContext,
  services: Pick<Services, 'archive'>,
  summary: (id: string) => ItemSummary,
  input: { id: string; action: IdleAction; reason?: string | undefined },
): ItemSummary {
  const item = requireItem(w.db, input.id) as ItemRow;
  if (item.type === 'Epic' || item.status !== 'progress') {
    throw new ToolError(
      'validation',
      `${item.id} is ${item.status}, so it isn't an idle ticket any more. Reload to see it.`,
      { details: { status: item.status } },
    );
  }
  const live = w.db.sqlite
    .prepare(
      `SELECT id FROM runs WHERE item_id = ? AND state IN ('open', 'needs_input', 'parked') LIMIT 1`,
    )
    .get(item.id) as { id: string } | undefined;
  if (live) {
    throw new ToolError(
      'conflict',
      `An agent is working on ${item.id} again (run ${live.id}), so it isn't idle. Reload to see it.`,
      { details: { run_id: live.id }, current: summary(item.id) },
    );
  }
  const why = input.reason?.trim() ? `: ${input.reason.trim()}` : '';
  if (input.action === 'cancel') {
    return services.archive.cancel(w, {
      id: item.id,
      expected_version: item.version,
      reason: `idle since ${idleDay(sinceOf(w.db, item.id, item.updated_at))}${why}`,
    });
  }
  if (input.action === 'clear_branches') {
    const inverse = clearBranches(w, item.id);
    if (inverse.length === 0) {
      throw new ToolError('validation', `${item.id} has no branches to clear.`, {
        details: { branches: [] },
      });
    }
    w.event({
      type: 'item.updated',
      summary: `You cleared ${item.id}'s branches: it's idle${why}`,
      item_id: item.id,
      project_key: item.project_key,
      data: { changed: { branches: { cleared: true } }, idle: true },
      inverse,
    });
    return summary(item.id);
  }
  const to = input.action;
  const inverse: InverseOp[] = [
    w.update('items', item.id, {
      status: to,
      ...(to === 'planning' ? clearApproval(w.db, item.id) : {}),
    }),
  ];
  w.event({
    type: 'item.status_changed',
    summary: `You moved ${item.id} from progress to ${to}: idle, nobody worked on it${why}`,
    item_id: item.id,
    project_key: item.project_key,
    data: { status: { old: 'progress', new: to }, reason: input.reason ?? 'idle', idle: true },
    inverse,
  });
  return summary(item.id);
}

function sinceOf(db: Db, id: string, fallback: string): string {
  const row = db.sqlite
    .prepare(`SELECT max(e.at) AS at FROM events e WHERE e.item_id = ? AND ${ACTIVITY_SQL}`)
    .get(id) as { at: string | null };
  return row.at ?? fallback;
}

/**
 * Mark every reported branch not active (B45), and forget the branch the
 * radar found by name, so it stops checking them; clears their findings.
 */
function clearBranches(w: WriteContext, id: string): InverseOp[] {
  const row = w.db.sqlite
    .prepare('SELECT branches, radar_branch, radar_branch_matches FROM items WHERE id = ?')
    .get(id) as {
    branches: string | null;
    radar_branch: string | null;
    radar_branch_matches: string | null;
  };
  const reported = reportedBranches(w.db, id);
  if (reported.length === 0 && !row.radar_branch) return [];
  const stored = row.branches ? (JSON.parse(row.branches) as Record<string, unknown>[]) : [];
  const names = new Set(reported.map((b) => b.name));
  const next = [
    ...stored.map((b) => (names.has(b.name as string) ? { ...b, removed: true } : b)),
    ...(row.radar_branch && !names.has(row.radar_branch)
      ? [{ name: row.radar_branch, by: 'owner', at: w.now, removed: true }]
      : []),
  ];
  w.db.sqlite
    .prepare(
      'UPDATE items SET branches = ?, radar_branch = NULL, radar_branch_matches = NULL WHERE id = ?',
    )
    .run(JSON.stringify(next), id);
  return [
    {
      op: 'update',
      table: 'items',
      id,
      set: {
        branches: row.branches,
        radar_branch: row.radar_branch,
        radar_branch_matches: row.radar_branch_matches,
      },
    },
    ...clearUncheckedFindings(w, id),
  ];
}
