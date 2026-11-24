/**
 * Decision records (BUILD_SPEC §5.14; MCP_SPEC §5.8; FR-041–FR-043): the
 * `decisions` service, and the one scope rule every reader uses.
 *
 * - **Scope inheritance:** an item sees the active records of its project,
 *   its epic (an epic also sees its own), its labels and itself
 *   (`inScopeOf`). `get_item`, `get_context`, `list_decisions in_scope_of`
 *   and the ticket's Decisions section all read through it.
 * - **Order:** owner records first, then newest (MCP_SPEC §5.8).
 * - **Authority:** agents publish `agent` records and may supersede or
 *   withdraw agent records; owner records are authoritative, so agents get
 *   `forbidden` and a pointer to `ask_owner`. The owner records `owner`
 *   decisions, confirms agent ones (`authority=owner`, `confirmed_at`) and
 *   may supersede or withdraw anything.
 * - **Events:** `decision.published`, `.confirmed`, `.superseded`,
 *   `.withdrawn` and (decision 38) `.acknowledged`, on the scope item (epic
 *   or item scope) or on the project. Each carries its inverse, so every
 *   owner action is undoable (§5.11).
 * - **Needs you (decision 38; B44):** an active agent record of project scope
 *   is a card until the owner confirms, withdraws, supersedes or
 *   acknowledges it (`projectReviews`). Records that predate the card
 *   (`review_grouped`, set by migration 0014) share one card per project.
 *   Item, epic and label records never raise attention.
 */
import { ToolError, type DecisionRecord, type DecisionScopeKind, LIMITS } from '@docket/shared';
import type { Db } from '../db/client.js';
import type { DecisionsService, ReadContext, ServiceDeps } from './contracts.js';
import { newId } from './ids.js';
import { callerName } from './model.js';
import type { InverseOp, WriteContext } from './write.js';

// ---- Rows and the record view ----

interface DecisionDbRow {
  id: string;
  project_key: string;
  scope_kind: DecisionScopeKind;
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
  acknowledged_at: string | null;
  review_grouped: number;
  /** Decision 53: 1 on the record that pauses its project. */
  pauses_project: number;
  version: number;
  created_at: string;
}

const SELECT = `SELECT d.*, (SELECT n.id FROM decision_records n WHERE n.supersedes_id = d.id ORDER BY n.created_at DESC, n.id DESC LIMIT 1) AS superseded_by_id
  FROM decision_records d`;

/** Owner records first, then newest. */
const ORDER = `ORDER BY CASE d.authority WHEN 'owner' THEN 0 ELSE 1 END, d.created_at DESC, d.id DESC`;

export function recordView(d: DecisionDbRow): DecisionRecord {
  return {
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
  };
}

export function decisionById(db: Db, id: string): DecisionRecord | undefined {
  const row = db.sqlite.prepare(`${SELECT} WHERE d.id = ?`).get(id) as DecisionDbRow | undefined;
  return row ? recordView(row) : undefined;
}

// ---- Scope (the one rule) ----

/** What an item inherits from: the item row and its label names. */
export interface ScopeSubject {
  id: string;
  project_key: string;
  type: string;
  epic_id: string | null;
  labels: readonly string[];
}

/** The item's label names. */
export function labelsOf(db: Db, itemId: string): string[] {
  return (
    db.sqlite
      .prepare(
        `SELECT l.name FROM item_labels il JOIN labels l ON l.id = il.label_id
         WHERE il.item_id = ? ORDER BY l.name`,
      )
      .all(itemId) as { name: string }[]
  ).map((l) => l.name);
}

/**
 * Every record that applies to an item: its project, its epic (and, for an
 * epic, itself), its labels and the item. Active only unless asked.
 */
