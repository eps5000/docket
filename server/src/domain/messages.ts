/**
 * Questions and owner notes (BUILD_SPEC §5.7): the `messages` service.
 *
 * US6 (T120):
 * - `ask_owner` creates an open question (at most one per item) and puts
 *   the asking run in `needs_input`: the run the call names, else the
 *   caller's own open lead on the item. A run that has ended gets
 *   `conflict`. While the item has an answer no agent has read yet,
 *   asking again gets `validation` ("Call get_item first"), so no owner
 *   answer is ever dropped.
 * - The owner answers (`question.answered`, undoable) and leaves notes
 *   (`owner_note.added`, undoable). Answering doesn't touch the run: it
 *   stays `needs_input` until the agent reads the answer.
 *
 * `markDelivered` is filled by US3 (B9, agreed with the coordinator): the
 * owner note a fresh-packet request posts (§5.6) is delivered by
 * `get_item`, which calls it. US6 reuses it as is. It is a receipt, not an
 * event (contracts/events.md): it sets `read_by_agent_at` on the delivered
 * owner notes and on a delivered answered question, and puts the
 * question's `needs_input` run back to `open`. Only `get_item`'s standard
 * and full views deliver (MCP_SPEC §3.2); summary and `get_context` don't.
 */
import { ToolError } from '@docket/shared';
import type { MessagesService, ServiceDeps } from './contracts.js';
import { newId } from './ids.js';
import { activeLead, assertCallerRun, callerName, ms, requireItem } from './model.js';

interface QuestionRow {
  id: string;
  item_id: string;
  run_id: string | null;
  text: string;
  asked_by: string;
  answer: string | null;
  answered_at: string | null;
  read_by_agent_at: string | null;
  created_at: string;
}

const quote = (text: string, max = 80) =>
  `“${text.length > max ? `${text.slice(0, max - 1)}…` : text}”`;

const questionView = (q: QuestionRow) => ({
  id: q.id,
  text: q.text,
  asked_at: q.created_at,
  answer: q.answer,
  answered_at: q.answered_at,
});

export function createMessagesService(_deps: ServiceDeps): MessagesService {
  return {
    askOwner(w, input) {
      const named = assertCallerRun(w.db, w.actor, w.now);
      const item = requireItem(w.db, input.id);
      const open = w.db.sqlite
        .prepare(
          'SELECT * FROM questions WHERE item_id = ? AND answered_at IS NULL ORDER BY created_at DESC LIMIT 1',
        )
        .get(item.id) as QuestionRow | undefined;
      if (open) {
        throw new ToolError(
          'validation',
          `${item.id} already has an open question: ${quote(open.text)}. Wait for the answer in get_item (open_question).`,
          { details: { question_id: open.id } },
        );
      }
      // An answer the agent hasn't read yet would never be delivered once a newer question
      // takes its place in get_item, so it must be read first (gate review of B13).
      const unread = w.db.sqlite
        .prepare(
          'SELECT id FROM questions WHERE item_id = ? AND answered_at IS NOT NULL AND read_by_agent_at IS NULL ORDER BY created_at DESC LIMIT 1',
        )
        .get(item.id) as { id: string } | undefined;
      if (unread) {
        throw new ToolError(
          'validation',
          `${item.id} has an answer you haven't read. Call get_item first.`,
          { details: { question_id: unread.id } },
        );
      }
      // The asking run: the one the call names (on this item), else the caller's own lead here.
      let runId: string | null = null;
      if (named && named.item_id === item.id) runId = named.id;
      else if (!named && w.actor.kind === 'agent') {
        const lead = activeLead(w.db, item.id);
        if (lead && lead.client === w.actor.client) runId = lead.id;
      }
      const id = newId('q', ms(w.now));
      const who = callerName(w.db, w.actor);
      w.insert('questions', {
        id,
        item_id: item.id,
        run_id: runId,
        text: input.question,
        asked_by: who,
        answer: null,
        answered_at: null,
        read_by_agent_at: null,
      });
      if (runId) {
        const run = w.get('runs', runId) as { state: string } | undefined;
        if (run && run.state === 'open') w.update('runs', runId, { state: 'needs_input' });
      }
      w.event({
        type: 'question.asked',
        summary: `${who} asks: ${quote(input.question, 200)}`,
        item_id: item.id,
        project_key: item.project_key,
        data: { question_id: id, run_id: runId },
        objects: [
          { kind: 'question', id },
          ...(runId ? [{ kind: 'run' as const, id: runId }] : []),
        ],
      });
      return { question_id: id };
    },

    answer(w, input) {
      const item = requireItem(w.db, input.id);
      const q = w.get('questions', input.question_id) as QuestionRow | undefined;
      if (!q || q.item_id !== item.id) {
        throw new ToolError(
          'not_found',
          `No question ${input.question_id} on ${item.id}. Reload the item to see its question.`,
        );
      }
      if (q.answered_at !== null) {
        throw new ToolError(
          'conflict',
          `You already answered this question: ${quote(q.answer ?? '')}. Leave a note to add to it.`,
          { current: questionView(q) },
        );
      }
      const inverse = w.update('questions', q.id, { answer: input.text, answered_at: w.now });
      w.event({
        type: 'question.answered',
        summary: `You answered ${q.asked_by}: ${quote(input.text, 200)}`,
        item_id: item.id,
        project_key: item.project_key,
        data: { question_id: q.id, run_id: q.run_id },
        objects: [{ kind: 'question', id: q.id }],
        inverse: [inverse],
      });
      return questionView(w.require('questions', q.id) as unknown as QuestionRow);
    },

    addOwnerNote(w, input) {
      const item = requireItem(w.db, input.id);
      const id = newId('note', ms(w.now));
      const inverse = w.insert('owner_notes', { id, item_id: item.id, text: input.text });
      w.event({
        type: 'owner_note.added',
        summary: `You left a note: ${input.text}`,
        item_id: item.id,
        project_key: item.project_key,
        data: { note_id: id, text: input.text },
        inverse: [inverse],
      });
      return { id, text: input.text, at: w.now };
    },

    markDelivered(r, receipt) {
      const sql = r.db.sqlite;
      sql.transaction(() => {
        const note = sql.prepare(
          'UPDATE owner_notes SET read_by_agent_at = ? WHERE id = ? AND item_id = ? AND read_by_agent_at IS NULL',
        );
        for (const id of receipt.owner_note_ids) note.run(r.now, id, receipt.item_id);
        if (receipt.question_id) {
          const q = sql
            .prepare(
              'SELECT id, run_id FROM questions WHERE id = ? AND item_id = ? AND answered_at IS NOT NULL AND read_by_agent_at IS NULL',
            )
            .get(receipt.question_id, receipt.item_id) as
            { id: string; run_id: string | null } | undefined;
          if (q) {
            sql.prepare('UPDATE questions SET read_by_agent_at = ? WHERE id = ?').run(r.now, q.id);
            if (q.run_id) {
              sql
                .prepare(
                  "UPDATE runs SET state = 'open', updated_at = ? WHERE id = ? AND state = 'needs_input'",
                )
                .run(r.now, q.run_id);
            }
          }
        }
      })();
    },
  };
}
