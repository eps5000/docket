import { useState } from 'react';
import { Link } from 'react-router';
import { STATUS_LABELS, type Status, type WorkItem } from '@tasklite/shared';
import { Button, TicketCard } from '../../components/kit';
import { paths } from '../../lib/paths';

export const BOARD_COLUMNS: readonly { status: Status; note?: string }[] = [
  { status: 'inbox' },
  { status: 'planning', note: 'Yours' },
  { status: 'ready' },
  { status: 'progress' },
  { status: 'review', note: 'Your human review' },
  { status: 'done' },
];

/**
 * Board (UI_SPEC §6.2.1): six columns; Ready splits into Startable and
 * Waiting on blockers; Done keeps *Archive* / *Archive all*. US2 (T082) fills
 * the cards' actions (archive with Undo is US7).
 */
export function BoardLayout({ items }: { items: readonly WorkItem[] }) {
  const [showWaiting, setShowWaiting] = useState(false);
  return (
    <div className="board" data-layout="board">
      {BOARD_COLUMNS.map(({ status, note }) => {
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
                go.map((i) => <TicketCard key={i.id} item={i} />)
              )}
              {wait.length > 0 && (
                <>
                  <div className="subh">
                    <span>Waiting on blockers · {wait.length}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-expanded={showWaiting}
                      onClick={() => setShowWaiting(!showWaiting)}
                    >
                      {showWaiting ? 'Hide' : 'Show'}
                    </Button>
                  </div>
                  {showWaiting ? (
                    wait.map((i) => <TicketCard key={i.id} item={i} />)
                  ) : (
                    <div className="mini">
                      {wait.map((i) => (
                        <Link
                          key={i.id}
                          to={paths.item(i.id)}
                          className="chip c-bad mono"
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
            {status === 'done' && cards.some((c) => !c.archived) && (
              <div className="row colnote" style={{ justifyContent: 'flex-end' }}>
                <Button variant="ghost" size="sm" disabled title="Archive all lands with US7">
                  Archive all
                </Button>
              </div>
            )}
            {cards.map((i) => (
              <TicketCard key={i.id} item={i} />
            ))}
          </section>
        );
      })}
    </div>
  );
}
