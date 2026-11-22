import type { OverviewResponse } from '@docket/shared';
import { Card, CardHeader } from '../../components/kit';
import { plural } from '../../lib/format';

/** One sentence that says what the bars say. */
export function completedSummary(completed: OverviewResponse['completed']): string {
  if (completed.count === 0) return 'No tickets completed in this window.';
  const peak = completed.buckets.reduce((a, b) => (b.count > a.count ? b : a));
  return `${plural(completed.count, 'ticket')} completed. Busiest: ${peak.label}, with ${peak.count}.`;
}

/**
 * Completed per day (per hour for 24h). A single series, so no legend: the
 * title names it. Bars are hidden from assistive tech, which gets the summary
 * and a table of the same values.
 */
export function CompletedChart({ completed }: { completed: OverviewResponse['completed'] }) {
  const unit = completed.granularity === 'hour' ? 'hour' : 'day';
  const max = Math.max(1, ...completed.buckets.map((b) => b.count));
  const first = completed.buckets[0];
  const last = completed.buckets.at(-1);
  return (
    <Card data-card="completed-chart" className="ov-chart">
      <CardHeader title={`Completed per ${unit}`} />
      <div className="ov-chart-body">
        <p className="src">{completedSummary(completed)}</p>
        <div className="ov-bars" aria-hidden="true">
          {completed.buckets.map((b) => (
            <div key={b.key} className="ov-bar" title={`${b.label}: ${b.count}`}>
              {b.count > 0 && <i style={{ height: `${(b.count / max) * 100}%` }} />}
            </div>
          ))}
        </div>
        <div className="ov-axis" aria-hidden="true">
          <span>{first?.label}</span>
          <span>{last?.label}</span>
        </div>
        {/* In a wrapper: a table ignores the clipping `.sr` relies on. */}
        <div className="sr">
          <table>
            <caption>Tickets completed per {unit}</caption>
            <thead>
              <tr>
                <th scope="col">{unit === 'hour' ? 'Hour' : 'Day'}</th>
                <th scope="col">Completed</th>
              </tr>
            </thead>
            <tbody>
              {completed.buckets.map((b) => (
                <tr key={b.key}>
                  <th scope="row">{b.label}</th>
                  <td>{b.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}