export function inScopeOf(
  db: Db,
  subject: ScopeSubject,
  opts: { includeInactive?: boolean } = {},
): DecisionRecord[] {
  const epics = [subject.epic_id, subject.type === 'Epic' ? subject.id : null].filter(
    (x): x is string => x !== null,
  );
  return (
    db.sqlite
      .prepare(
        `${SELECT} WHERE d.project_key = ? ${opts.includeInactive ? '' : "AND d.status = 'active'"} AND (
           d.scope_kind = 'project'
           OR (d.scope_kind = 'epic' AND d.scope_id IN (SELECT value FROM json_each(?)))
           OR (d.scope_kind = 'item' AND d.scope_id = ?)
           OR (d.scope_kind = 'label' AND d.scope_id IN (SELECT value FROM json_each(?))))
         ${ORDER}`,
      )
      .all(
        subject.project_key,
        JSON.stringify(epics),
        subject.id,
        JSON.stringify(subject.labels),
      ) as DecisionDbRow[]
  ).map(recordView);
}

/** The records of exactly one scope (an epic's own, a label's, the project-wide ones). */
export function ofScope(
  db: Db,
  project: string,
  scope: { kind: DecisionScopeKind; id?: string | null },
  opts: { includeInactive?: boolean } = {},
): DecisionRecord[] {
  return (
    db.sqlite
      .prepare(
        `${SELECT} WHERE d.project_key = ? AND d.scope_kind = ? AND d.scope_id IS ?
         ${opts.includeInactive ? '' : "AND d.status = 'active'"} ${ORDER}`,
      )
      .all(
        project,
        scope.kind,
        scope.kind === 'project' ? null : (scope.id ?? null),
      ) as DecisionDbRow[]
  ).map(recordView);
}

// ---- Needs you: agents' project-wide records to review (decision 38) ----

/** Agent records of project scope, active, not yet acknowledged: what Needs you reviews. */
const TO_REVIEW = `d.scope_kind = 'project' AND d.authority = 'agent' AND d.status = 'active'
  AND d.acknowledged_at IS NULL AND d.project_key IN (SELECT key FROM projects WHERE deleted_at IS NULL)`;

/**
 * Needs you's project-decision cards in scope: one per new agent record
 * (newest first), and one per project for the records that predate the card.
 */
export function projectReviews(
  db: Db,
  scope: string,
): {
  cards: DecisionRecord[];
  groups: { project: string; decisions: { id: string; title: string; author: string }[] }[];
} {
  const inScope = scope === 'all' ? '' : 'AND d.project_key = ?';
  const args = scope === 'all' ? [] : [scope];
  const cards = (
    db.sqlite
      .prepare(
        `${SELECT} WHERE ${TO_REVIEW} AND d.review_grouped = 0 ${inScope}
         ORDER BY d.created_at DESC, d.id DESC`,
      )
      .all(...args) as DecisionDbRow[]
  ).map(recordView);
  const grouped = db.sqlite
    .prepare(
      `SELECT d.id, d.project_key, d.title, d.author FROM decision_records d
       WHERE ${TO_REVIEW} AND d.review_grouped = 1 ${inScope}
       ORDER BY d.project_key, d.created_at DESC, d.id DESC`,
    )
    .all(...args) as { id: string; project_key: string; title: string; author: string }[];
  const groups = new Map<string, { id: string; title: string; author: string }[]>();
  for (const { project_key, ...d } of grouped) {
    const list = groups.get(project_key) ?? [];
    list.push(d);
    groups.set(project_key, list);
  }
  return {
    cards,
    groups: [...groups].map(([project, decisions]) => ({ project, decisions })),
  };
}

// ---- Validation helpers ----

function validation(message: string, fields: Record<string, string>): ToolError {
  return new ToolError('validation', message, { details: { fields } });
}

function requireProject(db: Db, key: string): void {
  const p = db.sqlite
    .prepare('SELECT key FROM projects WHERE key = ? AND deleted_at IS NULL')
    .get(key);
  if (!p) {
    throw new ToolError('not_found', `No project ${key}. Check the key with list_projects.`);
  }
}

interface ItemCore {
  id: string;
  project_key: string;
  type: string;
  epic_id: string | null;
}

function itemCore(db: Db, id: string): ItemCore | undefined {
  return db.sqlite
    .prepare(
      `SELECT i.id, i.project_key, i.type, i.epic_id FROM items i JOIN projects p ON p.key = i.project_key
       WHERE i.id = ? AND p.deleted_at IS NULL`,
    )
    .get(id) as ItemCore | undefined;
}

