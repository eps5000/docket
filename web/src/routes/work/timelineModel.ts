/**
 * Pure helpers for Work → Timeline and the burn-down card (UI_SPEC §6.2.4,
 * §9.1): day arithmetic on `YYYY-MM-DD`, the words on bars, the forecast
 * line, the burn-down table and the chart's geometry. Kept apart from the
 * components so they can be unit tested without a DOM.
 */
import type { BurndownResponse, Forecast, Timeline } from '@tasklite/shared';

export type TimelineRow = Timeline['rows'][number];

const DAY = 86_400_000;
const dayMs = (date: string) => Date.parse(`${date}T00:00:00Z`);
export const addDays = (date: string, n: number): string =>
  new Date(dayMs(date) + n * DAY).toISOString().slice(0, 10);
/** Whole days from `a` to `b`. */
export const daysBetween = (a: string, b: string): number =>
  Math.round((dayMs(b) - dayMs(a)) / DAY);

const MONTH_DAY = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

/** "Nov 24" for a calendar day (no time zone shift). */
export function dayLabel(date: string): string {
  return MONTH_DAY.format(new Date(dayMs(date)));
}

/** Today in the browser's local time, and how far through it we are (0–1). */
export function localNow(now: Date = new Date()): { day: string; fraction: number } {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const midnight = new Date(y, now.getMonth(), now.getDate()).getTime();
  return { day: `${y}-${m}-${d}`, fraction: (now.getTime() - midnight) / DAY };
}

// ---- Timeline ----

/** A row's bar: start and end days, either date standing in for a missing one. */
export function plannedSpan(row: TimelineRow): { start: string; end: string } {
  const start = (row.planned_start ?? row.planned_end)!;
  const end = (row.planned_end ?? row.planned_start)!;
  return { start, end };
}

export const isRisky = (row: TimelineRow): boolean => row.blockers.some((b) => b.risky);

/** The text on the planned bar (UI_SPEC §6.2.4), most urgent first. */
export function barText(row: TimelineRow): string {
  if (isRisky(row)) return '⚠ blocker ends later';
  if (row.overdue) return 'overdue';
  if (row.status === 'done') return '✓ done';
  if (row.blocked) return '⊘ blocked';
  return '';
}

/** The bar's hover text: "Planned Nov 4 → Nov 11 · set by claude". */
export function plannedTitle(row: TimelineRow): string {
  const { start, end } = plannedSpan(row);
  const by = row.dates_set_by ? ` · set by ${row.dates_set_by}` : '';
  return `Planned ${dayLabel(start)} → ${dayLabel(end)}${by}`;
}

/** Blockers with a planned end, for the ticks and "after DOC-4 ends Nov 10". */
export function datedBlockers(row: TimelineRow) {
  return row.blockers.filter((b): b is typeof b & { planned_end: string } => !!b.planned_end);
}

/** One sentence for screen readers: the bar, the actual time, the risk and the blockers. */
export function describeRow(row: TimelineRow): string {
  const parts = [plannedTitle(row)];
  if (row.actual_start) {
    parts.push(
      `actual ${dayLabel(row.actual_start)} → ${row.actual_end ? dayLabel(row.actual_end) : 'now'}`,
    );
  }
  const text = barText(row);
  if (text) parts.push(text.replace(/^[⚠✓⊘] /, ''));
  const after = datedBlockers(row).map(
    (b) => `${b.id} ends ${dayLabel(b.planned_end)}${b.risky ? ' (date risk)' : ''}`,
  );
  if (after.length > 0) parts.push(`after ${after.join(', ')}`);
  return `${parts.join('; ')}.`;
}

/** Week starts (Mondays) from `from` to `to`. */
export function weekStarts(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 7)) out.push(d);
  return out;
}

// ---- Forecast ----

/** "P50 Nov 24 – P85 Dec 3". */
export function forecastRange(f: Extract<Forecast, { available: true }>): string {
  return `P50 ${dayLabel(f.p50)} – P85 ${dayLabel(f.p85)}`;
}

/** The assumptions: "6.2 pts/wk over the last 4 weeks · n=11 · excludes 2 unestimated items". */
export function forecastAssumptions(f: Extract<Forecast, { available: true }>): string {
  const unestimated =
    f.excludes_unestimated === 1
      ? '1 unestimated item'
      : `${f.excludes_unestimated} unestimated items`;
  return `${f.rate_per_week} pts/wk over the last ${f.window_weeks} weeks · n=${f.n} · excludes ${unestimated}`;
}

/** The line under the chart, or the reason there is no forecast yet. */
export function forecastLine(f: Forecast): string {
  if (!f.available) return /[.!?]$/.test(f.reason) ? f.reason : `${f.reason}.`;
  return `Forecast: ${forecastRange(f)} · ${forecastAssumptions(f)}`;
}

// ---- Burn-down ----

