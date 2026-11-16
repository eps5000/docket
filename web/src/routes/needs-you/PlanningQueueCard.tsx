import { Link } from 'react-router';
import type { ItemSummary } from '@tasklite/shared';
import { Card, CardHeader, EmptyState } from '../../components/kit';
import { paths } from '../../lib/paths';
import { LOWER_CARD_ROWS } from './DeferredCard';

/**
 * Your Planning queue · N (UI_SPEC §6.1): item + type and epic, with *Move to
 * Ready* (US7 wires the action).
 */
export function PlanningQueueCard({ items }: { items: readonly ItemSummary[] }) {
  return (
    <Card data-card="planning-queue">
      <CardHeader title={`Your Planning queue · ${items.length}`} />
      {items.length === 0 ? (
        <EmptyState text="Nothing in Planning." />
      ) : (
        items.slice(0, LOWER_CARD_ROWS).map((i) => (
          <div className="mrow noico" key={i.id}>
            <div style={{ minWidth: 0 }}>
              <div className="row" style={{ minWidth: 0 }}>
                <Link to={paths.item(i.id)} className="mono">
                  {i.id}
                </Link>
                <span className="tt">{i.title}</span>
              </div>
              <div className="src one">
                {i.type}
                {i.epic_title ? ` · ◆ ${i.epic_title}` : ''}
              </div>
            </div>
          </div>
        ))
      )}
      {items.length > LOWER_CARD_ROWS && (
        <div className="cardfoot">
          <span />
          <Link to={paths.work({ filter: 'planning' })}>View all {items.length} →</Link>
        </div>
      )}
    </Card>
  );
}