/** The scope must exist and belong to `project` (MCP_SPEC §5.8: `validation`). */
function checkScope(
  db: Db,
  project: string,
  scope: { kind: DecisionScopeKind; id?: string | undefined },
): string | null {
  if (scope.kind === 'project') return null;
  const id = scope.id ?? '';
  if (!id) {
    throw validation(`A ${scope.kind} scope needs its id.`, { 'scope.id': 'required' });
  }
  if (scope.kind === 'label') {
    const label = db.sqlite
      .prepare('SELECT name FROM labels WHERE project_key = ? AND name = ?')
      .get(project, id);
    if (!label) {
      throw validation(
        `No label "${id}" in ${project}. Use an existing label, or create it with upsert_label first.`,
        { 'scope.id': 'no such label in this project' },
      );
    }
    return id;
  }
  const item = itemCore(db, id);
  if (!item) {
    throw validation(`No item ${id}. Check the ID with search_items.`, {
      'scope.id': 'no such item',
    });
  }
  if (item.project_key !== project) {
    throw validation(
      `${id} is in ${item.project_key}, not ${project}. Publish it in ${item.project_key}, or pick a scope in ${project}.`,
      { 'scope.id': 'in another project' },
    );
  }
  if (scope.kind === 'epic' && item.type !== 'Epic') {
    throw validation(`${id} is a ${item.type}, not an epic. Use scope kind "item" for it.`, {
      'scope.kind': 'not an epic',
    });
  }
  return id;
}

// ---- Cursor ----

const encodeCursor = (offset: number) =>
  Buffer.from(JSON.stringify({ d: offset }), 'utf8').toString('base64url');

function decodeCursor(cursor: string): number {
  try {
    const o = (JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { d?: unknown }).d;
    if (typeof o === 'number' && Number.isInteger(o) && o >= 0) return o;
  } catch {
    // fall through
  }
  throw validation(
    'That cursor is not valid here. Pass next_cursor from the previous list_decisions, or leave it out.',
    { cursor: 'not a list_decisions cursor' },
  );
}

// ---- Events ----

const short = (t: string) => (t.length > 80 ? `${t.slice(0, 79)}…` : t);

/** Epic and item records log on that item; project and label records on the project. */
function where(d: { project_key: string; scope_kind: string; scope_id: string | null }) {
  const onItem = d.scope_kind === 'epic' || d.scope_kind === 'item' ? d.scope_id : null;
  return { item_id: onItem, project_key: d.project_key };
}

const ownerOnly = (what: string) =>
  new ToolError(
    'forbidden',
    `${what} is an owner decision; agents can't change it. To challenge it, use ask_owner.`,
  );

// ---- The service ----

