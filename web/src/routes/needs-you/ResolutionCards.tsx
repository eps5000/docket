import { Link } from 'react-router';
import type { ResolutionRow } from '@docket/shared';
import { Card, CardHeader } from '../../components/kit';
import { HelpLink } from '../../help/HelpLink';
import { paths } from '../../lib/paths';
import { ResolutionView } from '../shared/problems';

/**
 * Proposed resolutions on Needs you (owner decision 37; UI_SPEC §6.1): a
 * card each, counted as for you, with *Approve*, *Go a different way* (a
 * note is required) and *Acknowledge*. Each choice is posted to the item's
 * agent as an owner note, and can be undone from the toast.
 */
export function ResolutionCards({ resolutions }: { resolutions: readonly ResolutionRow[] }) {
  if (resolutions.length === 0) return null;
  return (
    <div className="mb shared-qs" data-card="resolutions">
      {resolutions.map((r) => (
        <Card key={r.id} className="sq-card" data-resolution-card={r.id}>
          <CardHeader
            title={
              <span>
                {r.proposed_by} proposes how to resolve a problem on{' '}
                <Link
                  to={paths.item(r.item_id, undefined, undefined, r.problem_id ?? undefined)}
                  className="mono"
                >
                  {r.item_id}
                </Link>
              </span>
            }
            extra={<HelpLink anchor="needs-you.resolutions" />}
          />
          <div className="pad" style={{ paddingTop: 0 }}>
            <ResolutionView resolution={r} />
          </div>
        </Card>
      ))}
    </div>
  );
}
