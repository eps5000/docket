import { Link } from 'react-router';
import type { ItemSummary, LinkEdge } from '@tasklite/shared';
import { TypeIcon } from '../../components/kit';
import { paths } from '../../lib/paths';

/**
 * The progress map's frame (UI_SPEC §6.3.4): the "n / N done" header, a
 * dotted, focusable canvas, and the key line. US4 (the map slice) replaces
 * the canvas body with waves, arrows, pan and zoom. Used by the epic Map tab,
 * label pages and Work → Map.
 */
export function ProgressMapShell({
  items,
  links: _links,
  outsideTitle,
}: {
  items: readonly ItemSummary[];
  links: readonly LinkEdge[];
  /** "Outside this epic", "Outside this view", "Without this label". */
  outsideTitle: string;
}) {
  const done = items.filter((i) => i.status === 'done').length;
  return (
    <div className="pmapbox" data-progress-map="">
      <div className="phead">
        <span className="big">{done}</span>
        <span>/ {items.length} done</span>
      </div>
      <div
        className="pcanvas"
        tabIndex={0}
        role="group"
        aria-label={`Progress map. Columns: ${outsideTitle}, then waves.`}
      >
        <div className="pcol">
          {items.map((i) => (
            <Link key={i.id} to={paths.item(i.id)} className={`pnode ps-${i.status}`}>
              <span className="row" style={{ gap: 6 }}>
                <TypeIcon type={i.type} />
                <span className="mono muted">{i.id}</span>
              </span>
              <span className="pt">{i.title}</span>
            </Link>
          ))}
        </div>
      </div>
      <div className="src" style={{ marginTop: 8 }}>
        Arrow = blocks · dashed green = cleared · hover to trace
      </div>
    </div>
  );
}
