/**
 * Splitting a ticket (owner decision 48; BUILD_SPEC §5.30; B61).
 *
 * One write creates a new ticket from an existing one and moves the chosen
 * acceptance criteria to it. Blockers, shared-part declarations and steps can
 * be moved or copied too. Agents call it through `create_item`'s `split_from`,
 * the owner through `POST /api/items/:id/split`.
 *
 * - **No criterion disappears.** A moved row keeps its ID and text and changes
 *   ticket. Everything not moved stays. The original always keeps at least one.
 * - **What stays.** The lead's claim, runs, reviews and decisions stay on the
 *   original. A moved step leaves the original's plan the way `set_plan` removes
 *   one: its row stays in the old plan version for history, and the new ticket
 *   gets its own row.
 * - **A live lead.** Only the lead's own run, its coordinator or the owner may
 *   split a claimed ticket, with `expected_version`. The step it is on can't move.
 * - **Packets.** An open packet is never edited. If criteria move it is marked
 *   out of date (`criteria_changed_at`, `packet.stale`).
 * - **Undo.** Every change returns its inverse. They all ride on the last event,
 *   `item.split`, which undo applies first, so the new ticket is deleted only
 *   after everything it took has gone back.
 *
 * It adds no gate: a split never blocks a claim, queue or delivery.
 */
import {
  ToolError,
  type ItemSummary,
  type Priority,
  type SplitCarryKind,
  type SplitRelation,
} from '@docket/shared';
import { allocateItemId, newId } from './ids.js';
import {
  OPEN_STORED_SQL,
  activeLead,
  actorName,
  assertCallerRun,
  callerName,
  currentSteps,
  leaseExpired,
  ms,
  planVersion,
  requireItem,
  type ItemRow,
  type StepRow,
} from './model.js';
import { namesCoordinator } from './run-activity.js';
import { syncOverlaps, type OverlapLinks } from './shared-changes.js';
import type { InverseOp, WriteContext } from './write.js';

export interface SplitInput {
  id: string;
  expected_version: number;
  move: number[];
  copy?: number[] | undefined;
  relation: SplitRelation;
  also?: { kind: SplitCarryKind; id: string; copy?: boolean | undefined }[] | undefined;
  coordinator?: string | undefined;
  type: 'Story' | 'Task' | 'Bug';
  title: string;
  description_md?: string | undefined;
  outcome_md?: string | undefined;
  priority?: Priority | undefined;
  status?: 'inbox' | 'planning' | undefined;
  planned_start?: string | undefined;
  planned_end?: string | undefined;
  effort?: number | undefined;
}

interface CriterionRow {
  id: string;
  text: string;
}

interface LinkRow {
  id: string;
  from_id: string;
  to_id: string;
  satisfied_when: string | null;
  created_by: string;
}

interface PartRow {
  id: string;
  part_key: string;
  change: string;
  note: string | null;
  declared_by: string;
  declared_at: string;
  member: string | null;
  design_impact: string;
  design_note: string | null;
  disputed: number;
}

const invalid = (field: string, message: string) =>
  new ToolError('validation', message, { details: { fields: { [field]: message } } });

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A live lead's ticket: only its own run, its coordinator or the owner may split it. */
function assertMaySplit(
  w: WriteContext,
  source: ItemRow,
  coordinator: string | undefined,
): ReturnType<typeof activeLead> {
  const found = activeLead(w.db, source.id);
  const lead = found && !leaseExpired(found, w.now) ? found : undefined;
  if (!lead || w.actor.kind === 'owner') return lead;
  const ownRun =
    w.actor.kind === 'agent' && w.actor.run_id === lead.id && w.actor.client === lead.client;
  const named =
    w.actor.kind === 'agent' &&
    coordinator !== undefined &&
    namesCoordinator(w.db, source.project_key, lead, coordinator);
  if (ownRun || named) return lead;
  const holder = actorName({ kind: 'agent', client: lead.client, label: lead.label });
  throw new ToolError(
    'forbidden',
    `${source.id} is led by ${holder}. Only its lead, its coordinator or the owner can split it.`,
    { current: { lead_client: lead.client, lead_label: lead.label, run_id: lead.id } },
  );
}

