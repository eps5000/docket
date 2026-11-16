import type { WorkResponse } from '@tasklite/shared';
import { Callout, EmptyState } from '../../components/kit';
import { ProgressMapShell } from '../shared/ProgressMapShell';

/**
 * Map (UI_SPEC §6.2.3): a ProgressMap of the filtered set, titled "Outside
 * this view". With no epic or label chosen, the tip callout. US4 fills the map.
 */
export function MapLayout({ data, scoped }: { data: WorkResponse; scoped: boolean }) {
  return (
    <div className="card pad" data-layout="map">
      {!scoped && (
        <Callout className="mb">
          Tip: pick an epic or label above. A whole project on one map gets busy.
        </Callout>
      )}
      {data.items.length === 0 ? (
        <EmptyState text="No items match." />
      ) : (
        <ProgressMapShell items={data.items} links={data.links} outsideTitle="Outside this view" />
      )}
    </div>
  );
}
