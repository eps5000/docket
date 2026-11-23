import type { OverviewResponse } from '@docket/shared';
import { Card, CardHeader } from '../../components/kit';
import { plural } from '../../lib/format';
import { axisTicks } from './CompletedChart';
import { useChartTip } from './useChartTip';

type Flow = OverviewResponse['flow'];
type Bucket = Flow['buckets'][number];
type Metric = 'finished' | 'merged' | 'parked';

const METRICS: readonly { key: Metric; name: string }[] = [
  { key: 'finished', name: 'Finished' },
  { key: 'merged', name: 'Merged' },
  { key: 'parked', name: 'Parked' },
];

const hasData = (b: Bucket) => b.finished + b.merged + b.parked > 0;

/** What the three panels say, in one sentence. */
export function flowSummary(flow: Flow): string {
  if (flow.finished + flow.merged + flow.parked === 0) {
    return 'Nothing finished, merged or parked in this window.';
  }
  return `${plural(flow.finished, 'ticket')} finished, ${plural(flow.merged, 'PR')} merged, parked ${plural(flow.parked, 'time')}.`;
}

/** Merged is only what Docket has on record, and this line says so. */
export function mergedNote(flow: Flow): string {
  const base = 'Merged counts only PRs an agent recorded in Docket.';
  if (flow.finished_without_merge === 0) return base;
  return `${base} ${flow.finished_without_merge} of ${plural(flow.finished, 'finished ticket')} ${flow.finished_without_merge === 1 ? 'has' : 'have'} none recorded, so the real number may be higher.`;
}

export const bucketText = (b: Bucket) =>
  `${b.label}: ${b.finished} finished, ${b.merged} merged, ${b.parked} parked`;

/**
 * Flow trends (owner decision 48): finished, merged and parked as three small
 * panels over one time axis. Each has its own whole-number scale, because parks
 * can outnumber finished tickets fifty to one and would flatten them on a shared
 * one. Each time slot is a single button across the panels, so one tooltip reads
 * all three. Assistive tech gets the summary and a table of the same values.
 */
export function FlowChart({ flow }: { flow: Flow }) {
  const unit = flow.granularity === 'hour' ? 'hour' : 'day';
  const { buckets } = flow;
  const { tipId, hintId, rootRef, tipRef, open, position, cancelHide, hideSoon, onBlur, barProps } =
    useChartTip(buckets, hasData);
  const first = buckets[0];
  const last = buckets.at(-1);
  return (
    <Card data-card="flow-chart" className="ov-chart">
      <CardHeader title={`Flow per ${unit}`} />
      <div className="ov-chart-body">
        <p className="src">{flowSummary(flow)}</p>
        {flow.note && (
          <p className="ov-flow-note" data-flow-note>
            {flow.note}
          </p>
        )}
        <div className="ov-flow" ref={rootRef} onBlur={onBlur}>
          {METRICS.map((m, row) => {
            const top = axisTicks(Math.max(0, ...buckets.map((b) => b[m.key]))).at(-1)!;
            const gridRow = row + 1;
            return (
              <div key={m.key} className="ov-flow-row" aria-hidden="true">
                <span className="ov-flow-name" style={{ gridRow }}>
                  {m.name} <b>{flow[m.key]}</b>
                </span>
                <span className="ov-flow-y" style={{ gridRow }}>
                  <span>{top}</span>
                  <span>0</span>
                </span>
                <span className="ov-flow-bars" style={{ gridRow }} data-flow-panel={m.key}>
                  {buckets.map((b) => (
                    <span key={b.key}>
                      {b[m.key] > 0 && <i style={{ height: `${(b[m.key] / top) * 100}%` }} />}
                    </span>
                  ))}
                </span>
              </div>
            );
          })}
          <div
            className="ov-flow-hits"
            role="group"
            aria-label={`Finished, merged and parked, one button per ${unit}`}
            aria-describedby={hintId}
          >
            {buckets.map((b, index) => (
              <button
                key={b.key}
                {...barProps(b, index)}
                className="ov-flow-hit"
                data-flow-bar={b.key}
                aria-label={bucketText(b)}
              />
            ))}
          </div>
          <span id={hintId} className="sr">
            Left and right arrow keys move between {unit}s, and Escape closes the details.
          </span>
          {open && (
            <div
              id={tipId}
              ref={tipRef}
              className="ov-tip"
              role="group"
              aria-label={bucketText(open)}
              data-flow-tip={open.key}
              style={position ?? { left: 0, top: 0, visibility: 'hidden' }}
              onMouseEnter={cancelHide}
              onMouseLeave={hideSoon}
            >
              <p className="ov-tip-h">
                <b>{open.label}</b>
              </p>
              <dl className="ov-flow-tip">
                {METRICS.map((m) => (
                  <div key={m.key}>
                    <dt>{m.name}</dt>
                    <dd>{open[m.key]}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
          <div className="ov-flow-axis" aria-hidden="true">
            <span>{first?.label}</span>
            <span>{last?.label}</span>
          </div>
        </div>
        <p className="src ov-flow-merged" data-flow-merged>
          {mergedNote(flow)}
        </p>
        {/* In a wrapper: a table ignores the clipping `.sr` relies on. */}
        <div className="sr">
          <table>
            <caption>Tickets finished, PRs merged and times parked per {unit}</caption>
            <thead>
              <tr>
                <th scope="col">{unit === 'hour' ? 'Hour' : 'Day'}</th>
                {METRICS.map((m) => (
                  <th key={m.key} scope="col">
                    {m.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {buckets.map((b) => (
                <tr key={b.key}>
                  <th scope="row">{b.label}</th>
                  {METRICS.map((m) => (
                    <td key={m.key}>{b[m.key]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}
