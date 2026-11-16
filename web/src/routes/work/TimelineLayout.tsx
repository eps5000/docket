import { Fragment, type CSSProperties } from 'react';
import { Link } from 'react-router';
import type { Timeline } from '@tasklite/shared';
import { Card, EmptyState, TypeIcon } from '../../components/kit';
import { useBootstrap } from '../../app/useBootstrap';
import { paths } from '../../lib/paths';
import { BurndownCard } from './BurndownCard';
import {
  addDays,
  barText,
  dayLabel,
  daysBetween,
  datedBlockers,
  describeRow,
  forecastAssumptions,
  forecastLine,
  forecastRange,
  isRisky,
  localNow,
  plannedSpan,
  plannedTitle,
  weekStarts,
  type TimelineRow,
} from './timelineModel';
import './timeline.css';

/**
 * Timeline (UI_SPEC §6.2.4, §9.1): the burn-down card above the week grid;
 * per row an entered-plan bar (who set the dates shows on hover only), the
 * actual-time line, blocker ticks and the risk text; a red Now line; a
 * forecast lane per project; the legend; and "Not on the timeline (no
 * dates)". Forecasts never move planned bars.
 */
export function TimelineLayout({
  timeline,
  epic,
  label,
}: {
  timeline: Timeline | null;
  epic?: string;
  label?: string;
}) {
  const boot = useBootstrap();
  const shortName = (key: string) =>
    boot.data?.projects.find((p) => p.key === key)?.short_name ?? key;
  if (!timeline) return null;
  const { from, to, rows } = timeline;
  const span = Math.max(1, daysBetween(from, to) + 1);
  const pct = (day: string) => (daysBetween(from, day) / span) * 100;
  const now = localNow();
  const nowX = ((daysBetween(from, now.day) + now.fraction) / span) * 100;
  const nowShown = nowX >= 0 && nowX <= 100;
  const weeks = weekStarts(from, to);

  return (
    <div className="stack" data-layout="timeline">
      <BurndownCard epic={epic} label={label} />
      <Card data-card="timeline-grid" className="tline">
        <div className="tline-scroll">
          <div className="tline-inner" role="table" aria-label="Timeline">
            <div className="tl-row tl-weeks" role="row">
              <div className="lbl" role="columnheader">
                <span className="sr">Item</span>
              </div>
              <div
                className="weeks"
                role="columnheader"
                style={{ gridTemplateColumns: `repeat(${weeks.length}, 1fr)` }}
              >
                <span className="sr">
                  Plan, {dayLabel(from)} to {dayLabel(to)}
                </span>
                {weeks.map((w) => (
                  <div className="w" key={w} aria-hidden="true">
                    <span>{dayLabel(w)}</span>
                  </div>
                ))}
              </div>
            </div>
            {rows.map((r) => (
              <TimelineRowView key={r.id} row={r} pct={pct} nowX={nowShown ? nowX : null} />
            ))}
            {timeline.forecasts.map(({ project, forecast }) => (
              <div className="tl-row lane" role="row" key={project} data-forecast-lane={project}>
                <div className="lbl" role="rowheader">
                  <b>Forecast · {shortName(project)} backlog</b>
                </div>
                <div className="track" role="cell">
                  {forecast.available ? (
                    <>
                      <span className="sr">
                        {forecastRange(forecast)}; {forecastAssumptions(forecast)}.
                      </span>
                      <div
                        className="bar forecast"
                        aria-hidden="true"
                        style={span2(pct(forecast.p50), pct(addDays(forecast.p85, 1)))}
                      >
                        {forecastRange(forecast)}
                      </div>
                      <div
                        className="under"
                        aria-hidden="true"
                        style={{ left: `calc(${clamp(pct(forecast.p50))}% + 1px)` }}
                      >
                        {forecastAssumptions(forecast)}
                      </div>
                    </>
                  ) : (
                    <div className="lane-none">{forecastLine(forecast)}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
        {rows.length === 0 && (
          <div className="pad" style={{ paddingTop: 0 }}>
            <EmptyState text="Nothing has planned dates in this view." />
          </div>
        )}
        <div className="pad tline-foot">
          <div className="legend" aria-label="Legend" role="group">
            <span>
              <span className="swatch sw-planned" aria-hidden="true" />
              Entered plan
            </span>
            <span>
              <span className="swatch sw-actual" aria-hidden="true" />
              Actual
            </span>
            <span>
              <span className="swatch sw-forecast" aria-hidden="true" />
              Forecast
            </span>
            <span>
              <span className="swatch sw-dep" aria-hidden="true" />
              Blocker’s planned end
            </span>
            <span>
              <span className="swatch sw-now" aria-hidden="true" />
              Now
            </span>
          </div>
          <div className="src" data-undated="">
            Not on the timeline (no dates):{' '}
            {timeline.undated.length === 0
              ? 'none'
              : timeline.undated.map((id, i) => (
                  <Fragment key={id}>
                    {i > 0 && ', '}
                    <Link to={paths.item(id)} className="mono">
                      {id}
                    </Link>
                  </Fragment>
                ))}
          </div>
        </div>
      </Card>
    </div>
  );
}

const clamp = (x: number) => Math.min(100, Math.max(0, x));

/** left/width for a bar from `a`% to `b`%, kept inside the track. */
function span2(a: number, b: number): CSSProperties {
  const l = clamp(a);
  return { left: `${l}%`, width: `${Math.max(0.6, clamp(b) - l)}%` };
}

function TimelineRowView({
  row,
  pct,
  nowX,
}: {
  row: TimelineRow;
  pct: (day: string) => number;
  nowX: number | null;
}) {
  const { start, end } = plannedSpan(row);
  const risky = isRisky(row);
  const done = row.status === 'done';
  const text = barText(row);
  const deps = datedBlockers(row);
  const endX = (day: string) => pct(addDays(day, 1));
  const actualEnd = row.actual_end ? endX(row.actual_end) : nowX;
  const cls = ['bar', 'planned', risky && 'risk', done && 'done'].filter(Boolean).join(' ');
  return (
    <div className="tl-row" role="row" data-row={row.id}>
      <div className="lbl" role="rowheader">
        <TypeIcon type={row.type} />
        <Link to={paths.item(row.id)} className="mono">
          {row.id}
        </Link>
        <span className="t" title={row.title}>
          {row.title}
        </span>
      </div>
      <div className="track" role="cell">
        <span className="sr">{describeRow(row)}</span>
        {nowX !== null && <div className="now" aria-hidden="true" style={{ left: `${nowX}%` }} />}
        {deps.map((b) => (
          <div
            key={b.id}
            className={b.risky ? 'dep risk' : 'dep'}
            aria-hidden="true"
            data-dep={b.id}
            style={{ left: `${clamp(endX(b.planned_end))}%` }}
            title={`${b.id} planned to finish ${dayLabel(b.planned_end)}`}
          />
        ))}
        <div
          className={cls}
          aria-hidden="true"
          data-bar="planned"
          title={plannedTitle(row)}
          style={span2(pct(start), endX(end))}
        >
          {text}
        </div>
        {row.actual_start && actualEnd !== null && (
          <div
            className="bar actual"
            aria-hidden="true"
            data-bar="actual"
            title={`Actual ${dayLabel(row.actual_start)} → ${row.actual_end ? dayLabel(row.actual_end) : 'now'}`}
            style={span2(pct(row.actual_start), actualEnd)}
          />
        )}
        {deps.length > 0 && (
          <div
            className="under"
            aria-hidden="true"
            data-after=""
            style={{ left: `calc(${clamp(pct(start))}% + 1px)` }}
          >
            after{' '}
            {deps.map((b, i) => (
              <Fragment key={b.id}>
                {i > 0 && ', '}
                {b.risky ? (
                  <b className="risk">
                    {b.id} ends {dayLabel(b.planned_end)}
                  </b>
                ) : (
                  `${b.id} ends ${dayLabel(b.planned_end)}`
                )}
              </Fragment>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
