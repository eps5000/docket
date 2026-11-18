/**
 * Dates, effort and the forecast (BUILD_SPEC §5.9; spec US8, FR-080–FR-082;
 * tasks.md T134).
 *
 * - Date risk: an item's planned start falls on or before an unresolved
 *   blocker's planned end. The timeline and Problems use the same test.
 * - Burn-down: remaining effort at the end of each local day, replayed from
 *   events (not the current state), with scope additions marked and
 *   unestimated items counted, never as zero.
 * - Forecast thresholds: at least 8 estimated items done in the last 4 full
 *   weeks, across at least 2 weeks; otherwise it says what is missing.
 * - Monte Carlo: 10,000 trials, P50 and P85, deterministic under a seeded RNG.
 * - Planned dates are never changed by any of it.
 * - Scale: the replay reads only the window's events (100,000 events).
 */
import type { Status } from '@docket/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BURNDOWN_DAYS,
  effectiveZone,
  FORECAST_TRIALS,
  forecastOf,
  localDay,
  monteCarloDays,
  mulberry32,
  type Completion,
} from '../../src/domain/forecast.js';
import { OWNER_ACTOR, type Actor } from '../../src/domain/write.js';
import { addProject, startDomain, type Domain } from '../us1-helpers.js';

const DAY = 86_400_000;
const NOV_16 = '2026-11-16T12:00:00Z';
let d: Domain;
let claude: Actor;

function at(iso: string): void {
  d.clock.current = new Date(iso);
}

function create(
  title: string,
  opts: {
    effort?: number;
    epic?: string;
    labels?: string[];
    type?: 'Task' | 'Story' | 'Epic';
    start?: string;
    end?: string;
    project?: string;
  } = {},
): string {
  return d.write(claude, (w, s) =>
    s.items.create(w, {
      project: opts.project ?? 'TST',
      type: opts.type ?? 'Task',
      title,
      priority: 2,
      status: 'planning',
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
      ...(opts.epic ? { epic: opts.epic } : {}),
      ...(opts.labels ? { labels: opts.labels } : {}),
      ...(opts.start ? { planned_start: opts.start } : {}),
      ...(opts.end ? { planned_end: opts.end } : {}),
    }),
  ).id;
}

function move(id: string, status: Status, reason?: string): void {
  d.write(claude, (w, s) => s.items.setStatus(w, { id, status, reason }));
}

function start(id: string): void {
  move(id, 'ready');
  move(id, 'progress');
}

function finish(id: string): void {
  start(id);
  move(id, 'done');
}

function update(id: string, fields: Record<string, unknown>): void {
  const v = d.row<{ version: number }>('SELECT version FROM items WHERE id = ?', id).version;
  d.write(claude, (w, s) => s.items.update(w, { id, expected_version: v, ...fields }));
}

function link(from: string, to: string): void {
  d.write(claude, (w, s) => s.links.link(w, { from, to, type: 'blocks' }));
}

const burndown = (q: { scope?: string; epic?: string; label?: string } = {}) =>
  d.services.forecast.burndown(d.read(OWNER_ACTOR), { scope: q.scope ?? 'TST', ...q } as never);

const timeline = (q: { scope?: string; epic?: string; label?: string } = {}) =>
  d.services.forecast.timeline(d.read(OWNER_ACTOR), {
    scope: q.scope ?? 'TST',
    filter: 'all',
    layout: 'timeline',
    ...q,
  } as never);

const series = (b: ReturnType<typeof burndown>) =>
  Object.fromEntries(b.series.map((p) => [p.date, p.remaining]));

beforeEach(() => {
  d = startDomain({ seed: false, env: { TZ: 'UTC' }, now: new Date('2026-10-01T10:00:00Z') });
  addProject(d, 'TST');
  addProject(d, 'OTH');
  claude = d.agent('claude');
});
afterEach(() => d.cleanup());

// ---- Date risk ----

