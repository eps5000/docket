import { useCallback, useMemo } from 'react';
import type { ItemDetailResponse } from '@docket/shared';
import { Link } from 'react-router';
import { Card, EmptyState } from '../../components/kit';
import type { MapZoom } from '../../components/ProgressMap';
import { useShell } from '../../app/ShellState';
import { paths } from '../../lib/paths';
import { GoalMap } from '../shared/GoalMap';

/**
 * Map (epic; UI_SPEC §6.3): the epic-level review strip (when the epic has
 * human review), then a ProgressMap of its children, with blockers from
 * outside the epic in their own column. Decision 64: the epic's unlinked bugs
 * stack in a Bugs column on the left. Decision 67: its Release sits alone in
 * the last column, with what it waits for and the open bugs holding it.
 */
export function EpicMapTab({ data }: { data: ItemDetailResponse }) {
  const hrs = data.item.checklist.human_review;
  const { id, title, project } = data.item;
  const { tabs, updateTab } = useShell();
  const mapZoom = tabs.tabs.find((tab) => tab.id === id)?.mapZoom;
  const onZoomChange = useCallback((zoom: MapZoom) => updateTab(id, { mapZoom: zoom }), [id, updateTab]);
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
  const releaseId = data.release?.id ?? null;
  const openBugs = data.release?.open_bugs.length ?? 0;
  const left = data.release?.left.length ?? 0;
  // Stable too: a closed epic draws no Bugs column.
  const open = data.item.status !== 'done' && data.item.status !== 'canceled';
  const hasRelease = open && data.release !== undefined;
  const release = useMemo(
    () => (hasRelease ? { id: releaseId, left, openBugs } : null),
    [hasRelease, releaseId, left, openBugs],
  );
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
          <EmptyState text="No items yet. When planned, the agent breaks this epic into explorations, designs, implementation and bugs, before its Release." />
        ) : (
          <GoalMap
            items={children}
            mapZoom={mapZoom}
            onZoomChange={onZoomChange}
            outside={data.outside}
            links={data.links}
            outsideTitle="Outside this epic"
            home={home}
            goals={goals}
            release={release}
          />
        )}
      </Card>
    </div>
  );
}
