import { Link } from 'react-router';
import type { ItemDetailResponse } from '@tasklite/shared';
import { Card, EmptyState } from '../../components/kit';
import { paths } from '../../lib/paths';

/**
 * Dependencies (ticket; UI_SPEC §6.3, §6.3.3): a plain card with "Waits on n
 * · unblocks n", the 1-hop view, the cycle callout, "Relates to", and *See it
 * on the epic map →*. US4 fills the nodes and the cycle actions.
 */
export function DependenciesTab({ data }: { data: ItemDetailResponse }) {
  const { item } = data;
  const waits = item.links.blocked_by;
  const unblocks = item.links.blocks;
  return (
    <Card padded data-section="deps">
      <h3>
        Waits on {waits.length} · unblocks {unblocks.length}
      </h3>
      {waits.length === 0 && unblocks.length === 0 ? (
        <EmptyState text="No blocking links." />
      ) : (
        <div className="hop">
          {waits.length > 0 && (
            <>
              <div className="src">Waits on</div>
              {waits.map((l) => (
                <Link key={l.link_id} to={paths.item(l.id)} className="pnode">
                  <span className="mono muted">{l.id}</span> <span className="pt">{l.title}</span>
                </Link>
              ))}
              <div className="arrow" aria-hidden="true">
                ↓
              </div>
            </>
          )}
          <div className="pnode cur">
            <span className="mono muted">{item.id}</span> <span className="pt">{item.title}</span>
          </div>
          {unblocks.length > 0 && (
            <>
              <div className="arrow" aria-hidden="true">
                ↓
              </div>
              <div className="src">Then unblocks</div>
              {unblocks.map((l) => (
                <Link key={l.link_id} to={paths.item(l.id)} className="pnode">
                  <span className="mono muted">{l.id}</span> <span className="pt">{l.title}</span>
                </Link>
              ))}
            </>
          )}
        </div>
      )}
      {item.links.relates.length > 0 && (
        <div className="src" style={{ marginTop: 8 }}>
          Relates to (doesn’t block): {item.links.relates.map((l) => l.id).join(', ')}
        </div>
      )}
      {item.epic && (
        <Link className="btn ghost sm seemap" to={paths.item(item.epic, 'map')}>
          See it on the epic map →
        </Link>
      )}
    </Card>
  );
}
