/**
 * Items: create, edit, status transitions, labels and the owner's field and text edits (BUILD_SPEC §5.1; decision 22): the `items` service.
 *
 * US1 (T070) implements create, update (patch semantics, labels, dates with
 * `dates_set_by`), `set_status` with its guards, and `get_item`. US7 (T125)
 * adds the owner's `PATCH` (priority, the Inbox/Planning/Ready moves, and
 * inline text edits with the same limits, secret check and conflict
 * handling as agents, undoable; decision 22), `upsert_label`, and the label
 * page's *Move N to Ready*. US11 (T100) adds `Item.resume` and each run's
 * workspace (with its derived state) and `resume_ready`.
 */
import {
  ToolError,
  type ItemSummary,
  type ItemText,
  type ItemView,
  type Status,
} from '@docket/shared';
import {
  type DeliveryReceipt,
  type In,
  type ItemsService,
  type ReadContext,
  type ServiceDeps,
} from './contracts.js';
import { allocateItemId, newId } from './ids.js';
import { RecoveryReader } from './recovery-model.js';
import {
  BlockIndex,
  EVENT_COLUMNS,
  EVENT_FROM,
  activeLead,
  actorName,
  addedBy,
  assertCallerRun,
  callerName,
  checksOf,
  eventRow,
  leaseExpired,
  ms,
  requireItem,
  summarize,
  summaryOf,
  windowsOf,
  workStepsOf,
  type ItemRow,
  type RunRow,
  type StoredEvent,
} from './model.js';
import { inScopeOf } from './decisions.js';
import { assertDesignCleared } from './design-review.js';
import { activeSessionOf } from './onboarding-tag.js';
import {
  HoldRefusal,
  assertReadyGate,
  hasDeclared,
  onItemClosed,
  settleUndeclared,
} from './shared-changes.js';
import type { InverseOp, WriteContext } from './write.js';
import type { Db } from '../db/client.js';
import { choiceField } from './question-form.js';
import { addReportedBranch } from './radar.js';
import { producerHold } from './run-activity.js';
import { splitItem } from './split.js';
import {
  approveGaps,
  assertEpicReady,
  assertGapsApproved,
  clearApproval,
  editGaps,
  gapsCleared,
  gapsOf,
  knownGapsView,
  openGaps,
  type StoredGaps,
} from './epic-readiness.js';

const knownGapsField = (raw: unknown) => {
  const view = knownGapsView(raw);
  return view ? { known_gaps: view } : {};
};

/** Decision 42: `producer_hold`, only while the story is between workers. */
function holdField(db: Db, id: string, openRuns: number) {
  if (openRuns > 0) return {};
  const hold = producerHold(db, id);
  return hold
    ? {
        producer_hold: {
          producer: hold.producer,
          until: hold.until,
          last_worker: hold.last_worker,
        },
      }
    : {};
}

