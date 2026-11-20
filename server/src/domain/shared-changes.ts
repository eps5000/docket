/**
 * Shared changes and conflict guardrails (owner decision 36; BUILD_SPEC
 * §5.21; FR-158–FR-164; MCP_SPEC §5.15; tasks.md T182).
 *
 * B38 implements:
 * - **The registry** (FR-158): agents add parts through
 *   `declare_shared_changes`'s `new_parts` (never single-writer); the owner
 *   creates, edits, marks single-writer and archives (`shared_part.saved`,
 *   undoable).
 * - **Declarations** (FR-159): `declare_shared_changes` and the owner's
 *   `PUT /api/items/:id/shared` replace an item's declaration, or declare
 *   none (`items.shared_none_at`), with event `shared.declared` (undoable for
 *   the owner). The item's version doesn't move: a declaration isn't an edit
 *   of the item, so an agent's `expected_version` stays good.
 * - **Reads:** `list_shared_parts`, the item's Shared changes section and the
 *   radar card (from the tables; overlaps, leases, holds and findings stay
 *   empty until B39 writes them).
 * - **Informational overlaps** on a declaration: the other in-flight items
 *   (Ready, In progress, Review) declaring the same parts, except pairs the
 *   owner marked compatible and pairs a `blocks` link already sequences.
 *   `overlapsFor` is the rule B39's claim check reuses.
 *
 * B39 (T183) adds the guards (BUILD_SPEC §5.21 Rules):
 * - **the Ready gate** (`assertReadyGate`; items.ts calls it, the owner may
 *   override with a reason);
 * - **the overlap check at the claim** (`claimOverlaps`, `SeamConflict`;
 *   runs.ts): one `part_overlaps` row per pair is the owner question, and
 *   *Run one after the other* or *They're compatible* decide it. Declaring
 *   later, while claimed, raises it without revoking the claim. A pair that
 *   no longer applies becomes `resolved`;
 * - **leases** on single-writer parts (`DOCKET_LEASE_MINUTES`, default 120):
 *   expiry is lazy (reads skip an expired lease, a take ends it); a lease
 *   ends on Done, a hand-off, a release by the holder or the owner;
 * - **the changed-file mapping** through each part's path globs, and the hold
 *   at hand-off (`raiseHold`, `HoldRefusal`): a held packet, or a refused
 *   close, with *Add to the declaration* or *Send back*;
 * - **`get_context.shared`** (`contextFor`; context.ts cuts it to the budget).
 *
 * The conflict radar (T184) is radar.ts.
 */
import {
  IN_FLIGHT_STATUSES,
  LIMITS,
  ToolError,
  type ContextShared,
  type Declaration,
  type DeclaredChange,
  type InFlightChange,
  type ItemSharedResponse,
  type LeaseRow,
  type OverlapFound,
  type OverlapRow,
  type RadarFindingRow,
  type RadarResponse,
  type SharedChange,
  type SharedPartKind,
  type SharedPartOwnerRow,
  type SharedPartRow,
  type Status,
  type UndeclaredHoldRow,
} from '@docket/shared';
import type { Db } from '../db/client.js';
import { type ReadContext, type ServiceDeps, type SharedChangesService } from './contracts.js';
import { newId } from './ids.js';
import {
  clearFinding,
  finishRadar,
  planRadar,
  recordRadar,
  resolveRepoPath,
  validBranch,
} from './radar.js';
import {
  activeLead,
  callerName,
  isoPlus,
  leaseExpired,
  ms,
  requireItem,
  utcTime,
  type RunRow,
} from './model.js';
import type { InverseOp, WriteContext } from './write.js';

// ---- Rows ----

interface PartRow {
  id: string;
  project_key: string;
  key: string;
  kind: SharedPartKind;
  paths: string;
  single_writer: number;
  note: string | null;
  created_by: string;
  archived_at: string | null;
  version: number;
}

interface ChangeRow {
  id: string;
  item_id: string;
  part_key: string;
  change: SharedChange;
  note: string | null;
  declared_by: string;
  declared_at: string;
}

const statusSql = (statuses: readonly Status[]) => `(${statuses.map((s) => `'${s}'`).join(', ')})`;

/**
 * Items whose declared parts a claim is checked against (BUILD_SPEC §5.21
 * Overlap at claim; FR-160): In progress and Review. A Ready item has no
 * live claim (claiming moves it to In progress), so two Ready items that
 * declare the same part never refuse each other's first claim.
 */
export const CLAIMED_STATUSES = ['progress', 'review'] as const satisfies readonly Status[];

const parseList = (json: string | null): string[] => (json ? (JSON.parse(json) as string[]) : []);

function requireProject(db: Db, key: string): void {
  const row = db.sqlite
    .prepare('SELECT key FROM projects WHERE key = ? AND deleted_at IS NULL')
    .get(key);
  if (!row)
    throw new ToolError('not_found', `No project ${key}. Check the key with list_projects.`);
}

function partByKey(db: Db, project: string, key: string): PartRow | undefined {
  return db.sqlite
    .prepare('SELECT * FROM shared_parts WHERE project_key = ? AND key = ?')
    .get(project, key) as PartRow | undefined;
}

const kindOf = (key: string) => key.slice(0, key.indexOf(':')) as SharedPartKind;

/** The in-flight items (other than `except`) that declared a change to `key`, by item ID. */
function inFlightFor(
  db: Db,
  project: string,
  key: string,
  except?: string,
  statuses: readonly Status[] = IN_FLIGHT_STATUSES,
): InFlightChange[] {
  const rows = db.sqlite
    .prepare(
      `SELECT i.id, i.title, i.status, c.change, c.note
       FROM item_shared_changes c JOIN items i ON i.id = c.item_id
       WHERE i.project_key = ? AND c.part_key = ? AND i.status IN ${statusSql(statuses)}
         AND i.archived_at IS NULL AND i.id <> ?
       ORDER BY length(i.id), i.id`,
    )
    .all(project, key, except ?? '') as {
    id: string;
    title: string;
    status: Status;
    change: SharedChange;
    note: string | null;
  }[];
  return rows;
}

function liveLease(db: Db, project: string, key: string, now: string) {
  return db.sqlite
    .prepare(
      `SELECT id, item_id, run_id, expires_at FROM part_leases
       WHERE project_key = ? AND part_key = ? AND ended_at IS NULL AND expires_at > ?`,
    )
    .get(project, key, now) as
    { id: string; item_id: string; run_id: string | null; expires_at: string } | undefined;
}

function agentPart(db: Db, row: PartRow, now: string): SharedPartRow {
  const lease = liveLease(db, row.project_key, row.key, now);
  return {
    key: row.key,
    kind: row.kind,
    paths: parseList(row.paths),
    single_writer: !!row.single_writer,
    note: row.note,
    created_by: row.created_by,
    archived: row.archived_at !== null,
    in_flight: inFlightFor(db, row.project_key, row.key),
    lease: lease ? { item_id: lease.item_id, held_until: lease.expires_at } : null,
  };
}

function ownerPart(db: Db, row: PartRow, now: string): SharedPartOwnerRow {
  const lease = liveLease(db, row.project_key, row.key, now);
  return {
    ...agentPart(db, row, now),
    id: row.id,
    archived_at: row.archived_at,
    version: row.version,
    lease: lease
      ? {
          lease_id: lease.id,
          item_id: lease.item_id,
          run_id: lease.run_id,
          held_until: lease.expires_at,
        }
      : null,
  };
}

