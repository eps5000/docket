/**
 * Archive and cancel (BUILD_SPEC §5.1, §5.8; owner decision 23; FR-064,
 * FR-064b): the `archive` service (US7, T125).
 *
 * Archive (owner only): `archived_at` on a done item hides it from the
 * owner's default views (board, list, Timeline, Epics row, epic ticket
 * list); agent queries include it by default, and so do search and the
 * label page. Archiving an item that isn't done is refused. Archive,
 * unarchive and *Archive all* are undoable.
 *
 * Owner cancel: any open item, the reason optional. An epic with open
 * children is refused, naming them. An active lead run ends `interrupted`
 * with `end_reason: canceled` and its claim is released (`endLeadForOwner`,
 * B13). An open packet is withdrawn and its items go back to `declared`.
 * Undo restores the status (and the packet), never the run. Agents cancel
 * through `set_status` (items.ts), where a reason is required.
 */
import { ToolError, type ItemSummary } from '@docket/shared';
import type { ArchiveService, ServiceDeps } from './contracts.js';
import { requireItem, summaryOf, windowsOf, type ItemRow } from './model.js';
import { endLeadForOwner } from './runs.js';
import { assertReleaseStays, releaseOf } from './release.js';
import { onItemClosed } from './shared-changes.js';
import type { InverseOp, WriteContext } from './write.js';

const OPEN = ['inbox', 'planning', 'ready', 'progress', 'review'];
const list = (ids: string[]) => ids.join(', ');

