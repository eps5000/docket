/**
 * Flow trends on Overview (owner decision 48; BUILD_SPEC §5.29). Each metric is
 * defined here, once, and is read-only and advisory: nothing here touches the
 * Needs you badge or blocks anything.
 *
 * - **Finished:** the Completed set (`completedIn`), passed in.
 * - **Merged:** distinct PRs an agent recorded as merged (`pr` artifacts in state
 *   `merged`), at the time Docket first recorded it. A PR linked to two tickets
 *   counts once. Docket doesn't watch the forge, so this can be low, and
 *   `finished_without_merge` says by how many tickets. Never estimated.
 * - **Parked:** `run.parked` events on tickets. Epics are excluded.
 * - **The note:** one sentence when the first and second half of the activity
 *   in the window move in opposite directions.
 */
import type { OverviewResponse, OverviewWindow } from '@docket/shared';
import { effectiveZone, localDay } from './forecast.js';
import { ms, type ItemRow } from './model.js';
import type { Scoped } from './views.js';

const HOUR_MS = 3_600_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** The calendar day after `day`. */
export function nextDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

const dayText = (day: string) => {
  const [, m, d] = day.split('-');
  return `${MONTHS[Number(m) - 1] ?? m} ${Number(d)}`;
};

export interface BucketFrame {
  slots: { key: string; label: string }[];
  /** The slot of an instant inside the window. */
  indexOf(iso: string): number;
}

/** The chart's time slots over `(from, to]`: 24 hours, or the calendar days in `tz`. */
export function bucketFrame(
  window: OverviewWindow,
  fromMs: number,
  toMs: number,
  tz: string | null,
): BucketFrame {
  if (window === '24h') {
    const format = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      hourCycle: 'h23',
      timeZone: effectiveZone(tz),
    });
    const slots = Array.from({ length: 24 }, (_, k) => {
      const key = new Date(fromMs + k * HOUR_MS).toISOString();
      const hour = format.formatToParts(new Date(key)).find((p) => p.type === 'hour')?.value;
      return { key, label: `${hour ?? '00'}:00` };
    });
    return {
      slots,
      indexOf: (iso) => Math.min(23, Math.max(0, Math.ceil((ms(iso) - fromMs) / HOUR_MS) - 1)),
    };
  }
  // `from` itself is outside the window, so the first day starts just after it.
  const first = localDay(new Date(fromMs + 1).toISOString(), tz);
  const last = localDay(new Date(toMs).toISOString(), tz);
  const slots: BucketFrame['slots'] = [];
  const byDay = new Map<string, number>();
  for (let day = first; day <= last; day = nextDay(day)) {
    byDay.set(day, slots.length);
    slots.push({ key: day, label: dayText(day) });
  }
  return { slots, indexOf: (iso) => byDay.get(localDay(iso, tz))! };
}

/** One PR however it was linked: its URL, or the ticket and label when it has none. */
const prKey = (a: { item_id: string; url: string | null; label: string }) =>
  a.url?.trim()
    ? a.url.trim().toLowerCase().replace(/\/+$/, '')
    : `${a.item_id}:${a.label.trim().toLowerCase()}`;

/**
 * The merges Docket has on record in scope: each PR once, at its first record,
 * and every ticket with a merged PR.
 */
export function recordedMerges(s: Scoped): { at: string[]; items: Set<string> } {
  const rows = s.db.sqlite
    .prepare(
      `SELECT item_id, url, label, created_at FROM artifacts
       WHERE kind = 'pr' AND lower(state) = 'merged' ORDER BY created_at, id`,
    )
    .all() as { item_id: string; url: string | null; label: string; created_at: string }[];
  const seen = new Set<string>();
  const items = new Set<string>();
  const at: string[] = [];
  for (const row of rows) {
    if (!s.items.has(row.item_id)) continue;
    items.add(row.item_id);
    const key = prKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    at.push(row.created_at);
  }
  return { at, items };
}

/** When tickets were parked in `(from, to]`. Epics are excluded. */
function parkedTimes(s: Scoped, fromMs: number, toMs: number): string[] {
  const rows = s.db.sqlite
    .prepare(`SELECT at, item_id FROM events WHERE type = 'run.parked' AND at > ? AND at <= ?`)
    .all(new Date(fromMs).toISOString(), new Date(toMs).toISOString()) as {
    at: string;
    item_id: string | null;
  }[];
  return rows.flatMap((e) => {
    const item = e.item_id ? s.items.get(e.item_id) : undefined;
    return item && item.type !== 'Epic' ? [e.at] : [];
  });
}

/** Under this much activity, two halves are too short to call a trend. */
const NOTE_MIN_SPAN_MS = 12 * HOUR_MS;
/** A change smaller than this is noise. */
const NOTE_MIN_CHANGE = 2;

/**
 * Compares the first and second half of the activity in the window, so a
 * project two days old can show a trend in a 30-day window, and both halves
 * are the same length, so a day still in progress can't read as a drop.
 */
export function flowNote(
  times: { finished: readonly number[]; merged: readonly number[]; parked: readonly number[] },
  toMs: number,
): string | null {
  let start = Infinity;
  for (const list of [times.finished, times.merged, times.parked]) {
    for (const t of list) if (t < start) start = t;
  }
  if (!Number.isFinite(start) || toMs - start < NOTE_MIN_SPAN_MS) return null;
  const middle = start + (toMs - start) / 2;
  const halves = (list: readonly number[]) => {
    const first = list.filter((t) => t <= middle).length;
    return [first, list.length - first] as const;
  };
  const [finished0, finished1] = halves(times.finished);
  if (finished0 - finished1 < NOTE_MIN_CHANGE) return null;
  const compared = `first half of this period against the second`;
  const [parked0, parked1] = halves(times.parked);
  if (parked1 - parked0 >= NOTE_MIN_CHANGE) {
    return `Parking is up while finished tickets are down (parked ${parked0} to ${parked1}, finished ${finished0} to ${finished1}, ${compared}).`;
  }
  const [merged0, merged1] = halves(times.merged);
  if (merged1 >= merged0 && merged1 >= NOTE_MIN_CHANGE) {
    return `PRs are still merging while finished tickets are down (merged ${merged0} to ${merged1}, finished ${finished0} to ${finished1}, ${compared}).`;
  }
  return null;
}

export function flowOf(
  s: Scoped,
  done: readonly ItemRow[],
  window: OverviewWindow,
  fromMs: number,
  toMs: number,
  tz: string | null,
): OverviewResponse['flow'] {
  const frame = bucketFrame(window, fromMs, toMs, tz);
  const buckets = frame.slots.map((slot) => ({ ...slot, finished: 0, merged: 0, parked: 0 }));
  const merges = recordedMerges(s);
  const merged = merges.at.filter((at) => ms(at) > fromMs && ms(at) <= toMs);
  const parked = parkedTimes(s, fromMs, toMs);
  for (const i of done) buckets[frame.indexOf(i.closed_at!)]!.finished++;
  for (const at of merged) buckets[frame.indexOf(at)]!.merged++;
  for (const at of parked) buckets[frame.indexOf(at)]!.parked++;
  return {
    granularity: window === '24h' ? 'hour' : 'day',
    buckets,
    finished: done.length,
    merged: merged.length,
    parked: parked.length,
    finished_without_merge: done.filter((i) => !merges.items.has(i.id)).length,
    note: flowNote(
      {
        finished: done.map((i) => ms(i.closed_at!)),
        merged: merged.map(ms),
        parked: parked.map(ms),
      },
      toMs,
    ),
  };
}