function declarationOf(db: Db, itemId: string): Declaration {
  const item = db.sqlite.prepare('SELECT shared_none_at FROM items WHERE id = ?').get(itemId) as {
    shared_none_at: string | null;
  };
  const rows = db.sqlite
    .prepare('SELECT * FROM item_shared_changes WHERE item_id = ? ORDER BY part_key')
    .all(itemId) as ChangeRow[];
  const changes: DeclaredChange[] = rows.map((r) => ({
    part: r.part_key,
    kind: kindOf(r.part_key),
    change: r.change,
    note: r.note,
  }));
  if (rows.length > 0) {
    const latest = rows.reduce((a, b) => (b.declared_at > a.declared_at ? b : a));
    return {
      item_id: itemId,
      state: 'declared',
      changes,
      declared_by: latest.declared_by,
      declared_at: latest.declared_at,
    };
  }
  if (item.shared_none_at) {
    // Who declared none is on the latest shared.declared event.
    const ev = db.sqlite
      .prepare(
        `SELECT actor_kind, client, label FROM events
         WHERE item_id = ? AND type = 'shared.declared' ORDER BY seq DESC LIMIT 1`,
      )
      .get(itemId) as
      { actor_kind: string; client: string | null; label: string | null } | undefined;
    const by = !ev
      ? null
      : ev.actor_kind !== 'agent'
        ? ev.actor_kind
        : ev.label
          ? `${ev.client ?? 'agent'} · ${ev.label}`
          : (ev.client ?? 'agent');
    return {
      item_id: itemId,
      state: 'none',
      changes: [],
      declared_by: by,
      declared_at: item.shared_none_at,
    };
  }
  return {
    item_id: itemId,
    state: 'not_declared',
    changes: [],
    declared_by: null,
    declared_at: null,
  };
}

/** Whether a `blocks` link joins the two items, either way. */
function sequenced(db: Db, a: string, b: string): boolean {
  return !!db.sqlite
    .prepare(
      `SELECT 1 FROM links WHERE type = 'blocks'
       AND ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)) LIMIT 1`,
    )
    .get(a, b, b, a);
}

/** Whether the owner marked the pair compatible (a live overlap in state `compatible`). */
function compatible(db: Db, a: string, b: string): boolean {
  const [x, y] = a < b ? [a, b] : [b, a];
  return !!db.sqlite
    .prepare(
      `SELECT 1 FROM part_overlaps WHERE item_a = ? AND item_b = ? AND state = 'compatible' LIMIT 1`,
    )
    .get(x, y);
}

/**
 * The other in-flight items that declare any of `keys`, grouped by item:
 * an overlap unless the pair is compatible or sequenced by a `blocks` link
 * (BUILD_SPEC §5.21 Overlap at claim). B39's claim check reuses it.
 */
export function overlapsFor(
  db: Db,
  itemId: string,
  project: string,
  keys: string[],
  statuses: readonly Status[] = IN_FLIGHT_STATUSES,
): OverlapFound[] {
  const byItem = new Map<string, OverlapFound>();
  for (const key of keys) {
    for (const other of inFlightFor(db, project, key, itemId, statuses)) {
      let found = byItem.get(other.id);
      if (!found) {
        if (compatible(db, itemId, other.id) || sequenced(db, itemId, other.id)) continue;
        found = { with: { id: other.id, title: other.title, status: other.status }, parts: [] };
        byItem.set(other.id, found);
      }
      found.parts.push(key);
    }
  }
  return [...byItem.values()];
}

// ---- Declaring ----

interface DeclareInput {
  id: string;
  changes?: { part: string; change: SharedChange; note?: string }[];
  none?: true;
  new_parts?: {
    key: string;
    kind?: SharedPartKind;
    paths?: string[];
    note?: string;
    single_writer?: boolean;
  }[];
}

/** Insert a registry row; returns the inverse. */
function insertPart(
  w: WriteContext,
  project: string,
  part: { key: string; paths?: string[]; note?: string | null; single_writer?: boolean },
  createdBy: string,
): { id: string; inverse: InverseOp } {
  const id = newId('spt', ms(w.now));
  const inverse = w.insert('shared_parts', {
    id,
    project_key: project,
    key: part.key,
    kind: kindOf(part.key),
    paths: part.paths ?? [],
    single_writer: part.single_writer ?? false,
    note: part.note ?? null,
    created_by: createdBy,
    archived_at: null,
    version: 1,
  });
  return { id, inverse };
}

/** Replace an item's declaration (the agent tool and the owner's route share it). */
function declare(
  w: WriteContext,
  input: DeclareInput,
): { declaration: Declaration; registered: string[]; overlaps: OverlapFound[] } {
  const db = w.db;
  const item = requireItem(db, input.id);
  if (item.status === 'done' || item.status === 'canceled') {
    throw new ToolError(
      'validation',
      `${item.id} is ${item.status === 'done' ? 'done' : 'canceled'}; declare shared changes on open items only.`,
    );
  }
  const project = item.project_key;
  const who = callerName(db, w.actor);
  const isOwner = w.actor.kind === 'owner';

  // New parts first, so the changes can name them.
  const registered: string[] = [];
  for (const part of input.new_parts ?? []) {
    if (partByKey(db, project, part.key)) continue; // already registered: reused as it is
    const { id, inverse } = insertPart(
      w,
      project,
      { ...part, single_writer: isOwner ? (part.single_writer ?? false) : false },
      who,
    );
    registered.push(part.key);
    w.event({
      type: 'shared_part.saved',
      summary: `Registered shared part ${part.key}`,
      project_key: project,
      data: { part_id: id, key: part.key, created: true },
      objects: [{ kind: 'shared_part', id }],
      inverse: [inverse],
    });
  }

  const changes = input.changes ?? [];
  const missing: string[] = [];
  const archived: string[] = [];
  for (const c of changes) {
    const part = partByKey(db, project, c.part);
    if (!part) missing.push(c.part);
    else if (part.archived_at) archived.push(c.part);
  }
  if (missing.length > 0 || archived.length > 0) {
    const parts = [
      missing.length > 0 ? `isn't registered in ${project}: ${missing.join(', ')}` : null,
      archived.length > 0 ? `is archived: ${archived.join(', ')}` : null,
    ].filter(Boolean);
    throw new ToolError(
      'validation',
      `A part you named ${parts.join('; and one ')}. Name parts from list_shared_parts ${project}, or register a new one with new_parts.`,
      { details: { parts: [...missing, ...archived] } },
    );
  }

  // Replace the declaration: remove unlisted parts, update changed ones, add new ones.
  const inverse: InverseOp[] = [];
  const existing = db.sqlite
    .prepare('SELECT * FROM item_shared_changes WHERE item_id = ?')
    .all(item.id) as ChangeRow[];
  const wanted = new Map(changes.map((c) => [c.part, c]));
  for (const row of existing) {
    if (!wanted.has(row.part_key)) inverse.push(w.remove('item_shared_changes', row.id));
  }
  for (const c of changes) {
    const row = existing.find((r) => r.part_key === c.part);
    const note = c.note ?? null;
    if (row) {
      if (row.change !== c.change || row.note !== note) {
        inverse.push(
          w.update('item_shared_changes', row.id, {
            change: c.change,
            note,
            declared_by: who,
            declared_at: w.now,
          }),
        );
      }
    } else {
      inverse.push(
        w.insert('item_shared_changes', {
          id: newId('isc', ms(w.now)),
          item_id: item.id,
          part_key: c.part,
          change: c.change,
          note,
          declared_by: who,
          declared_at: w.now,
        }),
      );
    }
  }

  // `shared_none_at` without touching the item's version (see the header).
  const noneBefore = (
    db.sqlite.prepare('SELECT shared_none_at FROM items WHERE id = ?').get(item.id) as {
      shared_none_at: string | null;
    }
  ).shared_none_at;
  const noneAfter = input.none ? w.now : null;
  if (noneBefore !== noneAfter) {
    db.sqlite.prepare('UPDATE items SET shared_none_at = ? WHERE id = ?').run(noneAfter, item.id);
    inverse.push({
      op: 'update',
      table: 'items',
      id: item.id,
      set: { shared_none_at: noneBefore },
    });
  }

  const listed = changes.map((c) => `${c.part} ${c.change}`).join(', ');
  w.event({
    type: 'shared.declared',
    summary: input.none
      ? `Declared no shared changes on ${item.id}`
      : `Declared shared changes on ${item.id}: ${listed}`,
    item_id: item.id,
    project_key: project,
    data: {
      none: !!input.none,
      changes: changes.map((c) => ({ part: c.part, change: c.change })),
      previous: existing.map((r) => ({ part: r.part_key, change: r.change })),
      registered,
    },
    inverse,
  });

  // Declaring later (BUILD_SPEC §5.21): while the item is claimed, a new overlap with other
  // claimed work flags both items and raises the question, without revoking either claim.
  // Undecided pairs that no longer share a part resolve.
  resolveOverlaps(w, item.id);
  if (!input.none && (CLAIMED_STATUSES as readonly Status[]).includes(item.status)) {
    const keys = changes.map((c) => c.part);
    for (const o of overlapsFor(db, item.id, project, keys, CLAIMED_STATUSES)) {
      const mineFirst = claimedAt(db, item.id) < claimedAt(db, o.with.id);
      const [first, other] = mineFirst ? [item.id, o.with.id] : [o.with.id, item.id];
      raiseOverlap(w, project, first, other, o.parts, 'declared');
    }
  }

  return {
    declaration: declarationOf(db, item.id),
    registered,
    overlaps: input.none
      ? []
      : overlapsFor(
          db,
          item.id,
          project,
          changes.map((c) => c.part),
        ),
  };
}

