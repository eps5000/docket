import { Link } from 'react-router';
import { STATUS_LABELS, type DeferredRow } from '@tasklite/shared';
import { Card, CardHeader, EmptyState } from '../../components/kit';
import { paths } from '../../lib/paths';

/** Rows shown before *View all N →* (UI_SPEC §6.1). */
export const LOWER_CARD_ROWS = 3;

/**
 * Deferred, not verified · N (UI_SPEC §6.1): item + review text + the test
 * ticket, or "No follow-up ticket" with *Create test ticket* (US3 fills it).
 */
export function DeferredCard({ rows }: { rows: readonly DeferredRow[] }) {
  return (
    <Card data-card="deferred">
      <CardHeader title={`Deferred, not verified · ${rows.length}`} />
      {rows.length === 0 ? (
        <EmptyState text="Nothing deferred." />
      ) : (
        rows.slice(0, LOWER_CARD_ROWS).map((r) => (
          <div className="mrow noico" key={r.hr_item_id}>
            <div style={{ minWidth: 0 }}>
              <div className="row" style={{ minWidth: 0 }}>
                <Link to={paths.item(r.item_id)} className="mono">
                  {r.item_id}
                </Link>
                <span className="tt">{r.title}</span>
              </div>
              <div className="src one" title={r.text}>
                {r.text}
              </div>
              <div className="src one">
                {r.follow_up
                  ? `Test ticket ${r.follow_up.id} · ${STATUS_LABELS[r.follow_up.status].toLowerCase()}`
                  : 'No follow-up ticket'}
              </div>
            </div>
          </div>
        ))
      )}
      {rows.length > LOWER_CARD_ROWS && (
        <div className="cardfoot">
          <span />
          <Link to={paths.work({ filter: 'deferred_review' })}>View all {rows.length} →</Link>
        </div>
      )}
    </Card>
  );
}
