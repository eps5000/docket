import { useQuery } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  waitCountsText,
  type EpicPick,
  type EpicPickFit,
  type PickEpicResponse,
} from '@docket/shared';
import {
  Callout,
  Card,
  Chip,
  EmptyState,
  EpicReadinessLine,
  Skeleton,
  epicReleaseText,
} from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { QueryState } from '../../app/QueryState';
import { useBreadcrumb } from '../../app/ShellState';
import { useBootstrap } from '../../app/useBootstrap';
import { HelpLink } from '../../help/HelpLink';
import { queryKeys } from '../../lib/api';
import { paths } from '../../lib/paths';
import { nextSort, sortPicks, type PickSort, type PickSortKey } from './pickEpicSort';
import '../screens.css';

const GROUPS: { fit: EpicPickFit; title: string }[] = [
  { fit: 'available', title: 'Good to hand off' },
  { fit: 'being_worked', title: 'Already being worked' },
  { fit: 'likely_parks', title: 'Likely to park' },
  { fit: 'not_ready', title: 'Not ready to start' },
];

const COLUMNS = 7;

/**
 * Pick next epic (`/projects/:key/next-epic`; owner decision 54; UI_SPEC
 * §6.2.5): which open epic to hand to a new agent without it parking on
 * another epic's work. Read-only.
 */
