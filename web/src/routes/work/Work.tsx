import { useNoProjects } from '../../app/useBootstrap';
import { NoProjectsPointer } from '../needs-you/Welcome';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import {
  ONBOARDING_CHANGES,
  UI_FILTER_KEYS,
  WORK_LAYOUTS,
  type OnboardingChange,
  type WorkResponse,
} from '@docket/shared';
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
    onboarding: params.get('onboarding') || undefined,
    onboarding_change: (ONBOARDING_CHANGES as readonly string[]).includes(
      params.get('onboarding_change') ?? '',
    )
      ? (params.get('onboarding_change') as OnboardingChange)
      : undefined,
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
  const { layout, filter, epic, label, onboarding, onboarding_change } = readWorkParams(params);
  const q = { scope, layout, filter, epic, label, onboarding, onboarding_change };
  const query = useQuery({
    queryKey: queryKeys.work(q),
    queryFn: () => apiClient['work.get']({ query: q }),
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
  const noProjects = useNoProjects();

  if (noProjects) {
    // First run (B32): a pointer to the Welcome page instead of empty columns.
    return (
      <div className="work">
        <h1>Work</h1>
        <NoProjectsPointer />
      </div>
    );
  }

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
      {onboarding && (
        <OnboardingFilter
          session={onboarding}
          change={onboarding_change}
          onRemove={() => set({ onboarding: undefined, onboarding_change: undefined })}
        />
      )}
      {layout === 'timeline' && (epic || label) && (
        <ActiveScope
          epic={epic}
          epicTitle={data?.epics.find((e) => e.id === epic)?.title}
          label={label}
          onRemove={set}
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

/**
 * The Timeline hides the filter row, so an epic or label filter it was opened
 * with shows here as a removable chip (B18; UI_SPEC §6.2.4).
 */
function ActiveScope({
  epic,
  epicTitle,
  label,
  onRemove,
}: {
  epic?: string;
  epicTitle?: string;
  label?: string;
  onRemove: (patch: Record<string, string | undefined>) => void;
}) {
  return (
    <div className="filters" role="group" aria-label="Active filters" data-active-filters>
      {epic && (
        <button
          type="button"
          className="chip c-info fchip"
          aria-label={`Remove the epic filter: ${epicTitle ?? epic}`}
          title="Show every epic"
          onClick={() => onRemove({ epic: undefined })}
        >
          <span aria-hidden="true">◆</span> {epicTitle ?? epic}
          <span aria-hidden="true" className="fchip-x">
            ×
          </span>
        </button>
      )}
      {label && (
        <button
          type="button"
          className="chip c-info fchip"
          aria-label={`Remove the label filter: #${label}`}
          title="Show every label"
          onClick={() => onRemove({ label: undefined })}
        >
          # {label}
          <span aria-hidden="true" className="fchip-x">
            ×
          </span>
        </button>
      )}
    </div>
  );
}

/**
 * The onboarding review card's links (decision 31; UI_SPEC §6.7d; B30): a
 * removable chip says why the list is short, "Onboarding by claude · created".
 */
function OnboardingFilter({
  session,
  change,
  onRemove,
}: {
  session: string;
  change?: OnboardingChange;
  onRemove: () => void;
}) {
  const sessions = useQuery({
    queryKey: queryKeys.onboarding({}),
    queryFn: () => apiClient['onboarding.list']({ query: {} }),
  });
  const s = sessions.data?.sessions.find((x) => x.id === session);
  const who = s ? (s.started_by.split(' · ')[0] ?? s.started_by) : 'an agent';
  const text = `Onboarding by ${who}${s && s.project ? ` (${s.project})` : ''} · ${change ?? 'created or enriched'}`;
  return (
    <div
      className="filters"
      role="group"
      aria-label="Active filters"
      data-onboarding-filter={session}
    >
      <button
        type="button"
        className="chip c-info fchip"
        aria-label={`Remove the onboarding filter: ${text}`}
        title="Show all work"
        onClick={onRemove}
      >
        {text}
        <span aria-hidden="true" className="fchip-x">
          ×
        </span>
      </button>
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
