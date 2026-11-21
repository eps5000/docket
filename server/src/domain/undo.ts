/**
 * Owner undo (BUILD_SPEC §5.11; decision T6; FR-062).
 *
 * `POST /api/mutations/:id/undo` is accepted within 60 s of an owner
 * mutation if no later event touched the same objects. It applies the
 * stored inverse in one write and records, for each original event, an
 * event of the same type with summary "Undid: <original summary>" and
 * `data.undo_of = <mutation_id>` (no separate `undo` event type; settled
 * with the coordinator for B2). The undo has its own mutation ID and is not
 * itself undoable. A second undo of the same mutation returns `conflict`.
 * Undoing an answer the agent has already read also returns `conflict`
 * (B18): the agent may have acted on it, so the owner leaves a note instead.
 */
import { ToolError, type EventType } from '@docket/shared';
import type { ServiceDeps, UndoService } from './contracts.js';
import {
  OWNER_ACTOR,
  type Actor,
  type InverseOp,
  type ObjectRef,
  type WriteContext,
  type WritePath,
  type WriteResult,
} from './write.js';

export const UNDO_WINDOW_MS = 60_000;

interface StoredEvent {
  seq: number;
  at: string;
  actor_kind: string;
  project_key: string | null;
  item_id: string | null;
  type: EventType;
  summary: string;
  data: string | null;
  inverse: string | null;
}

function objectsOf(event: { data: string | null; item_id: string | null }): ObjectRef[] {
  const data = event.data ? (JSON.parse(event.data) as { objects?: ObjectRef[] }) : {};
  const objects = [...(data.objects ?? [])];
  if (event.item_id && !objects.some((o) => o.kind === 'item' && o.id === event.item_id)) {
    objects.push({ kind: 'item', id: event.item_id });
  }
  return objects;
}

const key = (o: ObjectRef) => `${o.kind}:${o.id}`;

export function undoMutation(
  write: WritePath,
  mutationId: string,
  actor: Actor = OWNER_ACTOR,
): WriteResult<{ undone: string }> {
  return write.run({ actor, operation: 'undo', args: { mutation_id: mutationId } }, (ctx) =>
    applyUndo(ctx, mutationId),
  );
}

/** The `undo` service (contracts.ts): the undo itself, inside the caller's write. */
export function createUndoService(_deps: ServiceDeps): UndoService {
  return { undo: (w, input) => applyUndo(w, input.mutation_id) };
}

/** Undo `mutationId` inside an open write (see the header for the rules). */
export function applyUndo(ctx: WriteContext, mutationId: string): { undone: string } {
  const sqlite = ctx.db.sqlite;
  const events = sqlite
    .prepare(
      `SELECT seq, at, actor_kind, project_key, item_id, type, summary, data, inverse
       FROM events WHERE mutation_id = ? ORDER BY seq`,
    )
    .all(mutationId) as StoredEvent[];
  if (events.length === 0) {
    throw new ToolError('not_found', `No change ${mutationId} to undo.`);
  }
  // Decision 39: an automatic outcome written inside the owner's own change is recorded as
  // Docket, and goes back with it. A mutation made only by Docket or an agent stays out.
  const docket = (e: StoredEvent) =>
    e.actor_kind === 'system' &&
    !!e.data &&
    (JSON.parse(e.data) as { decided_by?: unknown }).decided_by === 'docket';
  if (
    events.some((e) => e.actor_kind !== 'owner' && !docket(e)) ||
    !events.some((e) => e.actor_kind === 'owner')
  ) {
    throw new ToolError(
      'forbidden',
      "Agent changes can't be undone from the UI. Leave the agent a note instead.",
    );
  }
  if (events.some((e) => e.data && 'undo_of' in (JSON.parse(e.data) as object))) {
    throw new ToolError('validation', "An undo can't be undone. Make the change again instead.");
  }
  if (events.some((e) => e.inverse === null)) {
    throw new ToolError('validation', "This change can't be undone.");
  }
  const alreadyUndone = sqlite
    .prepare(`SELECT 1 FROM events WHERE json_extract(data, '$.undo_of') = ? LIMIT 1`)
    .get(mutationId);
  if (alreadyUndone) {
    throw new ToolError('conflict', 'This change was already undone.');
  }
  const madeAt = Date.parse(events[0]!.at);
  if (Date.parse(ctx.now) - madeAt > UNDO_WINDOW_MS) {
    throw new ToolError(
      'conflict',
      'Undo is only possible within 60 seconds of the change. Make the change again instead.',
    );
  }

  // An answer the agent has already read can't be taken back: the receipt
  // (`read_by_agent_at`) isn't an event, so the clash check below misses it.
  for (const e of events) {
    if (e.type !== 'question.answered' || !e.data) continue;
    const qid = (JSON.parse(e.data) as { question_id?: string }).question_id;
    const read = qid
      ? (sqlite.prepare('SELECT read_by_agent_at FROM questions WHERE id = ?').get(qid) as
          { read_by_agent_at: string | null } | undefined)
      : undefined;
    if (read?.read_by_agent_at) {
      throw new ToolError('conflict', 'The agent already read this answer; leave a note instead.', {
        details: { question_id: qid },
      });
    }
  }

  // Did anything later touch the same objects?
  const touched = new Set(events.flatMap(objectsOf).map(key));
  const lastSeq = events[events.length - 1]!.seq;
  const later = sqlite
    .prepare('SELECT seq, item_id, data, summary FROM events WHERE seq > ? ORDER BY seq')
    .all(lastSeq) as {
    seq: number;
    item_id: string | null;
    data: string | null;
    summary: string;
  }[];
  const clash = later.find((e) => objectsOf(e).some((o) => touched.has(key(o))));
  if (clash) {
    throw new ToolError(
      'conflict',
      `Can't undo: it has changed since ("${clash.summary}"). Make the change again instead.`,
      { details: { later_event: clash.seq } },
    );
  }

  // Apply the inverses, newest first.
  for (const event of [...events].reverse()) {
    const ops = JSON.parse(event.inverse!) as InverseOp[];
    for (const op of [...ops].reverse()) {
      if (op.op === 'update') ctx.update(op.table, op.id, op.set);
      else if (op.op === 'delete') ctx.remove(op.table, op.id);
      else ctx.restore(op.table, op.row);
    }
  }
  for (const event of events) {
    ctx.event({
      type: event.type,
      summary: `Undid: ${event.summary}`,
      item_id: event.item_id,
      project_key: event.project_key,
      data: { undo_of: mutationId },
      objects: objectsOf(event),
      inverse: null,
    });
  }
  return { undone: mutationId };
}
