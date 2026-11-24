/**
 * Every epic has one Release (owner decision 67; BUILD_SPEC §5.46). It replaces
 * decision 64's finish line (B81) and keeps its bug rules.
 *
 * **One per epic, created with it.** Creating an epic creates "Release <epic
 * title>" in Inbox, in the same write (`createReleaseFor`). While the epic is
 * open, the Release can be renamed but not canceled, archived, moved out or
 * retyped (`assertReleaseStays`); canceling the epic cancels it too. A second
 * Release in one epic is refused, unless the first is a generated placeholder
 * nobody has worked on yet, which the new one replaces.
 *
 * **It depends on everything else in the epic, automatically.** Every other
 * open ticket in the epic, bugs included, is one of its blockers in the one
 * evaluator (`automaticBlockers`, read by `BlockIndex`), with no link rows. A
 * ticket added mid-epic is covered the moment it lands; one moved out or
 * canceled stops counting. Links between a Release and a ticket in its own
 * epic are refused either way (`checkReleaseLink`).
 *
 * **Gates before Review or Done** (`release_gates`): every other ticket Done,
 * canceled or moved out; no open bugs; no unsettled known gaps or partial
 * exits in the epic; its own checklist (work steps and agent checks) done.
 *
 * **The epic closes when its Release is done** (`closeEpicWithRelease`).
 */
import {
  OPEN_STATUSES,
  RELEASE_GATE_LABELS,
  RELEASE_NAMED_MAX,
  RELEASE_WAYS_FORWARD,
  ToolError,
  bugCount,
  releaseTitle,
  ticketCount,
  type EpicRelease,
  type ReleaseBug,
  type ReleaseDetail,
  type ReleaseGate,
  type ReleaseHold,
  type Status,
} from '@docket/shared';
import type { Db } from '../db/client.js';
import { openPartialExit } from './exit-reports.js';
import { allocateItemId } from './ids.js';
import { activeLead, callerName, currentSteps, checkRows, type ItemRow } from './model.js';
import { onItemClosed } from './shared-changes.js';
import { typeInfoOf, type TypeInfo } from './ticket-types.js';
import type { StoredShaping } from './shaping.js';
import type { InverseOp, WriteContext } from './write.js';

const OPEN: ReadonlySet<Status> = new Set(OPEN_STATUSES);
const inJson = (ids: readonly string[]) => JSON.stringify(ids);

/** GF-2 before GF-10. */
export function compareKeys(a: string, b: string): number {
  const [pa, na] = splitKey(a);
  const [pb, nb] = splitKey(b);
  return pa.localeCompare(pb) || na - nb || a.localeCompare(b);
}
function splitKey(id: string): [string, number] {
  const m = /^(.*?)-(\d+)$/.exec(id);
  return m ? [m[1]!, Number(m[2])] : [id, 0];
}

/** Which open ticket is likeliest to finish first: the closer to done, the nearer. */
const NEAREST: Record<Status, number> = {
  done: 0,
  review: 1,
  progress: 2,
  ready: 3,
  planning: 4,
  inbox: 5,
  canceled: 6,
};
const nearestFirst = (a: TicketRow, b: TicketRow) =>
  NEAREST[a.status] - NEAREST[b.status] || compareKeys(a.id, b.id);

// ---- Reading ----

export interface ReleaseRow {
  id: string;
  title: string;
  status: Status;
  epic_id: string;
  type_info: string | null;
}

interface TicketRow {
  id: string;
  title: string;
  status: Status;
  type: ItemRow['type'];
  epic_id: string;
}

/** Each epic's Release (not archived), by epic ID. */
export function releasesOf(db: Db, epicIds: readonly string[]): Map<string, ReleaseRow> {
  const out = new Map<string, ReleaseRow>();
  if (epicIds.length === 0) return out;
  for (const r of db.sqlite
    .prepare(
      `SELECT id, title, status, epic_id, type_info FROM items
       WHERE type = 'Release' AND archived_at IS NULL
         AND epic_id IN (SELECT value FROM json_each(?))
       ORDER BY created_at, id`,
    )
    .all(inJson(epicIds)) as ReleaseRow[]) {
    if (!out.has(r.epic_id)) out.set(r.epic_id, r);
  }
  return out;
}

export function releaseOf(db: Db, epicId: string): ReleaseRow | null {
  return releasesOf(db, [epicId]).get(epicId) ?? null;
}