// ---- Guards (B39, T183): the Ready gate, overlaps, leases, holds ----

/** `model:Token` → `model Token`, the way Needs you and Activity say a part. */
export function partLabel(key: string): string {
  const colon = key.indexOf(':');
  return colon < 0 ? key : `${key.slice(0, colon)} ${key.slice(colon + 1)}`;
}

/** Up to three part labels, then `and n more`. */
function partsText(keys: string[]): string {
  const shown = keys.slice(0, 3).map(partLabel);
  if (keys.length > 3) shown.push(`${keys.length - 3} more`);
  return shown.length <= 1
    ? (shown[0] ?? '')
    : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]!}`;
}

/** The parts an item declares, by key. */
export function declaredKeys(db: Db, itemId: string): string[] {
  return (
    db.sqlite
      .prepare('SELECT part_key FROM item_shared_changes WHERE item_id = ? ORDER BY part_key')
      .all(itemId) as { part_key: string }[]
  ).map((r) => r.part_key);
}

/** Whether the item has declared its shared changes: one or more parts, or none. */
export function hasDeclared(db: Db, itemId: string): boolean {
  const row = db.sqlite
    .prepare(
      `SELECT shared_none_at,
         (SELECT count(*) FROM item_shared_changes WHERE item_id = items.id) AS n
       FROM items WHERE id = ?`,
    )
    .get(itemId) as { shared_none_at: string | null; n: number } | undefined;
  return !!row && (row.n > 0 || row.shared_none_at !== null);
}

/**
 * The Ready gate (BUILD_SPEC §5.21; FR-159): moving an item to Ready needs
 * its shared changes declared, or none. Agents can't pass it; the owner may,
 * with a reason (`override_reason`), recorded in Activity by the caller.
 */
export function assertReadyGate(db: Db, item: { id: string }, owner = false): void {
  if (hasDeclared(db, item.id)) return;
  throw new ToolError(
    'not_declared',
    owner
      ? `Declare the shared parts ${item.id} will change (or none) before it moves to Ready, or give a reason to move it anyway.`
      : `Declare the shared parts ${item.id} will change (or none) with declare_shared_changes, then move it to Ready.`,
  );
}

/** When the item's current lead claimed it (its latest lead run), for "claimed first". */
function claimedAt(db: Db, itemId: string): string {
  const row = db.sqlite
    .prepare('SELECT max(created_at) AS at FROM runs WHERE item_id = ? AND is_lead = 1')
    .get(itemId) as { at: string | null };
  return row.at ?? '9999';
}

function liveOverlapRow(db: Db, a: string, b: string) {
  const [x, y] = a < b ? [a, b] : [b, a];
  return db.sqlite
    .prepare(`SELECT * FROM part_overlaps WHERE item_a = ? AND item_b = ? AND state <> 'resolved'`)
    .get(x, y) as Record<string, unknown> | undefined;
}

/**
 * Open the owner question for a pair (BUILD_SPEC §5.21; FR-160): one
 * `part_overlaps` row per pair, never a second while one is live. `first` is
 * the item claimed first (*Run one after the other* makes it the blocker).
 * Events `overlap.raised` on both items. Returns the new row's ID, or null
 * when the pair already has a live question (its parts are kept current).
 */
export function raiseOverlap(
  w: WriteContext,
  project: string,
  first: string,
  other: string,
  parts: string[],
  why: 'claim' | 'declared',
): string | null {
  const live = liveOverlapRow(w.db, first, other);
  if (live) {
    const had = parseList(live.parts as string);
    const merged = [...new Set([...had, ...parts])].sort();
    if (live.state === 'open' && merged.length !== had.length) {
      w.update('part_overlaps', live.id as string, { parts: merged });
    }
    return null;
  }
  const [a, b] = first < other ? [first, other] : [other, first];
  const id = newId('pov', ms(w.now));
  const sorted = [...parts].sort();
  w.insert('part_overlaps', {
    id,
    project_key: project,
    item_a: a,
    item_b: b,
    claimed_first: first,
    parts: sorted,
    state: 'open',
    note: null,
    link_id: null,
    raised_at: w.now,
    decided_by: null,
    decided_at: null,
    version: 1,
  });
  const both = `${first} and ${other} both change ${partsText(sorted)}`;
  for (const [self, peer] of [
    [first, other],
    [other, first],
  ] as const) {
    w.event({
      type: 'overlap.raised',
      summary:
        why === 'claim'
          ? self === other
            ? `${both}: the claim of ${other} was refused until you decide`
            : `${both}: ${other} waits until you decide`
          : `Now overlaps ${peer} on ${partsText(sorted)}: you've been asked whether they can run together`,
      item_id: self,
      project_key: project,
      data: { overlap_id: id, with: peer, parts: sorted, claimed_first: first, why },
      objects: [
        { kind: 'overlap', id },
        { kind: 'item', id: peer },
      ],
    });
  }
  return id;
}

/**
 * Overlaps that no longer apply become `resolved` (enums.ts OVERLAP_STATES):
 * either item closed or was canceled, or (while still undecided) the two no
 * longer declare a common part. A resolved pair can be raised again later.
 */
export function resolveOverlaps(w: WriteContext, itemId: string): void {
  const rows = w.db.sqlite
    .prepare(`SELECT * FROM part_overlaps WHERE (item_a = ? OR item_b = ?) AND state <> 'resolved'`)
    .all(itemId, itemId) as Record<string, unknown>[];
  for (const row of rows) {
    const a = itemRef(w.db, row.item_a as string);
    const b = itemRef(w.db, row.item_b as string);
    const closed = [a.status, b.status].some((s) => s === 'done' || s === 'canceled');
    let stale = closed;
    if (!stale && row.state === 'open') {
      const mine = new Set(declaredKeys(w.db, a.id));
      stale = !declaredKeys(w.db, b.id).some((k) => mine.has(k));
    }
    if (stale) w.update('part_overlaps', row.id as string, { state: 'resolved' });
  }
}