/** Check the 1-based positions and return which rows move and which are copied. */
function pickCriteria(rows: CriterionRow[], move: number[], copy: number[]) {
  const check = (field: 'move' | 'copy', list: number[]) => {
    const bad = list.find((n) => n < 1 || n > rows.length);
    if (bad !== undefined) {
      throw invalid(
        field,
        `There is no acceptance criterion ${bad}: this ticket has ${rows.length}. Read it again with get_item.`,
      );
    }
    if (new Set(list).size !== list.length) {
      throw invalid(field, `${field} lists the same criterion twice.`);
    }
  };
  check('move', move);
  check('copy', copy);
  const both = move.find((n) => copy.includes(n));
  if (both !== undefined) {
    throw invalid('copy', `Criterion ${both} is in both move and copy. Choose one.`);
  }
  if (rows.length > 0 && move.length >= rows.length) {
    throw invalid(
      'move',
      'The original must keep at least one acceptance criterion. Copy one, or leave it out of move.',
    );
  }
  const pick = (list: number[]) =>
    rows.filter((_, i) => list.includes(i + 1)).map((row) => ({ row, moved: list === move }));
  return { moved: pick(move), copied: pick(copy) };
}

/** The steps a split may carry: not the one a live run is on, and owner steps only by the owner. */
function assertStepMovable(
  w: WriteContext,
  step: StepRow,
  lead: ReturnType<typeof activeLead>,
): void {
  const onIt = w.db.sqlite
    .prepare(`SELECT 1 FROM runs WHERE current_step_id = ? AND state IN ${OPEN_STORED_SQL} LIMIT 1`)
    .get(step.id);
  if (onIt || (lead && step.state === 'current')) {
    throw invalid(
      'also',
      `The lead is working on step ${step.id}, so it can't move. Copy it, or finish it first.`,
    );
  }
  if (w.actor.kind !== 'owner' && step.added_by === 'owner') {
    throw new ToolError(
      'forbidden',
      `${step.id} was added by the owner; only the owner can move it. You may copy it.`,
      { details: { kind: 'work step' } },
    );
  }
}

