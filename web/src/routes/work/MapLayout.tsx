import type { WorkResponse } from '@docket/shared';
import { Callout, EmptyState } from '../../components/kit';
import { ProgressMap } from '../../components/ProgressMap';

/**
 * Map (UI_SPEC §6.2.3): a ProgressMap of the filtered set, with blockers
 * from outside it under "Outside this view". With no epic or label chosen,
 * the tip callout.
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
        <ProgressMap
          items={data.items}
          outside={data.outside}
          links={data.links}
          outsideTitle="Outside this view"
        />
      )}
    </div>
  );
}