/**
 * A claim refused because the item's parts overlap in-flight work
 * (`seam_conflict`; MCP_SPEC §5.15). Like `ClaimConflict`, the refusal rolls
 * the claim's transaction back, so the adapter writes `recordRejection` on
 * its own: a `claim.rejected` event and one owner question per pair.
 */
export class SeamConflict extends ToolError {
  readonly recordRejection: (w: WriteContext) => void;
  constructor(item: { id: string; project_key: string }, overlaps: OverlapFound[]) {
    const parts = [...new Set(overlaps.flatMap((o) => o.parts))].sort();
    const withText = overlaps
      .map((o) => `${o.with.id} (${STATUS_WORDS[o.with.status] ?? o.with.status})`)
      .join(', ');
    super(
      'seam_conflict',
      `${item.id} changes ${parts.join(', ')}, like ${withText}. Pick other work: the owner has been asked whether they can run together.`,
      { details: { with: overlaps.map((o) => o.with.id), parts } },
    );
    this.name = 'SeamConflict';
    this.recordRejection = (w) => {
      w.event({
        type: 'claim.rejected',
        summary: `Lead claim by ${callerName(w.db, w.actor)} refused: ${item.id} overlaps ${overlaps.map((o) => `${o.with.id} on ${partsText(o.parts)}`).join('; ')}`,
        item_id: item.id,
        project_key: item.project_key,
        data: { seam_conflict: { with: overlaps.map((o) => o.with.id), parts } },
      });
      for (const o of overlaps) {
        raiseOverlap(w, item.project_key, o.with.id, item.id, o.parts, 'claim');
      }
    };
  }
}

const STATUS_WORDS: Partial<Record<Status, string>> = {
  ready: 'Ready',
  progress: 'In progress',
  review: 'In review',
};

/** The overlaps that refuse a claim of `item` now (empty when it may start). */
export function claimOverlaps(db: Db, item: { id: string; project_key: string }): OverlapFound[] {
  const keys = declaredKeys(db, item.id);
  if (keys.length === 0) return [];
  return overlapsFor(db, item.id, item.project_key, keys, CLAIMED_STATUSES);
}

/**
 * Items with an undecided overlap question whose other item is still in
 * flight: the owner has been asked, so `ready_to_start` leaves them out and
 * unattended agents move on to other work (SC-023).
 */
export function waitingOnOverlap(db: Db, ids: string[]): Set<string> {
  const out = new Set<string>();
  if (ids.length === 0) return out;
  const wanted = new Set(ids);
  const rows = db.sqlite
    .prepare(
      `SELECT o.item_a, o.item_b, a.status AS sa, b.status AS sb FROM part_overlaps o
       JOIN items a ON a.id = o.item_a JOIN items b ON b.id = o.item_b
       WHERE o.state = 'open'`,
    )
    .all() as { item_a: string; item_b: string; sa: Status; sb: Status }[];
  const claimed = new Set<Status>(CLAIMED_STATUSES);
  for (const r of rows) {
    if (wanted.has(r.item_a) && claimed.has(r.sb)) out.add(r.item_a);
    if (wanted.has(r.item_b) && claimed.has(r.sa)) out.add(r.item_b);
  }
  return out;
}

// ---- Leases ----

interface LeaseDbRow {
  id: string;
  project_key: string;
  part_key: string;
  item_id: string;
  run_id: string | null;
  taken_at: string;
  expires_at: string;
  ended_at: string | null;
  end_reason: string | null;
}

const LEASE_END_TEXT: Record<string, string> = {
  released: 'released',
  owner_released: 'released by you',
  done: 'the item is done',
  handed_off: 'the item was handed off',
  expired: 'it expired',
};

function endLease(
  w: WriteContext,
  row: LeaseDbRow,
  reason: 'released' | 'owner_released' | 'done' | 'handed_off' | 'expired',
): void {
  w.update('part_leases', row.id, { ended_at: w.now, end_reason: reason });
  w.event({
    type: 'lease.ended',
    summary: `Lease on ${row.part_key} for ${row.item_id} ended: ${LEASE_END_TEXT[reason]}`,
    item_id: row.item_id,
    project_key: row.project_key,
    data: { lease_id: row.id, part: row.part_key, end_reason: reason },
    objects: [{ kind: 'lease', id: row.id }],
  });
}

/**
 * End the item's leases (BUILD_SPEC §5.21 Leases): on Done (`done`), a
 * hand-off (`handed_off`), or a cancel. One that already ran out ends as
 * `expired` (expiry is otherwise lazy: reads skip it, a take ends it).
 */
export function endLeasesOf(
  w: WriteContext,
  itemId: string,
  reason: 'done' | 'handed_off' | 'released' | 'owner_released',
): void {
  const rows = w.db.sqlite
    .prepare('SELECT * FROM part_leases WHERE item_id = ? AND ended_at IS NULL ORDER BY part_key')
    .all(itemId) as LeaseDbRow[];
  for (const row of rows) endLease(w, row, row.expires_at <= w.now ? 'expired' : reason);
}

/** What closing or canceling an item ends: its leases, and the overlaps it was part of. */
export function onItemClosed(w: WriteContext, itemId: string, to: 'done' | 'canceled'): void {
  endLeasesOf(
    w,
    itemId,
    to === 'done' ? 'done' : w.actor.kind === 'owner' ? 'owner_released' : 'released',
  );
  resolveOverlaps(w, itemId);
}

// ---- Changed files ----

/**
 * A part's path glob as a regular expression: `**` any path (`**\/` zero or
 * more folders), `*` within one segment, `?` one character. A glob with no
 * wildcard also matches everything under it, as a folder.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const folder = /[*?]/.test(glob) ? '' : '(?:/.*)?';
  return new RegExp(`^${re}${folder}$`);
}

/**
 * Map changed files to the project's (unarchived) parts through each part's
 * `paths`; a `file:` part with no paths matches its own path. Returns each
 * part touched with the files that hit it.
 */
export function partsForFiles(db: Db, project: string, files: string[]): Map<string, string[]> {
  const parts = db.sqlite
    .prepare(
      'SELECT key, kind, paths FROM shared_parts WHERE project_key = ? AND archived_at IS NULL',
    )
    .all(project) as { key: string; kind: SharedPartKind; paths: string }[];
  const hits = new Map<string, string[]>();
  for (const p of parts) {
    let globs = parseList(p.paths);
    if (globs.length === 0 && p.kind === 'file') globs = [p.key.slice('file:'.length)];
    if (globs.length === 0) continue;
    const res = globs.map(globToRegExp);
    const matched = files.filter((f) => res.some((re) => re.test(f)));
    if (matched.length > 0) hits.set(p.key, matched);
  }
  return hits;
}

/** The parts the changed files touch that the item didn't declare, with those files. */
export function undeclaredChanges(
  db: Db,
  item: { id: string; project_key: string },
  files: string[],
): { parts: string[]; files: string[] } {
  if (files.length === 0) return { parts: [], files: [] };
  const declared = new Set(declaredKeys(db, item.id));
  const parts: string[] = [];
  const hit = new Set<string>();
  for (const [key, matched] of partsForFiles(db, item.project_key, files)) {
    if (declared.has(key)) continue;
    parts.push(key);
    for (const f of matched) hit.add(f);
  }
  parts.sort();
  return { parts, files: files.filter((f) => hit.has(f)) };
}

/**
 * Hold a hand-off for the owner (BUILD_SPEC §5.21 Hand-off; FR-162): one open
 * `undeclared_holds` row per item, the Needs you card. A repeat with the same
 * parts and files changes nothing (a retried close raises no second question).
 */
