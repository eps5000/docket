import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { BurndownResponse } from '@tasklite/shared';
import { Button, Card, CardHeader, EmptyState, Skeleton } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { QueryState } from '../../app/QueryState';
import { useShell } from '../../app/ShellState';
import { queryKeys } from '../../lib/api';
import {
  burndownEmpty,
  burndownGeometry,
  burndownRows,
  burndownSummary,
  changeText,
  dayLabel,
  forecastLine,
} from './timelineModel';
import './timeline.css';

/**
 * Remaining effort (UI_SPEC §9.1): the burn-down card above the Timeline
 * grid, scoped by the same Epic and Label filters, otherwise the project
 * scope. A hand-built SVG step chart (180px, tokens only, both themes) with
 * scope additions as up-ticks, a Today line and the forecast band; one line
 * of forecast under it; an sr-only summary and *Show as table*.
 */
export function BurndownCard({ epic, label }: { epic?: string; label?: string }) {
  const { scope } = useShell();
  const query = useQuery({
    queryKey: queryKeys.burndown({ scope, epic, label }),
    queryFn: () => apiClient['burndown.get']({ query: { scope, epic, label } }),
  });
  const [table, setTable] = useState(false);
  const d = query.data;
  return (
    <Card data-card="burndown">
      <CardHeader
        title="Remaining effort"
        extra={
          d && (
            <span className="src" data-burndown-summary="">
              {d.open_effort} pts open · {d.not_estimated} not estimated · last 4 weeks
            </span>
          )
        }
      />
      <div className="pad" style={{ paddingTop: 0 }}>
        <QueryState
          query={query}
          skeleton={<Skeleton lines={1} tall={1} label="Loading burn-down" />}
        >
          {(data) =>
            burndownEmpty(data) ? (
              <EmptyState text="No estimated work in this view. Agents set effort with update_item." />
            ) : (
              <>
                <p className="sr" data-burndown-sr="">
                  {burndownSummary(data)}
                </p>
                <BurndownChart data={data} />
                <div className="bd-foot">
                  <span className="src" data-forecast-line="">
                    {forecastLine(data.forecast)}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-expanded={table}
                    onClick={() => setTable((t) => !t)}
                  >
                    {table ? 'Hide table' : 'Show as table'}
                  </Button>
                </div>
                {table && <BurndownTable data={data} />}
              </>
            )
          }
        </QueryState>
      </div>
    </Card>
  );
}

/** Width of the element, following resizes (a fixed fallback without ResizeObserver). */
function useWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w > 0) setWidth(w);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function BurndownChart({ data }: { data: BurndownResponse }) {
  const [ref, width] = useWidth(800);
  const g = burndownGeometry(data, width);
  const f = data.forecast.available ? data.forecast : null;
  return (
    <div ref={ref} className="bd-chart" data-burndown-chart="">
      {/* The summary sentence and the table carry the content; the drawing is decorative for AT. */}
      <svg width={g.width} height={g.height} aria-hidden="true" focusable="false">
        {g.ticks.map((t) => (
          <g key={t.value}>
            <line className="bd-grid" x1={g.plot.left} x2={g.plot.right} y1={t.y} y2={t.y} />
            <text className="bd-axis" x={g.plot.left - 6} y={t.y + 4} textAnchor="end">
              {t.value}
            </text>
          </g>
        ))}
        {g.forecast && f && (
          <g data-forecast-band="">
            <rect
              className="bd-band"
              x={g.today}
              y={g.plot.top}
              width={Math.max(0, g.forecast.p85 - g.today)}
              height={g.plot.bottom - g.plot.top}
            />
            <line
              className="bd-p"
              x1={g.forecast.p50}
              x2={g.forecast.p50}
              y1={g.plot.top}
              y2={g.plot.bottom}
            />
            <line
              className="bd-p"
              x1={g.forecast.p85}
              x2={g.forecast.p85}
              y1={g.plot.top}
              y2={g.plot.bottom}
            />
            <text className="bd-label" x={g.forecast.p50 - 4} y={g.plot.top + 10} textAnchor="end">
              P50 {dayLabel(f.p50)}
            </text>
            <text className="bd-label" x={g.forecast.p85 - 4} y={g.plot.top + 24} textAnchor="end">
              P85 {dayLabel(f.p85)}
            </text>
          </g>
        )}
        <line
          className="bd-today"
          x1={g.today}
          x2={g.today}
          y1={g.plot.top - 4}
          y2={g.plot.bottom}
        />
        <path className="bd-line" d={g.path} data-burndown-line="" />
        {g.additions.map((a, i) => (
          <g key={i} className="bd-add" data-addition="">
            <title>{a.title}</title>
            <line x1={a.x} x2={a.x} y1={a.y} y2={a.y - 9} />
            <path d={`M${a.x - 3.5},${a.y - 6} L${a.x},${a.y - 11} L${a.x + 3.5},${a.y - 6}`} />
          </g>
        ))}
        <line
          className="bd-grid"
          x1={g.plot.left}
          x2={g.plot.right}
          y1={g.plot.bottom}
          y2={g.plot.bottom}
        />
        {g.labels.map((l) => (
          <text
            key={l.text}
            className="bd-axis"
            x={l.x}
            y={g.height - 6}
            textAnchor={l.text === 'Today' ? 'middle' : 'start'}
          >
            {l.text}
          </text>
        ))}
      </svg>
    </div>
  );
}

function BurndownTable({ data }: { data: BurndownResponse }) {
  return (
    <div
      className="bd-table"
      id="burndown-table"
      role="region"
      aria-label="Remaining effort table"
      // Scrolls when tall: focusable so the keyboard can scroll it (UI_SPEC §11).
      tabIndex={0}
    >
      <table>
        <caption className="sr">Remaining effort per day</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Remaining</th>
            <th scope="col">Change</th>
          </tr>
        </thead>
        <tbody>
          {burndownRows(data).map((r) => (
            <tr key={r.date}>
              <td>{dayLabel(r.date)}</td>
              <td>{r.remaining} pts</td>
              <td>
                {changeText(r.change)}
                {r.added.length > 0 && <span className="src"> · {r.added.join(', ')}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
