import { Link } from 'react-router';
import type { ForYouRow } from '@tasklite/shared';
import { Card, CardHeader, EmptyState, Icon } from '../../components/kit';
import { paths } from '../../lib/paths';

/**
 * For you now · N (UI_SPEC §6.1): packet rows (*Open packet*) and question
 * rows (*Answer* opens an inline reply). Shell: US2 (T081) fills the rows,
 * the reply box (US6) and the 1 s highlight for new rows.
 */
export function ForYouNow({ rows }: { rows: readonly ForYouRow[] }) {
  return (
    <Card data-card="for-you">
      <CardHeader title={`For you now · ${rows.length}`} />
      {rows.length === 0 ? (
        <EmptyState text="Nothing to verify. Agents will hand off when work is built." />
      ) : (
        rows.map((r) => <ForYouRowView key={`${r.kind}:${r.item_id}`} row={r} />)
      )}
    </Card>
  );
}

function ForYouRowView({ row }: { row: ForYouRow }) {
  const line =
    row.kind === 'packet'
      ? `Round ${row.round} packet · ${row.to_verify} to verify · about ${row.estimate}`
      : `${row.asked_by} asks: “${row.text}”`;
  return (
    <div className="att" data-row={row.kind}>
      <div className="ico ico-warn" aria-hidden="true">
        <Icon name={row.kind === 'packet' ? 'packet' : 'question'} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="row" style={{ minWidth: 0 }}>
          <Link to={paths.item(row.item_id)} className="tt">
            {row.title}
          </Link>
          <span className="mono muted">{row.item_id}</span>
        </div>
        <div className="why one" title={line}>
          {line}
        </div>
      </div>
      {row.kind === 'packet' ? (
        <Link className="btn sm primary" to={paths.review(row.item_id)}>
          Open packet
        </Link>
      ) : (
        <Link className="btn sm primary" to={paths.item(row.item_id)}>
          Answer
        </Link>
      )}
    </div>
  );
}