export function splitItem(
  w: WriteContext,
  links: OverlapLinks,
  summaryOf: (id: string) => ItemSummary,
  input: SplitInput,
): { item: ItemSummary; source: ItemSummary } {
  w.checkVersion('items', input.id, input.expected_version);
  const source = requireItem(w.db, input.id);
  assertCallerRun(w.db, w.actor, w.now);
  if (source.type === 'Epic') {
    throw invalid('id', `${source.id} is an Epic. Split a Story, Task or Bug.`);
  }
  if (['done', 'canceled'].includes(source.status) || source.archived_at) {
    throw invalid('id', `${source.id} is closed, so it can't be split. Create a new ticket.`);
  }
  const lead = assertMaySplit(w, source, input.coordinator);

  const sql = w.db.sqlite;
  const criteria = sql
    .prepare('SELECT id, text FROM acceptance_criteria WHERE item_id = ? ORDER BY position, id')
    .all(source.id) as CriterionRow[];
  const { moved, copied } = pickCriteria(criteria, input.move, input.copy ?? []);

  // ---- What else comes along ----
  const also = input.also ?? [];
  const seen = new Set<string>();
  for (const a of also) {
    const key = `${a.kind}:${a.id}`;
    if (seen.has(key)) throw invalid('also', `also lists ${a.kind} ${a.id} twice.`);
    seen.add(key);
  }
  if (moved.length + copied.length + also.length === 0) {
    throw invalid(
      'move',
      'Nothing to split. Choose at least one criterion, blocker, part or step.',
    );
  }
  const blockers = also
    .filter((a) => a.kind === 'blocker')
    .map((a) => {
      const row = sql
        .prepare("SELECT * FROM links WHERE from_id = ? AND to_id = ? AND type = 'blocks'")
        .get(a.id, source.id) as LinkRow | undefined;
      if (!row) throw invalid('also', `${a.id} doesn't block ${source.id}.`);
      if (!a.copy) {
        // Docket's sequence for an overlap belongs to that pair of tickets.
        const held = sql
          .prepare("SELECT 1 FROM part_overlaps WHERE link_id = ? AND state <> 'resolved'")
          .get(row.id);
        if (held) {
          throw invalid(
            'also',
            `${a.id} blocks ${source.id} because they change the same shared part, so that blocker can't move. Copy it instead.`,
          );
        }
      }
      return { row, copy: a.copy === true };
    });
  const parts = also
    .filter((a) => a.kind === 'part')
    .map((a) => {
      const row = sql
        .prepare('SELECT * FROM item_shared_changes WHERE item_id = ? AND part_key = ?')
        .get(source.id, a.id) as PartRow | undefined;
      if (!row) throw invalid('also', `${source.id} doesn't declare the shared part ${a.id}.`);
      return { row, copy: a.copy === true };
    });
  const planSteps = currentSteps(w.db, source.id);
  const steps = also
    .filter((a) => a.kind === 'step')
    .map((a) => {
      const row = planSteps.find((s) => s.id === a.id);
      if (!row) throw invalid('also', `${a.id} isn't on ${source.id}'s current plan.`);
      if (!a.copy) assertStepMovable(w, row, lead);
      return { row, copy: a.copy === true };
    });

  // ---- The new ticket ----
  const who = callerName(w.db, w.actor);
  const id = allocateItemId(sql, source.project_key);
  const dated = input.planned_start !== undefined || input.planned_end !== undefined;
  const ops: InverseOp[] = [
    w.insert('items', {
      id,
      project_key: source.project_key,
      type: input.type,
      title: input.title,
      description_md: input.description_md ?? '',
      outcome_md: input.outcome_md ?? '',
      status: input.status ?? 'inbox',
      priority: input.priority ?? source.priority,
      epic_id: source.epic_id,
      planned_start: input.planned_start ?? null,
      planned_end: input.planned_end ?? null,
      dates_set_by: dated ? who : null,
      dates_set_at: dated ? w.now : null,
      effort: input.effort ?? null,
      imported: false,
      split_from: source.id,
    }),
  ];
  for (const l of sql
    .prepare('SELECT label_id FROM item_labels WHERE item_id = ?')
    .all(source.id) as { label_id: string }[]) {
    ops.push(
      w.insert('item_labels', {
        id: newId('il', ms(w.now)),
        item_id: id,
        label_id: l.label_id,
      }),
    );
  }

  // Criteria, in the original's order. A moved row keeps its ID.
  [...moved, ...copied]
    .sort((a, b) => criteria.indexOf(a.row) - criteria.indexOf(b.row))
    .forEach(({ row, moved: isMove }, position) => {
      ops.push(
        isMove
          ? w.update('acceptance_criteria', row.id, { item_id: id, position })
          : w.insert('acceptance_criteria', {
              id: newId('ac', ms(w.now)),
              item_id: id,
              position,
              text: row.text,
            }),
      );
    });

  // Blockers.
  const linkEvents: { from: string; to: string; link: string }[] = [];
  for (const { row, copy } of blockers) {
    if (copy) {
      const linkId = newId('lnk', ms(w.now));
      ops.push(
        w.insert('links', {
          id: linkId,
          from_id: row.from_id,
          to_id: id,
          type: 'blocks',
          satisfied_when: row.satisfied_when,
          created_by: who,
        }),
      );
      linkEvents.push({ from: row.from_id, to: id, link: linkId });
    } else {
      ops.push(w.update('links', row.id, { to_id: id }));
      linkEvents.push({ from: row.from_id, to: id, link: row.id });
    }
  }
  if (input.relation !== 'none') {
    const [from, to] = input.relation === 'after_original' ? [source.id, id] : [id, source.id];
    const linkId = newId('lnk', ms(w.now));
    ops.push(
      w.insert('links', { id: linkId, from_id: from, to_id: to, type: 'blocks', created_by: who }),
    );
    linkEvents.push({ from, to, link: linkId });
  }

  // Shared-part declarations.
  for (const { row, copy } of parts) {
    ops.push(
      copy
        ? w.insert('item_shared_changes', {
            id: newId('isc', ms(w.now)),
            item_id: id,
            part_key: row.part_key,
            change: row.change,
            note: row.note,
            declared_by: row.declared_by,
            declared_at: row.declared_at,
            member: row.member,
            design_impact: row.design_impact,
            design_note: row.design_note,
            disputed: row.disputed === 1,
          })
        : w.update('item_shared_changes', row.id, { item_id: id }),
    );
  }

  // Steps: the new ticket's first plan, then the original's next one without the moved steps.
  if (steps.length > 0) {
    ops.push(
      w.insert('plan_versions', {
        id: newId('pv', ms(w.now)),
        item_id: id,
        version_no: 1,
        reason: `Split from ${source.id}`,
        created_by: who,
      }),
    );
    steps.forEach(({ row, copy }, position) => {
      ops.push(
        w.insert('work_steps', {
          id: newId('wst', ms(w.now)),
          item_id: id,
          plan_version_no: 1,
          position,
          text: row.text,
          state: copy ? 'todo' : row.state,
          was_text: row.was_text,
          from_review: row.from_review,
          added_by: row.added_by,
          state_by: copy ? null : row.state_by,
          state_at: copy ? null : row.state_at,
          details_md: row.details_md,
          source: row.source,
          details_version: row.details_version,
        }),
      );
    });
  }
  const leaving = steps.filter((s) => !s.copy).map((s) => s.row.id);
  const planWas = planVersion(w.db, source.id);
  if (leaving.length > 0) {
    ops.push(
      w.insert('plan_versions', {
        id: newId('pv', ms(w.now)),
        item_id: source.id,
        version_no: planWas + 1,
        reason: `Split into ${id}`,
        created_by: who,
      }),
    );
    planSteps
      .filter((s) => !leaving.includes(s.id))
      .forEach((s, position) => {
        ops.push(w.update('work_steps', s.id, { plan_version_no: planWas + 1, position }));
      });
  }

  // An open packet stays as it was built, and is marked out of date.
  const packet =
    moved.length > 0
      ? (sql
          .prepare("SELECT id, round FROM packets WHERE item_id = ? AND state = 'open'")
          .get(source.id) as { id: string; round: number } | undefined)
      : undefined;
  if (packet) ops.push(w.update('packets', packet.id, { criteria_changed_at: w.now }));

  // Moving a declaration can end an overlap. Docket's own decisions record their inverse; an
  // open question that resolves does not, so it is put back here.
  if (parts.some((p) => !p.copy)) {
    const before = sql
      .prepare('SELECT id, state, decided_by FROM part_overlaps WHERE item_a = ? OR item_b = ?')
      .all(source.id, source.id) as { id: string; state: string; decided_by: string | null }[];
    syncOverlaps(w, links, source.id);
    for (const row of before) {
      if (row.decided_by === 'docket') continue;
      const now = w.get('part_overlaps', row.id) as { state: string } | undefined;
      if (now && now.state !== row.state) {
        ops.push({ op: 'update', table: 'part_overlaps', id: row.id, set: { state: row.state } });
      }
    }
  }

  ops.push(w.update('items', source.id, {}));

  // ---- Events: one undo reverses them all, and the last one carries the inverse ----
  const touch: InverseOp[] = [{ op: 'update', table: 'items', id: source.id, set: {} }];
  const project = source.project_key;
  if (leaving.length > 0) {
    w.event({
      type: 'plan.updated',
      summary: `${who} moved ${count(leaving.length, 'step')} to ${id} (v${planWas + 1})`,
      item_id: source.id,
      project_key: project,
      data: {
        plan_version: { old: planWas, new: planWas + 1 },
        added: [],
        removed: leaving,
        changed: {},
        reason: `Split into ${id}`,
      },
      inverse: touch,
    });
  }
  if (packet) {
    w.event({
      type: 'packet.stale',
      summary: `Packet round ${packet.round} on ${source.id} is out of date: its acceptance criteria moved to ${id}`,
      item_id: source.id,
      project_key: project,
      data: { packet_id: packet.id, round: packet.round, reason: 'criteria_moved', split_into: id },
      objects: [{ kind: 'packet', id: packet.id }],
      inverse: touch,
    });
  }
  for (const l of linkEvents) {
    w.event({
      type: 'link.added',
      summary: `${l.from} blocks ${l.to}`,
      item_id: id,
      project_key: project,
      data: { link_id: l.link, from: l.from, to: l.to, type: 'blocks', split: true },
      objects: [{ kind: 'link', id: l.link }],
      inverse: touch,
    });
  }
  w.event({
    type: 'item.created',
    summary: `${who} created ${input.type.toLowerCase()} ${id} ${input.title}, split from ${source.id}`,
    item_id: id,
    project_key: project,
    data: { status: input.status ?? 'inbox', labels_created: [], split_from: source.id },
    objects: [{ kind: 'item', id: source.id }],
    inverse: touch,
  });
  const facts = [
    moved.length > 0 ? `moved ${count(moved.length, 'criterion', 'criteria')}` : null,
    copied.length > 0 ? `copied ${count(copied.length, 'criterion', 'criteria')}` : null,
    blockers.length > 0 ? count(blockers.length, 'blocker') : null,
    parts.length > 0 ? count(parts.length, 'shared part') : null,
    steps.length > 0 ? count(steps.length, 'step') : null,
  ].filter(Boolean);
  w.event({
    type: 'item.split',
    summary: `${who} split ${id} from ${source.id}: ${facts.join(', ')}`,
    item_id: source.id,
    project_key: project,
    data: {
      split_into: id,
      relation: input.relation,
      moved: moved.map((m) => m.row.id),
      copied: copied.length,
      blockers: blockers.length,
      parts: parts.length,
      steps: steps.length,
    },
    objects: [{ kind: 'item', id }],
    inverse: ops,
  });
  return { item: summaryOf(id), source: summaryOf(source.id) };
}