/** Each epic's other tickets (not the Release, not archived), by epic ID. */
function ticketsOf(db: Db, epicIds: readonly string[]): Map<string, TicketRow[]> {
  const out = new Map<string, TicketRow[]>();
  if (epicIds.length === 0) return out;
  for (const t of db.sqlite
    .prepare(
      `SELECT id, title, status, type, epic_id FROM items
       WHERE epic_id IN (SELECT value FROM json_each(?)) AND archived_at IS NULL
         AND type NOT IN ('Epic', 'Release')`,
    )
    .all(inJson(epicIds)) as TicketRow[]) {
    const list = out.get(t.epic_id) ?? [];
    list.push(t);
    out.set(t.epic_id, list);
  }
  return out;
}

const bugOf = (t: TicketRow): ReleaseBug => ({
  id: t.id,
  title: t.title,
  status: t.status as ReleaseBug['status'],
});

/** The epic page's Release section, for each epic asked about that has one or ever could. */
export function releaseDetails(db: Db, epicIds: readonly string[]): Map<string, ReleaseDetail> {
  const releases = releasesOf(db, epicIds);
  const tickets = ticketsOf(db, epicIds);
  const out = new Map<string, ReleaseDetail>();
  for (const epic of epicIds) {
    const r = releases.get(epic) ?? null;
    const open = (tickets.get(epic) ?? []).filter((t) => OPEN.has(t.status)).sort(nearestFirst);
    out.set(epic, {
      id: r?.id ?? null,
      title: r?.title ?? null,
      status: r?.status ?? null,
      left: open.map((t) => t.id),
      open_bugs: open
        .filter((t) => t.type === 'Bug')
        .sort((a, b) => compareKeys(a.id, b.id))
        .map(bugOf),
    });
  }
  return out;
}

/** Epic cards and Pick next epic: the Release, how many tickets it waits for, open bugs. */
export function epicReleases(db: Db, epicIds: readonly string[]): Map<string, EpicRelease> {
  const out = new Map<string, EpicRelease>();
  for (const [epic, d] of releaseDetails(db, epicIds)) {
    out.set(epic, { id: d.id, left: d.left.length, open_bugs: d.open_bugs.length });
  }
  return out;
}

/** On a Release while other tickets in its epic are open; else null. */
export function releaseHoldOf(
  db: Db,
  item: Pick<ItemRow, 'id' | 'epic_id' | 'type'>,
): ReleaseHold | null {
  if (item.type !== 'Release' || !item.epic_id) return null;
  const d = releaseDetails(db, [item.epic_id]).get(item.epic_id)!;
  if (d.left.length === 0) return null;
  return {
    epic: item.epic_id,
    left: d.left.length,
    waiting_on: d.left.slice(0, RELEASE_NAMED_MAX),
    open_bugs: d.open_bugs,
  };
}

// ---- The gates ----

export interface FailedGate {
  gate: ReleaseGate;
  /** The tickets (or, for `checklist`, the steps and checks) that fail it. */
  items: string[];
}

/** Each gate the Release fails, in order; empty when it may finish. */
export function releaseGates(db: Db, item: Pick<ItemRow, 'id' | 'epic_id' | 'type'>): FailedGate[] {
  if (item.type !== 'Release' || !item.epic_id) return [];
  const failed: FailedGate[] = [];
  const tickets = ticketsOf(db, [item.epic_id]).get(item.epic_id) ?? [];
  const open = tickets.filter((t) => OPEN.has(t.status)).sort(nearestFirst);
  const openOther = open.filter((t) => t.type !== 'Bug').map((t) => t.id);
  const openBugs = open.filter((t) => t.type === 'Bug').map((t) => t.id);
  if (openOther.length > 0) failed.push({ gate: 'open_tickets', items: openOther });
  if (openBugs.length > 0) failed.push({ gate: 'open_bugs', items: openBugs });

  // Known gaps left open (decision 58) and partial exits nobody settled (decision 61), on
  // any ticket in the epic that isn't canceled, the Release included.
  const live = [...tickets.filter((t) => t.status !== 'canceled').map((t) => t.id), item.id];
  const unsettled = new Set<string>();
  for (const g of db.sqlite
    .prepare(
      `SELECT id, known_gaps FROM items WHERE known_gaps IS NOT NULL
       AND id IN (SELECT value FROM json_each(?))`,
    )
    .all(inJson(live)) as { id: string; known_gaps: string }[]) {
    if (hasOpenGap(g.known_gaps)) unsettled.add(g.id);
  }
  for (const id of live) if (openPartialExit(db, id)) unsettled.add(id);
  if (unsettled.size > 0) {
    failed.push({ gate: 'unsettled', items: [...unsettled].sort(compareKeys) });
  }

  const steps = currentSteps(db, item.id).filter(
    (s) => s.state !== 'done' && s.state !== 'skipped',
  );
  const checks = checkRows(db, item.id).filter((c) => c.state !== 'pass' && c.state !== 'skipped');
  if (steps.length + checks.length > 0) {
    failed.push({
      gate: 'checklist',
      items: [...steps.map((s) => `step: ${s.text}`), ...checks.map((c) => `check: ${c.text}`)],
    });
  }
  return failed;
}