export function raiseHold(
  w: WriteContext,
  item: { id: string; project_key: string },
  hold: {
    via: 'submit_packet' | 'set_status';
    packet_id: string | null;
    parts: string[];
    files: string[];
  },
): string {
  const open = w.db.sqlite
    .prepare("SELECT * FROM undeclared_holds WHERE item_id = ? AND state = 'open'")
    .get(item.id) as Record<string, unknown> | undefined;
  const summary = `${item.id} changed shared parts it didn't declare: ${partsText(hold.parts)}`;
  if (open) {
    const same =
      open.packet_id === hold.packet_id &&
      open.via === hold.via &&
      JSON.stringify(parseList(open.parts as string)) === JSON.stringify(hold.parts) &&
      JSON.stringify(parseList(open.files as string)) === JSON.stringify(hold.files);
    if (same) return open.id as string;
    w.update('undeclared_holds', open.id as string, {
      via: hold.via,
      packet_id: hold.packet_id,
      parts: hold.parts,
      files: hold.files,
    });
    w.event({
      type: 'undeclared.held',
      summary,
      item_id: item.id,
      project_key: item.project_key,
      data: { hold_id: open.id, via: hold.via, packet_id: hold.packet_id, parts: hold.parts },
      objects: [{ kind: 'undeclared_hold', id: open.id as string }],
    });
    return open.id as string;
  }
  const id = newId('udh', ms(w.now));
  w.insert('undeclared_holds', {
    id,
    item_id: item.id,
    packet_id: hold.packet_id,
    via: hold.via,
    parts: hold.parts,
    files: hold.files,
    state: 'open',
    note: null,
    decided_by: null,
    decided_at: null,
    version: 1,
  });
  w.event({
    type: 'undeclared.held',
    summary,
    item_id: item.id,
    project_key: item.project_key,
    data: { hold_id: id, via: hold.via, packet_id: hold.packet_id, parts: hold.parts },
    objects: [{ kind: 'undeclared_hold', id }],
  });
  return id;
}

/**
 * A close refused for changes to undeclared parts (`not_declared` with
 * `details.undeclared` and `details.files`; MCP_SPEC §5.15). The refusal
 * rolls back, so the adapter writes `recordRejection`: the owner question.
 */
export class HoldRefusal extends ToolError {
  readonly recordRejection: (w: WriteContext) => void;
  constructor(item: { id: string; project_key: string }, parts: string[], files: string[]) {
    super(
      'not_declared',
      `${item.id} changed shared parts it didn't declare: ${parts.join(', ')}. The owner has been asked to add them to the declaration or send it back; leave ${item.id} as it is until they decide.`,
      { details: { undeclared: parts, files } },
    );
    this.name = 'HoldRefusal';
    this.recordRejection = (w) => {
      raiseHold(w, item, { via: 'set_status', packet_id: null, parts, files });
    };
  }
}

// ---- The item's Shared changes section ----

function itemRef(db: Db, id: string) {
  return db.sqlite.prepare('SELECT id, title, status FROM items WHERE id = ?').get(id) as {
    id: string;
    title: string;
    status: Status;
  };
}

function overlapRow(db: Db, r: Record<string, unknown>): OverlapRow {
  const first = r.claimed_first as string;
  const other = first === r.item_a ? (r.item_b as string) : (r.item_a as string);
  return {
    id: r.id as string,
    project: r.project_key as string,
    items: [itemRef(db, first), itemRef(db, other)],
    parts: parseList(r.parts as string),
    state: r.state as OverlapRow['state'],
    note: r.note as string | null,
    link_id: r.link_id as string | null,
    raised_at: r.raised_at as string,
    decided_by: r.decided_by as string | null,
    decided_at: r.decided_at as string | null,
    version: r.version as number,
  };
}

function leaseRow(db: Db, r: Record<string, unknown>): LeaseRow {
  const run = r.run_id
    ? (db.sqlite.prepare('SELECT client, label FROM runs WHERE id = ?').get(r.run_id) as
        { client: string; label: string | null } | undefined)
    : undefined;
  return {
    id: r.id as string,
    part: r.part_key as string,
    item_id: r.item_id as string,
    run_id: r.run_id as string | null,
    holder: run ? (run.label ? `${run.client} · ${run.label}` : run.client) : null,
    taken_at: r.taken_at as string,
    expires_at: r.expires_at as string,
    ended_at: r.ended_at as string | null,
    end_reason: r.end_reason as LeaseRow['end_reason'],
  };
}

function holdRow(db: Db, r: Record<string, unknown>): UndeclaredHoldRow {
  return {
    id: r.id as string,
    item: itemRef(db, r.item_id as string),
    packet_id: r.packet_id as string | null,
    via: r.via as UndeclaredHoldRow['via'],
    parts: parseList(r.parts as string),
    files: parseList(r.files as string),
    state: r.state as UndeclaredHoldRow['state'],
    note: r.note as string | null,
    created_at: r.created_at as string,
    decided_by: r.decided_by as string | null,
    decided_at: r.decided_at as string | null,
    version: r.version as number,
  };
}

function findingRow(db: Db, r: Record<string, unknown>): RadarFindingRow {
  return {
    id: r.id as string,
    project: r.project_key as string,
    branch_a: r.branch_a as string,
    branch_b: r.branch_b as string,
    item_a: r.item_a ? itemRef(db, r.item_a as string) : null,
    item_b: r.item_b ? itemRef(db, r.item_b as string) : null,
    files: parseList(r.files as string),
    seen_at: r.seen_at as string,
    cleared_at: r.cleared_at as string | null,
  };
}

function itemShared(r: ReadContext, id: string): ItemSharedResponse {
  const db = r.db;
  const item = requireItem(db, id);
  const all = (sql: string, ...params: unknown[]) =>
    db.sqlite.prepare(sql).all(...params) as Record<string, unknown>[];
  return {
    declaration: declarationOf(db, item.id),
    overlaps: all(
      `SELECT * FROM part_overlaps WHERE (item_a = ? OR item_b = ?) AND state <> 'resolved'
       ORDER BY raised_at`,
      item.id,
      item.id,
    ).map((row) => overlapRow(db, row)),
    leases: all(
      `SELECT * FROM part_leases WHERE item_id = ? AND ended_at IS NULL AND expires_at > ?
       ORDER BY part_key`,
      item.id,
      r.now,
    ).map((row) => leaseRow(db, row)),
    findings: all(
      `SELECT * FROM radar_findings WHERE (item_a = ? OR item_b = ?) AND cleared_at IS NULL
       ORDER BY seen_at`,
      item.id,
      item.id,
    ).map((row) => findingRow(db, row)),
    holds: all(
      'SELECT * FROM undeclared_holds WHERE item_id = ? ORDER BY created_at DESC',
      item.id,
    ).map((row) => holdRow(db, row)),
  };
}

// ---- The radar card ----

function radar(r: ReadContext, project: string): RadarResponse {
  const db = r.db;
  requireProject(db, project);
  const p = db.sqlite
    .prepare(
      'SELECT repo_path, main_branch, radar_last_run_at, radar_off_reason FROM projects WHERE key = ?',
    )
    .get(project) as {
    repo_path: string | null;
    main_branch: string;
    radar_last_run_at: string | null;
    radar_off_reason: string | null;
  };
  const off = p.repo_path === null ? 'Radar off: no repository' : p.radar_off_reason;
  return {
    project,
    repo_path: p.repo_path,
    main_branch: p.main_branch,
    state: off ? 'off' : p.radar_last_run_at ? 'ok' : 'idle',
    off_reason: off,
    last_run_at: p.radar_last_run_at,
    findings: (
      db.sqlite
        .prepare(
          'SELECT * FROM radar_findings WHERE project_key = ? AND cleared_at IS NULL ORDER BY seen_at',
        )
        .all(project) as Record<string, unknown>[]
    ).map((row) => findingRow(db, row)),
  };
}

// ---- Leases and context, for the service ----

