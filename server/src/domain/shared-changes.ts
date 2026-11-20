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
 * Stubs until B39 (T183, T184), each throwing `NotImplementedError`:
 * leases, overlap and hold decisions, `get_context.shared`, the radar
 * settings and runs.
 */
import {
  IN_FLIGHT_STATUSES,
  ToolError,
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
import {
  notImplemented,
  type ReadContext,
  type ServiceDeps,
  type SharedChangesService,
} from './contracts.js';
import { newId } from './ids.js';
import { callerName, ms, requireItem } from './model.js';
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

const IN_FLIGHT_SQL = `(${IN_FLIGHT_STATUSES.map((s) => `'${s}'`).join(', ')})`;

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
function inFlightFor(db: Db, project: string, key: string, except?: string): InFlightChange[] {
  const rows = db.sqlite
    .prepare(
      `SELECT i.id, i.title, i.status, c.change, c.note
       FROM item_shared_changes c JOIN items i ON i.id = c.item_id
       WHERE i.project_key = ? AND c.part_key = ? AND i.status IN ${IN_FLIGHT_SQL}
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
): OverlapFound[] {
  const byItem = new Map<string, OverlapFound>();
  for (const key of keys) {
    for (const other of inFlightFor(db, project, key, itemId)) {
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

// ---- The service ----

export function createSharedChangesService(_deps: ServiceDeps): SharedChangesService {
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

    // B39 (T183): leases, overlap and hold decisions, get_context.shared.
    takeLease: notImplemented('sharedChanges.takeLease'),
    releaseLease: notImplemented('sharedChanges.releaseLease'),
    ownerReleaseLease: notImplemented('sharedChanges.ownerReleaseLease'),
    decideOverlap: notImplemented('sharedChanges.decideOverlap'),
    decideHold: notImplemented('sharedChanges.decideHold'),
    contextFor: notImplemented('sharedChanges.contextFor'),
    // B39 (T184): the radar's settings and runs.
    setRadar: notImplemented('sharedChanges.setRadar'),
    runRadar: notImplemented('sharedChanges.runRadar'),
  };
}