function hasOpenGap(raw: string): boolean {
  try {
    const v = JSON.parse(raw) as { gaps?: { settled?: string | null }[] };
    return Array.isArray(v.gaps) && v.gaps.some((g) => !g.settled);
  } catch {
    return false;
  }
}

const listed = (ids: readonly string[], max = 5) =>
  ids.length > max
    ? `${ids.slice(0, max).join(', ')} and ${ids.length - max} more`
    : ids.join(', ');

/** The `release_gates` refusal: each failing gate, and what to do about it. */
export function releaseGatesError(
  item: Pick<ItemRow, 'id' | 'epic_id'>,
  failed: readonly FailedGate[],
  to: 'review' | 'done',
): ToolError {
  const parts = failed.map((f) => {
    switch (f.gate) {
      case 'open_tickets':
        return `${ticketCount(f.items.length)} still open: ${listed(f.items)}`;
      case 'open_bugs':
        return `${bugCount(f.items.length)} open: ${listed(f.items)}`;
      case 'unsettled':
        return `unsettled known gaps or partial exits on ${listed(f.items)} (record how each gap was settled with update_item known_gaps; settle each partial exit)`;
      case 'checklist':
        return `its own checklist isn't done: ${listed(f.items, 3)}`;
    }
  });
  const holds = failed.some((f) => f.gate === 'open_tickets' || f.gate === 'open_bugs');
  return new ToolError(
    'release_gates',
    `${item.id} is the Release of epic ${item.epic_id}, so it can't move to ${to === 'review' ? 'Review' : 'Done'} yet: ${parts.join('; ')}.${holds ? ` For each open ticket: ${RELEASE_WAYS_FORWARD.join('; or ')}.` : ''}`,
    {
      details: {
        epic: item.epic_id,
        release: item.id,
        gates: failed.map((f) => ({
          gate: f.gate,
          label: RELEASE_GATE_LABELS[f.gate],
          items: f.items,
        })),
        ...(holds ? { ways_forward: ['finish', 'move', 'cancel'] } : {}),
      },
    },
  );
}

/** Throw `release_gates` when a Release would move to Review or Done with a gate failing. */
export function assertReleaseClear(
  db: Db,
  item: Pick<ItemRow, 'id' | 'epic_id' | 'type'>,
  to: 'review' | 'done',
): void {
  const failed = releaseGates(db, item);
  if (failed.length > 0) throw releaseGatesError(item, failed, to);
}

// ---- Creating ----

const RELEASE_DESCRIPTION = (epic: string) =>
  `The closing ticket of ${epic}: it owns the checks across tickets (journeys, flag-on checks, release QA), the deploy and the release decision. It waits for every other ticket in the epic, and finishes only with no open bugs, no unsettled known gaps or partial exits, and its own checklist done. Shape its checklist with the epic.`;

/**
 * Create the epic's Release in this write: "Release <epic title>" in Inbox,
 * with the epic's priority. `shaping` marks it Needs shaping (an ambiguous
 * migration). Returns its ID.
 */
export function createReleaseFor(
  w: WriteContext,
  epic: Pick<ItemRow, 'id' | 'project_key' | 'title' | 'priority'>,
  opts: { shaping?: StoredShaping; summary?: string } = {},
): string {
  const id = allocateItemId(w.db.sqlite, epic.project_key);
  const title = releaseTitle(epic.title);
  w.insert('items', {
    id,
    project_key: epic.project_key,
    type: 'Release',
    title,
    description_md: RELEASE_DESCRIPTION(epic.id),
    outcome_md: '',
    status: 'inbox',
    priority: epic.priority,
    epic_id: epic.id,
    imported: false,
    type_info: JSON.stringify({ generated: true } satisfies TypeInfo),
    ...(opts.shaping ? { shaping: JSON.stringify(opts.shaping) } : {}),
  });
  w.event({
    type: 'item.created',
    summary: opts.summary ?? `Docket created ${id} ${title}, the Release of epic ${epic.id}`,
    item_id: id,
    project_key: epic.project_key,
    data: { status: 'inbox', release_of: epic.id, labels_created: [] },
    objects: [{ kind: 'item', id: epic.id }],
  });
  return id;
}

