import type { ItemDetailResponse } from '@tasklite/shared';
import type { ItemKind } from './ItemPage';
import { HistorySection } from './activity/HistorySection';
import { LeadAndRunsSection } from './activity/LeadAndRunsSection';

/**
 * Activity (UI_SPEC §6.3): Lead and runs (with "Where the work lives" under
 * each run) and History with the note box. Epics show History only.
 */
export function ActivityTab({ kind, data }: { kind: ItemKind; data: ItemDetailResponse }) {
  return (
    <div className="stack1">
      {kind === 'ticket' && <LeadAndRunsSection data={data} />}
      <HistorySection kind={kind} data={data} />
    </div>
  );
}
