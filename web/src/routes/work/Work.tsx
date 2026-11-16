import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { UI_FILTER_KEYS, WORK_LAYOUTS, type WorkResponse } from '@tasklite/shared';
import { Callout, SegmentedControl, Skeleton } from '../../components/kit';
import { useBootstrap } from '../../app/useBootstrap';
import { apiClient } from '../../app/queryClient';
import { QueryState } from '../../app/QueryState';
import { useShell } from '../../app/ShellState';
import { queryKeys } from '../../lib/api';
import { paths, type WorkLayout } from '../../lib/paths';
import { BoardLayout } from './BoardLayout';
import { EpicsRow } from './EpicsRow';
import { ListLayout } from './ListLayout';
import { MapLayout } from './MapLayout';
import { TimelineLayout } from './TimelineLayout';
import { WorkFilters } from './WorkFilters';
import '../screens.css';

type UiFilter = (typeof UI_FILTER_KEYS)[number];

const LAYOUTS: { key: WorkLayout; label: string }[] = [
  { key: 'board', label: 'Board' },
  { key: 'list', label: 'List' },
  { key: 'map', label: 'Map' },
  { key: 'timeline', label: 'Timeline' },
];

/** The Work URL state (UI_SPEC §2: filters and layout live in the URL). */
export function readWorkParams(params: URLSearchParams) {
  const layout = params.get('layout');
  const filter = params.get('filter');
  return {
    layout: ((WORK_LAYOUTS as readonly string[]).includes(layout ?? '')
      ? layout
      : 'board') as WorkLayout,
    filter: ((UI_FILTER_KEYS as readonly string[]).includes(filter ?? '')
      ? filter
      : 'all') as UiFilter,
    epic: params.get('epic') || undefined,
    label: params.get('label') || undefined,
  };
}

/**
 * Work (`/work`, UI_SPEC §6.2): header with the layout control, the filter
 * row, the Epics row, then one layout. One file per part; US2 (T082) fills
 * Board and List, US4 Map, US8 Timeline.
 */
export function Work() {
  const { scope } = useShell();
  const [params, setParams] = useSearchParams();
  const { layout, filter, epic, label } = readWorkParams(params);
  const query = useQuery({
    queryKey: queryKeys.work({ scope, layout, filter, epic, label }),
    queryFn: () => apiClient['work.get']({ query: { scope, layout, filter, epic, label } }),
  });
  const set = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (!v || (k === 'layout' && v === 'board') || (k === 'filter' && v === 'all'))
        next.delete(k);
      else next.set(k, v);
    }
    setParams(next);
  };
  const data: WorkResponse | undefined = query.data;

  return (
    <div className="work">
      <div className="row headrow">
        <h1>Work</h1>
        <SegmentedControl
          label="Layout"
          options={LAYOUTS}
          value={layout}
          onChange={(l) => set({ layout: l })}
        />
      </div>
      {layout !== 'timeline' && (
        <WorkFilters
          filter={filter}
          epic={epic}
          label={label}
          epics={data?.epics ?? []}
          counts={data?.filter_counts}
          onChange={set}
        />
      )}
      <QueryState query={query} skeleton={<WorkSkeleton layout={layout} />}>
        {(d) => (
          <>
            {layout !== 'timeline' && <EpicsRow epics={d.epics} current={epic} />}
            {label && layout !== 'timeline' && <LabelCallout label={label} />}
            {layout === 'board' && <BoardLayout items={d.items} />}
            {layout === 'list' && <ListLayout items={d.items} />}
            {layout === 'map' && <MapLayout data={d} scoped={!!epic || !!label} />}
            {layout === 'timeline' && (
              <TimelineLayout timeline={d.timeline} epic={epic} label={label} />
            )}
          </>
        )}
      </QueryState>
    </div>
  );
}

function WorkSkeleton({ layout }: { layout: WorkLayout }) {
  if (layout === 'board') {
    return (
      <div className="board">
        {Array.from({ length: 6 }, (_, k) => (
          <div className="col" key={k}>
            <Skeleton lines={1} tall={2} label={k === 0 ? 'Loading the board' : 'Loading'} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="card pad">
      <Skeleton lines={6} />
    </div>
  );
}

/** "Filtered by #label. Open the label page for its brief, progress by epic and bulk actions." */
function LabelCallout({ label }: { label: string }) {
  const { scope } = useShell();
  const boot = useBootstrap();
  const project =
    scope !== 'all' ? scope : boot.data?.labels.find((l) => l.name === label)?.project;
  return (
    <Callout className="mb">
      Filtered by <b>#{label}</b>.{' '}
      {project ? (
        <Link to={paths.label(project, label)}>Open the label page</Link>
      ) : (
        'Open the label page'
      )}{' '}
      for its brief, progress by epic and bulk actions.
    </Callout>
  );
}