/** The moves `set_status` allows from each status (BUILD_SPEC §5.1). Review is entered by submit_packet. */
export const ALLOWED_MOVES: Record<Status, Status[]> = {
  inbox: ['planning', 'canceled'],
  planning: ['ready', 'canceled'],
  ready: ['planning', 'progress', 'canceled'],
  progress: ['ready', 'done', 'canceled'],
  review: ['progress', 'done', 'canceled'],
  done: ['progress'],
  canceled: [],
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (ids: string[]) => ids.join(', ');

/** The owner's status moves on `PATCH /api/items/:id` (UI_SPEC §6.3 contextual actions). */
const OWNER_MOVES: Partial<Record<Status, Status[]>> = {
  inbox: ['planning'],
  planning: ['ready'],
  ready: ['planning'],
};

/** How Activity names the fields the owner edits inline ("You edited the outcome"). */
const TEXT_NAMES = {
  title: 'title',
  description_md: 'description',
  outcome_md: 'outcome',
  acceptance: 'acceptance criteria',
} as const;

/** "a", "a and b", "a, b and c". */
const joinWords = (words: string[]) =>
  words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)!}`;

export function createItemsService(deps: ServiceDeps): ItemsService {
  const windows = () => windowsOf(deps.config);
  const summary = (w: { db: WriteContext['db']; now: string }, id: string): ItemSummary =>
    summaryOf({ db: w.db, windows: windows(), now: w.now }, id);

  // ---- Labels and acceptance ----

  function labelId(w: WriteContext, project: string, name: string, created: string[]): string {
    const row = w.db.sqlite
      .prepare('SELECT id FROM labels WHERE project_key = ? AND name = ?')
      .get(project, name) as { id: string } | undefined;
    if (row) return row.id;
    const id = newId('lbl', ms(w.now));
    w.insert('labels', { id, project_key: project, name, brief_md: '' });
    created.push(name);
    return id;
  }

  function currentLabels(w: WriteContext, itemId: string): string[] {
    return (
      w.db.sqlite
        .prepare(
          'SELECT l.name FROM item_labels il JOIN labels l ON l.id = il.label_id WHERE il.item_id = ? ORDER BY l.name',
        )
        .all(itemId) as { name: string }[]
    ).map((r) => r.name);
  }

  function setLabels(
    w: WriteContext,
    item: { id: string; project_key: string },
    names: string[],
  ): string[] {
    const created: string[] = [];
    const want = [...new Set(names)].sort();
    const have = currentLabels(w, item.id);
    for (const name of have.filter((n) => !want.includes(n))) {
      const link = w.db.sqlite
        .prepare(
          'SELECT il.id FROM item_labels il JOIN labels l ON l.id = il.label_id WHERE il.item_id = ? AND l.name = ?',
        )
        .get(item.id, name) as { id: string };
      w.remove('item_labels', link.id);
    }
    for (const name of want.filter((n) => !have.includes(n))) {
      w.insert('item_labels', {
        id: newId('il', ms(w.now)),
        item_id: item.id,
        label_id: labelId(w, item.project_key, name, created),
      });
    }
    return created;
  }

  function setAcceptance(w: WriteContext, itemId: string, texts: string[]): void {
    for (const row of w.db.sqlite
      .prepare('SELECT id FROM acceptance_criteria WHERE item_id = ?')
      .all(itemId) as { id: string }[]) {
      w.remove('acceptance_criteria', row.id);
    }
    texts.forEach((text, position) => {
      w.insert('acceptance_criteria', {
        id: newId('ac', ms(w.now)),
        item_id: itemId,
        position,
        text,
      });
    });
  }

  function acceptanceOf(db: WriteContext['db'], itemId: string): string[] {
    return (
      db.sqlite
        .prepare('SELECT text FROM acceptance_criteria WHERE item_id = ? ORDER BY position, id')
        .all(itemId) as { text: string }[]
    ).map((r) => r.text);
  }

  /** An epic reference must be an Epic in the same project, and an epic can't have an epic. */
  function checkEpic(
    w: WriteContext,
    epic: string,
    item: { id?: string; project: string; type: string },
  ): void {
    if (item.type === 'Epic') {
      throw new ToolError(
        'validation',
        'An Epic cannot belong to another epic. Leave epic out for an Epic.',
        {
          details: { fields: { epic: 'not allowed on an Epic' } },
        },
      );
    }
    if (epic === item.id) {
      throw new ToolError(
        'validation',
        'An item cannot be its own epic. Pass an Epic in the same project.',
        {
          details: { fields: { epic: 'is the item itself' } },
        },
      );
    }
    const row = w.db.sqlite
      .prepare('SELECT type, project_key FROM items WHERE id = ?')
      .get(epic) as { type: string; project_key: string } | undefined;
    if (!row || row.type !== 'Epic' || row.project_key !== item.project) {
      throw new ToolError(
        'validation',
        `${epic} is not an Epic in ${item.project}. Pass an Epic from the same project (search_items type ["Epic"]).`,
        { details: { fields: { epic: 'must be an Epic in the same project' } } },
      );
    }
  }

  function checkDates(start: string | null | undefined, end: string | null | undefined): void {
    if (start && end && start > end) {
      throw new ToolError(
        'validation',
        `planned_start ${start} is after planned_end ${end}. Swap or fix the dates.`,
        {
          details: { fields: { planned_start: 'is after planned_end' } },
        },
      );
    }
  }

  // ---- Status ----

  /** May the caller act on the claim `lead` holds? Its own run, or the same agent client (FR-027). */
  const ownsLead = (w: WriteContext, lead: RunRow) =>
    w.actor.kind !== 'agent' || w.actor.run_id === lead.id || w.actor.client === lead.client;

  function refuse(
    id: string,
    from: Status,
    to: Status,
    extra: Record<string, unknown> = {},
    message?: string,
  ): never {
    const allowed = ALLOWED_MOVES[from];
    const hint =
      to === 'review' && from === 'progress'
        ? 'Hand off for review with submit_packet.'
        : allowed.length > 0
          ? `Allowed moves: ${allowed.join(', ')}.`
          : `${from} is final; nothing moves out of it.`;
    throw new ToolError(
      'validation',
      message ?? `Can't move ${id} from ${from} to ${to}. ${hint}`,
      { details: { allowed, ...extra } },
    );
  }

  function openChildren(db: WriteContext['db'], epic: string): string[] {
    return (
      db.sqlite
        .prepare(
          "SELECT id FROM items WHERE epic_id = ? AND status NOT IN ('done', 'canceled') ORDER BY project_key, CAST(substr(id, instr(id, '-') + 1) AS INTEGER)",
        )
        .all(epic) as { id: string }[]
    ).map((r) => r.id);
  }

  /** `create_item` with `split_from` (decision 48): the rest of the call describes the new ticket. */
  function splitFromCreate(
    w: WriteContext,
    input: In<'create_item'>,
    from: NonNullable<In<'create_item'>['split_from']>,
  ): ItemSummary {
    const source = requireItem(w.db, from.id);
    if (input.project !== source.project_key) {
      throw new ToolError(
        'validation',
        `A split stays in ${source.project_key}. Pass project ${source.project_key}.`,
        { details: { fields: { project: 'must be the original ticket project' } } },
      );
    }
    if (input.type === 'Epic') {
      throw new ToolError('validation', 'A split creates a Story, Task or Bug.', {
        details: { fields: { type: 'must not be Epic' } },
      });
    }
    if (input.epic !== undefined && input.epic !== source.epic_id) {
      throw new ToolError('validation', "A split keeps the original's epic. Leave epic out.", {
        details: { fields: { epic: 'a split keeps the epic' } },
      });
    }
    for (const field of ['labels', 'blocked_by', 'acceptance'] as const) {
      if (input[field] !== undefined) {
        const hint =
          field === 'labels'
            ? "A split keeps the original's labels; change them afterwards with update_item."
            : field === 'blocked_by'
              ? 'In a split, choose blockers with split_from.also.'
              : 'In a split, acceptance comes from split_from.move and copy.';
        throw new ToolError('validation', hint, {
          details: { fields: { [field]: 'not with split_from' } },
        });
      }
    }
    checkDates(input.planned_start, input.planned_end);
    return splitItem(w, deps.services().links, (id) => summary(w, id), {
      ...from,
      type: input.type,
      title: input.title,
      description_md: input.description_md,
      outcome_md: input.outcome_md,
      priority: input.priority,
      status: input.status,
      planned_start: input.planned_start,
      planned_end: input.planned_end,
      effort: input.effort,
    }).item;
  }

  return {
    create(w, input) {
      if (input.split_from) return splitFromCreate(w, input, input.split_from);
      assertCallerRun(w.db, w.actor, w.now);
      const project = w.db.sqlite
        .prepare('SELECT key FROM projects WHERE key = ? AND deleted_at IS NULL')
        .get(input.project) as { key: string } | undefined;
      if (!project) {
        throw new ToolError(
          'not_found',
          `No project ${input.project}. Check the key with list_projects.`,
        );
      }
      if (input.epic) checkEpic(w, input.epic, { project: input.project, type: input.type });
      checkDates(input.planned_start, input.planned_end);
      const blockers = [...new Set(input.blocked_by ?? [])];
      for (const b of blockers) {
        if (!w.get('items', b))
          throw new ToolError('not_found', `No item ${b}. Check the ID with search_items.`);
      }
      const id = allocateItemId(w.db.sqlite, input.project);
      const who = callerName(w.db, w.actor);
      const dated = input.planned_start !== undefined || input.planned_end !== undefined;
      w.insert('items', {
        id,
        project_key: input.project,
        type: input.type,
        title: input.title,
        description_md: input.description_md ?? '',
        outcome_md: input.outcome_md ?? '',
        status: input.status ?? 'inbox',
        priority: input.priority ?? 2,
        epic_id: input.epic ?? null,
        planned_start: input.planned_start ?? null,
        planned_end: input.planned_end ?? null,
        dates_set_by: dated ? who : null,
        dates_set_at: dated ? w.now : null,
        effort: input.effort ?? null,
        imported: false,
      });
      if (input.acceptance?.length) setAcceptance(w, id, input.acceptance);
      const createdLabels = input.labels?.length
        ? setLabels(w, { id, project_key: input.project }, input.labels)
        : [];
      w.event({
        type: 'item.created',
        summary: `${who} created ${input.type.toLowerCase()} ${id} ${input.title}`,
        item_id: id,
        project_key: input.project,
        data: { status: input.status ?? 'inbox', labels_created: createdLabels },
      });
      for (const blocker of blockers) {
        const linkId = newId('lnk', ms(w.now));
        w.insert('links', {
          id: linkId,
          from_id: blocker,
          to_id: id,
          type: 'blocks',
          created_by: who,
        });
        w.event({
          type: 'link.added',
          summary: `${blocker} blocks ${id}`,
          item_id: id,
          project_key: input.project,
          data: { link_id: linkId, from: blocker, to: id, type: 'blocks' },
          objects: [
            { kind: 'item', id: blocker },
            { kind: 'link', id: linkId },
          ],
        });
      }
      return summary(w, id);
    },

    split(w, input) {
      return splitItem(w, deps.services().links, (id) => summary(w, id), input);
    },

    update(w, input) {
      const before = w.checkVersion(
        'items',
        input.id,
        input.expected_version,
      ) as unknown as ItemRow;
      requireItem(w.db, input.id);
      assertCallerRun(w.db, w.actor, w.now);
      const set: Record<string, unknown> = {};
      const changed: Record<string, { old: unknown; new: unknown }> = {};
      const field = (key: keyof ItemRow, value: unknown) => {
        if (value === undefined) return;
        set[key] = value;
        if (before[key] !== value) changed[key] = { old: before[key], new: value };
      };
      field('title', input.title);
      field('description_md', input.description_md);
      field('outcome_md', input.outcome_md);
      field('priority', input.priority);
      if (input.epic !== undefined) {
        if (input.epic !== null)
          checkEpic(w, input.epic, {
            id: before.id,
            project: before.project_key,
            type: before.type,
          });
        field('epic_id', input.epic);
      }
      if (input.effort !== undefined) field('effort', input.effort);
      if (input.planned_start !== undefined || input.planned_end !== undefined) {
        const start =
          input.planned_start !== undefined ? input.planned_start : before.planned_start;
        const end = input.planned_end !== undefined ? input.planned_end : before.planned_end;
        checkDates(start, end);
        field('planned_start', input.planned_start);
        field('planned_end', input.planned_end);
        set.dates_set_by = callerName(w.db, w.actor);
        set.dates_set_at = w.now;
      }
      let labelsCreated: string[] = [];
      const labelsTouched =
        input.labels !== undefined ||
        input.add_labels !== undefined ||
        input.remove_labels !== undefined;
      if (labelsTouched) {
        const old = currentLabels(w, before.id);
        let next = input.labels ?? old;
        next = [...next, ...(input.add_labels ?? [])].filter(
          (n) => !(input.remove_labels ?? []).includes(n),
        );
        labelsCreated = setLabels(w, before, next);
        const now = currentLabels(w, before.id);
        if (now.join(',') !== old.join(',')) changed.labels = { old, new: now };
      }
      if (input.acceptance !== undefined) {
        const old = acceptanceOf(w.db, before.id);
        setAcceptance(w, before.id, input.acceptance);
        if (old.join('\n') !== input.acceptance.join('\n'))
          changed.acceptance = { old, new: input.acceptance };
      }
      // Decision 58: what implementation will settle, and how each one was.
      if (input.known_gaps !== undefined) {
        const was = gapsOf(w.db, before.id);
        const edit = editGaps(w, before, input.known_gaps);
        if (edit.changed) {
          set.known_gaps = edit.value;
          const brief = (g: StoredGaps | null) =>
            (g?.gaps ?? []).map((x) => ({ gap: x.gap, settled: x.settled }));
          changed.known_gaps = { old: brief(was), new: brief(edit.value) };
        }
      }
      const sent = Object.keys(input).filter(
        (k) => !['id', 'expected_version', 'run_id'].includes(k),
      );
      if (sent.length === 0) {
        throw new ToolError('validation', 'Nothing to update: send at least one field to change.', {
          details: { fields: {} },
        });
      }
      w.update('items', before.id, set);
      const names = Object.keys(changed).map((k) => (k === 'epic_id' ? 'epic' : k));
      w.event({
        type: 'item.updated',
        summary: `${callerName(w.db, w.actor)} updated ${before.id}: ${names.length > 0 ? names.join(', ') : 'no changes'}`,
        item_id: before.id,
        project_key: before.project_key,
        data: { changed, labels_created: labelsCreated },
      });
      return summary(w, before.id);
    },

    ownerPatch(w, input) {
      const before = requireItem(w.db, input.id);
      if (before.version !== input.expected_version) staleEdit(w, before, input);
      const set: Record<string, unknown> = {};
      const changed: Record<string, { old: unknown; new: unknown }> = {};
      const inverse: InverseOp[] = [];
      const texts: string[] = [];
      for (const key of ['title', 'description_md', 'outcome_md'] as const) {
        const value = input[key];
        if (value === undefined || value === before[key]) continue;
        set[key] = value;
        changed[key] = { old: before[key], new: value };
      }
      if (input.priority !== undefined && input.priority !== before.priority) {
        set.priority = input.priority;
        changed.priority = { old: before.priority, new: input.priority };
      }
      let move: { from: Status; to: Status } | null = null;
      if (input.status !== undefined && input.status !== before.status) {
        const from = before.status;
        const to = input.status;
        const ok =
          (from === 'inbox' && to === 'planning') ||
          (from === 'planning' && to === 'ready') ||
          (from === 'ready' && to === 'planning');
        if (!ok) {
          throw new ToolError(
            'validation',
            `${before.id} is ${from}; here you can move Inbox items to Planning, and Planning and Ready items between each other. Use Return to Ready or Release lead claim for work in progress.`,
            { details: { status: from, allowed: OWNER_MOVES[from] ?? [] } },
          );
        }
        // The Ready gate (decision 36): undeclared items need the owner's reason.
        if (to === 'ready' && !input.override_reason) assertReadyGate(w.db, before, true);
        // Decision 58: open known gaps move to Ready only with the owner's approval.
        if (to === 'ready' && !gapsCleared(gapsOf(w.db, before.id))) {
          if (!input.approve_gaps) {
            const open = openGaps(gapsOf(w.db, before.id));
            throw new ToolError(
              'validation',
              `${before.id} has ${open.length} open known gap${open.length === 1 ? '' : 's'}. Approve ${open.length === 1 ? 'it' : 'them'} to move it to Ready, or shape ${open.length === 1 ? 'it' : 'them'} first.`,
              { details: { known_gaps: open.map((g) => g.gap), approve: 'approve_gaps' } },
            );
          }
          approveGaps(w, deps, before, { via: 'item_page', move: false });
        }
        if (to === 'planning') Object.assign(set, clearApproval(w.db, before.id));
        set.status = to;
        move = { from, to };
      }
      if (input.acceptance !== undefined) {
        const rows = w.db.sqlite
          .prepare(
            'SELECT id, text FROM acceptance_criteria WHERE item_id = ? ORDER BY position, id',
          )
          .all(before.id) as { id: string; text: string }[];
        const old = rows.map((r) => r.text);
        if (old.join('\n') !== input.acceptance.join('\n')) {
          for (const r of rows) inverse.push(w.remove('acceptance_criteria', r.id));
          input.acceptance.forEach((text, position) => {
            inverse.push(
              w.insert('acceptance_criteria', {
                id: newId('ac', ms(w.now)),
                item_id: before.id,
                position,
                text,
              }),
            );
          });
          changed.acceptance = { old, new: input.acceptance };
        }
      }
      for (const key of ['title', 'description_md', 'outcome_md', 'acceptance'] as const) {
        if (changed[key]) texts.push(TEXT_NAMES[key]);
      }
      const edited = texts.length > 0 || changed.priority !== undefined;
      // Nothing differs: no write and no event (the write path allows an explicit no-op).
      if (!edited && !move) return itemText(w, before.id);
      inverse.push(w.update('items', before.id, set));
      if (edited) {
        const parts: string[] = [];
        if (texts.length > 0) parts.push(`edited the ${joinWords(texts)}`);
        if (changed.priority) parts.push(`set ${before.id} to P${String(input.priority)}`);
        w.event({
          type: 'item.updated',
          summary: `You ${parts.join(' and ')}`,
          item_id: before.id,
          project_key: before.project_key,
          data: { changed, fields: Object.keys(changed) },
          inverse,
        });
      }
      if (move) {
        // One undo reverses both: the update event carries the inverse when there is one.
        const touch: InverseOp = { op: 'update', table: 'items', id: before.id, set: {} };
        const override =
          move.to === 'ready' && input.override_reason && !hasDeclared(w.db, before.id)
            ? input.override_reason
            : null;
        w.event({
          type: 'item.status_changed',
          summary: `You moved ${before.id} from ${move.from} to ${move.to}${override ? ` without declaring its shared changes: ${override}` : ''}`,
          item_id: before.id,
          project_key: before.project_key,
          data: {
            status: { old: move.from, new: move.to },
            ...(override ? { override_reason: override } : {}),
          },
          inverse: edited ? [touch] : inverse,
        });
      }
      return itemText(w, before.id);
    },

    setStatus(w, input) {
      const item = w.checkVersion('items', input.id, input.expected_version) as unknown as ItemRow;
      requireItem(w.db, input.id);
      assertCallerRun(w.db, w.actor, w.now);
      const from = item.status;
      const to = input.status;
      const agent = w.actor.kind === 'agent';
      if (!ALLOWED_MOVES[from].includes(to)) refuse(item.id, from, to);
      // Onboarding never makes anything Ready (decision 31; US15 scenario 3).
      if (to === 'ready' && activeSessionOf(w.db, w.actor, item.project_key)) {
        throw new ToolError(
          'forbidden',
          `You're onboarding ${item.project_key}: leave ${item.id} in ${from}. The owner moves items to Ready after reviewing the onboarding.`,
        );
      }

      let lead = activeLead(w.db, item.id);
      if (lead && leaseExpired(lead, w.now)) {
        // The claim is already over; end it as such before moving.
        w.update('runs', lead.id, { state: 'interrupted', end_reason: 'lease_expired' });
        lead = undefined;
      }
      const endsClaim =
        (from === 'progress' && to === 'ready') || to === 'done' || to === 'canceled';
      if (lead && endsClaim && !ownsLead(w, lead)) {
        const holder = actorName({ kind: 'agent', client: lead.client, label: lead.label });
        throw new ToolError(
          'forbidden',
          `${item.id} is led by ${holder}; only its lead can move it to ${to}. Pick another item, or ask the owner.`,
          { current: { lead_client: lead.client, lead_label: lead.label, run_id: lead.id } },
        );
      }

      // The Ready gate (decision 36; FR-159): planning → ready needs a declaration, or none.
      // Giving up work (progress → ready) isn't gated: the item was Ready before.
      if (from === 'planning' && to === 'ready') {
        assertReadyGate(w.db, item);
        // Decision 58: open known gaps need the owner's approval; the refusal asks for it.
        if (w.actor.kind !== 'owner') assertGapsApproved(w, item);
      }
      // Decision 39: an unapproved change to an approved design pauses this item.
      if (to === 'done') assertDesignCleared(w.db, item, 'close', !agent);
      if (from === 'ready' && to === 'progress') {
        // Decision 58: an epic starts only when every ticket is at least Ready.
        assertEpicReady(w.db, item);
        assertDesignCleared(w.db, item, 'start', !agent);
        const s = summary(w, item.id);
        if (s.blocked) {
          refuse(
            item.id,
            from,
            to,
            { blocked_by: s.blocked_by },
            `${item.id} is blocked by ${list(s.blocked_by)}. It can start once they clear.`,
          );
        }
      }
      if (to === 'done') {
        const undecided = (
          w.db.sqlite
            .prepare(
              "SELECT id FROM hr_items WHERE item_id = ? AND state IN ('declared', 'ready') ORDER BY position, id",
            )
            .all(item.id) as { id: string }[]
        ).map((r) => r.id);
        const allowed = ALLOWED_MOVES[from].filter((s) => s !== 'done');
        if (undecided.length > 0) {
          throw new ToolError(
            'validation',
            `Can't close ${item.id}: ${plural(undecided.length, 'human review item is', 'human review items are')} undecided. Submit a packet with submit_packet.`,
            {
              details: {
                allowed,
                reason: `${plural(undecided.length, 'human review item is', 'human review items are')} undecided: ${list(undecided)}`,
              },
            },
          );
        }
        // Decisions 36 and 39 (FR-162, FR-181): undeclared parts get the three questions. Safe
        // ones join the declaration; one that needs the owner holds the close, and the
        // refusal raises the question in a write of its own.
        if (input.changed_files?.length) {
          const held = settleUndeclared(w, deps.services().links, item, input.changed_files);
          if (held.parts.length > 0) throw new HoldRefusal(item, held.parts, held.files);
        }
        if (item.type === 'Epic') {
          const open = openChildren(w.db, item.id);
          if (open.length > 0) {
            throw new ToolError(
              'validation',
              `Can't close epic ${item.id}: ${list(open)} ${open.length === 1 ? 'is' : 'are'} still open. Finish or cancel ${open.length === 1 ? 'it' : 'them'} first.`,
              { details: { allowed, reason: `open children: ${list(open)}`, open_children: open } },
            );
          }
        }
      }
      if (to === 'canceled') {
        if (agent && !input.reason) {
          throw new ToolError('validation', `Say why you are canceling ${item.id}: pass reason.`, {
            details: { fields: { reason: 'is required to cancel' } },
          });
        }
        if (item.type === 'Epic') {
          const open = openChildren(w.db, item.id);
          if (open.length > 0) {
            throw new ToolError(
              'validation',
              `Can't cancel epic ${item.id}: ${list(open)} ${open.length === 1 ? 'is' : 'are'} still open. Finish or cancel ${open.length === 1 ? 'it' : 'them'} first.`,
              { details: { allowed: ALLOWED_MOVES[from], open_children: open } },
            );
          }
        }
      }
      if (from === 'done' && to === 'progress' && agent && !input.reason) {
        throw new ToolError('validation', `Say why you are reopening ${item.id}: pass reason.`, {
          details: { fields: { reason: 'is required to reopen' } },
        });
      }

      // ---- Apply ----
      const who = callerName(w.db, w.actor);
      const project = item.project_key;
      if (lead && endsClaim) {
        const [state, endReason] =
          to === 'done'
            ? (['finished', 'finished'] as const)
            : to === 'canceled'
              ? (['interrupted', 'canceled'] as const)
              : (['interrupted', 'released'] as const);
        w.update('runs', lead.id, { state, end_reason: endReason });
        w.event({
          type: to === 'done' ? 'run.ended' : 'claim.released',
          summary:
            to === 'done'
              ? `Lead run finished: ${item.id} closed`
              : to === 'canceled'
                ? `Lead run interrupted: ${item.id} canceled`
                : `${who} gave up the lead on ${item.id}`,
          item_id: item.id,
          project_key: project,
          data: { run_id: lead.id, end_reason: endReason },
          objects: [{ kind: 'run', id: lead.id }],
        });
      }
      if (to === 'canceled') {
        const packet = w.db.sqlite
          .prepare("SELECT id, round FROM packets WHERE item_id = ? AND state = 'open'")
          .get(item.id) as { id: string; round: number } | undefined;
        if (packet) {
          w.update('packets', packet.id, { state: 'withdrawn' });
          for (const hr of w.db.sqlite
            .prepare("SELECT id FROM hr_items WHERE item_id = ? AND state = 'ready'")
            .all(item.id) as { id: string }[]) {
            w.update('hr_items', hr.id, { state: 'declared' });
          }
          w.event({
            type: 'packet.withdrawn',
            summary: `Packet round ${packet.round} withdrawn: ${item.id} canceled`,
            item_id: item.id,
            project_key: project,
            data: { packet_id: packet.id },
            objects: [{ kind: 'packet', id: packet.id }],
          });
        }
      }
      const set: Record<string, unknown> = { status: to };
      // Decision 58: back in Planning, its known gaps need the owner's approval again.
      if (to === 'planning') Object.assign(set, clearApproval(w.db, item.id));
      if (to === 'done') {
        set.closed_by = w.actor.kind === 'owner' ? 'owner' : 'agent';
        set.closed_at = w.now;
      } else if (from === 'done') {
        set.closed_by = null;
        set.closed_at = null;
      }
      w.update('items', item.id, set);
      w.event({
        type: 'item.status_changed',
        summary: `${who} moved ${item.id} from ${from} to ${to}${input.reason ? `: ${input.reason}` : ''}`,
        item_id: item.id,
        project_key: project,
        data: {
          status: { old: from, new: to },
          ...(input.reason ? { reason: input.reason } : {}),
          // Decision 36: what the close reported, for the radar and the record.
          ...(to === 'done' && input.branch ? { branch: input.branch } : {}),
          ...(to === 'done' && input.changed_files
            ? { changed_files: input.changed_files.length }
            : {}),
        },
      });
      // B41: the close's branch joins the item's reported branches.
      if (to === 'done') addReportedBranch(w, item.id, input.branch);
      // Decision 36: Done and canceled end the item's leases and its overlaps.
      if (to === 'done' || to === 'canceled') onItemClosed(w, item.id, to);
      return summary(w, item.id);
    },

    get(r: ReadContext, input: In<'get_item'>) {
      return readItem(r, input);
    },

    upsertLabel(w, input) {
      assertCallerRun(w.db, w.actor, w.now);
      const project = w.db.sqlite
        .prepare('SELECT key FROM projects WHERE key = ? AND deleted_at IS NULL')
        .get(input.project) as { key: string } | undefined;
      if (!project) {
        throw new ToolError(
          'not_found',
          `No project ${input.project}. Check the key with list_projects.`,
        );
      }
      const row = w.db.sqlite
        .prepare('SELECT id, brief_md FROM labels WHERE project_key = ? AND name = ?')
        .get(input.project, input.name) as { id: string; brief_md: string | null } | undefined;
      const who = callerName(w.db, w.actor);
      const brief = input.brief_md;
      if (row && (brief === undefined || brief === (row.brief_md ?? ''))) {
        // Silence preserves: nothing to change, nothing recorded.
        return { project: input.project, name: input.name, brief_md: row.brief_md || null };
      }
      const id = row?.id ?? newId('lbl', ms(w.now));
      const briefFields =
        brief !== undefined ? { brief_md: brief, brief_by: who, brief_at: w.now } : {};
      const inverse = row
        ? w.update('labels', id, briefFields)
        : w.insert('labels', {
            id,
            project_key: input.project,
            name: input.name,
            brief_md: '',
            ...briefFields,
          });
      w.event({
        type: 'label.upserted',
        summary: row
          ? `${who} updated the brief of #${input.name}`
          : `${who} created label #${input.name}${brief ? ' with a brief' : ''}`,
        project_key: input.project,
        data: { name: input.name, created: !row, brief_changed: brief !== undefined },
        objects: [{ kind: 'label', id }],
        inverse: [inverse],
      });
      return { project: input.project, name: input.name, brief_md: brief || null };
    },

    moveLabelToReady(w, input) {
      const label = w.db.sqlite
        .prepare('SELECT id FROM labels WHERE project_key = ? AND name = ?')
        .get(input.project, input.name) as { id: string } | undefined;
      if (!label) {
        throw new ToolError('not_found', `No label #${input.name} in ${input.project}.`);
      }
      const ids = (
        w.db.sqlite
          .prepare(
            `SELECT i.id FROM items i JOIN item_labels il ON il.item_id = i.id
             WHERE il.label_id = ? AND i.status = 'planning' AND i.archived_at IS NULL
             ORDER BY CAST(substr(i.id, instr(i.id, '-') + 1) AS INTEGER)`,
          )
          .all(label.id) as { id: string }[]
      ).map((r) => r.id);
      if (ids.length === 0) {
        throw new ToolError('validation', `Nothing with #${input.name} is in Planning.`);
      }
      // The Ready gate (decision 36): every item must have declared its shared changes.
      const undeclared = ids.filter((id) => !hasDeclared(w.db, id));
      if (undeclared.length > 0) {
        throw new ToolError(
          'not_declared',
          `Declare the shared parts ${undeclared.join(', ')} will change (or none) before ${undeclared.length === 1 ? 'it moves' : 'they move'} to Ready. Open each item's Shared changes.`,
          { details: { items: undeclared } },
        );
      }
      // Decision 58: a ticket with open known gaps needs its own approval on its page.
      const gapped = ids.filter((id) => !gapsCleared(gapsOf(w.db, id)));
      if (gapped.length > 0) {
        throw new ToolError(
          'validation',
          `${gapped.join(', ')} ${gapped.length === 1 ? 'has' : 'have'} open known gaps. Approve them on ${gapped.length === 1 ? 'its' : 'each'} item page, or shape them first.`,
          { details: { items: gapped } },
        );
      }
      for (const id of ids) {
        const inverse = w.update('items', id, { status: 'ready' });
        w.event({
          type: 'item.status_changed',
          summary: `You moved ${id} from planning to ready (#${input.name})`,
          item_id: id,
          project_key: input.project,
          data: { status: { old: 'planning', new: 'ready' }, label: input.name },
          inverse: [inverse],
        });
      }
      return ids;
    },
  };

  /** The owner's edit was based on an old version: `conflict` with the latest text and who changed it. */
  function staleEdit(
    w: WriteContext,
    current: ItemRow,
    input: { expected_version: number; [k: string]: unknown },
  ): never {
    const last = w.db.sqlite
      .prepare(
        `SELECT actor_kind, client, label, at, data FROM events
         WHERE item_id = ? AND type IN ('item.updated', 'item.status_changed')
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(current.id) as
      | {
          actor_kind: string;
          client: string | null;
          label: string | null;
          at: string;
          data: string | null;
        }
      | undefined;
    const by = last
      ? last.actor_kind === 'owner'
        ? 'you'
        : actorName({ kind: last.actor_kind as 'agent', client: last.client, label: last.label })
      : null;
    const fields = last?.data
      ? Object.keys((JSON.parse(last.data) as { changed?: object }).changed ?? {})
      : [];
    const names = fields
      .filter((f): f is keyof typeof TEXT_NAMES => f in TEXT_NAMES)
      .map((f) => TEXT_NAMES[f]);
    const what = by
      ? ` (${by} ${names.length > 0 ? `edited the ${joinWords(names)}` : 'changed it'})`
      : '';
    throw new ToolError(
      'conflict',
      `${current.id} changed since you opened it${what}. Their version is shown; reapply yours if it still makes sense.`,
      {
        current: {
          ...itemText(w, current.id),
          changed_by: by,
          changed_at: last?.at ?? current.updated_at,
          expected_version: input.expected_version,
        },
      },
    );
  }

  function itemText(w: { db: WriteContext['db']; now: string }, id: string): ItemText {
    const row = requireItem(w.db, id);
    return {
      ...summary(w, id),
      description_md: row.description_md,
      outcome_md: row.outcome_md,
      acceptance: acceptanceOf(w.db, id),
    };
  }

  // ---- get_item (MCP_SPEC §5.2, §3.2) ----

  function readItem(
    r: ReadContext,
    input: In<'get_item'>,
  ): { item: ItemView; delivery: DeliveryReceipt | null } {
    const { db, now } = r;
    const sql = db.sqlite;
    const row = requireItem(db, input.id);
    const index = new BlockIndex(db);
    const base = summarize({ db, windows: windows(), now, index }, [row])[0]!;
    const view = input.view ?? 'standard';
    const wanted = (key: string) =>
      !input.fields || input.fields.includes(key as never) || key === 'id' || key === 'version';

    const openQuestion = sql
      .prepare(
        `SELECT id, text, created_at, answer, answered_at, answer_choice FROM questions
         WHERE item_id = ? AND withdrawn_at IS NULL AND (answered_at IS NULL OR read_by_agent_at IS NULL)
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(row.id) as
      | {
          id: string;
          text: string;
          created_at: string;
          answer: string | null;
          answered_at: string | null;
          answer_choice: string | null;
        }
      | undefined;
    const notes = sql
      .prepare(
        'SELECT id, text, created_at FROM owner_notes WHERE item_id = ? AND read_by_agent_at IS NULL ORDER BY created_at, id',
      )
      .all(row.id) as { id: string; text: string; created_at: string }[];

    // Step details only in the full view (decision 33): standard shows a marker, so its budget holds.
    const work = workStepsOf(db, row.id, { details: (input.view ?? 'standard') === 'full' });
    const checks = checksOf(db, row.id);

    if (view === 'summary') {
      const out: ItemView = {
        ...base,
        counts: {
          work_done: work.steps.filter((s) => s.state === 'done').length,
          work_total: work.steps.length,
          checks_pass: checks.filter((c) => c.state === 'pass').length,
          checks_total: checks.length,
        },
        has_open_question: openQuestion !== undefined,
        unread_owner_notes_count: notes.length,
      };
      return { item: pick(out, wanted), delivery: null };
    }

    const full = view === 'full';
    const linkRows = sql
      .prepare(
        `SELECT l.id, l.from_id, l.to_id, l.type, l.satisfied_when, i.id AS other, i.title, i.status, i.project_key
         FROM links l JOIN items i ON i.id = CASE WHEN l.from_id = ? THEN l.to_id ELSE l.from_id END
         WHERE l.from_id = ? OR l.to_id = ? ORDER BY i.project_key, CAST(substr(i.id, instr(i.id, '-') + 1) AS INTEGER)`,
      )
      .all(row.id, row.id, row.id) as {
      id: string;
      from_id: string;
      to_id: string;
      type: 'blocks' | 'relates';
      satisfied_when: 'done' | 'merged' | 'verified' | null;
      other: string;
      title: string;
      status: Status;
      project_key: string;
    }[];
    const ref = (l: (typeof linkRows)[number]) => ({
      link_id: l.id,
      id: l.other,
      title: l.title,
      status: l.status,
      project: l.project_key,
    });
    const blockRef = (l: (typeof linkRows)[number]) => {
      const waiting = index.waitingFor(l);
      return {
        ...ref(l),
        satisfied_when: index.rule(l),
        cleared: waiting === null,
        waiting_for: waiting,
      };
    };

    const hr = (
      sql.prepare('SELECT * FROM hr_items WHERE item_id = ? ORDER BY position, id').all(row.id) as {
        id: string;
        text: string;
        state: 'declared' | 'ready' | 'approved' | 'deferred';
        added_by: string;
        last_decision: string | null;
        follow_up_item_id: string | null;
        version: number;
      }[]
    ).map((h) => {
      const last = h.last_decision
        ? (JSON.parse(h.last_decision) as Record<string, unknown>)
        : null;
      return {
        id: h.id,
        text: h.text,
        state: h.state,
        added_by: addedBy(h.added_by),
        added_by_client: h.added_by === 'owner' ? null : h.added_by.split(' · ')[0]!,
        locked: h.state === 'ready',
        version: h.version,
        last_decision: last
          ? {
              kind: last.kind as 'approve' | 'changes' | 'defer',
              note: (last.note as string | null) ?? null,
              round: Number(last.round ?? 0),
              at: String(last.at ?? ''),
              result_ref: (last.result_ref as string | null) ?? null,
            }
          : null,
        follow_up_item_id: h.follow_up_item_id,
      };
    });
    let reviewedWithEpic: string | null = null;
    if (hr.length === 0 && row.epic_id) {
      const n = sql
        .prepare('SELECT count(*) AS n FROM hr_items WHERE item_id = ?')
        .get(row.epic_id) as { n: number };
      if (n.n > 0) reviewedWithEpic = row.epic_id;
    }

    const runRows = sql
      .prepare(
        `SELECT * FROM runs WHERE item_id = ?
         ORDER BY CASE WHEN state IN ('open', 'needs_input', 'parked') THEN 0 ELSE 1 END,
                  CASE WHEN state IN ('open', 'needs_input', 'parked') THEN created_at END,
                  updated_at DESC, id`,
      )
      .all(row.id) as RunRow[];
    const openRuns = runRows.filter((x) => ['open', 'needs_input', 'parked'].includes(x.state));
    const ended = runRows
      .filter((x) => !['open', 'needs_input', 'parked'].includes(x.state))
      .slice(0, 5);

    const labels = base.labels;
    // Active records in scope (decisions.ts, the one scope rule), owner first.
    const decisions = inScopeOf(db, { ...row, labels }).map((d) => ({
      id: d.id,
      title: d.title,
      authority: d.authority,
    }));

    const documents = (
      sql
        .prepare(
          `SELECT d.id AS document_id, d.name, d.kind, v.id AS version_id, v.version_no, v.mime, v.size, v.sha256, v.created_at, v.created_by
           FROM documents d JOIN document_versions v ON v.document_id = d.id
           WHERE d.item_id = ? AND v.version_no = (SELECT max(version_no) FROM document_versions WHERE document_id = d.id)
           ORDER BY d.name`,
        )
        .all(row.id) as {
        document_id: string;
        name: string;
        kind: 'planning' | 'packet_attachment' | 'import_report' | 'brief' | 'other';
        version_id: string;
        version_no: number;
        mime: string;
        size: number;
        sha256: string;
        created_at: string;
        created_by: string;
      }[]
    ).map((d) => ({
      document_id: d.document_id,
      name: d.name,
      kind: d.kind,
      latest: {
        document_version_id: d.version_id,
        version_no: d.version_no,
        mime: d.mime,
        size: d.size,
        sha256: d.sha256,
        created_at: d.created_at,
        created_by: d.created_by,
      },
    }));

    // Commits on the item, and on its children for an epic-level packet (§5.6).
    const commitsFor = sql
      .prepare(
        `SELECT sha, branch, reported_at FROM commits
         WHERE item_id = ? OR item_id IN (SELECT id FROM items WHERE epic_id = ?)
         ORDER BY reported_at DESC, id DESC`,
      )
      .all(row.id, row.type === 'Epic' ? row.id : '') as {
      sha: string;
      branch: string | null;
      reported_at: string;
    }[];
    const sameSha = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);
    const packets = (
      sql
        .prepare(
          'SELECT id, round, state, built_from_commit, created_at, criteria_changed_at FROM packets WHERE item_id = ? ORDER BY round',
        )
        .all(row.id) as {
        id: string;
        round: number;
        state: 'open' | 'decided' | 'withdrawn';
        built_from_commit: string | null;
        created_at: string;
        criteria_changed_at: string | null;
      }[]
    ).map((p) => ({
      packet_id: p.id,
      round: p.round,
      state: p.state,
      stale:
        p.state === 'open' &&
        (p.criteria_changed_at !== null ||
          commitsFor.some(
            (c) =>
              ms(c.reported_at) > ms(p.created_at) &&
              !sameSha(c.sha.toLowerCase(), (p.built_from_commit ?? '').toLowerCase()),
          )),
      built_from_commit: p.built_from_commit ?? '',
      created_at: p.created_at,
    }));
    const commits = (
      sql
        .prepare(
          'SELECT sha, branch, reported_at FROM commits WHERE item_id = ? ORDER BY reported_at DESC, id DESC LIMIT ?',
        )
        .all(row.id, full ? 20 : 3) as { sha: string; branch: string | null; reported_at: string }[]
    ).map((c) => ({ sha: c.sha, branch: c.branch, at: c.reported_at }));
    const artifacts = sql
      .prepare(
        'SELECT kind, label, url, state FROM artifacts WHERE item_id = ? ORDER BY created_at, id',
      )
      .all(row.id) as { kind: string; label: string; url: string | null; state: string | null }[];
    const events = (
      sql
        .prepare(
          `SELECT ${EVENT_COLUMNS} FROM ${EVENT_FROM} WHERE e.item_id = ? ORDER BY e.seq DESC LIMIT ?`,
        )
        .all(row.id, full ? 20 : 5) as StoredEvent[]
    ).map(eventRow);

    const splitInto = (
      sql
        .prepare(
          "SELECT id FROM items WHERE split_from = ? ORDER BY CAST(substr(id, instr(id, '-') + 1) AS INTEGER)",
        )
        .all(row.id) as { id: string }[]
    ).map((x) => x.id);
    const recovery = new RecoveryReader(db, windows(), now);
    const item: ItemView = {
      ...base,
      description_md: row.description_md,
      outcome_md: row.outcome_md,
      acceptance: acceptanceOf(db, row.id),
      links: {
        blocks: linkRows.filter((l) => l.type === 'blocks' && l.from_id === row.id).map(blockRef),
        blocked_by: linkRows.filter((l) => l.type === 'blocks' && l.to_id === row.id).map(blockRef),
        relates: linkRows.filter((l) => l.type === 'relates').map(ref),
      },
      checklist: {
        plan_version: work.version,
        work: work.steps,
        checks,
        human_review: hr,
        reviewed_with_epic: reviewedWithEpic,
      },
      runs: [...openRuns, ...ended].map((x) => recovery.runView(x, { external: full })),
      decisions,
      open_question: openQuestion
        ? {
            id: openQuestion.id,
            text: openQuestion.text,
            asked_at: openQuestion.created_at,
            answer: openQuestion.answer,
            answered_at: openQuestion.answered_at,
            ...choiceField(openQuestion.answer_choice),
          }
        : null,
      ...(row.split_from ? { split_from: row.split_from } : {}),
      ...(splitInto.length > 0 ? { split_into: splitInto } : {}),
      resume: wanted('resume') ? deps.services().recovery.itemResume(r, { item_id: row.id }) : null,
      ...holdField(db, row.id, openRuns.length),
      // Decision 58: what implementation will settle, and the owner's approval.
      ...knownGapsField(row.known_gaps),
      unread_owner_notes: notes.map((n) => ({ id: n.id, text: n.text, at: n.created_at })),
      documents,
      packets,
      commits,
      artifacts,
      dates_set_by: row.dates_set_by,
      closed_by: row.closed_by,
      recent_events: events,
    };
    const picked = pick(item, wanted);

    // Owner notes and an answer are returned once, then marked read (§5.7): only what was shown.
    const deliveredNotes = wanted('unread_owner_notes') ? notes.map((n) => n.id) : [];
    const deliveredAnswer =
      wanted('open_question') && openQuestion && openQuestion.answered_at !== null
        ? openQuestion.id
        : null;
    const delivery: DeliveryReceipt | null =
      deliveredNotes.length > 0 || deliveredAnswer
        ? {
            item_id: row.id,
            owner_note_ids: deliveredNotes,
            question_id: deliveredAnswer,
            delivered_to: actorName({ ...r.actor, label: input.agent_label ?? r.actor.label }),
          }
        : null;
    return { item: picked, delivery };
  }
}

/** Only the wanted top-level fields (`id` and `version` always). */
function pick(item: ItemView, wanted: (key: string) => boolean): ItemView {
  return Object.fromEntries(Object.entries(item).filter(([k]) => wanted(k))) as ItemView;
}