describe('date risk', () => {
  it('flags an item planned to start on or before an unresolved blocker’s planned end, on the timeline and in Problems', () => {
    at('2026-11-02T09:00:00Z');
    const blocker = create('Schema', { start: '2026-11-02', end: '2026-11-10' });
    const risky = create('API', { start: '2026-11-09', end: '2026-11-12' });
    const sameDay = create('Docs', { start: '2026-11-10', end: '2026-11-12' });
    const safe = create('UI', { start: '2026-11-11', end: '2026-11-14' });
    link(blocker, risky);
    link(blocker, sameDay);
    link(blocker, safe);

    const rows = new Map(timeline().rows.map((r) => [r.id, r]));
    expect(rows.get(risky)!.blockers).toEqual([
      { id: blocker, planned_end: '2026-11-10', risky: true },
    ]);
    expect(rows.get(sameDay)!.blockers[0]!.risky).toBe(true);
    expect(rows.get(safe)!.blockers).toEqual([
      { id: blocker, planned_end: '2026-11-10', risky: false },
    ]);

    const problems = d.services.views
      .needsYou(d.read(OWNER_ACTOR), { scope: 'TST' })
      .problems.filter((p) => p.kind === 'date_risk')
      .map((p) => p.item_id)
      .sort();
    expect(problems).toEqual([risky, sameDay].sort());
  });

  it('a cleared blocker is no risk, and a blocker without a planned end is shown but not risky', () => {
    at('2026-11-02T09:00:00Z');
    const done = create('Done first', { start: '2026-11-02', end: '2026-11-10' });
    const undated = create('No dates');
    const item = create('Then this', { start: '2026-11-05', end: '2026-11-12' });
    link(done, item);
    link(undated, item);
    finish(done);
    const row = timeline().rows.find((r) => r.id === item)!;
    expect(row.blockers).toEqual([{ id: undated, planned_end: null, risky: false }]);
    expect(row.blocked).toBe(true);
  });
});

// ---- The timeline query ----

describe('the timeline', () => {
  it('rows carry planned dates with who set them, actual dates from status history, and overdue', () => {
    at('2026-11-02T09:00:00Z');
    const a = create('Started late', { start: '2026-11-02', end: '2026-11-04' });
    const b = create('Finished', { start: '2026-11-02', end: '2026-11-06' });
    at('2026-11-03T10:00:00Z');
    start(a);
    start(b);
    at('2026-11-05T15:00:00Z');
    move(b, 'done');
    at('2026-11-09T12:00:00Z');

    const t = timeline();
    const rows = new Map(t.rows.map((r) => [r.id, r]));
    expect(rows.get(a)).toMatchObject({
      planned_start: '2026-11-02',
      planned_end: '2026-11-04',
      dates_set_by: 'claude',
      actual_start: '2026-11-03',
      actual_end: null,
      overdue: true,
      status: 'progress',
    });
    expect(rows.get(b)).toMatchObject({
      actual_start: '2026-11-03',
      actual_end: '2026-11-05',
      overdue: false,
      status: 'done',
    });
    // The grid spans whole weeks, Monday to Sunday, and includes today.
    expect(t.from <= '2026-11-02').toBe(true);
    expect(t.to >= '2026-11-09').toBe(true);
    expect(new Date(`${t.from}T00:00:00Z`).getUTCDay()).toBe(1);
    expect(new Date(`${t.to}T00:00:00Z`).getUTCDay()).toBe(0);
  });

  it('lists undated open items, and leaves out epics, archived and canceled items', () => {
    at('2026-11-02T09:00:00Z');
    const epic = create('Epic', { type: 'Epic', start: '2026-11-02', end: '2026-11-30' });
    const dated = create('Dated', { start: '2026-11-03', end: '2026-11-04', epic });
    const undated = create('Undated', { epic });
    const canceled = create('Canceled', { start: '2026-11-03', end: '2026-11-04' });
    const archived = create('Archived', { start: '2026-11-03', end: '2026-11-04' });
    move(canceled, 'canceled', 'Not needed.');
    finish(archived);
    d.write(OWNER_ACTOR, (w, s) => s.archive.archive(w, { id: archived }));

    const t = timeline();
    expect(t.rows.map((r) => r.id)).toEqual([dated]);
    expect(t.undated).toEqual([undated]);
    // Scoped by epic and label like the burn-down.
    expect(timeline({ epic }).rows.map((r) => r.id)).toEqual([dated]);
    expect(timeline({ label: 'nothing-here' }).rows).toEqual([]);
  });

  it('has one forecast lane per project in scope', () => {
    expect(timeline().forecasts.map((f) => f.project)).toEqual(['TST']);
    expect(timeline({ scope: 'all' }).forecasts.map((f) => f.project)).toEqual(['OTH', 'TST']);
    expect(timeline().forecasts[0]!.forecast).toEqual({
      available: false,
      reason: 'No forecast yet: needs 8 completed items with effort (have 0)',
      have: 0,
    });
  });
});

