import { useNavigate } from 'react-router';
import type { WorkItem } from '@tasklite/shared';
import {
  BlockedChip,
  Priority,
  ReviewChip,
  RunState,
  StatusChip,
  TypeIcon,
  leadName,
} from '../../components/kit';
import { formatAge, isoTitle } from '../../lib/format';
import { paths } from '../../lib/paths';
import { Link } from 'react-router';

/**
 * List (UI_SPEC §6.2.2): ID, Title, Status (+ blocked), Priority, Lead · run,
 * Human review, Last activity. The whole row is clickable. Empty: "No items match."
 */
export function ListLayout({ items }: { items: readonly WorkItem[] }) {
  const navigate = useNavigate();
  return (
    <div className="card" style={{ overflow: 'auto' }} data-layout="list">
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
            items.map((i) => (
              <tr key={i.id} className="clickrow" onClick={() => navigate(paths.item(i.id))}>
                <td>
                  <Link to={paths.item(i.id)} className="mono" onClick={(e) => e.stopPropagation()}>
                    {i.id}
                  </Link>
                </td>
                <td>
                  <div className="row wrap" style={{ gap: 6 }}>
                    <TypeIcon type={i.type} />
                    <span>{i.title}</span>
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
                    <>
                      <div>{leadName(i.lead)}</div>
                      <RunState state={i.lead.run_state} />
                    </>
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
