/**
 * Questions and owner notes (BUILD_SPEC §5.7): the `messages` service.
 *
 * Stub (tasks.md T047): `askOwner`, `answer` and `addOwnerNote` throw
 * `NotImplementedError` until US6 (T107) fills them in, here, in place.
 * The signatures are in contracts.ts.
 *
 * `markDelivered` is filled by US3 (B9, agreed with the coordinator): the
 * owner note a fresh-packet request posts (§5.6) is delivered by
 * `get_item`, which calls it. US6 reuses it as is. It is a receipt, not an
 * event (contracts/events.md): it sets `read_by_agent_at` on the delivered
 * owner notes and on a delivered answered question, and puts the
 * question's `needs_input` run back to `open`. Only `get_item`'s standard
 * and full views deliver (MCP_SPEC §3.2); summary and `get_context` don't.
 */
import { notImplemented, type MessagesService, type ServiceDeps } from './contracts.js';

export function createMessagesService(_deps: ServiceDeps): MessagesService {
  return {
    askOwner: notImplemented('messages.askOwner'),
    answer: notImplemented('messages.answer'),
    addOwnerNote: notImplemented('messages.addOwnerNote'),

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