// ---- Burn-down ----

describe('burn-down', () => {
  /**
   * Oct 1: A 5, B 3, C unestimated. Oct 25: A done. Nov 1: D 4 added.
   * Nov 5: B re-estimated 3 → 6. Nov 10: B canceled. Today Nov 16.
   */
  function history(): { a: string; b: string; c: string; dd: string } {
    at('2026-10-01T10:00:00Z');
    const a = create('A', { effort: 5 });
    const b = create('B', { effort: 3 });
    const c = create('C');
    at('2026-10-25T10:00:00Z');
    finish(a);
    at('2026-11-01T10:00:00Z');
    const dd = create('D', { effort: 4 });
    at('2026-11-05T10:00:00Z');
    update(b, { effort: 6 });
    at('2026-11-10T10:00:00Z');
    move(b, 'canceled', 'Out of scope.');
    at('2026-11-16T12:00:00Z');
    return { a, b, c, dd };
  }

  it('replays remaining effort per local day from events, not from the current state', () => {
    const { b, dd } = history();
    const bd = burndown();
    expect(bd.window_days).toBe(BURNDOWN_DAYS);
    expect(bd.series).toHaveLength(28);
    expect(bd.series[0]!.date).toBe('2026-10-20');
    expect(bd.series.at(-1)!.date).toBe('2026-11-16');
    const s = series(bd);
    expect(s['2026-10-20']).toBe(8);
    expect(s['2026-10-24']).toBe(8);
    expect(s['2026-10-25']).toBe(3);
    expect(s['2026-10-31']).toBe(3);
    expect(s['2026-11-01']).toBe(7);
    expect(s['2026-11-05']).toBe(10);
    expect(s['2026-11-09']).toBe(10);
    expect(s['2026-11-10']).toBe(4);
    expect(s['2026-11-16']).toBe(4);
    expect(bd.open_effort).toBe(4);
    // Scope additions: D created with effort, B re-estimated upwards.
    expect(bd.additions).toEqual([
      { date: '2026-11-01', item_id: dd, effort: 4 },
      { date: '2026-11-05', item_id: b, effort: 3 },
    ]);
  });

  it('counts unestimated open items separately, never as zero', () => {
    history();
    const bd = burndown();
    expect(bd.not_estimated).toBe(1);
    // C has no effort and adds nothing to the series.
    expect(Math.min(...bd.series.map((p) => p.remaining))).toBe(3);
  });

  it('marks a reopened item and an item moved into the scope as additions', () => {
    at('2026-10-01T10:00:00Z');
    const epic = create('Epic', { type: 'Epic' });
    const a = create('A', { effort: 2, epic });
    const b = create('B', { effort: 5 });
    at('2026-11-03T10:00:00Z');
    finish(a);
    at('2026-11-04T10:00:00Z');
    move(a, 'progress', 'Found a bug.');
    at('2026-11-06T10:00:00Z');
    update(b, { epic });
    at('2026-11-16T12:00:00Z');

    const bd = burndown({ epic });
    const s = series(bd);
    expect(s['2026-11-02']).toBe(2);
    expect(s['2026-11-03']).toBe(0);
    expect(s['2026-11-04']).toBe(2);
    expect(s['2026-11-06']).toBe(7);
    expect(bd.additions).toEqual([
      { date: '2026-11-04', item_id: a, effort: 2 },
      { date: '2026-11-06', item_id: b, effort: 5 },
    ]);
    // The project scope saw no move: B was in it all along.
    expect(burndown().additions).toEqual([{ date: '2026-11-04', item_id: a, effort: 2 }]);
  });

  it('follows label changes for a label scope', () => {
    at('2026-10-01T10:00:00Z');
    const a = create('A', { effort: 3, labels: ['mobile'] });
    create('B', { effort: 4 });
    at('2026-11-08T10:00:00Z');
    update(a, { remove_labels: ['mobile'] });
    at('2026-11-16T12:00:00Z');
    const s = series(burndown({ label: 'mobile' }));
    expect(s['2026-11-07']).toBe(3);
    expect(s['2026-11-08']).toBe(0);
    expect(burndown({ label: 'mobile' }).open_effort).toBe(0);
  });

  it('replays through an owner undo', () => {
    at('2026-10-01T10:00:00Z');
    const a = create('A', { effort: 5 });
    at('2026-11-10T10:00:00Z');
    const v = d.row<{ version: number }>('SELECT version FROM items WHERE id = ?', a).version;
    const mutation = d.write(OWNER_ACTOR, (w, s) => {
      s.archive.cancel(w, { id: a, expected_version: v });
      return w.mutationId;
    });
    // Undone within the minute: the item was never out of scope at a day's end.
    d.clock.advance(10_000);
    d.write(OWNER_ACTOR, (w, s) => s.undo.undo(w, { mutation_id: mutation }));
    at('2026-11-16T12:00:00Z');
    const bd = burndown();
    expect(new Set(bd.series.map((p) => p.remaining))).toEqual(new Set([5]));
    // Crossing the undo and its original, backwards, lands on the same state.
    at('2026-11-12T12:00:00Z');
    move(a, 'canceled', 'Really not needed.');
    at('2026-11-16T12:00:00Z');
    const s = series(burndown());
    expect(s['2026-11-10']).toBe(5);
    expect(s['2026-11-12']).toBe(0);
  });

  it('replays in time order when an event was appended after newer ones', () => {
    at('2026-10-01T10:00:00Z');
    const a = create('A', { effort: 5 });
    const b = create('B', { effort: 3 });
    at('2026-11-12T10:00:00Z');
    finish(b);
    // A's completion on Nov 5 is appended after B's (as a fixture or a late import would).
    d.sql.prepare("UPDATE items SET status = 'done' WHERE id = ?").run(a);
    d.sql
      .prepare(
        `INSERT INTO events (at, actor_kind, client, project_key, item_id, type, summary, data, mutation_id)
         VALUES ('2026-11-05T10:00:00.000Z', 'agent', 'claude', 'TST', ?, 'item.status_changed', 'done', ?, 'mut_late')`,
      )
      .run(a, JSON.stringify({ status: { old: 'progress', new: 'done' } }));
    at('2026-11-16T12:00:00Z');
    const s = series(burndown());
    expect(s['2026-11-04']).toBe(8);
    expect(s['2026-11-05']).toBe(3);
    expect(s['2026-11-11']).toBe(3);
    expect(s['2026-11-12']).toBe(0);
  });

  it('ends each day in the configured local time zone', async () => {
    await d.cleanup();
    d = startDomain({
      seed: false,
      env: { TZ: 'America/New_York' },
      now: new Date('2026-10-01T10:00:00Z'),
    });
    addProject(d, 'TST');
    claude = d.agent('claude');
    const a = create('A', { effort: 5 });
    // 02:00 UTC on Nov 10 is still Nov 9 in New York.
    at('2026-11-10T02:00:00Z');
    finish(a);
    at('2026-11-16T17:00:00Z');
    const s = series(burndown());
    expect(s['2026-11-08']).toBe(5);
    expect(s['2026-11-09']).toBe(0);
    expect(localDay('2026-11-10T02:00:00Z', 'America/New_York')).toBe('2026-11-09');
    expect(localDay('2026-11-10T02:00:00Z', 'UTC')).toBe('2026-11-10');
  });

  it('the timeline reports the zone its days are in, so the Now line can use it (B18)', async () => {
    expect(timeline().time_zone).toBe(effectiveZone(d.server.runtime.config.tz));
    await d.cleanup();
    d = startDomain({ seed: false, env: { TZ: 'America/Chicago' }, now: new Date(NOV_16) });
    addProject(d, 'TST');
    claude = d.agent('claude');
    expect(timeline().time_zone).toBe('America/Chicago');
    expect(effectiveZone('Not/AZone')).toBe('UTC');
  });

  it('is empty, not zero-filled with false history, when nothing in scope is estimated', () => {
    at('2026-10-01T10:00:00Z');
    create('Unestimated');
    at('2026-11-16T12:00:00Z');
    const bd = burndown();
    expect(bd.open_effort).toBe(0);
    expect(bd.not_estimated).toBe(1);
    expect(bd.forecast.available).toBe(false);
  });
});

