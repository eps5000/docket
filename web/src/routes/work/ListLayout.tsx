import { useNavigate } from 'react-router';
import type { WorkItem } from '@docket/shared';
import {
  BlockedChip,
  Priority,
  ReviewChip,
  RunLine,
  StatusChip,
  TypeIcon,
  leadName,
  leadReason,
} from '../../components/kit';
import { formatAge, isoTitle } from '../../lib/format';
import { paths } from '../../lib/paths';
import { useRenderLimit } from '../../lib/progressive';
import { Link } from 'react-router';

/**
 * List (UI_SPEC §6.2.2): ID, Title, Status (+ blocked), Priority, Lead · run,
 * Human review, Last activity. The whole row is clickable. Empty: "No items match."
 */
export function ListLayout({ items }: { items: readonly WorkItem[] }) {
  const navigate = useNavigate();
  // Thousands of rows render progressively: the first screenful at once (lib/progressive.ts).
  const limit = useRenderLimit(items.length);
  return (
    // position: relative makes the card the containing block of the screen-reader-only text
    // (position: absolute) in its cells, so its scroll box clips that too; otherwise a wide
    // table (long blocker chips) pushed it past the page's right edge at 1024 px (B35).
    <div className="card" style={{ overflow: 'auto', position: 'relative' }} data-layout="list">
      <table>
        <thead>
          <tr>
            <th scope="col">ID</th>
            <th scope="col">Title</th>
            <th scope="col">Status</th>
            <th scope="col">Priority</th>
            <th scope="col">Lead · run</th>
            <th scope="col">Human review</th>
            <th scope="col">Last activity</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr>
              <td colSpan={7} className="muted" data-empty="">
                No items match.
              </td>
            </tr>
          ) : (
            items.slice(0, limit).map((i) => (
              <tr key={i.id} className="clickrow" onClick={() => navigate(paths.item(i.id))}>
                <td>
                  <Link to={paths.item(i.id)} className="mono" onClick={(e) => e.stopPropagation()}>
                    {i.id}
                  </Link>
                </td>
                <td>
                  <div className="row wrap" style={{ gap: 6 }}>
                    <TypeIcon type={i.type} />
                    <span className="ltitle">{i.title}</span>
                  </div>
                  {i.epic_title && <div className="ptag">◆ {i.epic_title}</div>}
                </td>
                <td>
                  <div className="row wrap">
                    <StatusChip status={i.status} />
                    <BlockedChip blockers={i.blocked_by} />
                  </div>
                </td>
                <td>
                  <Priority p={i.priority} />
                </td>
                <td>
                  {i.lead && (
                    <RunLine
                      state={i.lead.run_state}
                      reason={leadReason(i.lead_parked)}
                      agent={leadName(i.lead)}
                    />
                  )}
                </td>
                <td>
                  <ReviewChip item={i} />
                </td>
                <td className="muted" title={isoTitle(i.last_activity_at)}>
                  {formatAge(i.last_activity_at)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
