import { useMemo } from 'react';
import type { ItemDetailResponse } from '@docket/shared';
import { Link } from 'react-router';
import { Card, EmptyState } from '../../components/kit';
import { paths } from '../../lib/paths';
import { GoalMap } from '../shared/GoalMap';

/**
 * Map (epic; UI_SPEC §6.3): the epic-level review strip (when the epic has
 * human review), then a ProgressMap of its children, with blockers from
 * outside the epic in their own column.
 */
export function EpicMapTab({ data }: { data: ItemDetailResponse }) {
  const hrs = data.item.checklist.human_review;
  const { id, title, project } = data.item;
  // Stable, so the map doesn't re-measure on every render.
  const home = useMemo(() => ({ project }), [project]);
  const goals = useMemo(() => [{ id, title }], [id, title]);
  // Decision 62: mark the tickets added after the epic started.
  const midflight = data.epic_midflight;
  const children = useMemo(() => {
    const added = new Set(midflight?.added.map((t) => t.id));
    return added.size === 0
      ? data.children
      : data.children.map((c) => (added.has(c.id) ? { ...c, added_midflight: true } : c));
  }, [data.children, midflight]);
  return (
    <div className="stack1" data-section="map">
      {hrs.length > 0 && (
        <div className={`epicstrip${data.open_packet ? '' : ' later'}`}>
          <b>Epic-level human review{data.open_packet ? ': packet ready' : ''}</b>
          <span className="src">{hrs.map((h) => h.text).join(' · ')}</span>
        </div>
      )}
      {data.children.length > 0 && (
        <div>
          <Link className="btn ghost sm" to={paths.criticalPath(id, id)}>
            See what’s holding this epic up →
          </Link>
        </div>
      )}
      <Card padded>
        {data.children.length === 0 ? (
          <EmptyState text="No items yet. When planned, the agent breaks this epic into stories, tasks and bugs." />
        ) : (
          <GoalMap
            items={children}
            outside={data.outside}
            links={data.links}
            outsideTitle="Outside this epic"
            home={home}
            goals={goals}
          />
        )}
      </Card>
    </div>
  );
}