// ---- Forecast ----

/** `n` completions of `effort` on `date`. */
const done = (date: string, n: number, effort = 2): Completion[] =>
  Array.from({ length: n }, (_, i) => ({ item_id: `TST-${date}-${i}`, date, effort }));

describe('forecast thresholds', () => {
  // Monday Nov 16: the last 4 full weeks are Oct 19 – Nov 15.
  const today = '2026-11-16';

  it('says exactly what is missing with fewer than 8 estimated completions', () => {
    const f = forecastOf({
      today,
      completions: [...done('2026-10-20', 4), ...done('2026-11-02', 3)],
      remaining: 20,
      unestimated: 1,
    });
    expect(f).toEqual({
      available: false,
      reason: 'No forecast yet: needs 8 completed items with effort (have 7)',
      have: 7,
    });
  });

  it('counts only the last 4 full weeks: not this week, not earlier', () => {
    const f = forecastOf({
      today,
      completions: [
        ...done('2026-10-18', 5), // the Sunday before the window
        ...done('2026-11-16', 5), // this week
        ...done('2026-10-19', 1), // first day in
        ...done('2026-11-15', 1), // last day in
      ],
      remaining: 20,
      unestimated: 0,
    });
    expect(f).toMatchObject({ available: false, have: 2 });
  });

  it('needs completions in at least 2 different weeks', () => {
    const f = forecastOf({
      today,
      completions: done('2026-11-10', 9),
      remaining: 20,
      unestimated: 0,
    });
    expect(f).toEqual({
      available: false,
      reason: 'No forecast yet: needs completions in at least 2 of the last 4 weeks (have 1)',
      have: 9,
    });
  });

  it('with 8 across 2 weeks: P50 and P85 dates, the rate, n, and the unestimated count', () => {
    const f = forecastOf({
      today,
      completions: [...done('2026-10-21', 4, 3), ...done('2026-11-04', 4, 2)],
      remaining: 20,
      unestimated: 2,
    });
    expect(f.available).toBe(true);
    if (!f.available) return;
    // Weekly sample [12, 0, 8, 0]: 20 pts over 4 weeks.
    expect(f.rate_per_week).toBe(5);
    expect(f.window_weeks).toBe(4);
    expect(f.n).toBe(8);
    expect(f.excludes_unestimated).toBe(2);
    expect(f.p50 >= today).toBe(true);
    expect(f.p85 >= f.p50).toBe(true);
  });
});

