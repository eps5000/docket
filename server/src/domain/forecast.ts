/**
 * Dates, the timeline, burn-down and forecast (BUILD_SPEC §5.9; spec US8,
 * FR-080–FR-082): the `forecast` service. Nothing here writes: forecasts never
 * overwrite planned dates, and reading them appends no event.
 *
 * **Timeline** (`GET /api/work?layout=timeline`): dated tickets in scope with
 * their planned dates and who set them, actual dates from status history,
 * unresolved blockers with their planned ends, the date risk (the same rule
 * as Problems: `dateRiskBlockers` in model.ts), the undated open tickets, and
 * one forecast per project in scope.
 *
 * **Burn-down** (`GET /api/burndown`): remaining effort at the end of each
 * local day (config `TZ`) for the last 28 days, replayed from events. The
 * replay starts from the current rows and walks the events *backwards*,
 * undoing each one with the old values it recorded, until it passes the
 * start of the window. Events are read newest first by `seq` and the read
 * stops at the first one older than the window less two days of slack (the
 * write path stamps `at` when it appends, so older events never follow), so
 * its cost is the window's events, not the whole history: see the
 * 100,000-event test in forecast.test.ts. The window's events are then
 * replayed in time order.
 * - Item creation comes from `items.created_at` (seeded items have no
 *   `item.created` event).
 * - Owner undo events carry only `undo_of`; crossing one restores the
 *   original change's new values.
 * - A scope addition is any rise in an item's contribution: created with
 *   effort, moved into the epic or label, reopened, or re-estimated upwards.
 * - Items without effort are counted ("N not estimated"), never as zero.
 *
 * **Forecast:** a sample of effort completed per week over the last 4 full
 * weeks (Monday to Sunday, before the current week). It needs at least 8
 * estimated items done in that window, in at least 2 different weeks, and
 * otherwise says what is missing. A completion counts once per item, and not
 * at all if the item was reopened since. Monte Carlo with 10,000 trials draws
 * weekly throughput with replacement until the remaining effort reaches 0,
 * interpolating the last week by day; P50 and P85 are reported. The RNG is
 * seeded from the inputs, so a reload shows the same dates and tests are
 * deterministic.
 */
import {
  OPEN_STATUSES,
  type BurndownResponse,
  type Forecast,
  type Status,
  type Timeline,
} from '@docket/shared';
import type { ForecastService, ReadContext, ServiceDeps } from './contracts.js';
import { compareIds } from './links.js';
import { BlockIndex, dateRiskBlockers, type ItemRow } from './model.js';

export const BURNDOWN_DAYS = 28;
export const WINDOW_WEEKS = 4;
export const MIN_ITEMS = 8;
export const MIN_WEEKS = 2;
export const FORECAST_TRIALS = 10_000;
/** A trial that hasn't finished in ten years stops there. */
const MAX_WEEKS = 520;

// ---- Days (`YYYY-MM-DD`) ----

const DAY = 86_400_000;
const dayMs = (date: string) => Date.parse(`${date}T00:00:00Z`);
const dayOf = (msValue: number) => new Date(msValue).toISOString().slice(0, 10);
export const addDays = (date: string, n: number): string => dayOf(dayMs(date) + n * DAY);
/** The Monday of the week holding `date`. */
export const mondayOf = (date: string): string =>
  addDays(date, -((new Date(dayMs(date)).getUTCDay() + 6) % 7));
const minDay = (a: string, b: string) => (a < b ? a : b);
const maxDay = (a: string, b: string) => (a > b ? a : b);

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(tz: string | null | undefined): Intl.DateTimeFormat {
  const key = tz ?? '';
  let f = formatters.get(key);
  if (!f) {
    const opts = { year: 'numeric', month: '2-digit', day: '2-digit' } as const;
    try {
      f = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: tz ?? undefined });
    } catch {
      // An unknown zone: fall back to UTC rather than fail the view.
      f = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' });
    }
    formatters.set(key, f);
  }
  return f;
}

