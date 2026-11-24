import type { ItemDetailResponse } from '@docket/shared';
import type { ItemKind } from './ItemPage';
import { BriefSection } from './details/BriefSection';
import { DatesSection } from './details/DatesSection';
import { DecisionsSection } from './details/DecisionsSection';
import { DocumentsSection } from './details/DocumentsSection';
import { EpicTicketsSection } from './details/EpicTicketsSection';
import { GitHubSection } from './details/GitHubSection';
import { KnownGapsSection } from './details/KnownGapsSection';
import { OutcomeSection } from './details/OutcomeSection';
import { SharedChangesSection } from './details/SharedChangesSection';
import { UsageSection } from './details/UsageSection';

/**
 * Details (UI_SPEC §6.3 table). Ticket: Known gaps (decision 58; hidden when
 * none), Outcome, Decisions (hidden when none), Shared changes (decision 36),
 * GitHub (decision 49), Documents, Dates and effort. Epic: Brief and documents,
 * Decisions, Tickets in this epic. Both end with Token use when that source is on (decision 48).
 */
export function DetailsTab({ kind, data }: { kind: ItemKind; data: ItemDetailResponse }) {
  if (kind === 'epic') {
    return (
      <div className="stack1">
        <BriefSection data={data} />
        <DecisionsSection data={data} kind={kind} />
        <EpicTicketsSection data={data} />
        <UsageSection data={data} />
      </div>
    );
  }
  return (
    <div className="stack1">
      <KnownGapsSection data={data} />
      <OutcomeSection data={data} />
      <DecisionsSection data={data} kind={kind} />
      <SharedChangesSection data={data} />
      <GitHubSection data={data} />
      <DocumentsSection data={data} />
      <DatesSection data={data} />
      <UsageSection data={data} />
    </div>
  );
}