describe('Monte Carlo', () => {
  it('is deterministic under a seeded RNG', () => {
    const sample = [12, 0, 8, 3];
    const a = monteCarloDays(sample, 40, mulberry32(42));
    const b = monteCarloDays(sample, 40, mulberry32(42));
    expect(a).toEqual(b);
    expect(a!.p85).toBeGreaterThanOrEqual(a!.p50);
    // And the service's default seed makes a reload show the same dates.
    const args = {
      today: '2026-11-16',
      completions: [...done('2026-10-21', 4, 3), ...done('2026-11-04', 4, 2)],
      remaining: 30,
      unestimated: 0,
    };
    expect(forecastOf(args)).toEqual(forecastOf(args));
  });

  it('draws whole weeks with replacement until nothing remains, then interpolates the last week', () => {
    // A constant 5 pts a week finishes 10 pts in exactly 2 weeks.
    expect(monteCarloDays([5, 5, 5, 5], 10, mulberry32(1))).toEqual({ p50: 14, p85: 14 });
    // 10 pts a week finishes 5 pts half-way through the first week.
    expect(monteCarloDays([10], 5, mulberry32(1))).toEqual({ p50: 4, p85: 4 });
    // Nothing remaining: done today.
    expect(monteCarloDays([3, 4], 0, mulberry32(1))).toEqual({ p50: 0, p85: 0 });
  });

  it('runs 10,000 trials and P85 is the 85th percentile of them', () => {
    expect(FORECAST_TRIALS).toBe(10_000);
    // Weeks of 10, 0 or 0 pts, 10 pts remaining: the finish week is geometric
    // (p = 1/3): P(≤ 2 weeks) = 0.56 and P(≤ 5 weeks) = 0.87, far from the cut-offs.
    const r = monteCarloDays([10, 0, 0], 10, mulberry32(7));
    expect(r).toEqual({ p50: 14, p85: 35 });
  });

  it('the service forecast uses the replayed history', () => {
    // Eight items of 2 pts done across two weeks; 16 pts left.
    at('2026-10-01T10:00:00Z');
    const ids = Array.from({ length: 16 }, (_, i) => create(`Item ${i}`, { effort: 2 }));
    create('Unestimated');
    at('2026-10-21T10:00:00Z');
    ids.slice(0, 4).forEach(finish);
    at('2026-11-04T10:00:00Z');
    ids.slice(4, 8).forEach(finish);
    at('2026-11-16T12:00:00Z');
    const f = d.services.forecast.forecast(d.read(OWNER_ACTOR), { project: 'TST' });
    expect(f).toMatchObject({
      available: true,
      n: 8,
      rate_per_week: 4,
      window_weeks: 4,
      excludes_unestimated: 1,
    });
    // The burn-down and the timeline lane say the same.
    expect(burndown().forecast).toEqual(f);
    expect(timeline().forecasts[0]!.forecast).toEqual(f);
    // Seven would not do.
    move(ids[0]!, 'progress', 'Reopened.');
    expect(d.services.forecast.forecast(d.read(OWNER_ACTOR), { project: 'TST' })).toEqual({
      available: false,
      reason: 'No forecast yet: needs 8 completed items with effort (have 7)',
      have: 7,
    });
  });
});