const pts = (n: number) => `${Math.round(n * 100) / 100} pts`;

export interface BurndownRow {
  date: string;
  remaining: number;
  /** Change from the day before; null on the first day. */
  change: number | null;
  /** "+3 pts: RCP-31 added". */
  added: string[];
}

export function additionText(a: BurndownResponse['additions'][number]): string {
  return `+${pts(a.effort)}: ${a.item_id} added`;
}

/** The *Show as table* rows: date, remaining, change (UI_SPEC §9.1). */
export function burndownRows(data: BurndownResponse): BurndownRow[] {
  return data.series.map((p, i) => ({
    date: p.date,
    remaining: p.remaining,
    change: i === 0 ? null : Math.round((p.remaining - data.series[i - 1]!.remaining) * 100) / 100,
    added: data.additions.filter((a) => a.date === p.date).map(additionText),
  }));
}

export function changeText(change: number | null): string {
  if (change === null || change === 0) return '—';
  return change > 0 ? `+${change}` : `−${Math.abs(change)}`;
}

/** Nothing estimated in scope, now or in the window. */
export const burndownEmpty = (data: BurndownResponse): boolean =>
  data.open_effort === 0 && data.series.every((p) => p.remaining === 0);

/** The sr-only summary sentence. */
export function burndownSummary(data: BurndownResponse): string {
  const first = data.series[0];
  const start = first ? `from ${pts(first.remaining)} on ${dayLabel(first.date)} ` : '';
  const adds =
    data.additions.length === 0
      ? 'no scope additions'
      : data.additions.length === 1
        ? '1 scope addition'
        : `${data.additions.length} scope additions`;
  return `Remaining effort went ${start}to ${pts(data.open_effort)} today, with ${adds}; ${data.not_estimated} not estimated. ${forecastLine(data.forecast)}`;
}

export interface ChartGeometry {
  width: number;
  height: number;
  plot: { left: number; right: number; top: number; bottom: number };
  /** The step line of remaining effort. */
  path: string;
  /** Y axis ticks. */
  ticks: { y: number; value: number }[];
  today: number;
  additions: { x: number; y: number; title: string }[];
  forecast: { p50: number; p85: number } | null;
  /** X axis labels. */
  labels: { x: number; text: string }[];
}

/** A round axis maximum: 1, 2, 5 × 10ⁿ steps, at least 1. */
export function niceMax(value: number): { max: number; step: number } {
  if (value <= 0) return { max: 1, step: 1 };
  const rough = value / 4;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= rough)!;
  return { max: Math.ceil(value / step) * step, step };
}

/**
 * The chart's geometry (UI_SPEC §9.1): X is days, the last 28 plus space to
 * the P85 date; Y is points from 0. Each day's value is drawn as a step that
 * holds until the next day.
 */
export function burndownGeometry(
  data: BurndownResponse,
  width: number,
  height = 180,
): ChartGeometry {
  const plot = { left: 40, right: width - 16, top: 14, bottom: height - 24 };
  const first = data.series[0]?.date ?? addDays(new Date().toISOString().slice(0, 10), -27);
  const today = data.series.at(-1)?.date ?? addDays(first, 27);
  const last =
    data.forecast.available && data.forecast.p85 > today
      ? addDays(data.forecast.p85, 1)
      : addDays(today, 1);
  const span = Math.max(1, daysBetween(first, last));
  const x = (day: string) =>
    plot.left + (daysBetween(first, day) / span) * (plot.right - plot.left);
  const top = Math.max(0, ...data.series.map((p) => p.remaining));
  const { max, step } = niceMax(top);
  const y = (v: number) => plot.bottom - (v / max) * (plot.bottom - plot.top);

  let path = '';
  data.series.forEach((p, i) => {
    const x0 = x(p.date);
    const x1 = x(addDays(p.date, 1));
    path += i === 0 ? `M${x0},${y(p.remaining)}` : `V${y(p.remaining)}`;
    path += `H${x1}`;
  });

  const ticks: ChartGeometry['ticks'] = [];
  for (let v = 0; v <= max + 1e-9; v += step)
    ticks.push({ y: y(v), value: Math.round(v * 100) / 100 });

  const byDay = new Map(data.series.map((p) => [p.date, p.remaining]));
  const additions = data.additions.map((a) => ({
    x: x(a.date),
    y: y(byDay.get(a.date) ?? 0),
    title: additionText(a),
  }));

  // Days are drawn as whole days, so "Today" and the P dates sit at the end of their day.
  const end = (day: string) => x(addDays(day, 1));
  const labels = [
    { x: x(first), text: dayLabel(first) },
    { x: end(today), text: 'Today' },
  ];
  const forecast = data.forecast.available
    ? { p50: end(data.forecast.p50), p85: end(data.forecast.p85) }
    : null;
  return { width, height, plot, path, ticks, today: end(today), additions, forecast, labels };
}
