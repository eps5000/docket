/**
 * Items: create, edit, status transitions, labels and the owner's field and text edits (BUILD_SPEC §5.1; decision 22): the `items` service.
 *
 * US1 (T070) implements create, update (patch semantics, labels, dates with
 * `dates_set_by`), `set_status` with its guards, and `get_item`. Still
 * stubs: the owner's edits and the label page (US7, T112), and
 * `upsert_label` (its slice). Item.resume is US11's (T099): null until then.
 */
import { ToolError, type ItemSummary, type ItemView, type Status } from '@tasklite/shared';
import {
  notImplemented,
  type DeliveryReceipt,
  type In,
  type ItemsService,
  type ReadContext,
  type ServiceDeps,
} from './contracts.js';
import { allocateItemId, newId } from './ids.js';
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
  runView,
  summarize,
  summaryOf,
  windowsOf,
  workStepsOf,
  type ItemRow,
  type RunRow,
  type StoredEvent,
} from './model.js';
import type { WriteContext } from './write.js';

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

  return {
    create(w, input) {
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

    ownerPatch: notImplemented('items.ownerPatch'),

    setStatus(w, input) {
      const item = w.checkVersion('items', input.id, input.expected_version) as unknown as ItemRow;
      requireItem(w.db, input.id);
      assertCallerRun(w.db, w.actor, w.now);
      const from = item.status;
      const to = input.status;
      const agent = w.actor.kind === 'agent';
      if (!ALLOWED_MOVES[from].includes(to)) refuse(item.id, from, to);

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

      if (from === 'ready' && to === 'progress') {
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
        data: { status: { old: from, new: to }, ...(input.reason ? { reason: input.reason } : {}) },
      });
      return summary(w, item.id);
    },

    get(r: ReadContext, input: In<'get_item'>) {
      return readItem(r, input);
    },

    upsertLabel: notImplemented('items.upsertLabel'),
    moveLabelToReady: notImplemented('items.moveLabelToReady'),
  };

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
        `SELECT id, text, created_at, answer, answered_at FROM questions
         WHERE item_id = ? AND (answered_at IS NULL OR read_by_agent_at IS NULL)
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(row.id) as
      | {
          id: string;
          text: string;
          created_at: string;
          answer: string | null;
          answered_at: string | null;
        }
      | undefined;
    const notes = sql
      .prepare(
        'SELECT id, text, created_at FROM owner_notes WHERE item_id = ? AND read_by_agent_at IS NULL ORDER BY created_at, id',
      )
      .all(row.id) as { id: string; text: string; created_at: string }[];

    const work = workStepsOf(db, row.id);
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
    const decisions = sql
      .prepare(
        `SELECT id, title, authority FROM decision_records
         WHERE project_key = ? AND status = 'active' AND (
           scope_kind = 'project'
           OR (scope_kind = 'epic' AND scope_id IN (?, ?))
           OR (scope_kind = 'item' AND scope_id = ?)
           OR (scope_kind = 'label' AND scope_id IN (SELECT value FROM json_each(?)))
         )
         ORDER BY CASE authority WHEN 'owner' THEN 0 ELSE 1 END, created_at, id`,
      )
      .all(row.project_key, row.epic_id ?? '', row.id, row.id, JSON.stringify(labels)) as {
      id: string;
      title: string;
      authority: 'owner' | 'agent';
    }[];

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
          'SELECT id, round, state, built_from_commit, created_at FROM packets WHERE item_id = ? ORDER BY round',
        )
        .all(row.id) as {
        id: string;
        round: number;
        state: 'open' | 'decided' | 'withdrawn';
        built_from_commit: string | null;
        created_at: string;
      }[]
    ).map((p) => ({
      packet_id: p.id,
      round: p.round,
      state: p.state,
      stale:
        p.state === 'open' &&
        commitsFor.some(
          (c) =>
            ms(c.reported_at) > ms(p.created_at) &&
            !sameSha(c.sha.toLowerCase(), (p.built_from_commit ?? '').toLowerCase()),
        ),
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
      runs: [...openRuns, ...ended].map((x) => runView(db, x, windows(), now, { external: full })),
      decisions,
      open_question: openQuestion
        ? {
            id: openQuestion.id,
            text: openQuestion.text,
            asked_at: openQuestion.created_at,
            answer: openQuestion.answer,
            answered_at: openQuestion.answered_at,
          }
        : null,
      resume: null,
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