/**
 * The zone `localDay` actually uses for `tz`: the configured zone, UTC when
 * that zone is unknown, or the process's own zone when none is configured.
 * The Timeline sends it, so the browser draws "today" in the same zone.
 */
export function effectiveZone(tz: string | null | undefined): string {
  return formatterFor(tz).resolvedOptions().timeZone;
}

/** The local calendar day of an instant in `tz` (the host zone when null). */
export function localDay(iso: string, tz: string | null | undefined): string {
  const parts = formatterFor(tz).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** `localDay`, memoised by minute (the replay asks for the same minutes often). */
function dayCache(tz: string | null | undefined): (iso: string) => string {
  const cache = new Map<string, string>();
  return (iso) => {
    const key = iso.slice(0, 16);
    let day = cache.get(key);
    if (day === undefined) {
      day = localDay(iso, tz);
      cache.set(key, day);
    }
    return day;
  };
}

// ---- Monte Carlo ----

/** A small, fast, seedable PRNG (mulberry32): uniform in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** FNV-1a: a stable 32-bit seed from text. */
function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Days until `remaining` effort is done, at P50 and P85, drawing weekly
 * throughput from `sample` with replacement. The last week is interpolated
 * (5 pts left in a 10-pt week is 3.5 days, rounded up to 4). Null when the
 * sample has no throughput at all.
 */
export function monteCarloDays(
  sample: readonly number[],
  remaining: number,
  rng: () => number,
  trials = FORECAST_TRIALS,
): { p50: number; p85: number } | null {
  if (remaining <= 0) return { p50: 0, p85: 0 };
  if (!sample.some((x) => x > 0)) return null;
  const days = new Float64Array(trials);
  for (let t = 0; t < trials; t++) {
    let left = remaining;
    let weeks = 0;
    days[t] = MAX_WEEKS * 7;
    while (weeks < MAX_WEEKS) {
      const draw = sample[Math.floor(rng() * sample.length)]!;
      if (draw >= left) {
        days[t] = Math.ceil((weeks + left / draw) * 7 - 1e-9);
        break;
      }
      left -= draw;
      weeks++;
    }
  }
  days.sort();
  const at = (p: number) => days[Math.max(0, Math.ceil(p * trials) - 1)]!;
  return { p50: at(0.5), p85: at(0.85) };
}

/** One estimated item done on a local day. */
export interface Completion {
  item_id: string;
  date: string;
  effort: number;
}

const round = (x: number, places = 1) => Math.round(x * 10 ** places) / 10 ** places;

/** The forecast from completions and what remains (BUILD_SPEC §5.9; decision T11). */
export function forecastOf(o: {
  today: string;
  completions: readonly Completion[];
  remaining: number;
  unestimated: number;
  rng?: () => number;
  trials?: number;
}): Forecast {
  const thisWeek = mondayOf(o.today);
  const from = addDays(thisWeek, -7 * WINDOW_WEEKS);
  const inWindow = o.completions.filter((c) => c.date >= from && c.date < thisWeek);
  const n = inWindow.length;
  if (n < MIN_ITEMS) {
    return {
      available: false,
      reason: `No forecast yet: needs ${MIN_ITEMS} completed items with effort (have ${n})`,
      have: n,
    };
  }
  const weekly = Array.from({ length: WINDOW_WEEKS }, () => 0);
  const counts = Array.from({ length: WINDOW_WEEKS }, () => 0);
  for (const c of inWindow) {
    const w = Math.floor((dayMs(c.date) - dayMs(from)) / (7 * DAY));
    weekly[w]! += c.effort;
    counts[w]!++;
  }
  const weeks = counts.filter((x) => x > 0).length;
  if (weeks < MIN_WEEKS) {
    return {
      available: false,
      reason: `No forecast yet: needs completions in at least ${MIN_WEEKS} of the last ${WINDOW_WEEKS} weeks (have ${weeks})`,
      have: n,
    };
  }
  const remaining = round(o.remaining, 6);
  const rng = o.rng ?? mulberry32(seedOf(JSON.stringify([o.today, remaining, weekly])));
  const days = monteCarloDays(weekly, remaining, rng, o.trials);
  if (!days) {
    return {
      available: false,
      reason: `No forecast yet: the ${n} items completed in the last ${WINDOW_WEEKS} weeks have 0 effort`,
      have: n,
    };
  }
  return {
    available: true,
    p50: addDays(o.today, days.p50),
    p85: addDays(o.today, days.p85),
    rate_per_week: round(weekly.reduce((a, b) => a + b, 0) / WINDOW_WEEKS),
    window_weeks: WINDOW_WEEKS,
    n,
    excludes_unestimated: o.unestimated,
  };
}

// ---- The burn-down replay ----

interface ScopeSpec {
  /** Live project keys in scope. */
  projects: string[];
  epic?: string;
  label?: string;
}

interface ItemState {
  exists: boolean;
  status: Status;
  effort: number | null;
  epic_id: string | null;
  labels: Set<string>;
}

interface Candidate {
  id: string;
  created_at: string;
  state: ItemState;
}

interface Replay {
  today: string;
  series: { date: string; remaining: number }[];
  additions: { date: string; item_id: string; effort: number }[];
  open_effort: number;
  not_estimated: number;
  completions: Completion[];
}

/** One step of the backward walk: an item event, or an item's creation. */
interface Step {
  at: string;
  seq: number;
  create?: Candidate;
  event?: EventLite;
}

interface EventLite {
  seq: number;
  at: string;
  item_id: string | null;
  type: string;
  data: string | null;
  mutation_id: string;
}

type Changed = Record<string, { old: unknown; new: unknown }>;
interface EventData {
  status?: { old: Status; new: Status };
  changed?: Changed;
  undo_of?: string;
}

const OPEN = new Set<string>(OPEN_STATUSES);
const tidy = (x: number) => round(x, 6);

function parse(data: string | null): EventData {
  if (!data) return {};
  try {
    return JSON.parse(data) as EventData;
  } catch {
    return {};
  }
}

/** Set the effort, epic and labels a change recorded, taking `side` (old or new). */
function applyChanged(st: ItemState, changed: Changed | undefined, side: 'old' | 'new'): void {
  if (!changed) return;
  if (changed.effort) {
    const v = changed.effort[side];
    st.effort = typeof v === 'number' ? v : null;
  }
  if (changed.epic_id) {
    const v = changed.epic_id[side];
    st.epic_id = typeof v === 'string' ? v : null;
  }
  if (changed.labels) {
    const v = changed.labels[side];
    st.labels = new Set(Array.isArray(v) ? (v as string[]) : []);
  }
}

function replay(r: ReadContext, tz: string | null, scope: ScopeSpec): Replay {
  const sql = r.db.sqlite;
  const dayAt = dayCache(tz);
  const today = localDay(r.now, tz);
  const first = addDays(today, -(BURNDOWN_DAYS - 1));
  const thisWeek = mondayOf(today);
  const oldest = minDay(first, addDays(thisWeek, -7 * WINDOW_WEEKS));
  // Events this much before the oldest day are never read: two days of slack
  // covers any zone offset and a clock that stepped back.
  const cutoff = new Date(dayMs(oldest) - 2 * DAY).toISOString();

  // Current state of every ticket in the scope's projects.
  const projects = JSON.stringify(scope.projects);
  const items = new Map<string, Candidate>();
  for (const row of sql
    .prepare(
      `SELECT id, status, effort, epic_id, created_at FROM items
       WHERE type <> 'Epic' AND project_key IN (SELECT value FROM json_each(?))`,
    )
    .all(projects) as Pick<ItemRow, 'id' | 'status' | 'effort' | 'epic_id' | 'created_at'>[]) {
    items.set(row.id, {
      id: row.id,
      created_at: row.created_at,
      state: {
        exists: true,
        status: row.status,
        effort: row.effort,
        epic_id: row.epic_id,
        labels: new Set(),
      },
    });
  }
  if (scope.label) {
    for (const l of sql
      .prepare(
        `SELECT il.item_id, l.name FROM item_labels il JOIN labels l ON l.id = il.label_id
         WHERE l.project_key IN (SELECT value FROM json_each(?))`,
      )
      .all(projects) as { item_id: string; name: string }[]) {
      items.get(l.item_id)?.state.labels.add(l.name);
    }
  }

  const inScope = (st: ItemState) =>
    st.exists &&
    (!scope.epic || st.epic_id === scope.epic) &&
    (!scope.label || st.labels.has(scope.label));
  const contribution = (st: ItemState) =>
    inScope(st) && OPEN.has(st.status) && st.effort !== null ? st.effort : 0;

  let total = 0;
  let notEstimated = 0;
  for (const c of items.values()) {
    total += contribution(c.state);
    if (inScope(c.state) && OPEN.has(c.state.status) && c.state.effort === null) notEstimated++;
  }
  const openEffort = total;

  // Creations inside the window become steps of the walk too.
  const steps: Step[] = [...items.values()]
    .filter((c) => c.created_at >= cutoff)
    .map((c) => ({ at: c.created_at, seq: -1, create: c }));

  const eventsQuery =
    scope.projects.length === 1
      ? sql
          .prepare(
            `SELECT seq, at, item_id, type, data, mutation_id FROM events
             WHERE project_key = ? AND type IN ('item.updated', 'item.status_changed')
             ORDER BY seq DESC`,
          )
          .iterate(scope.projects[0])
      : sql
          .prepare(
            `SELECT seq, at, item_id, type, data, mutation_id FROM events
             WHERE type IN ('item.updated', 'item.status_changed') ORDER BY seq DESC`,
          )
          .iterate();
  // Newest first by seq, stopping at the first event older than the cutoff:
  // events are appended when they happen, so nothing older is read.
  for (const e of eventsQuery as IterableIterator<EventLite>) {
    if (e.at < cutoff) break;
    if (e.item_id && items.has(e.item_id)) steps.push({ at: e.at, seq: e.seq, event: e });
  }
  // Replay in time order, newest first (a few events may be appended out of
  // order); at the same instant a creation comes last, before its own events.
  steps.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.seq - a.seq));

  const original = sql.prepare(
    'SELECT type, item_id, data FROM events WHERE mutation_id = ? ORDER BY seq',
  );

  const values = new Map<string, number>();
  const additions = new Map<string, { date: string; item_id: string; effort: number }>();
  const completions: Completion[] = [];
  const counted = new Set<string>();
  const reopened = new Set<string>();
  const undone = new Set<string>();
  let cursor = today;

  /** Record every day from the cursor down to `day` (their values are the current total). */
  const recordDown = (day: string) => {
    while (cursor >= day && cursor >= first) {
      values.set(cursor, tidy(total));
      cursor = addDays(cursor, -1);
    }
  };

  /** Undo one change to `c`, moving `total` to the value before it. */
  const cross = (c: Candidate, day: string, undo: (st: ItemState) => void) => {
    const after = contribution(c.state);
    undo(c.state);
    const before = contribution(c.state);
    total += before - after;
    if (after > before && day >= first) {
      const key = `${day} ${c.id}`;
      const prev = additions.get(key);
      additions.set(key, {
        date: day,
        item_id: c.id,
        effort: tidy((prev?.effort ?? 0) + after - before),
      });
    }
  };

  const crossCreation = (c: Candidate) => {
    const day = dayAt(c.created_at);
    recordDown(day);
    if (day < oldest) return;
    cross(c, day, (st) => {
      st.exists = false;
    });
  };

  for (const step of steps) {
    if (step.create) {
      crossCreation(step.create);
      continue;
    }
    const e = step.event!;
    const c = items.get(e.item_id!)!;
    const day = dayAt(e.at);
    recordDown(day);
    if (day < oldest) continue;
    const data = parse(e.data);

    if (data.undo_of) {
      // Before the undo, the original change stood: restore its new values.
      undone.add(data.undo_of);
      const orig = (original.all(data.undo_of) as { type: string; item_id: string; data: string }[])
        .filter((o) => o.type === e.type && o.item_id === c.id)
        .map((o) => parse(o.data));
      cross(c, day, (st) => {
        for (const o of orig) {
          if (o.status) st.status = o.status.new;
          applyChanged(st, o.changed, 'new');
        }
      });
      continue;
    }

    if (e.type === 'item.status_changed' && data.status) {
      const { old, new: to } = data.status;
      const live = !undone.has(e.mutation_id);
      if (live && to === 'done' && !counted.has(c.id) && !reopened.has(c.id)) {
        counted.add(c.id);
        if (inScope(c.state) && c.state.effort !== null) {
          completions.push({ item_id: c.id, date: day, effort: c.state.effort });
        }
      }
      if (live && old === 'done' && to !== 'done') reopened.add(c.id);
      cross(c, day, (st) => {
        st.status = old;
      });
    } else if (e.type === 'item.updated') {
      cross(c, day, (st) => applyChanged(st, data.changed, 'old'));
    }
  }
  recordDown(first);

  const series: Replay['series'] = [];
  for (let day = first; day <= today; day = addDays(day, 1)) {
    series.push({ date: day, remaining: values.get(day) ?? tidy(total) });
  }
  return {
    today,
    series,
    additions: [...additions.values()]
      .filter((a) => a.effort > 0)
      .sort((a, b) =>
        a.date < b.date ? -1 : a.date > b.date ? 1 : compareIds(a.item_id, b.item_id),
      ),
    open_effort: tidy(openEffort),
    not_estimated: notEstimated,
    completions,
  };
}

