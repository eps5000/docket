import type { BurndownResponse } from '@docket/shared';
import { describe, expect, it } from 'vitest';
import {
  zonedNow,
  barText,
  burndownEmpty,
  burndownGeometry,
  burndownRows,
  burndownSummary,
  changeText,
  dayLabel,
  describeRow,
  forecastLine,
  niceMax,
  plannedTitle,
  weekStarts,
  type TimelineRow,
} from './timelineModel';

const row = (patch: Partial<TimelineRow> = {}): TimelineRow => ({
  id: 'RCP-16',
  title: 'Shopping list',
  type: 'Implementation',
  project: 'RCP',
  status: 'ready',
  blocked: true,
  planned_start: '2026-11-09',
  planned_end: '2026-11-14',
  dates_set_by: 'owner',
  actual_start: null,
  actual_end: null,
  overdue: false,
  blockers: [{ id: 'DOC-4', planned_end: '2026-11-10', risky: true }],
  ...patch,
});

const noForecast = {
  available: false as const,
  reason: 'No forecast yet: needs 8 completed items with effort (have 2)',
  have: 2,
};
const forecast = {
  available: true as const,
  p50: '2026-11-24',
  p85: '2026-12-03',
  rate_per_week: 6.2,
  window_weeks: 4,
  n: 11,
  excludes_unestimated: 2,
};

function burndown(patch: Partial<BurndownResponse> = {}): BurndownResponse {
  return {
    series: [
      { date: '2026-11-14', remaining: 8 },
      { date: '2026-11-15', remaining: 11 },
      { date: '2026-11-16', remaining: 6 },
    ],
    additions: [{ date: '2026-11-15', item_id: 'RCP-31', effort: 3 }],
    open_effort: 6,
    not_estimated: 2,
    window_days: 28,
    forecast: noForecast,
    ...patch,
  };
}

describe('timeline rows', () => {
  it('labels days without shifting time zones', () => {
    expect(dayLabel('2026-11-24')).toBe('Nov 24');
    expect(dayLabel('2026-12-03')).toBe('Dec 3');
  });

  it('puts who set the dates in the hover text only', () => {
    expect(plannedTitle(row())).toBe('Planned Nov 9 → Nov 14 · set by owner');
    expect(barText(row())).not.toMatch(/set by/);
  });

  it('bar text: risk, then overdue, then done, then blocked', () => {
    expect(barText(row())).toBe('⚠ blocker ends later');
    expect(barText(row({ blockers: [], overdue: true }))).toBe('overdue');
    expect(barText(row({ blockers: [], status: 'done', blocked: false }))).toBe('✓ done');
    expect(barText(row({ blockers: [] }))).toBe('⊘ blocked');
    expect(barText(row({ blockers: [], blocked: false }))).toBe('');
  });

  it('describes a row for screen readers, with the risky blocker named', () => {
    expect(describeRow(row({ actual_start: '2026-11-09' }))).toBe(
      'Planned Nov 9 → Nov 14 · set by owner; actual Nov 9 → now; blocker ends later; after DOC-4 ends Nov 10 (date risk).',
    );
  });

  it('weeks run Monday to Monday across the range', () => {
    expect(weekStarts('2026-11-02', '2026-11-29')).toEqual([
      '2026-11-02',
      '2026-11-09',
      '2026-11-16',
      '2026-11-23',
    ]);
  });
});

describe('forecast line', () => {
  it('says what is missing, as a sentence', () => {
    expect(forecastLine(noForecast)).toBe(
      'No forecast yet: needs 8 completed items with effort (have 2).',
    );
  });

  it('shows P50 and P85, the rate, n and the unestimated count', () => {
    expect(forecastLine(forecast)).toBe(
      'Forecast: P50 Nov 24 – P85 Dec 3 · 6.2 pts/wk over the last 4 weeks · n=11 · excludes 2 unestimated items',
    );
    expect(forecastLine({ ...forecast, excludes_unestimated: 1 })).toMatch(
      /excludes 1 unestimated item$/,
    );
  });
});

describe('burn-down table and chart', () => {
  it('rows: date, remaining and the change, with additions named', () => {
    expect(burndownRows(burndown())).toEqual([
      { date: '2026-11-14', remaining: 8, change: null, added: [] },
      { date: '2026-11-15', remaining: 11, change: 3, added: ['+3 pts: RCP-31 added'] },
      { date: '2026-11-16', remaining: 6, change: -5, added: [] },
    ]);
    expect(changeText(null)).toBe('—');
    expect(changeText(3)).toBe('+3');
    expect(changeText(-5)).toBe('−5');
  });

  it('the summary sentence', () => {
    expect(burndownSummary(burndown())).toBe(
      'Remaining effort went from 8 pts on Nov 14 to 6 pts today, with 1 scope addition; 2 not estimated. No forecast yet: needs 8 completed items with effort (have 2).',
    );
  });

  it('is empty only when nothing in scope is or was estimated', () => {
    expect(burndownEmpty(burndown())).toBe(false);
    expect(
      burndownEmpty(burndown({ open_effort: 0, series: [{ date: '2026-11-16', remaining: 0 }] })),
    ).toBe(true);
    expect(
      burndownEmpty(burndown({ open_effort: 0, series: [{ date: '2026-11-15', remaining: 2 }] })),
    ).toBe(false);
  });

  it('a step line from 0 up, an up-tick per addition, and space to the P85 date', () => {
    const g = burndownGeometry(burndown(), 640);
    expect(g.path.startsWith('M')).toBe(true);
    expect(g.path.match(/V/g)).toHaveLength(2);
    expect(g.ticks[0]!.value).toBe(0);
    expect(g.ticks.at(-1)!.value).toBeGreaterThanOrEqual(11);
    expect(g.additions).toHaveLength(1);
    expect(g.additions[0]!.title).toBe('+3 pts: RCP-31 added');
    expect(g.forecast).toBeNull();
    // Without a forecast, today's step ends at the right edge.
    expect(g.today).toBeCloseTo(g.plot.right);

    const f = burndownGeometry(burndown({ forecast }), 640);
    expect(f.forecast).not.toBeNull();
    expect(f.today).toBeLessThan(f.forecast!.p50);
    expect(f.forecast!.p50).toBeLessThan(f.forecast!.p85);
    expect(f.forecast!.p85).toBeCloseTo(f.plot.right);
  });

  it('round axis maxima', () => {
    expect(niceMax(0)).toEqual({ max: 1, step: 1 });
    expect(niceMax(11)).toEqual({ max: 15, step: 5 });
    expect(niceMax(37)).toEqual({ max: 40, step: 10 });
  });
});

describe('zonedNow (B18: the Now line uses the server zone)', () => {
  // 2026-11-16 04:30 UTC is still Nov 15 in Chicago and already Nov 16 in Tokyo.
  const at = new Date('2026-11-16T04:30:00Z');
  it('gives the day and the fraction of it in the given zone', () => {
    expect(zonedNow(at, 'UTC')).toEqual({ day: '2026-11-16', fraction: 4.5 / 24 });
    expect(zonedNow(at, 'America/Chicago')).toEqual({ day: '2026-11-15', fraction: 22.5 / 24 });
    expect(zonedNow(at, 'Asia/Tokyo')).toEqual({ day: '2026-11-16', fraction: 13.5 / 24 });
  });
  it('falls back to the browser zone for an unknown zone', () => {
    expect(zonedNow(at, 'Not/AZone')).toEqual(zonedNow(at));
  });
});
