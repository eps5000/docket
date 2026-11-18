import { useState } from 'react';
import { Link } from 'react-router';
import { STATUSES, STATUS_LABELS, type ItemDetailResponse } from '@docket/shared';
import {
  BlockedChip,
  Button,
  Chip,
  EmptyState,
  ForYouChip,
  RunLine,
  Section,
  TypeIcon,
  leadName,
  leadReason,
} from '../../../components/kit';
import { paths } from '../../../lib/paths';

/**
 * Tickets in this epic (summary "n/N done · n ready but blocked · n for
 * you"), grouped by status; archived tickets fold into "+ N archived · Show"
 * (US7, T127). US2 fills it. Each row carries the coordination state the
 * Board cards show (B20): the blocked chip, *For you*, and the lead's run line.
 */
export function EpicTicketsSection({ data }: { data: ItemDetailResponse }) {
  const kids = data.children;
  const done = kids.filter((k) => k.status === 'done').length;
  const blocked = kids.filter((k) => k.status === 'ready' && k.blocked).length;
  const forYou = kids.filter((k) => k.for_you).length;
  const [showArchived, setShowArchived] = useState(false);
  const archivedN = kids.filter((k) => k.archived).length;
  const live = showArchived ? kids : kids.filter((k) => !k.archived);
  return (
    <Section
      sectionKey="tickets"
      title="Tickets in this epic"
      summary={`${done}/${kids.length} done · ${blocked} ready but blocked · ${forYou} for you`}
    >
      {kids.length === 0 ? (
        <EmptyState text="No items yet." />
      ) : (
        STATUSES.map((s) => {
          const group = live.filter((k) => k.status === s);
          if (group.length === 0) return null;
          return (
            <div key={s}>
              <div className="src" style={{ marginTop: 8 }}>
                {STATUS_LABELS[s]} · {group.length}
              </div>
              {group.map((k) => (
                <div className="lrow ticketrow" key={k.id} data-ticket={k.id}>
                  <TypeIcon type={k.type} />
                  <Link to={paths.item(k.id)} className="mono">
                    {k.id}
                  </Link>
                  <span className="grow one" title={k.title}>
                    {k.title}
                  </span>
                  {k.blocked && <BlockedChip blockers={k.blocked_by} />}
                  {k.for_you && <ForYouChip />}
                  {k.lead && (
                    <RunLine
                      state={k.lead.run_state}
                      reason={leadReason(k.lead_parked)}
                      agent={leadName(k.lead)}
                    />
                  )}
                  {k.archived && <Chip kind="neutral">Archived</Chip>}
                </div>
              ))}
            </div>
          );
        })
      )}
      {archivedN > 0 && (
        <div className="src row" style={{ marginTop: 8 }} data-archived-fold="">
          {!showArchived && <span>+ {archivedN} archived ·</span>}
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={showArchived}
            onClick={() => setShowArchived(!showArchived)}
          >
            {showArchived ? 'Hide archived' : 'Show'}
          </Button>
        </div>
      )}
    </Section>
  );
}
