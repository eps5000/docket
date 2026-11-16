import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router';
import type { ItemDetailResponse } from '@tasklite/shared';
import { Button, ErrorState, Skeleton, ViewTabs, type ViewTab } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { useBreadcrumb, useShell, type Crumb } from '../../app/ShellState';
import { useBootstrap } from '../../app/useBootstrap';
import { queryKeys } from '../../lib/api';
import { paths, type ItemTab } from '../../lib/paths';
import { ActivityTab } from './ActivityTab';
import { ChecklistTab } from './ChecklistTab';
import { DependenciesTab } from './DependenciesTab';
import { DetailsTab } from './DetailsTab';
import { EpicMapTab } from './EpicMapTab';
import { ItemBanners } from './ItemBanners';
import { ItemHeader } from './ItemHeader';
import '../screens.css';

export type ItemKind = 'ticket' | 'epic';

const TICKET_TABS: readonly ItemTab[] = ['details', 'checklist', 'deps', 'activity'];
const EPIC_TABS: readonly ItemTab[] = ['details', 'checklist', 'map', 'activity'];

/**
 * The view tab to show: the URL's, else the tab you last used for this item,
 * else Details. `deps` and `map` swap between tickets and epics (UI_SPEC §6.3).
 */
export function resolveTab(kind: ItemKind, fromUrl: string | null, remembered?: ItemTab): ItemTab {
  const wanted = (fromUrl ?? remembered ?? 'details') as ItemTab;
  if (kind === 'epic' && wanted === 'deps') return 'map';
  if (kind === 'ticket' && wanted === 'map') return 'deps';
  return (kind === 'epic' ? EPIC_TABS : TICKET_TABS).includes(wanted) ? wanted : 'details';
}

/** The four view tabs with their counts and dots (UI_SPEC §6.3 table). */
export function itemTabs(kind: ItemKind, data?: ItemDetailResponse): ViewTab<ItemTab>[] {
  const item = data?.item;
  const work = item?.checklist.work ?? [];
  const workDone = work.filter((w) => w.state === 'done').length;
  const packetReady = !!data?.open_packet;
  const epicTotal = item
    ? item.checklist.work.length + item.checklist.checks.length + item.checklist.human_review.length
    : 0;
  const links = item ? item.links.blocks.length + item.links.blocked_by.length : 0;
  const runTrouble = item?.runs.find((r) => r.is_lead && ['stale', 'failed'].includes(r.run_state));
  const tabs: ViewTab<ItemTab>[] = [
    { key: 'details', label: 'Details', hint: 'What this is: outcome, documents, dates' },
    {
      key: 'checklist',
      label: 'Checklist',
      count: kind === 'epic' ? epicTotal : work.length ? `${workDone}/${work.length}` : undefined,
      dot: packetReady ? { tone: 'warn', text: 'packet ready' } : undefined,
      hint: 'Work steps, agent review and human review',
    },
    kind === 'epic'
      ? {
          key: 'map',
          label: 'Map',
          count: data
            ? `${data.children.filter((c) => c.status === 'done').length}/${data.children.length}`
            : undefined,
          hint: 'Where it is: progress and dependencies across its tickets',
        }
      : {
          key: 'deps',
          label: 'Dependencies',
          count: links,
          hint: 'Where it sits: what it waits on and what it unblocks',
        },
    {
      key: 'activity',
      label: 'Activity',
      dot: runTrouble ? { tone: 'warn', text: `${runTrouble.run_state} run` } : undefined,
      hint: 'What the agents did: lead, runs and history',
    },
  ];
  return tabs;
}

/**
 * The ticket and epic page (`/items/:id`, UI_SPEC §6.3): header, banners,
 * the four view tabs, and one column of sections per tab. Tab memory lives in
 * the open-item tab (sessionStorage). US2 (T083) fills the read views.
 */
export function ItemPage() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const { tabs, updateTab, scope, setCapture } = useShell();
  const boot = useBootstrap();
  const query = useQuery({
    queryKey: queryKeys.item(id),
    queryFn: () => apiClient['items.get']({ params: { id } }),
  });
  const data = query.data;
  const item = data?.item;
  const kind: ItemKind = item?.type === 'Epic' ? 'epic' : 'ticket';
  const remembered = tabs.tabs.find((t) => t.id === id)?.view;
  const tab = resolveTab(kind, params.get('tab'), remembered);

  // The open-item tab learns the type and title, and remembers the view.
  useEffect(() => {
    updateTab(id, { view: tab, ...(item ? { type: item.type, title: item.title } : {}) });
  }, [id, tab, item, updateTab]);

  const project = item ? boot.data?.projects.find((p) => p.key === item.project) : undefined;
  const scopeName =
    scope === 'all'
      ? 'All projects'
      : (boot.data?.projects.find((p) => p.key === scope)?.short_name ?? scope);
  const crumbs: Crumb[] = item
    ? [
        { kind: 'text', text: project?.short_name ?? item.project },
        item.epic && item.epic_title
          ? { kind: 'link', text: item.epic_title, to: paths.item(item.epic), epic: true }
          : { kind: 'link', text: 'Work', to: paths.work() },
        { kind: 'current', text: item.title, mono: item.id },
      ]
    : [
        { kind: 'text', text: scopeName },
        { kind: 'link', text: 'Work', to: paths.work() },
        { kind: 'current', text: id },
      ];
  useBreadcrumb({ crumbs });

  const setTab = (t: ItemTab) => {
    const next = new URLSearchParams(params);
    next.set('tab', t);
    setParams(next, { replace: true });
  };

  return (
    <div className="itempage" data-item-page={id}>
      <ItemHeader id={id} data={data} />
      {data && <ItemBanners data={data} />}
      <ViewTabs
        label={kind === 'epic' ? 'Epic views' : 'Ticket views'}
        tabs={itemTabs(kind, data)}
        active={tab}
        onChange={setTab}
        extra={
          kind === 'epic' && item ? (
            <Button
              size="sm"
              onClick={() =>
                setCapture({ epic: { id: item.id, title: item.title, project: item.project } })
              }
            >
              + New item in this epic
            </Button>
          ) : undefined
        }
      >
        {query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : !data ? (
          <div className="card pad">
            <Skeleton lines={4} label="Loading the item" />
          </div>
        ) : (
          <TabBody tab={tab} kind={kind} data={data} />
        )}
      </ViewTabs>
    </div>
  );
}

function TabBody({ tab, kind, data }: { tab: ItemTab; kind: ItemKind; data: ItemDetailResponse }) {
  switch (tab) {
    case 'details':
      return <DetailsTab kind={kind} data={data} />;
    case 'checklist':
      return <ChecklistTab kind={kind} data={data} />;
    case 'deps':
      return <DependenciesTab data={data} />;
    case 'map':
      return <EpicMapTab data={data} />;
    case 'activity':
      return <ActivityTab kind={kind} data={data} />;
  }
}