export function createArchiveService(deps: ServiceDeps): ArchiveService {
  const summary = (w: WriteContext, id: string): ItemSummary =>
    summaryOf({ db: w.db, windows: windowsOf(deps.config), now: w.now }, id);

  function notDone(item: ItemRow): never {
    throw new ToolError(
      'validation',
      `${item.id} is ${item.status}; only done items can be archived.`,
      { details: { status: item.status, allowed: ['done'] } },
    );
  }

  function archiveOne(w: WriteContext, item: ItemRow): void {
    const inverse = w.update('items', item.id, { archived_at: w.now });
    w.event({
      type: 'item.archived',
      summary: `You archived ${item.id}`,
      item_id: item.id,
      project_key: item.project_key,
      data: { archived_at: { old: null, new: w.now } },
      inverse: [inverse],
    });
  }

  function openChildren(w: WriteContext, epic: string): string[] {
    return (
      w.db.sqlite
        .prepare(
          `SELECT id FROM items WHERE epic_id = ? AND status NOT IN ('done', 'canceled')
           ORDER BY project_key, CAST(substr(id, instr(id, '-') + 1) AS INTEGER)`,
        )
        .all(epic) as { id: string }[]
    ).map((r) => r.id);
  }

  return {
    archive(w, input) {
      const item = requireItem(w.db, input.id);
      if (item.status !== 'done') notDone(item);
      if (item.archived_at) {
        throw new ToolError('validation', `${item.id} is already archived.`);
      }
      // Decision 67: a Release stays while its epic is open.
      assertReleaseStays(w.db, item, 'archive');
      archiveOne(w, item);
      return summary(w, item.id);
    },

    unarchive(w, input) {
      const item = requireItem(w.db, input.id);
      if (!item.archived_at) {
        throw new ToolError('validation', `${item.id} is not archived.`);
      }
      const inverse = w.update('items', item.id, { archived_at: null });
      w.event({
        type: 'item.unarchived',
        summary: `You unarchived ${item.id}`,
        item_id: item.id,
        project_key: item.project_key,
        data: { archived_at: { old: item.archived_at, new: null } },
        inverse: [inverse],
      });
      return summary(w, item.id);
    },

    archiveMany(w, input) {
      const items = [...new Set(input.ids)].map((id) => requireItem(w.db, id));
      const open = items.filter((i) => i.status !== 'done').map((i) => i.id);
      if (open.length > 0) {
        throw new ToolError(
          'validation',
          `Only done items can be archived: ${list(open)} ${open.length === 1 ? 'is' : 'are'} not done.`,
          { details: { not_done: open } },
        );
      }
      for (const i of items) assertReleaseStays(w.db, i, 'archive');
      const todo = items.filter((i) => !i.archived_at);
      if (todo.length === 0) {
        throw new ToolError('validation', 'Those items are already archived.');
      }
      for (const item of todo) archiveOne(w, item);
      return todo.map((i) => i.id);
    },

    cancel(w, input) {
      const item = w.checkVersion('items', input.id, input.expected_version) as unknown as ItemRow;
      requireItem(w.db, item.id);
      if (!OPEN.includes(item.status)) {
        throw new ToolError(
          'validation',
          `${item.id} is ${item.status}; only open items can be canceled.`,
          { details: { status: item.status, allowed: OPEN } },
        );
      }
      // Decision 67: a Release goes only with its epic, and goes with it.
      assertReleaseStays(w.db, item, 'cancel');
      const release = item.type === 'Epic' ? releaseOf(w.db, item.id) : null;
      if (item.type === 'Epic') {
        const open = openChildren(w, item.id).filter((id) => id !== release?.id);
        if (open.length > 0) {
          throw new ToolError(
            'validation',
            `Can't cancel epic ${item.id}: ${list(open)} ${open.length === 1 ? 'is' : 'are'} still open. Finish or cancel ${open.length === 1 ? 'it' : 'them'} first.`,
            { details: { open_children: open } },
          );
        }
      }
      // Decision 64: shipping without a bug is deliberate, so canceling one in an epic needs a reason.
      if (item.type === 'Bug' && item.epic_id && !input.reason?.trim()) {
        throw new ToolError(
          'validation',
          `Say why you're canceling bug ${item.id}: while it's open it holds epic ${item.epic_id}'s release.`,
          { details: { fields: { reason: 'is required to cancel a bug in an epic' } } },
        );
      }

      // The lead's run ends; undo never brings it back (§5.1).
      endLeadForOwner(w, item, 'canceled');

      // An open packet is withdrawn; undo restores it with the status.
      const packet = w.db.sqlite
        .prepare("SELECT id, round FROM packets WHERE item_id = ? AND state = 'open'")
        .get(item.id) as { id: string; round: number } | undefined;
      if (packet) {
        const inverse: InverseOp[] = [w.update('packets', packet.id, { state: 'withdrawn' })];
        for (const hr of w.db.sqlite
          .prepare("SELECT id FROM hr_items WHERE item_id = ? AND state = 'ready'")
          .all(item.id) as { id: string }[]) {
          inverse.push(w.update('hr_items', hr.id, { state: 'declared' }));
        }
        w.event({
          type: 'packet.withdrawn',
          summary: `Packet round ${packet.round} withdrawn: ${item.id} canceled`,
          item_id: item.id,
          project_key: item.project_key,
          data: { packet_id: packet.id },
          objects: [{ kind: 'packet', id: packet.id }],
          inverse,
        });
      }

      const inverse = [w.update('items', item.id, { status: 'canceled' })];
      // Decision 67: the epic's open Release is canceled with it, in the same undo.
      if (release && release.status !== 'done' && release.status !== 'canceled') {
        const releaseRow = requireItem(w.db, release.id);
        endLeadForOwner(w, releaseRow, 'canceled');
        inverse.push(w.update('items', release.id, { status: 'canceled' }));
        onItemClosed(w, release.id, 'canceled');
      }
      w.event({
        type: 'item.status_changed',
        summary: `You canceled ${item.id} (was ${item.status})${release && release.status !== 'done' && release.status !== 'canceled' ? `, with its Release ${release.id}` : ''}${input.reason ? `: ${input.reason}` : ''}`,
        item_id: item.id,
        project_key: item.project_key,
        data: {
          status: { old: item.status, new: 'canceled' },
          ...(input.reason ? { reason: input.reason } : {}),
        },
        inverse,
      });
      // Decision 36: canceling ends the item's leases and its overlaps (not part of the undo).
      onItemClosed(w, item.id, 'canceled');
      return summary(w, item.id);
    },
  };
}
