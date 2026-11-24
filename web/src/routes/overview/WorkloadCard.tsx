import { Link } from 'react-router';
import {
  STATUS_LABELS,
  WAIT_KIND_LABELS,
  WORKLOAD_BUCKETS,
  type OverviewResponse,
  type WorkloadBucket,
} from '@docket/shared';
import { Card, CardHeader, StatusBar } from '../../components/kit';
import { paths } from '../../lib/paths';

/** Epics shown before *View all*. */
export const WORKLOAD_ROWS = 6;

type Group = OverviewResponse['workload'][number];

const bucketLabel = (b: WorkloadBucket) =>
  b === 'blocked' || b === 'queued' ? WAIT_KIND_LABELS[b] : STATUS_LABELS[b];

/** "Visual: 3 Ready, 2 Queued, 1 Blocked": the bar's text equivalent. */
export function workloadText(g: Group): string {
  const name = g.epic_id ? (g.title ?? g.epic_id) : 'No epic';
  const parts = WORKLOAD_BUCKETS.filter((b) => g.counts[b] > 0).map(
    (b) => `${g.counts[b]} ${bucketLabel(b)}`,
  );
  return `${name}: ${parts.join(', ')}`;
}

const groupLink = (g: Group) =>
  g.epic_id ? paths.work({ epic: g.epic_id, quick: 'active' }) : paths.overviewList('no_epic');

/** Open tickets by status, per epic, largest first. */
export function WorkloadCard({ workload }: { workload: OverviewResponse['workload'] }) {
  const open = workload.reduce((n, g) => n + g.total, 0);
  return (
    <Card data-card="workload" className="ov-chart">
      <CardHeader title={`Workload · ${open} open`} />
      {workload.length === 0 ? (
        <div className="ov-chart-body">
          <p className="src">No open tickets.</p>
        </div>
      ) : (
        <div className="ov-chart-body">
          <ul className="ov-legend" aria-label="Status colours">
            {WORKLOAD_BUCKETS.map((b) => (
              <li key={b}>
                <i className={`sb-${b}`} aria-hidden="true" />
                {bucketLabel(b)}
              </li>
            ))}
          </ul>
          <ul className="ov-work">
            {workload.slice(0, WORKLOAD_ROWS).map((g) => {
              const name = g.epic_id ? (g.title ?? g.epic_id) : 'No epic';
              return (
                <li key={g.epic_id ?? 'none'} data-workload={g.epic_id ?? 'none'}>
                  <span className="one ov-epic" title={name}>
                    {name}
                  </span>
                  <StatusBar counts={g.counts} label={workloadText(g)} />
                  <Link to={groupLink(g)} className="ov-count">
                    {g.total} <span className="sr">open in {name}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
          {workload.length > WORKLOAD_ROWS && (
            <div className="cardfoot">
              <span />
              <Link to={paths.work({ quick: 'active' })}>View all open work →</Link>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