export function PickEpicPage() {
  const { key = '' } = useParams();
  const boot = useBootstrap();
  const project = boot.data?.projects.find((p) => p.key === key);
  const name = project?.name ?? key;
  useBreadcrumb({
    crumbs: [
      { kind: 'text', text: name },
      { kind: 'current', text: 'Pick next epic' },
    ],
  });
  const query = useQuery({
    queryKey: queryKeys.pickEpic(key),
    queryFn: () => apiClient['projects.pickEpic']({ params: { key } }),
    enabled: project !== undefined,
  });

  if (boot.data && !project) {
    return (
      <div className="pickepic">
        <h1>Pick next epic</h1>
        <Card padded>
          <p style={{ margin: 0 }}>
            <span className="muted">There’s no project {key}. </span>
            <Link to={paths.settings()}>See your projects in Settings</Link>
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="pickepic" data-pick-epic={key}>
      <div className="row headrow">
        <div className="withhelp wh-h1">
          <h1>Pick next epic · {name}</h1>
          <HelpLink anchor="work.pick-next-epic" />
        </div>
        <Link className="btn sm" to={paths.work()}>
          Back to Work
        </Link>
      </div>
      <p className="src pickepic-lede">Based on dependencies recorded in Docket.</p>
      <QueryState
        query={query}
        skeleton={
          <Card padded>
            <Skeleton lines={6} label="Loading epics" />
          </Card>
        }
      >
        {(d) => <PickTable data={d} />}
      </QueryState>
    </div>
  );
}

function PickTable({ data }: { data: PickEpicResponse }) {
  const [sort, setSort] = useState<PickSort | null>(null);
  if (data.epics.length === 0) {
    return (
      <Card padded>
        <EmptyState text="No open epic has open tickets yet. Add tickets to an epic, and it shows here." />
      </Card>
    );
  }
  const startHead = data.paused ? 'Can start once resumed' : 'Can start now';
  const head = (k: PickSortKey, label: string) => (
    <SortHead sortKey={k} label={label} sort={sort} onSort={(x) => setSort(nextSort(sort, x))} />
  );
  return (
    <>
      {data.paused && (
        <Callout className="mb pick-paused">
          This project is paused. The counts show what could start once you resume it.
        </Callout>
      )}
      {!data.best && (
        <Callout tone="warn" className="mb pick-none">
          No epic is free to hand off right now. Each one is already being worked, would likely
          park, or isn’t ready to start.
        </Callout>
      )}
      <Card>
        <div className="tablewrap">
          <table className="pe-table" aria-label="Open epics to pick from">
            <thead>
              <tr>
                {head('title', 'Epic')}
                {head('own', 'Can finish on its own')}
                {head('start', startHead)}
                {head('waits', 'Waits on')}
                {head('unblocks', 'Unblocks elsewhere')}
                {head('shaped', 'Not shaped yet')}
                {head('worked', 'Being worked')}
              </tr>
            </thead>
            {GROUPS.map(({ fit, title }) => {
              const rows = sortPicks(
                data.epics.filter((e) => e.fit === fit),
                sort,
              );
              if (rows.length === 0) return null;
              return (
                <tbody key={fit} data-pick-group={fit}>
                  <tr className="pe-group">
                    <th scope="rowgroup" colSpan={COLUMNS}>
                      {title} · {rows.length}
                    </th>
                  </tr>
                  {rows.map((p) => (
                    <PickRow key={p.id} pick={p} reason={bestReasonFor(data, p)} />
                  ))}
                </tbody>
              );
            })}
          </table>
        </div>
      </Card>
    </>
  );
}

const bestReasonFor = (data: PickEpicResponse, p: EpicPick) =>
  data.best?.id === p.id ? data.best.reason : null;

function SortHead({
  sortKey,
  label,
  sort,
  onSort,
}: {
  sortKey: PickSortKey;
  label: string;
  sort: PickSort | null;
  onSort: (key: PickSortKey) => void;
}) {
  const active = sort?.key === sortKey;
  const dir = active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined;
  return (
    <th scope="col" aria-sort={dir}>
      <button type="button" className="pe-sort" onClick={() => onSort(sortKey)}>
        {label}
        <span aria-hidden="true">{active ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}</span>
      </button>
    </th>
  );
}

function PickRow({ pick: p, reason }: { pick: EpicPick; reason: string | null }) {
  return (
    <tr data-pick-row={p.id} data-best-next={reason ? '' : undefined}>
      <td className="pe-epic">
        <span className="row wrap" style={{ gap: 6 }}>
          {reason && <Chip kind="ok">Best next</Chip>}
          <Link to={paths.item(p.id)}>{p.title}</Link>
          <span className="mono muted">{p.id}</span>
        </span>
        {reason && (
          <div className="src" data-best-reason>
            {reason}
          </div>
        )}
        {p.park_reason && (
          <div className="src" data-park-reason>
            {p.park_reason}
          </div>
        )}
        {/* Decision 58: its Inbox and Planning tickets, before or after it started. */}
        {p.readiness && <EpicReadinessLine readiness={p.readiness} className="src" />}
        {/* Decision 64: its finish line and the open bugs holding it. */}
        {p.release && (p.release.open_bugs > 0 || p.release.finish_line === null) && (
          <div className="src" data-pick-release={p.release.open_bugs}>
            <span aria-hidden="true">⚑</span> {epicReleaseText(p.release)}
          </div>
        )}
        <div className="src">
          <Link to={paths.criticalPath(p.id, p.id)}>
            Critical path <span className="sr">for {p.title}</span>
          </Link>
        </div>
      </td>
      <td data-col="own">
        {p.self_contained} of {p.open}
      </td>
      <td data-col="start">
        {p.can_start.count}
        {p.can_start.first.length > 0 && (
          <div className="src">
            {p.can_start.first.map((t, i) => (
              <Fragment key={t.id}>
                {i > 0 && ', '}
                <Link className="mono" to={paths.item(t.id)} title={t.title}>
                  {t.id}
                </Link>
              </Fragment>
            ))}
            {p.can_start.count > p.can_start.first.length &&
              ` and ${p.can_start.count - p.can_start.first.length} more`}
          </div>
        )}
        {/* Decision 57: what waits its turn, and what needs attention. */}
        {p.waiting.queued + p.waiting.blocked > 0 && (
          <div className="src" data-pick-waits="">
            {waitCountsText(p.waiting)}
          </div>
        )}
      </td>
      <td data-col="waits">
        {p.waits_on.length === 0
          ? 'Nothing'
          : p.waits_on.map((w) => (
              <div key={w.epic ?? 'none'}>
                {w.epic ? <Link to={paths.item(w.epic)}>{w.title ?? w.epic}</Link> : 'No epic'}{' '}
                <span className="muted">({w.tickets})</span>
              </div>
            ))}
      </td>
      <td data-col="unblocks">{p.unblocks_elsewhere}</td>
      <td data-col="shaped">{p.not_shaped}</td>
      <td data-col="worked">
        {p.worked_by.length === 0
          ? 'Nobody'
          : p.worked_by.map((w) => (
              <div key={`${w.role}:${w.who}`}>
                {w.who} <span className="muted">({w.role})</span>
              </div>
            ))}
      </td>
    </tr>
  );
}
