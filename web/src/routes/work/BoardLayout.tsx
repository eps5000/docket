import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { STATUS_LABELS, type Status, type WorkItem } from '@docket/shared';
import { Button, Icon, TicketCard } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { queryKeys } from '../../lib/api';
import { plural } from '../../lib/format';
import { paths } from '../../lib/paths';
import { useRenderLimit } from '../../lib/progressive';
import { runOwnerMutation, showToast } from '../../lib/undo';

export const BOARD_COLUMNS: readonly { status: Status; note?: string }[] = [
  { status: 'inbox' },
  { status: 'planning', note: 'Yours' },
  { status: 'ready' },
  { status: 'progress' },
  { status: 'review', note: 'Your human review' },
  { status: 'done' },
];

/** Shown as a seventh column only under *Shows canceled* (B43). */
const CANCELED_COLUMN: { status: Status; note?: string } = { status: 'canceled' };

/**
 * Board (UI_SPEC §6.2.1): six columns; Ready splits into Startable and
 * Waiting on blockers; Done keeps every done item until it's archived: each
 * card has *Archive* (or *Unarchive* under the Archived filter), the column
 * header has *Archive all* for the visible done items, and each toasts with
 * Undo (US7, T127). B43: done items show only under *Shows done*; until then
 * the Done column says how many are hidden, with *Show N done*.
 */
export function BoardLayout({
  items,
  hiddenDone = 0,
  onShowDone,
  showCanceled = false,
}: {
  items: readonly WorkItem[];
  /** Done items the filter hides (0 when *Shows done* is ticked). */
  hiddenDone?: number;
  onShowDone?: () => void;
  showCanceled?: boolean;
}) {
  const [showWaiting, setShowWaiting] = useState(false);
  const archiving = useArchive();
  // At scale (thousands of items), each column renders its first cards at once and the rest
  // right after (lib/progressive.ts). Counts and Archive all always use the whole column.
  const limit = useRenderLimit(items.length);
  return (
    <div className={showCanceled ? 'board c7' : 'board'} data-layout="board">
      {(showCanceled ? [...BOARD_COLUMNS, CANCELED_COLUMN] : BOARD_COLUMNS).map(
        ({ status, note }) => {
          const cards = items.filter((i) => i.status === status);
          const head = (
            <div className="colh">
              <h2 className="colname">{STATUS_LABELS[status]}</h2>
              <span>{cards.length}</span>
            </div>
          );
          if (status === 'ready') {
            const go = cards.filter((i) => !i.blocked);
            const wait = cards.filter((i) => i.blocked);
            return (
              <section className="col" key={status} aria-label={STATUS_LABELS[status]}>
                {head}
                <div className="src colnote">Startable · {go.length}</div>
                {go.length === 0 ? (
                  <div className="src colnote">Nothing startable</div>
                ) : (
                  go.slice(0, limit).map((i) => <TicketCard key={i.id} item={i} />)
                )}
                {wait.length > 0 && (
                  <>
                    {/* One button with a full-width hit target (B20), not a label plus a small link. */}
                    <button
                      type="button"
                      className="subh subtog"
                      aria-expanded={showWaiting}
                      onClick={() => setShowWaiting(!showWaiting)}
                    >
                      {/* Wraps as "Waiting on / blockers · 5", never with the count alone. */}
                      <span>
                        Waiting on <span className="nowrap">blockers · {wait.length}</span>
                      </span>
                      <span className="subtog-act">
                        {showWaiting ? 'Hide' : 'Show'}
                        <span className={`chev${showWaiting ? '' : ' shut'}`} aria-hidden="true">
                          <Icon name="chev" small />
                        </span>
                      </span>
                    </button>
                    {showWaiting ? (
                      wait.slice(0, limit).map((i) => <TicketCard key={i.id} item={i} />)
                    ) : (
                      <div className="colmini">
                        {wait.slice(0, limit).map((i) => (
                          <Link
                            key={i.id}
                            to={paths.item(i.id)}
                            className="chip st-blocked mono"
                            title={i.title}
                          >
                            {i.id}
                          </Link>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </section>
            );
          }
          return (
            <section className="col" key={status} aria-label={STATUS_LABELS[status]}>
              {head}
              {note && <div className="src colnote">{note}</div>}
              {status === 'done' && hiddenDone > 0 && onShowDone && (
                <div
                  className="src colnote row"
                  data-hidden-done=""
                  style={{ gap: 6, flexWrap: 'wrap' }}
                >
                  <span>Hidden by the filter.</span>
                  <Button variant="ghost" size="sm" onClick={onShowDone}>
                    Show {hiddenDone} done
                  </Button>
                </div>
              )}
              {status === 'done' && cards.some((c) => !c.archived) && (
                <div className="row colnote" style={{ justifyContent: 'flex-end' }}>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={archiving.busy}
                    onClick={() =>
                      void archiving.all(cards.filter((c) => !c.archived).map((c) => c.id))
                    }
                  >
                    Archive all
                  </Button>
                </div>
              )}
              {cards.slice(0, limit).map((i) => (
                <TicketCard
                  key={i.id}
                  item={i}
                  onArchive={() => void archiving.one(i.id)}
                  onUnarchive={() => void archiving.undo(i.id)}
                />
              ))}
            </section>
          );
        },
      )}
    </div>
  );
}

/** Archive, Archive all and Unarchive, each with the Undo toast (BUILD_SPEC §5.8, §5.11). */
function useArchive() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const run = async <T extends { mutation_id: string }>(fn: () => Promise<T>, success: string) => {
    setBusy(true);
    try {
      const res = await runOwnerMutation(fn, { success });
      if (res) await queryClient.invalidateQueries({ queryKey: queryKeys.all });
    } catch (err) {
      showToast(err instanceof Error && err.message ? err.message : 'That didn’t work. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return {
    busy,
    one: (id: string) =>
      run(
        () => apiClient['items.archive']({ params: { id } }),
        `${id} archived. It’s still in the tracker; find it with search or the Archived filter.`,
      ),
    undo: (id: string) =>
      run(() => apiClient['items.unarchive']({ params: { id } }), `${id} is back in your views.`),
    all: (ids: string[]) =>
      run(
        () => apiClient['archive.many']({ body: { ids } }),
        `Archived ${plural(ids.length, 'done item')}.`,
      ),
  };
}
