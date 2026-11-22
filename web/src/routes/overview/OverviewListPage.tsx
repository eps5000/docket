import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router';
import {
  OVERVIEW_METRICS,
  type OverviewItemRow,
  type OverviewMetric,
  type OverviewWindow,
} from '@docket/shared';
import { Card, EmptyState, Skeleton, StatusChip } from '../../components/kit';
import { QueryState } from '../../app/QueryState';
import { apiClient } from '../../app/queryClient';
import { useShell } from '../../app/ShellState';
import { queryKeys } from '../../lib/api';
import { formatStamp, isoTitle } from '../../lib/format';
import { paths } from '../../lib/paths';
import { NotFound } from '../NotFound';
import { isOverviewWindow, readOverviewWindow, WINDOW_WORDS } from './overviewWindow';
import '../screens.css';
import './overview.css';

const TITLES: Record<OverviewMetric, string> = {
  completed: 'Completed',
  agents_working: 'Agents working',
  agents_waiting: 'Agents waiting',
  in_flight: 'In flight',
  no_epic: 'Open tickets with no epic',
};

const MEANING: Record<OverviewMetric, (w: OverviewWindow) => string> = {
  completed: (w) => `Tickets that entered Done in the last ${WINDOW_WORDS[w]} and are still Done.`,
  agents_working: () => 'Stories with live, current work. A story counts once, however many runs.',
  agents_waiting: () => 'Stories whose producer is parked on a dependency that hasn’t cleared.',
  in_flight: () => 'Open tickets in In progress or Review.',
  no_epic: () => 'Open tickets that aren’t in an epic.',
};

const isMetric = (v: string | undefined): v is OverviewMetric =>
  (OVERVIEW_METRICS as readonly string[]).includes(v ?? '');

/** The list behind an Overview number that no Work filter can show (`/overview/:metric`). */
export function OverviewListPage() {
  const { metric } = useParams();
  if (!isMetric(metric)) return <NotFound />;
  return <MetricList metric={metric} />;
}

function MetricList({ metric }: { metric: OverviewMetric }) {
  const { scope } = useShell();
  const [params] = useSearchParams();
  const asked = params.get('window');
  const window = isOverviewWindow(asked) ? asked : readOverviewWindow();
  const query = useQuery({
    queryKey: queryKeys.overviewItems({ scope, window, metric }),
    queryFn: () => apiClient['overview.items']({ query: { scope, window, metric } }),
  });
  return (
    <div className="overview" data-overview-list={metric}>
      <p className="src">
        <Link to={paths.overview()}>← Overview</Link>
      </p>
      <h1>
        {TITLES[metric]}
        {query.data ? ` · ${query.data.count}` : ''}
      </h1>
      <p className="src">{MEANING[metric](window)}</p>
      <QueryState query={query} skeleton={<Skeleton lines={6} label="Loading the list" />}>
        {(data) => (
          <Card>
            {data.rows.length === 0 ? (
              <EmptyState text="Nothing here right now." />
            ) : (
              <div className="tablewrap ov-table">
                <table aria-label={TITLES[metric]}>
                  <thead>
                    <tr>
                      <th scope="col">Ticket</th>
                      <th scope="col">Title</th>
                      <th scope="col">Status</th>
                      <th scope="col">Epic</th>
                      {metric === 'completed' && <th scope="col">Completed</th>}
                      {metric.startsWith('agents_') && <th scope="col">Producer</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => (
                      <Row key={r.id} row={r} metric={metric} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {data.count > data.rows.length && (
              <div className="cardfoot">
                <span className="src">
                  Showing the first {data.rows.length} of {data.count}
                </span>
              </div>
            )}
          </Card>
        )}
      </QueryState>
    </div>
  );
}

function Row({ row: r, metric }: { row: OverviewItemRow; metric: OverviewMetric }) {
  return (
    <tr data-item={r.id}>
      <td className="mono">
        <Link to={paths.item(r.id)}>{r.id}</Link>
      </td>
      <td className="ov-title">{r.title}</td>
      <td>
        <span className="row">
          <StatusChip status={r.status} />
          {r.blocked && <span className="chip st-blocked">Blocked</span>}
        </span>
      </td>
      <td className="ov-title">
        {r.epic_id ? <Link to={paths.item(r.epic_id)}>{r.epic_title ?? r.epic_id}</Link> : '–'}
      </td>
      {metric === 'completed' && (
        <td title={r.closed_at ? isoTitle(r.closed_at) : undefined}>
          {r.closed_at ? formatStamp(r.closed_at) : '–'}
        </td>
      )}
      {metric.startsWith('agents_') && <td>{r.agent ?? '–'}</td>}
    </tr>
  );
}