type Ctx = { db: Db; actor: WriteContext['actor']; now: string };

/** The caller must lead the item (`forbidden` otherwise): its own run, or the same client. */
function assertLeads(r: Ctx, item: { id: string }): RunRow | undefined {
  const lead = activeLead(r.db, item.id);
  if (r.actor.kind !== 'agent') return lead;
  const owns =
    !!lead &&
    !leaseExpired(lead, r.now) &&
    (r.actor.run_id === lead.id || r.actor.client === lead.client);
  if (!owns) {
    throw new ToolError(
      'forbidden',
      `You don't lead ${item.id}. Claim it with claim_lead before you take or release its leases.`,
    );
  }
  return lead;
}

/** The item and the single-writer part a lease call names, checked. */
function leaseTarget(r: Ctx, input: { id: string; part: string }) {
  const item = requireItem(r.db, input.id);
  const lead = assertLeads(r, item);
  const part = partByKey(r.db, item.project_key, input.part);
  if (!part) {
    throw new ToolError(
      'not_found',
      `No shared part ${input.part} in ${item.project_key}. See list_shared_parts ${item.project_key}.`,
    );
  }
  if (part.archived_at) {
    throw new ToolError('validation', `${part.key} is archived, so it takes no lease.`);
  }
  if (!part.single_writer) {
    throw new ToolError(
      'validation',
      `${part.key} isn't single-writer, so it takes no lease. Only parts the owner marks single-writer do.`,
    );
  }
  return { item, part, lead };
}

/**
 * `get_context.shared` in full (BUILD_SPEC §5.21 Context; FR-164): the
 * item's declaration, the other in-flight items' declared changes to its
 * parts, up to 30 other in-flight declarations in the project (newest
 * first), the leases it holds, and its open radar findings. context.ts
 * cuts it to the budget.
 */
function contextShared(r: ReadContext, id: string): ContextShared {
  const db = r.db;
  const item = requireItem(db, id);
  const decl = declarationOf(db, item.id);
  const overlapping: ContextShared['overlapping'] = [];
  for (const c of decl.changes) {
    for (const o of inFlightFor(db, item.project_key, c.part, item.id)) {
      overlapping.push({ ...o, part: c.part });
    }
  }
  const mine = new Set(decl.changes.map((c) => c.part));
  const others = (
    db.sqlite
      .prepare(
        `SELECT i.id, i.title, i.status, c.change, c.note, c.part_key AS part
         FROM item_shared_changes c JOIN items i ON i.id = c.item_id
         WHERE i.project_key = ? AND i.status IN ${statusSql(IN_FLIGHT_STATUSES)}
           AND i.archived_at IS NULL AND i.id <> ?
         ORDER BY c.declared_at DESC, length(i.id), i.id, c.part_key`,
      )
      .all(item.project_key, item.id) as ContextShared['in_flight']
  ).filter((c) => !mine.has(c.part));
  const leases = (
    db.sqlite
      .prepare(
        `SELECT part_key, expires_at FROM part_leases
         WHERE item_id = ? AND ended_at IS NULL AND expires_at > ? ORDER BY part_key`,
      )
      .all(item.id, r.now) as { part_key: string; expires_at: string }[]
  ).map((l) => ({ part: l.part_key, held_until: l.expires_at }));
  const radar = (
    db.sqlite
      .prepare(
        `SELECT * FROM radar_findings WHERE (item_a = ? OR item_b = ?) AND cleared_at IS NULL
         ORDER BY seen_at, id`,
      )
      .all(item.id, item.id) as Record<string, unknown>[]
  ).map((f) => {
    const mineA = f.item_a === item.id;
    return {
      with: ((mineA ? f.item_b : f.item_a) as string | null) ?? null,
      branch: (mineA ? f.branch_b : f.branch_a) as string,
      files: parseList(f.files as string),
    };
  });
  return {
    declaration: { state: decl.state, changes: decl.changes },
    overlapping,
    in_flight: others.slice(0, LIMITS.context_in_flight_max),
    leases,
    radar,
    truncated: others.length > LIMITS.context_in_flight_max,
  };
}

// ---- The service ----

