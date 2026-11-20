import type { ItemDetailResponse } from '@docket/shared';
import type { ItemKind } from './ItemPage';
import { BriefSection } from './details/BriefSection';
import { DatesSection } from './details/DatesSection';
import { DecisionsSection } from './details/DecisionsSection';
import { DocumentsSection } from './details/DocumentsSection';
import { EpicTicketsSection } from './details/EpicTicketsSection';
import { OutcomeSection } from './details/OutcomeSection';
import { SharedChangesSection } from './details/SharedChangesSection';

/**
 * Details (UI_SPEC §6.3 table). Ticket: Outcome, Decisions (hidden when
 * none), Shared changes (decision 36), Documents, Dates and effort. Epic: Brief and documents, Decisions,
 * Tickets in this epic.
 */
export function DetailsTab({ kind, data }: { kind: ItemKind; data: ItemDetailResponse }) {
  if (kind === 'epic') {
    return (
      <div className="stack1">
        <BriefSection data={data} />
        <DecisionsSection data={data} kind={kind} />
        <EpicTicketsSection data={data} />
      </div>
    );
  }
  return (
    <div className="stack1">
      <OutcomeSection data={data} />
      <DecisionsSection data={data} kind={kind} />
      <SharedChangesSection data={data} />
      <DocumentsSection data={data} />
      <DatesSection data={data} />
    </div>
  );
}