/**
 * Making `item` the Release of `epicId` (a create or a type change): refused
 * when the epic already has one, unless that one is a generated placeholder
 * nobody has worked on (Inbox or Planning, never led), which this replaces:
 * it is canceled and archived in the same write. Returns the replaced ID.
 */
export function makeRoomForRelease(
  w: WriteContext,
  epicId: string,
  item: { id?: string },
): string | null {
  const current = releaseOf(w.db, epicId);
  if (!current || current.id === item.id) return null;
  const info = typeInfoOf(current.type_info);
  const untouched =
    info?.generated === true &&
    (current.status === 'inbox' || current.status === 'planning') &&
    !w.db.sqlite.prepare('SELECT 1 FROM runs WHERE item_id = ? LIMIT 1').get(current.id);
  if (!untouched) {
    throw new ToolError(
      'validation',
      `Epic ${epicId} already has its Release, ${current.id}; an epic has exactly one. Rename it, or fold this work into its checklist.`,
      { details: { epic: epicId, release: current.id } },
    );
  }
  const row = w.require('items', current.id) as unknown as ItemRow;
  w.update('items', current.id, { status: 'canceled', archived_at: w.now, shaping: null });
  w.event({
    type: 'item.status_changed',
    summary: `${callerName(w.db, w.actor)} replaced ${current.id}, the generated Release of ${epicId}, with ${item.id ?? 'a new Release'}: canceled and archived`,
    item_id: current.id,
    project_key: row.project_key,
    data: { status: { old: row.status, new: 'canceled' }, reason: 'replaced as the Release' },
  });
  return current.id;
}

// ---- Keeping it ----

const epicOpen = (db: Db, epicId: string) => {
  const e = db.sqlite.prepare('SELECT status FROM items WHERE id = ?').get(epicId) as
    { status: Status } | undefined;
  return !!e && OPEN.has(e.status);
};

const STAYS_WORDS = {
  cancel: 'canceled',
  archive: 'archived',
  move: 'moved out of its epic',
  retype: 'given another type',
} as const;

/**
 * A Release can be renamed but not removed while its epic is open: not
 * canceled, archived, moved to another epic or retyped. Canceling the epic
 * cancels it along with it.
 */
export function assertReleaseStays(
  db: Db,
  item: Pick<ItemRow, 'id' | 'type' | 'epic_id'>,
  change: keyof typeof STAYS_WORDS,
): void {
  if (item.type !== 'Release' || !item.epic_id || !epicOpen(db, item.epic_id)) return;
  throw new ToolError(
    'validation',
    `${item.id} is the Release of epic ${item.epic_id}, so it can't be ${STAYS_WORDS[change]} while the epic is open. Rename it if the name is wrong; to drop the epic, cancel the epic.`,
    { details: { epic: item.epic_id, release: item.id } },
  );
}

/**
 * Links between a Release and a ticket in its own epic: nothing inside the
 * epic depends on its Release, and it already depends on everything else.
 */
export function checkReleaseLink(db: Db, from: string, to: string): void {
  const rows = db.sqlite
    .prepare('SELECT id, type, epic_id FROM items WHERE id IN (?, ?)')
    .all(from, to) as { id: string; type: string; epic_id: string | null }[];
  const a = rows.find((r) => r.id === from);
  const b = rows.find((r) => r.id === to);
  if (!a || !b || !a.epic_id || a.epic_id !== b.epic_id) return;
  if (a.type === 'Release') {
    throw new ToolError(
      'validation',
      `${from} is the Release of epic ${a.epic_id}: nothing inside the epic depends on it. Link ${to} to the ticket it really waits for.`,
      { details: { release: from, epic: a.epic_id } },
    );
  }
  if (b.type === 'Release') {
    throw new ToolError(
      'validation',
      `${to} is the Release of epic ${b.epic_id}, so it already waits for ${from} and every other ticket in the epic. No link needed.`,
      { details: { release: to, epic: b.epic_id } },
    );
  }
}

// ---- Closing the epic ----

/**
 * The epic closes when its Release is done (decision 67), in the same write:
 * its lead run ends, and it moves to Done as the same caller. It stays open,
 * with a note, while human review items on the epic are undecided.
 */