export function createDecisionsService(_deps: ServiceDeps): DecisionsService {
  /** The record, or `not_found`; `conflict` with `current` on a stale expected version. */
  function load(w: WriteContext, id: string, expected?: number): DecisionDbRow {
    const row = w.checkVersion('decision_records', id, expected);
    return row as unknown as DecisionDbRow;
  }

  function mustBeActive(db: Db, row: DecisionDbRow, verb: string): void {
    if (row.status !== 'active') {
      throw new ToolError(
        'conflict',
        `${row.id} is already ${row.status}; only an active decision can be ${verb}. List the active ones with list_decisions.`,
        { current: decisionById(db, row.id) },
      );
    }
  }

  return {
    publish(w, input, opts) {
      const owner = w.actor.kind === 'owner';
      const agent = w.actor.kind === 'agent';
      if (!owner && !agent) {
        throw new ToolError('forbidden', 'Only the owner or an agent can record a decision.');
      }
      requireProject(w.db, input.project);
      const scopeId = checkScope(w.db, input.project, input.scope);
      const author = owner ? 'owner' : callerName(w.db, w.actor);
      const inverse: InverseOp[] = [];

      // Superseding: agents only agent records; the owner anything (§5.14).
      let old: DecisionDbRow | null = null;
      if (input.supersedes) {
        const row = w.get('decision_records', input.supersedes) as DecisionDbRow | undefined;
        if (!row) {
          throw new ToolError(
            'not_found',
            `No decision ${input.supersedes}. Check it with list_decisions include_inactive.`,
          );
        }
        if (row.project_key !== input.project) {
          throw validation(
            `${row.id} is in ${row.project_key}, not ${input.project}. Supersede it from its own project.`,
            { supersedes: 'in another project' },
          );
        }
        if (agent && row.authority === 'owner') throw ownerOnly(row.id);
        mustBeActive(w.db, row, 'superseded');
        // Decision 53: rewording a pause keeps the project paused; only resuming lifts it.
        if (row.pauses_project === 1 && input.scope.kind !== 'project') {
          throw validation(
            `${row.id} pauses all of ${row.project_key}, so its replacement must be project-wide. To lift it, resume the project.`,
            { 'scope.kind': 'must be project' },
          );
        }
        old = row;
      }

      const id = newId('dec', new Date(w.now).getTime());
      const title = input.title.trim();
      inverse.push(
        w.insert('decision_records', {
          id,
          project_key: input.project,
          scope_kind: input.scope.kind,
          scope_id: scopeId,
          title,
          decision_md: input.decision.trim(),
          rationale_md: input.rationale?.trim() || null,
          authority: owner ? 'owner' : 'agent',
          author,
          status: 'active',
          supersedes_id: old?.id ?? null,
          confirmed_at: null,
          acknowledged_at: null,
          review_grouped: 0,
          pauses_project: opts?.pausesProject || old?.pauses_project === 1 ? 1 : 0,
          version: 1,
        }),
      );
      const record = {
        project_key: input.project,
        scope_kind: input.scope.kind,
        scope_id: scopeId,
      };
      const who = owner ? 'Owner' : author;
      if (old) {
        // The old record first, so undo restores it after removing the new one.
        const oldInverse = w.update('decision_records', old.id, { status: 'superseded' });
        w.event({
          type: 'decision.superseded',
          summary: `${who} superseded ${old.id}: ${short(old.title)}`,
          ...where(old),
          data: {
            decision_id: old.id,
            superseded_by: id,
            status: { old: 'active', new: 'superseded' },
          },
          inverse: [oldInverse],
          objects: [{ kind: 'decision', id: old.id }],
        });
      }
      w.event({
        type: 'decision.published',
        summary: `${who} recorded a decision: ${short(title)}`,
        ...where(record),
        data: {
          decision_id: id,
          authority: owner ? 'owner' : 'agent',
          scope: { kind: input.scope.kind, id: scopeId },
          ...(old ? { supersedes: old.id } : {}),
        },
        inverse,
        objects: [{ kind: 'decision', id }],
      });
      return decisionById(w.db, id)!;
    },

    list(r: ReadContext, input) {
      requireProject(r.db, input.project);
      const includeInactive = input.include_inactive ?? false;
      let all: DecisionRecord[];
      if (input.in_scope_of) {
        const item = itemCore(r.db, input.in_scope_of);
        if (!item) {
          throw new ToolError(
            'not_found',
            `No item ${input.in_scope_of}. Check the ID with search_items.`,
          );
        }
        if (item.project_key !== input.project) {
          throw validation(
            `${item.id} is in ${item.project_key}, not ${input.project}. List ${item.project_key}'s decisions instead.`,
            { in_scope_of: 'in another project' },
          );
        }
        all = inScopeOf(r.db, { ...item, labels: labelsOf(r.db, item.id) }, { includeInactive });
        if (input.scope) {
          const s = input.scope;
          all = all.filter(
            (d) => d.scope.kind === s.kind && (s.kind === 'project' || d.scope.id === s.id),
          );
        }
      } else if (input.scope) {
        all = ofScope(r.db, input.project, input.scope, { includeInactive });
      } else {
        all = (
          r.db.sqlite
            .prepare(
              `${SELECT} WHERE d.project_key = ? ${includeInactive ? '' : "AND d.status = 'active'"} ${ORDER}`,
            )
            .all(input.project) as DecisionDbRow[]
        ).map(recordView);
      }
      const limit = input.limit ?? LIMITS.page_default;
      const offset = input.cursor ? decodeCursor(input.cursor) : 0;
      return {
        items: all.slice(offset, offset + limit),
        next_cursor: offset + limit < all.length ? encodeCursor(offset + limit) : null,
      };
    },

    withdraw(w, input) {
      const row = load(w, input.decision_id, input.expected_version);
      if (w.actor.kind === 'agent' && row.authority === 'owner') throw ownerOnly(row.id);
      if (w.actor.kind !== 'agent' && w.actor.kind !== 'owner') {
        throw new ToolError('forbidden', 'Only the owner or an agent can withdraw a decision.');
      }
      mustBeActive(w.db, row, 'withdrawn');
      const who = w.actor.kind === 'owner' ? 'Owner' : callerName(w.db, w.actor);
      const reason = input.reason.trim();
      const lifting = row.pauses_project === 1;
      const inverse = w.update('decision_records', row.id, {
        status: 'withdrawn',
        // Decision 53: aging restarts from this moment, and undo puts it back.
        ...(lifting ? { pause_lifted_at: w.now } : {}),
      });
      w.event({
        type: 'decision.withdrawn',
        summary: `${who} withdrew a decision: ${short(row.title)}${reason ? ` (${short(reason)})` : ''}`,
        ...where(row),
        data: { decision_id: row.id, reason, status: { old: 'active', new: 'withdrawn' } },
        inverse: [inverse],
        objects: [{ kind: 'decision', id: row.id }],
      });
      if (lifting) {
        // However it's withdrawn, the history says the project resumed.
        w.event({
          type: 'project.updated',
          summary: `Owner resumed project ${row.project_key}`,
          project_key: row.project_key,
          data: {
            old: { paused: true },
            new: { paused: false },
            decision_id: row.id,
          },
          inverse: [{ op: 'update', table: 'decision_records', id: row.id, set: {} }],
          objects: [
            { kind: 'project', id: row.project_key },
            { kind: 'decision', id: row.id },
          ],
        });
      }
      return decisionById(w.db, row.id)!;
    },

    confirm(w, input) {
      if (w.actor.kind !== 'owner') {
        throw new ToolError(
          'forbidden',
          'Only the owner can confirm a decision. To propose one, use publish_decision.',
        );
      }
      const row = load(w, input.decision_id, input.expected_version);
      mustBeActive(w.db, row, 'confirmed');
      if (row.authority === 'owner') {
        throw new ToolError(
          'conflict',
          `${row.id} is already an owner decision; there is nothing to confirm.`,
          { current: decisionById(w.db, row.id) },
        );
      }
      const inverse = w.update('decision_records', row.id, {
        authority: 'owner',
        confirmed_at: w.now,
      });
      w.event({
        type: 'decision.confirmed',
        summary: `Owner confirmed a decision: ${short(row.title)}`,
        ...where(row),
        data: {
          decision_id: row.id,
          authority: { old: 'agent', new: 'owner' },
          author: row.author,
        },
        inverse: [inverse],
        objects: [{ kind: 'decision', id: row.id }],
      });
      return decisionById(w.db, row.id)!;
    },

    acknowledge(w, input) {
      if (w.actor.kind !== 'owner') {
        throw new ToolError('forbidden', 'Only the owner can acknowledge a decision.');
      }
      const ids = [...new Set(input.decision_ids)];
      // Check them all first, so one stale record leaves the rest untouched.
      const rows = ids.map((id) => {
        const row = load(w, id);
        mustBeActive(w.db, row, 'acknowledged');
        if (row.scope_kind !== 'project' || row.authority !== 'agent') {
          throw new ToolError(
            'conflict',
            `${row.id} isn't an agent's project-wide decision; only those wait for your review.`,
            { current: decisionById(w.db, row.id) },
          );
        }
        if (row.acknowledged_at !== null) {
          throw new ToolError('conflict', `${row.id} is already acknowledged.`, {
            current: decisionById(w.db, row.id),
          });
        }
        return row;
      });
      return rows.map((row) => {
        const inverse = w.update('decision_records', row.id, { acknowledged_at: w.now });
        w.event({
          type: 'decision.acknowledged',
          summary: `Owner acknowledged a decision by ${row.author}: ${short(row.title)}`,
          ...where(row),
          data: { decision_id: row.id, author: row.author },
          inverse: [inverse],
          objects: [{ kind: 'decision', id: row.id }],
        });
        return decisionById(w.db, row.id)!;
      });
    },
  };
}