// ---- The service ----

function liveProjects(r: ReadContext, scope: string): string[] {
  const keys = (
    r.db.sqlite.prepare('SELECT key FROM projects WHERE deleted_at IS NULL ORDER BY key').all() as {
      key: string;
    }[]
  ).map((p) => p.key);
  return scope === 'all' ? keys : keys.filter((k) => k === scope);
}

function forecastFor(r: ReadContext, tz: string | null, scope: ScopeSpec): Forecast {
  const run = replay(r, tz, scope);
  return forecastOf({
    today: run.today,
    completions: run.completions,
    remaining: run.open_effort,
    unestimated: run.not_estimated,
  });
}

interface StatusEvent {
  item_id: string;
  at: string;
  old: string | null;
  new: string | null;
}

export function createForecastService(deps: ServiceDeps): ForecastService {
  const tz = () => deps.config.tz;

  return {
    timeline(r, input): Timeline {
      const sql = r.db.sqlite;
      const zone = tz();
      const today = localDay(r.now, zone);
      const projects = liveProjects(r, input.scope);
      const labelled = input.label
        ? new Set(
            (
              sql
                .prepare(
                  `SELECT il.item_id FROM item_labels il JOIN labels l ON l.id = il.label_id WHERE l.name = ?`,
                )
                .all(input.label) as { item_id: string }[]
            ).map((x) => x.item_id),
          )
        : null;
      // Tickets in scope; archived and canceled items leave the timeline (UI_SPEC §6.2.4, §6.3).
      const tickets = (
        sql
          .prepare(
            `SELECT * FROM items WHERE type <> 'Epic' AND status <> 'canceled' AND archived_at IS NULL
             AND project_key IN (SELECT value FROM json_each(?))`,
          )
          .all(JSON.stringify(projects)) as ItemRow[]
      ).filter(
        (i) => (!input.epic || i.epic_id === input.epic) && (!labelled || labelled.has(i.id)),
      );
      const dated = tickets.filter((i) => i.planned_start !== null || i.planned_end !== null);
      const undated = tickets
        .filter((i) => i.planned_start === null && i.planned_end === null && OPEN.has(i.status))
        .map((i) => i.id)
        .sort(compareIds);

      const index = new BlockIndex(r.db);
      const blockerIds = new Set(dated.flatMap((i) => index.state(i.id).blocked_by));
      const ends = new Map(
        (
          sql
            .prepare(
              'SELECT id, planned_end FROM items WHERE id IN (SELECT value FROM json_each(?))',
            )
            .all(JSON.stringify([...blockerIds])) as { id: string; planned_end: string | null }[]
        ).map((b) => [b.id, b.planned_end]),
      );
      const plannedEnd = (id: string) => ends.get(id) ?? null;

      // Actual dates: from the first move to In progress; the end is Done, or
      // when it last left In progress (review, or returned to Ready).
      const history = new Map<string, StatusEvent[]>();
      for (const e of sql
        .prepare(
          `SELECT item_id, at, json_extract(data, '$.status.old') AS old, json_extract(data, '$.status.new') AS new
           FROM events WHERE type = 'item.status_changed' AND item_id IN (SELECT value FROM json_each(?))
           ORDER BY seq`,
        )
        .all(JSON.stringify(dated.map((i) => i.id))) as StatusEvent[]) {
        history.set(e.item_id, [...(history.get(e.item_id) ?? []), e]);
      }
      const actual = (i: ItemRow): { start: string | null; end: string | null } => {
        const events = history.get(i.id) ?? [];
        const started = events.find((e) => e.new === 'progress');
        if (!started) return { start: null, end: null };
        const start = localDay(started.at, zone);
        if (i.status === 'progress') return { start, end: null };
        const doneAt =
          i.status === 'done'
            ? (i.closed_at ?? events.filter((e) => e.new === 'done').at(-1)?.at ?? null)
            : null;
        const left = events.filter((e) => e.old === 'progress' && e.at >= started.at).at(-1)?.at;
        const endAt = doneAt ?? left ?? null;
        return { start, end: endAt ? maxDay(localDay(endAt, zone), start) : null };
      };

      const rows: Timeline['rows'] = dated
        .sort(
          (a, b) =>
            (a.planned_start ?? a.planned_end!).localeCompare(b.planned_start ?? b.planned_end!) ||
            compareIds(a.id, b.id),
        )
        .map((i) => {
          const state = index.state(i.id);
          const risky = new Set(dateRiskBlockers(index, i, plannedEnd));
          const a = actual(i);
          return {
            id: i.id,
            title: i.title,
            type: i.type,
            project: i.project_key,
            status: i.status,
            blocked: state.blocked,
            planned_start: i.planned_start,
            planned_end: i.planned_end,
            dates_set_by: i.dates_set_by,
            actual_start: a.start,
            actual_end: a.end,
            overdue: OPEN.has(i.status) && i.planned_end !== null && i.planned_end < today,
            blockers: state.blocked_by.map((b) => ({
              id: b,
              planned_end: plannedEnd(b),
              risky: risky.has(b),
            })),
          };
        });

      const forecasts = projects.map((project) => ({
        project,
        forecast: forecastFor(r, zone, { projects: [project] }),
      }));

      // Whole weeks, Monday to Sunday, covering today, every bar, tick and forecast; at least 5.
      let lo = today;
      let hi = today;
      const see = (day: string | null) => {
        if (!day) return;
        lo = minDay(lo, day);
        hi = maxDay(hi, day);
      };
      for (const row of rows) {
        see(row.planned_start);
        see(row.planned_end);
        see(row.actual_start);
        see(row.actual_end);
        for (const b of row.blockers) see(b.planned_end);
      }
      for (const f of forecasts) {
        if (f.forecast.available) see(f.forecast.p85);
      }
      const from = mondayOf(lo);
      const to = maxDay(addDays(mondayOf(hi), 6), addDays(from, 7 * 5 - 1));

      return { from, to, rows, undated, forecasts, time_zone: effectiveZone(zone) };
    },

    burndown(r, input): BurndownResponse {
      const zone = tz();
      const run = replay(r, zone, {
        projects: liveProjects(r, input.scope),
        epic: input.epic,
        label: input.label,
      });
      return {
        series: run.series,
        additions: run.additions,
        open_effort: run.open_effort,
        not_estimated: run.not_estimated,
        window_days: BURNDOWN_DAYS,
        forecast: forecastOf({
          today: run.today,
          completions: run.completions,
          remaining: run.open_effort,
          unestimated: run.not_estimated,
        }),
      };
    },

    forecast(r, input): Forecast {
      return forecastFor(r, tz(), { projects: liveProjects(r, input.project) });
    },
  };
}