// ---- Planned dates are never changed ----

describe('planned dates', () => {
  it('are unchanged by the timeline, the burn-down and the forecast', () => {
    at('2026-10-01T10:00:00Z');
    const ids = Array.from({ length: 10 }, (_, i) =>
      create(`Item ${i}`, { effort: 3, start: '2026-11-20', end: '2026-11-27' }),
    );
    at('2026-10-21T10:00:00Z');
    ids.slice(0, 4).forEach(finish);
    at('2026-11-04T10:00:00Z');
    ids.slice(4, 8).forEach(finish);
    at('2026-11-16T12:00:00Z');
    const snapshot = () =>
      d.rows(
        'SELECT id, planned_start, planned_end, dates_set_by, dates_set_at, version, updated_at FROM items ORDER BY id',
      );
    const events = () => d.row<{ n: number }>('SELECT count(*) AS n FROM events').n;
    const before = snapshot();
    const eventsBefore = events();

    const f = d.services.forecast.forecast(d.read(OWNER_ACTOR), { project: 'TST' });
    expect(f.available).toBe(true);
    burndown();
    const t = timeline();
    expect(t.rows.find((r) => r.id === ids[9])).toMatchObject({
      planned_start: '2026-11-20',
      planned_end: '2026-11-27',
    });

    expect(snapshot()).toEqual(before);
    expect(events()).toBe(eventsBefore);
  });
});