export function createSharedChangesService(deps: ServiceDeps): SharedChangesService {
  return {
    declare: (w, input) => declare(w, input),

    listParts(r, input) {
      requireProject(r.db, input.project);
      const rows = r.db.sqlite
        .prepare(
          `SELECT * FROM shared_parts WHERE project_key = ?
           ${input.include_archived ? '' : 'AND archived_at IS NULL'} ORDER BY key`,
        )
        .all(input.project) as PartRow[];
      return { project: input.project, parts: rows.map((row) => agentPart(r.db, row, r.now)) };
    },

    ownerList(r, input) {
      requireProject(r.db, input.key);
      const rows = r.db.sqlite
        .prepare(
          `SELECT * FROM shared_parts WHERE project_key = ?
           ${input.include_archived ? '' : 'AND archived_at IS NULL'} ORDER BY key`,
        )
        .all(input.key) as PartRow[];
      return { project: input.key, parts: rows.map((row) => ownerPart(r.db, row, r.now)) };
    },

    ownerCreate(w, { project, part }) {
      requireProject(w.db, project);
      if (partByKey(w.db, project, part.key)) {
        throw new ToolError(
          'validation',
          `${part.key} is already registered in ${project}. Edit it instead.`,
          { details: { parts: [part.key] } },
        );
      }
      const { id, inverse } = insertPart(w, project, part, 'owner');
      w.event({
        type: 'shared_part.saved',
        summary: `Registered shared part ${part.key}${part.single_writer ? ' (single-writer)' : ''}`,
        project_key: project,
        data: { part_id: id, key: part.key, created: true },
        objects: [{ kind: 'shared_part', id }],
        inverse: [inverse],
      });
      return ownerPart(w.db, w.get('shared_parts', id) as unknown as PartRow, w.now);
    },

    ownerUpdate(w, input) {
      const before = w.checkVersion(
        'shared_parts',
        input.id,
        input.expected_version,
      ) as unknown as PartRow;
      requireProject(w.db, before.project_key);
      const set: Record<string, unknown> = {};
      const changed: string[] = [];
      if (input.paths !== undefined) {
        set.paths = input.paths;
        changed.push('paths');
      }
      if (input.single_writer !== undefined && input.single_writer !== !!before.single_writer) {
        set.single_writer = input.single_writer;
        changed.push(input.single_writer ? 'marked single-writer' : 'no longer single-writer');
      }
      if (input.note !== undefined && input.note !== before.note) {
        set.note = input.note;
        changed.push('note');
      }
      if (input.archived !== undefined && input.archived !== (before.archived_at !== null)) {
        set.archived_at = input.archived ? w.now : null;
        changed.push(input.archived ? 'archived' : 'restored');
      }
      const inverse = w.update('shared_parts', before.id, set);
      w.event({
        type: 'shared_part.saved',
        summary: `Updated shared part ${before.key}: ${changed.join(', ') || 'no change'}`,
        project_key: before.project_key,
        data: { part_id: before.id, key: before.key, changed },
        objects: [{ kind: 'shared_part', id: before.id }],
        inverse: [inverse],
      });
      return ownerPart(w.db, w.get('shared_parts', before.id) as unknown as PartRow, w.now);
    },

    itemShared: (r, input) => itemShared(r, input.id),

    ownerDeclare(w, input) {
      const { registered } = declare(w, input);
      const r = { db: w.db, actor: w.actor, now: w.now };
      return { ...itemShared(r, input.id), registered };
    },

    radar: (r, input) => radar(r, input.key),

    // ---- Leases (B39, T183; MCP_SPEC §5.15) ----

    renewLease(r, input) {
      const { item, part } = leaseTarget(r, input);
      const live = r.db.sqlite
        .prepare(
          'SELECT * FROM part_leases WHERE project_key = ? AND part_key = ? AND ended_at IS NULL',
        )
        .get(item.project_key, part.key) as LeaseDbRow | undefined;
      if (!live || live.item_id !== item.id || live.expires_at <= r.now) return null;
      // A renewal writes no event (MCP_SPEC §5.15): like a heartbeat, it only moves the expiry.
      const until = isoPlus(r.now, deps.config.partLeaseMs);
      r.db.sqlite
        .prepare('UPDATE part_leases SET expires_at = ?, updated_at = ? WHERE id = ?')
        .run(until, r.now, live.id);
      return { part: part.key, item_id: item.id, held_until: until, renewed: true };
    },

    takeLease(w, input) {
      const { item, part, lead } = leaseTarget(w, input);
      let live = w.db.sqlite
        .prepare(
          'SELECT * FROM part_leases WHERE project_key = ? AND part_key = ? AND ended_at IS NULL',
        )
        .get(item.project_key, part.key) as LeaseDbRow | undefined;
      // Expiry is lazy: a take ends a lease that ran out.
      if (live && live.expires_at <= w.now) {
        endLease(w, live, 'expired');
        live = undefined;
      }
      const until = isoPlus(w.now, deps.config.partLeaseMs);
      if (live && live.item_id === item.id) {
        w.update('part_leases', live.id, { expires_at: until, run_id: lead?.id ?? live.run_id });
        w.event({
          type: 'lease.taken',
          summary: `${callerName(w.db, w.actor)} renewed the lease on ${part.key} for ${item.id}`,
          item_id: item.id,
          project_key: item.project_key,
          data: { lease_id: live.id, part: part.key, expires_at: until, renewed: true },
          objects: [{ kind: 'lease', id: live.id }],
        });
        return { part: part.key, item_id: item.id, held_until: until, renewed: true };
      }
      if (live) {
        const holder = leaseRow(w.db, live as unknown as Record<string, unknown>).holder;
        throw new ToolError(
          'lease_held',
          `${part.key} is leased to ${live.item_id}${holder ? ` (${holder})` : ''} until ${utcTime(live.expires_at, w.now)}. Work on something else.`,
          { current: { item_id: live.item_id, holder, held_until: live.expires_at } },
        );
      }
      const id = newId('pls', ms(w.now));
      w.insert('part_leases', {
        id,
        project_key: item.project_key,
        part_key: part.key,
        item_id: item.id,
        run_id: lead?.id ?? null,
        taken_at: w.now,
        expires_at: until,
        ended_at: null,
        end_reason: null,
      });
      w.event({
        type: 'lease.taken',
        summary: `${callerName(w.db, w.actor)} took the lease on ${part.key} for ${item.id} until ${utcTime(until, w.now)}`,
        item_id: item.id,
        project_key: item.project_key,
        data: { lease_id: id, part: part.key, expires_at: until },
        objects: [{ kind: 'lease', id }],
      });
      return { part: part.key, item_id: item.id, held_until: until, renewed: false };
    },

    releaseLease(w, input) {
      const item = requireItem(w.db, input.id);
      assertLeads(w, item);
      const live = w.db.sqlite
        .prepare(
          `SELECT * FROM part_leases WHERE item_id = ? AND part_key = ? AND ended_at IS NULL
           AND expires_at > ?`,
        )
        .get(item.id, input.part, w.now) as LeaseDbRow | undefined;
      if (!live) {
        throw new ToolError(
          'not_found',
          `${item.id} holds no lease on ${input.part}; it may have expired or ended already.`,
        );
      }
      endLease(w, live, 'released');
      return { part: live.part_key, item_id: item.id, released: true as const };
    },

    ownerReleaseLease(w, input) {
      const row = w.get('part_leases', input.id) as LeaseDbRow | undefined;
      if (!row) throw new ToolError('not_found', `No lease ${input.id}.`);
      if (row.ended_at !== null || row.expires_at <= w.now) {
        throw new ToolError(
          'conflict',
          `The lease on ${row.part_key} for ${row.item_id} has already ended. Showing the latest.`,
          { current: leaseRow(w.db, row as unknown as Record<string, unknown>) },
        );
      }
      endLease(w, row, 'owner_released');
      return leaseRow(w.db, w.get('part_leases', row.id)!);
    },

    // ---- Owner decisions (B39, T183; UI_SPEC §6.3.6) ----

    decideOverlap(w, input) {
      const row = w.get('part_overlaps', input.id);
      if (!row) throw new ToolError('not_found', `No overlap ${input.id}.`);
      if (row.state !== 'open') {
        throw new ToolError(
          'conflict',
          `This overlap was already ${row.state === 'resolved' ? 'resolved' : 'decided'}. Showing the latest.`,
          { current: overlapRow(w.db, row) },
        );
      }
      const first = row.claimed_first as string;
      const other = first === row.item_a ? (row.item_b as string) : (row.item_a as string);
      const parts = parseList(row.parts as string);
      const set: Record<string, unknown> = {
        decided_by: 'owner',
        decided_at: w.now,
      };
      let summary: string;
      if (input.decision === 'sequence') {
        // *Run one after the other*: `first` blocks `other` until it is merged.
        const link = deps.services().links.link(w, {
          from: first,
          to: other,
          type: 'blocks',
          satisfied_when: 'merged',
        });
        set.state = 'sequenced';
        set.link_id = link.link_id;
        summary = `You chose to run ${first} and ${other} one after the other: ${other} waits until ${first} is merged`;
      } else {
        set.state = 'compatible';
        set.note = input.note ?? null;
        summary = `You marked ${first} and ${other} compatible on ${partsText(parts)}`;
        if (input.note) {
          for (const id of [first, other]) {
            deps.services().messages.addOwnerNote(w, {
              id,
              text: `Runs alongside ${id === first ? other : first} (both change ${partsText(parts)}): ${input.note}`,
            });
          }
        }
      }
      w.update('part_overlaps', row.id as string, set);
      for (const id of [first, other]) {
        w.event({
          type: 'overlap.decided',
          summary,
          item_id: id,
          project_key: row.project_key as string,
          data: { overlap_id: row.id, decision: input.decision, parts, claimed_first: first },
          objects: [
            { kind: 'overlap', id: row.id as string },
            { kind: 'item', id: id === first ? other : first },
          ],
        });
      }
      return overlapRow(w.db, w.get('part_overlaps', row.id as string)!);
    },

    decideHold(w, input) {
      const row = w.get('undeclared_holds', input.id);
      if (!row) throw new ToolError('not_found', `No hold ${input.id}.`);
      if (row.state !== 'open') {
        throw new ToolError('conflict', 'This hold was already decided. Showing the latest.', {
          current: holdRow(w.db, row),
        });
      }
      const item = requireItem(w.db, row.item_id as string);
      const parts = parseList(row.parts as string);
      const packetId = row.packet_id as string | null;
      let summary: string;
      if (input.decision === 'add') {
        // *Add to the declaration*: the parts join it as changes; the held packet opens.
        const have = new Set(declaredKeys(w.db, item.id));
        for (const key of parts) {
          if (have.has(key)) continue;
          w.insert('item_shared_changes', {
            id: newId('isc', ms(w.now)),
            item_id: item.id,
            part_key: key,
            change: 'change',
            note: 'Added by the owner at hand-off',
            declared_by: 'owner',
            declared_at: w.now,
          });
        }
        w.db.sqlite
          .prepare(
            'UPDATE items SET shared_none_at = NULL WHERE id = ? AND shared_none_at IS NOT NULL',
          )
          .run(item.id);
        if (packetId) w.update('packets', packetId, { held_undeclared: null });
        summary = `You added ${partsText(parts)} to ${item.id}'s declaration${packetId ? '; its packet is open for review' : ''}`;
      } else {
        // *Send back*: a held packet is withdrawn and the item returns to In progress, with a note.
        const note =
          input.note ??
          `You changed shared parts you didn't declare: ${partsText(parts)}. Declare them with declare_shared_changes, or undo those changes, then hand off again.`;
        const packet = packetId
          ? (w.db.sqlite
              .prepare("SELECT id, round FROM packets WHERE id = ? AND state = 'open'")
              .get(packetId) as { id: string; round: number } | undefined)
          : undefined;
        if (packet) {
          w.update('packets', packet.id, { state: 'withdrawn', held_undeclared: null });
          for (const hr of w.db.sqlite
            .prepare("SELECT id FROM hr_items WHERE item_id = ? AND state = 'ready'")
            .all(item.id) as { id: string }[]) {
            w.update('hr_items', hr.id, { state: 'declared' });
          }
          w.event({
            type: 'packet.withdrawn',
            summary: `Packet round ${packet.round} withdrawn: sent back for undeclared shared changes`,
            item_id: item.id,
            project_key: item.project_key,
            data: { packet_id: packet.id },
            objects: [{ kind: 'packet', id: packet.id }],
          });
        }
        if (item.status === 'review') {
          w.update('items', item.id, { status: 'progress' });
          w.event({
            type: 'item.status_changed',
            summary: `You sent ${item.id} back to progress: undeclared shared changes`,
            item_id: item.id,
            project_key: item.project_key,
            data: { status: { old: 'review', new: 'progress' } },
          });
        }
        deps.services().messages.addOwnerNote(w, { id: item.id, text: note });
        summary = `You sent ${item.id} back for changing ${partsText(parts)} without declaring them`;
      }
      w.update('undeclared_holds', row.id as string, {
        state: input.decision === 'add' ? 'added' : 'sent_back',
        note: input.note ?? null,
        decided_by: 'owner',
        decided_at: w.now,
      });
      w.event({
        type: 'undeclared.decided',
        summary,
        item_id: item.id,
        project_key: item.project_key,
        data: { hold_id: row.id, decision: input.decision, parts, packet_id: packetId },
        objects: [{ kind: 'undeclared_hold', id: row.id as string }],
      });
      return holdRow(w.db, w.get('undeclared_holds', row.id as string)!);
    },

    contextFor: (r, input) => contextShared(r, input.item_id),
    // ---- The conflict radar (B39, T184; radar.ts) ----

    setRadar(w, input) {
      requireProject(w.db, input.key);
      const p = w.db.sqlite
        .prepare('SELECT id, repo_path, main_branch FROM projects WHERE key = ?')
        .get(input.key) as { id: string; repo_path: string | null; main_branch: string };
      const repo = input.repo_path === null ? null : input.repo_path.trim();
      if (repo !== null) resolveRepoPath(deps.config, repo);
      const main = input.main_branch?.trim() ?? p.main_branch;
      if (!validBranch(main)) {
        throw new ToolError('validation', `"${main}" isn't a branch name git accepts.`, {
          details: { fields: { main_branch: 'not a branch name' } },
        });
      }
      if (repo === p.repo_path && main === p.main_branch) return radar(w, input.key);
      w.update('projects', p.id, { repo_path: repo, main_branch: main, radar_off_reason: null });
      w.event({
        type: 'project.updated',
        summary:
          repo === null
            ? `You turned the conflict radar off for ${input.key}`
            : `You set the conflict radar for ${input.key} to read ${repo} (main branch ${main})`,
        project_key: input.key,
        data: {
          radar: { old: { repo_path: p.repo_path, main_branch: p.main_branch } },
          new: { repo_path: repo, main_branch: main },
        },
        objects: [{ kind: 'project', id: input.key }],
      });
      // Turning it off, or reading another repository, clears what the old one found.
      if (repo !== p.repo_path || main !== p.main_branch) {
        for (const f of w.db.sqlite
          .prepare('SELECT * FROM radar_findings WHERE project_key = ? AND cleared_at IS NULL')
          .all(input.key) as Record<string, unknown>[]) {
          clearFinding(w, f);
        }
      }
      return radar(w, input.key);
    },

    planRadar: (r, input) => planRadar(r, deps.config, input.key),
    recordRadar: (w, plan) => recordRadar(w, plan),
    finishRadar: (r, plan) => finishRadar(r, plan),
  };
}

