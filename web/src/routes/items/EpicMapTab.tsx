import type { ItemDetailResponse } from '@tasklite/shared';
import { Card, EmptyState } from '../../components/kit';
import { ProgressMapShell } from '../shared/ProgressMapShell';

/**
 * Map (epic; UI_SPEC §6.3): the epic-level review strip (when the epic has
 * human review), then a ProgressMap of its children. US4 fills the map.
 */
export function EpicMapTab({ data }: { data: ItemDetailResponse }) {
  const hrs = data.item.checklist.human_review;
  return (
    <div className="stack1" data-section="map">
      {hrs.length > 0 && (
        <div className={`epicstrip${data.open_packet ? '' : ' later'}`}>
          <b>Epic-level human review{data.open_packet ? ': packet ready' : ''}</b>
          <span className="src">{hrs.map((h) => h.text).join(' · ')}</span>
        </div>
      )}
      <Card padded>
        {data.children.length === 0 ? (
          <EmptyState text="No items yet. When planned, the agent breaks this epic into stories, tasks and bugs." />
        ) : (
          <ProgressMapShell
            items={data.children}
            links={data.links}
            outsideTitle="Outside this epic"
          />
        )}
      </Card>
    </div>
  );
}