export function closeEpicWithRelease(
  w: WriteContext,
  release: Pick<ItemRow, 'id' | 'epic_id' | 'type'>,
): InverseOp[] {
  const inverse: InverseOp[] = [];
  if (release.type !== 'Release' || !release.epic_id) return inverse;
  const epic = w.db.sqlite.prepare('SELECT * FROM items WHERE id = ?').get(release.epic_id) as
    ItemRow | undefined;
  if (!epic || !OPEN.has(epic.status)) return inverse;
  const undecided = w.db.sqlite
    .prepare(
      "SELECT count(*) AS n FROM hr_items WHERE item_id = ? AND state IN ('declared', 'ready')",
    )
    .get(epic.id) as { n: number };
  if (undecided.n > 0) {
    w.warn(
      `Epic ${epic.id} stays open: ${undecided.n} human review item${undecided.n === 1 ? ' is' : 's are'} on it undecided. Its Release ${release.id} is done.`,
    );
    return inverse;
  }
  const lead = activeLead(w.db, epic.id);
  if (lead) {
    inverse.push(
      w.update('runs', lead.id, {
        state: 'finished',
        end_reason: 'finished',
        summary: `Closed ${epic.id} as Done with its Release ${release.id}`,
      }),
    );
    w.event({
      type: 'run.ended',
      summary: `Lead run finished: ${epic.id} closed with its Release`,
      item_id: epic.id,
      project_key: epic.project_key,
      data: { run_id: lead.id, end_reason: 'finished' },
      objects: [{ kind: 'run', id: lead.id }],
    });
  }
  inverse.push(
    w.update('items', epic.id, {
      status: 'done',
      closed_by: w.actor.kind === 'owner' ? 'owner' : 'agent',
      closed_at: w.now,
    }),
  );
  w.event({
    type: 'item.status_changed',
    summary: `${epic.id} closed: its Release ${release.id} is done`,
    item_id: epic.id,
    project_key: epic.project_key,
    data: { status: { old: epic.status, new: 'done' }, release: release.id },
    objects: [{ kind: 'item', id: release.id }],
  });
  onItemClosed(w, epic.id, 'done');
  return inverse;
}

/**
 * Remove the `blocks` links between a new Release and tickets in its own epic:
 * its dependency on every other ticket is automatic, and nothing in the epic
 * may depend on it. Each removal is in Activity.
 */
export function dropEpicLinks(
  w: WriteContext,
  release: Pick<ItemRow, 'id' | 'project_key'>,
  epicId: string,
): void {
  const links = w.db.sqlite
    .prepare(
      `SELECT l.id, l.from_id, l.to_id FROM links l
       JOIN items a ON a.id = l.from_id JOIN items b ON b.id = l.to_id
       WHERE l.type = 'blocks' AND (l.from_id = ? OR l.to_id = ?)
         AND a.epic_id = ? AND b.epic_id = ?`,
    )
    .all(release.id, release.id, epicId, epicId) as {
    id: string;
    from_id: string;
    to_id: string;
  }[];
  for (const l of links) {
    w.remove('links', l.id);
    w.event({
      type: 'link.removed',
      summary: `${l.from_id} no longer blocks ${l.to_id}: ${release.id} is the Release of ${epicId}, which waits for every other ticket in it on its own`,
      item_id: l.to_id,
      project_key: release.project_key,
      data: { link_id: l.id, from: l.from_id, to: l.to_id, type: 'blocks' },
      objects: [{ kind: 'item', id: l.from_id }],
    });
  }
}

/**
 * Decision 67: an Exploration finishes with its findings, linked to the tickets
 * that use them. `findings` is the write-up (set_status reason, or the packet
 * summary); throws `validation` when it or the link is missing.
 */
export function assertExplorationFinish(
  db: Db,
  item: Pick<ItemRow, 'id' | 'type'>,
  findings: string | null | undefined,
): void {
  if (item.type !== 'Exploration') return;
  if (!findings?.trim()) {
    throw new ToolError(
      'validation',
      `${item.id} is an Exploration: it finishes with its findings. Pass reason: a short write-up with a recommendation.`,
      { details: { fields: { reason: 'the findings are required to close an Exploration' } } },
    );
  }
  const linked = db.sqlite
    .prepare(
      `SELECT 1 FROM links WHERE from_id = @id OR (type = 'relates' AND to_id = @id) LIMIT 1`,
    )
    .get({ id: item.id });
  if (!linked) {
    throw new ToolError(
      'validation',
      `Link ${item.id} to the tickets that use its findings first (link_items: blocks, or relates), then close it.`,
      { details: { reason: 'findings_unlinked' } },
    );
  }
}