// ---- Needs you and Problems (B39, T183/T185; UI_SPEC §6.3.6) ----

/**
 * The open owner questions and radar findings in scope: an overlap card per
 * undecided pair, a card per open hold, and the radar's open findings (which
 * Problems also lists as `radar_conflict`).
 */
export function needsYouShared(
  db: Db,
  scope: 'all' | string,
): {
  overlaps: OverlapRow[];
  undeclared_holds: UndeclaredHoldRow[];
  radar_findings: RadarFindingRow[];
} {
  const inScope = scope === 'all' ? '' : 'AND p.key = @scope';
  const all = (sql: string) =>
    db.sqlite.prepare(sql).all(scope === 'all' ? {} : { scope }) as Record<string, unknown>[];
  return {
    overlaps: all(
      `SELECT o.* FROM part_overlaps o JOIN projects p ON p.key = o.project_key
       WHERE o.state = 'open' AND p.deleted_at IS NULL ${inScope} ORDER BY o.raised_at, o.id`,
    ).map((r) => overlapRow(db, r)),
    undeclared_holds: all(
      `SELECT h.* FROM undeclared_holds h JOIN items i ON i.id = h.item_id
       JOIN projects p ON p.key = i.project_key
       WHERE h.state = 'open' AND p.deleted_at IS NULL ${inScope} ORDER BY h.created_at, h.id`,
    ).map((r) => holdRow(db, r)),
    radar_findings: all(
      `SELECT f.* FROM radar_findings f JOIN projects p ON p.key = f.project_key
       WHERE f.cleared_at IS NULL AND p.deleted_at IS NULL ${inScope} ORDER BY f.seen_at, f.id`,
    ).map((r) => findingRow(db, r)),
  };
}

/** "Heading for a conflict with RCP-18: 3 files · a.ts, b.ts" for a Problems row. */
export function radarReason(f: RadarFindingRow): string {
  const other = f.item_b ? f.item_b.id : f.branch_b;
  const n = f.files.length;
  const shown = f.files.slice(0, 3).join(', ');
  return `Heading for a conflict with ${other}: ${n} file${n === 1 ? '' : 's'}${shown ? ` · ${shown}${n > 3 ? ', …' : ''}` : ''} (${f.branch_a})`;
}

/**
 * Work cards' markers (UI_SPEC §6.3.6): items in an undecided overlap
 * ("overlap") or an open radar finding ("conflict ahead").
 */
export function sharedFlagsOf(db: Db): Map<string, { overlap: boolean; conflict: boolean }> {
  const out = new Map<string, { overlap: boolean; conflict: boolean }>();
  const flag = (id: string | null, key: 'overlap' | 'conflict') => {
    if (!id) return;
    const f = out.get(id) ?? { overlap: false, conflict: false };
    f[key] = true;
    out.set(id, f);
  };
  for (const r of db.sqlite
    .prepare("SELECT item_a, item_b FROM part_overlaps WHERE state = 'open'")
    .all() as { item_a: string; item_b: string }[]) {
    flag(r.item_a, 'overlap');
    flag(r.item_b, 'overlap');
  }
  for (const r of db.sqlite
    .prepare('SELECT item_a, item_b FROM radar_findings WHERE cleared_at IS NULL')
    .all() as { item_a: string | null; item_b: string | null }[]) {
    flag(r.item_a, 'conflict');
    flag(r.item_b, 'conflict');
  }
  return out;
}
