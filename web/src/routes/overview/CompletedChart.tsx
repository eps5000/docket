import { Link } from 'react-router';
import type { OverviewResponse } from '@docket/shared';
import { Card, CardHeader } from '../../components/kit';
import { plural } from '../../lib/format';
import { paths } from '../../lib/paths';
import { useChartTip } from './useChartTip';

type Bucket = OverviewResponse['completed']['buckets'][number];

/** One sentence that says what the bars say. */
export function completedSummary(completed: OverviewResponse['completed']): string {
  if (completed.count === 0) return 'No tickets completed in this window.';
  const peak = completed.buckets.reduce((a, b) => (b.count > a.count ? b : a));
  return `${plural(completed.count, 'ticket')} completed. Busiest: ${peak.label}, with ${peak.count}.`;
}

const hasCount = (b: Bucket) => b.count > 0;

const MAX_INTERVALS = 4;

/**
 * The vertical axis: whole numbers from 0, stepping by 1, 2 or 5 times a power
 * of ten, in at most four intervals. The last tick is at or above `max`, and is
 * the top of the scale. An empty chart still reads 0 and 1.
 */
export function axisTicks(max: number): number[] {
  const top = Math.max(1, Math.ceil(max));
  for (let power = 1; ; power *= 10) {
    for (const m of [1, 2, 5]) {
      const step = m * power;
      const intervals = Math.ceil(top / step);
      if (intervals <= MAX_INTERVALS) {
        return Array.from({ length: intervals + 1 }, (_, k) => k * step);
      }
    }
  }
}

/** "RCP-1 Title; RCP-2 Title; and 3 more", or "None". */
export function bucketTicketsText(b: Bucket): string {
  if (b.count === 0) return 'None';
  const names = b.tickets.map((t) => `${t.id} ${t.title}`);
  const more = b.count - b.tickets.length;
  return [...names, ...(more > 0 ? [`and ${more} more`] : [])].join('; ');
}

function BucketTip({
  bucket,
  id,
  position,
  tipRef,
  onEnter,
  onLeave,
}: {
  bucket: Bucket;
  id: string;
  position: { left: number; top: number } | null;
  tipRef: React.RefObject<HTMLDivElement | null>;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const more = bucket.count - bucket.tickets.length;
  const counted =
    bucket.count === 0 ? 'None completed' : `${plural(bucket.count, 'ticket')} completed`;
  return (
    <div
      id={id}
      ref={tipRef}
      className="ov-tip"
      role="group"
      aria-label={`${bucket.label}: ${counted}`}
      data-chart-tip={bucket.key}
      style={position ?? { left: 0, top: 0, visibility: 'hidden' }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <p className="ov-tip-h">
        <b>{bucket.label}</b> · {counted}
      </p>
      {bucket.tickets.length > 0 && (
        <ul>
          {bucket.tickets.map((t) => (
            <li key={t.id}>
              <Link to={paths.item(t.id)} title={`${t.id} ${t.title}`}>
                <span className="mono">{t.id}</span> <span className="ov-tip-t">{t.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {more > 0 && <p className="ov-tip-more">and {more} more</p>}
    </div>
  );
}

/**
 * Completed per day (per hour for 24h). A single series, so no legend: the
 * title names it. Each bar is a button, one tab stop for the whole row (arrow
 * keys move along it), and opens a tooltip naming its tickets. Tab goes on into
 * the tooltip's links, and Esc closes it. Assistive tech also gets the summary
 * and a table of the same values and tickets.
 */
export function CompletedChart({ completed }: { completed: OverviewResponse['completed'] }) {
  const unit = completed.granularity === 'hour' ? 'hour' : 'day';
  const { buckets } = completed;
  const ticks = axisTicks(Math.max(0, ...buckets.map((b) => b.count)));
  const top = ticks.at(-1)!;
  const first = buckets[0];
  const last = buckets.at(-1);
  const pct = (n: number) => `${(n / top) * 100}%`;

  const { tipId, hintId, rootRef, tipRef, open, position, cancelHide, hideSoon, onBlur, barProps } =
    useChartTip(buckets, hasCount);

  return (
    <Card data-card="completed-chart" className="ov-chart">
      <CardHeader title={`Completed per ${unit}`} />
      <div className="ov-chart-body">
        <p className="src">{completedSummary(completed)}</p>
        <div className="ov-plot" ref={rootRef} onBlur={onBlur}>
          <div className="ov-yaxis" aria-hidden="true" style={{ width: `${String(top).length}ch` }}>
            {ticks.map((t) => (
              <span key={t} style={{ bottom: pct(t) }}>
                {t}
              </span>
            ))}
          </div>
          <div className="ov-plotarea">
            <div className="ov-grid" aria-hidden="true">
              {ticks.map((t) => (
                <i key={t} data-zero={t === 0 || undefined} style={{ bottom: pct(t) }} />
              ))}
            </div>
            <div
              className="ov-bars"
              role="group"
              aria-label={`Tickets completed, one bar per ${unit}`}
              aria-describedby={hintId}
            >
              {buckets.map((b, index) => (
                <button
                  key={b.key}
                  {...barProps(b, index)}
                  className="ov-bar"
                  data-bar={b.key}
                  aria-label={`${b.label}: ${b.count === 0 ? 'none' : plural(b.count, 'ticket')} completed`}
                >
                  {b.count > 0 && <i style={{ height: pct(b.count) }} />}
                </button>
              ))}
            </div>
            <span id={hintId} className="sr">
              Left and right arrow keys move between bars. Tab moves into the open bar’s tickets,
              and Escape closes them.
            </span>
          </div>
          {/* Straight after the bars, so Tab from a bar lands on its first ticket. */}
          {open && (
            <BucketTip
              bucket={open}
              id={tipId}
              position={position}
              tipRef={tipRef}
              onEnter={cancelHide}
              onLeave={hideSoon}
            />
          )}
          <div className="ov-axis" aria-hidden="true">
            <span>{first?.label}</span>
            <span>{last?.label}</span>
          </div>
        </div>
        {/* In a wrapper: a table ignores the clipping `.sr` relies on. */}
        <div className="sr">
          <table>
            <caption>Tickets completed per {unit}</caption>
            <thead>
              <tr>
                <th scope="col">{unit === 'hour' ? 'Hour' : 'Day'}</th>
                <th scope="col">Completed</th>
                <th scope="col">Tickets</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((b) => (
                <tr key={b.key}>
                  <th scope="row">{b.label}</th>
                  <td>{b.count}</td>
                  <td>{bucketTicketsText(b)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}