// ---- Scale ----

describe('burn-down at scale', () => {
  /** Insert `n` item events for `items` items between `fromMs` and `toMs`, oldest first. */
  function generate(n: number, items: number, fromMs: number, toMs: number): void {
    const sql = d.sql;
    const created = new Date(fromMs - DAY).toISOString();
    const insertItem = sql.prepare(
      `INSERT INTO items (id, project_key, type, title, description_md, outcome_md, status, priority, effort, effort_unit, imported, version, created_at, updated_at)
       VALUES (?, 'TST', 'Task', ?, '', '', ?, 2, ?, 'pts', 0, 1, ?, ?)`,
    );
    const insertEvent = sql.prepare(
      `INSERT INTO events (at, actor_kind, client, project_key, item_id, type, summary, data, mutation_id)
       VALUES (?, 'agent', 'claude', 'TST', ?, ?, ?, ?, ?)`,
    );
    sql.transaction(() => {
      for (let i = 0; i < items; i++) {
        insertItem.run(`TST-${i + 1}`, `Item ${i + 1}`, 'progress', (i % 5) + 1, created, created);
      }
      for (let k = 0; k < n; k++) {
        const item = `TST-${(k % items) + 1}`;
        const when = new Date(fromMs + Math.floor(((toMs - fromMs) * k) / n)).toISOString();
        if (k % 2 === 0) {
          const effort = (k % 7) + 1;
          insertEvent.run(
            when,
            item,
            'item.updated',
            `claude updated ${item}: effort`,
            JSON.stringify({ changed: { effort: { old: effort, new: effort + 1 } } }),
            `mut_${k}`,
          );
        } else {
          // Back and forth between Ready and In progress; every 50th goes to Done.
          const [from, to] = k % 100 === 1 ? ['progress', 'done'] : ['ready', 'progress'];
          insertEvent.run(
            when,
            item,
            'item.status_changed',
            `${item} moved`,
            JSON.stringify({ status: { old: from, new: to } }),
            `mut_${k}`,
          );
        }
      }
    })();
  }

  function timed(): { ms: number; bd: ReturnType<typeof burndown> } {
    const t0 = performance.now();
    const bd = burndown();
    return { ms: performance.now() - t0, bd };
  }

  it('100,000 events over two years: reads only the window', () => {
    const now = Date.parse('2026-11-16T12:00:00Z');
    generate(100_000, 500, now - 730 * DAY, now - 60_000);
    at('2026-11-16T12:00:00Z');
    const { ms, bd } = timed();
    console.log(`burn-down, 100,000 events over 2 years (500 items): ${ms.toFixed(0)} ms`);
    expect(bd.series).toHaveLength(28);
    expect(ms).toBeLessThan(1000);
  });

  it('100,000 events all inside the window (worst case)', () => {
    const now = Date.parse('2026-11-16T12:00:00Z');
    generate(100_000, 500, now - 27 * DAY, now - 60_000);
    at('2026-11-16T12:00:00Z');
    const { ms, bd } = timed();
    console.log(`burn-down, 100,000 events in the last 28 days (500 items): ${ms.toFixed(0)} ms`);
    expect(bd.series).toHaveLength(28);
    expect(ms).toBeLessThan(3000);
  });
});
