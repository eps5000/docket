import { useState } from 'react';
import { Link } from 'react-router';
import { STATUSES, STATUS_LABELS, waitCountsText, type ItemDetailResponse } from '@docket/shared';
import {
  BlockedChip,
  Button,
  Chip,
  EmptyState,
  ForYouChip,
  RunLine,
  Section,
  TypeIcon,
  WaitChip,
  epicEmptyText,
  leadName,
  leadReason,
} from '../../../components/kit';
import { paths } from '../../../lib/paths';

/**
 * Tickets in this epic (summary "n/N done · Queued n · Blocked n · n for
 * you", or "No tickets yet · Status" with none, as on its card), grouped by
 * status; archived tickets fold into "+ N archived · Show" (US7, T127). Each
 * row carries the coordination state the Board cards show (B20): the Queued,
 * Blocked or Held chip (decision 57), *For you*, and the lead's run line.
 */
export function EpicTicketsSection({ data }: { data: ItemDetailResponse }) {
  const kids = data.children;
  const done = kids.filter((k) => k.status === 'done').length;
  const open = kids.filter((k) => !k.archived && k.status !== 'done' && k.status !== 'canceled');
  const queued = open.filter((k) => k.wait?.kind === 'queued').length;
  const blocked = open.filter((k) => k.wait?.kind === 'blocked').length;
  const forYou = kids.filter((k) => k.for_you).length;
  const [showArchived, setShowArchived] = useState(false);
  const archivedN = kids.filter((k) => k.archived).length;
  const live = showArchived ? kids : kids.filter((k) => !k.archived);
  return (
    <Section
      sectionKey="tickets"
      title="Tickets in this epic"
      summary={
        kids.length === 0
          ? epicEmptyText(data.item.status)
          : `${done}/${kids.length} done · ${waitCountsText({ queued, blocked })} · ${forYou} for you`
      }
    >
      {kids.length === 0 ? (
        <EmptyState text="No tickets yet. Add one with + New item in this epic." />
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
                  {k.wait ? (
                    <WaitChip wait={k.wait} />
                  ) : (
                    k.blocked && <BlockedChip blockers={k.blocked_by} />
                  )}
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
