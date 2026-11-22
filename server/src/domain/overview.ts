/**
 * The Overview metrics (owner decision 43; BUILD_SPEC §5.24). Every number on
 * the page is defined here, once, and the drill-down lists use the same sets,
 * so a number and the list behind it can't disagree.
 *
 * Read-only, and a fixed number of queries over the scope (SC-013): the items
 * and block state come from `scoped`, the agents from one query on active and
 * held lead runs.
 *
 * - **Completed:** tickets that entered Done in the window and are still Done.
 *   `closed_at` is the latest entry into Done, and reopening clears it, so a
 *   reopened ticket drops out and one closed twice counts once. Epics, canceled
 *   tickets and imports (they arrived Done; no work happened here) don't count.
 * - **Agents working:** open tickets whose lead is current (live or reported,
 *   lease not expired), or held for their producer between workers. Counted
 *   per story, so child runs and handoffs never inflate it.
 * - **Agents waiting:** open tickets whose lead is parked on a named dependency
 *   that hasn't cleared. A park naming nothing, or ready to resume, isn't waiting.
 * - **In flight:** open tickets in In progress or Review.
 * - **Blocked:** open tickets with an uncleared blocker (Work's *Blocked*).
 * - **Workload:** open tickets by status per epic; a blocked ticket counts once,
 *   as Blocked.
 */
import {
  OPEN_STATUSES,
  OVERVIEW_ITEMS_LIMIT,
  type OverviewItemRow,
  type OverviewItemsResponse,
  type OverviewMetric,
  type OverviewResponse,
  type OverviewWindow,
  type WaitingOn,
  type WorkloadBucket,
} from '@docket/shared';
import { compareIds } from './links.js';
import { effectiveZone, localDay } from './forecast.js';
import { actorName, displayRunState, ms, type ItemRow, type RunRow } from './model.js';
import { parkInfo, parseJson } from './recovery-model.js';
import type { Scoped } from './views.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
export const OVERVIEW_WINDOW_MS: Record<OverviewWindow, number> = {
  '24h': DAY_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const isOpen = (status: string) => (OPEN_STATUSES as readonly string[]).includes(status);

/** A ticket the open-work metrics count: not an epic, not archived, still open. */
const isOpenTicket = (i: ItemRow) =>
  i.type !== 'Epic' && i.archived_at === null && isOpen(i.status);

/** Entered Done in `(from, to]`, still Done. Epics and imports are never completed work. */
export function completedIn(items: Iterable<ItemRow>, fromMs: number, toMs: number): ItemRow[] {
  const out: ItemRow[] = [];
  for (const i of items) {
    if (i.type === 'Epic' || i.status !== 'done' || !i.closed_at || i.closed_by === 'imported') {
      continue;
    }
    const at = ms(i.closed_at);
    if (at > fromMs && at <= toMs) out.push(i);
  }
  return out;
}

// ---- Agents, per story ----

export type StoryActivity = { state: 'working' | 'waiting'; agent: string };

/** A parked lead's real dependency: something named that hasn't cleared. */
function waitsOnSomething(s: Scoped, run: RunRow): boolean {
  const w = parseJson<WaitingOn>(run.waiting_on) ?? {};
  const named = (w.items?.length ?? 0) > 0 || !!w.orchestrator || !!w.person || !!w.until;
  return named && !parkInfo(s.db, run, s.now, s.index).resume_ready;
}

const agentName = (run: RunRow) =>
  run.producer ?? actorName({ kind: 'agent', client: run.client, label: run.label });

/** What each open ticket's producer is doing now. One entry per story, however many runs. */
export function storyActivity(s: Scoped): Map<string, StoryActivity> {
  const now = ms(s.now);
  const out = new Map<string, StoryActivity>();
  const rows = s.db.sqlite
    .prepare(
      `SELECT * FROM runs WHERE is_lead = 1 AND state IN ('open', 'needs_input', 'parked')
       UNION ALL
       SELECT * FROM runs WHERE is_lead = 1 AND producer_hold_until IS NOT NULL
         AND state NOT IN ('open', 'needs_input', 'parked')`,
    )
    .all() as RunRow[];
  const active = new Set(
    rows.filter((r) => ['open', 'needs_input', 'parked'].includes(r.state)).map((r) => r.item_id),
  );
  for (const run of rows) {
    const item = s.items.get(run.item_id);
    if (!item || !isOpenTicket(item)) continue;
    if (run.state === 'parked') {
      if (waitsOnSomething(s, run)) {
        out.set(run.item_id, { state: 'waiting', agent: agentName(run) });
      }
    } else if (run.state === 'open') {
      const shown = displayRunState(run, s.windows, s.now);
      const leased = !run.lease_expires_at || ms(run.lease_expires_at) > now;
      if ((shown === 'live' || shown === 'reported') && leased) {
        out.set(run.item_id, { state: 'working', agent: agentName(run) });
      }
    } else if (
      run.state !== 'needs_input' &&
      !active.has(run.item_id) &&
      item.status === 'progress' &&
      run.producer &&
      run.producer_hold_until &&
      ms(run.producer_hold_until) > now
    ) {
      // Between workers: the story is still its producer's, and counts once.
      out.set(run.item_id, { state: 'working', agent: run.producer });
    }
  }
  return out;
}

/**
 * The one count of agents (decision 43): the sidebar badge and the Overview card
 * both read it from `GET /api/needs-you`. The badge is `working`; `waiting` isn't in it.
 */
export function agentsNow(s: Scoped): { working: number; waiting: number } {
  const out = { working: 0, waiting: 0 };
  for (const a of storyActivity(s).values()) out[a.state]++;
  return out;
}

// ---- Completed per hour or day ----

const pad = (n: number) => String(n).padStart(2, '0');

function hourLabel(iso: string, format: Intl.DateTimeFormat): string {
  const parts = format.formatToParts(new Date(iso));
  return `${parts.find((p) => p.type === 'hour')?.value ?? '00'}:00`;
}

function nextDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

const dayText = (day: string) => {
  const [, m, d] = day.split('-');
  return `${MONTHS[Number(m) - 1] ?? m} ${Number(d)}`;
};

/** The chart's buckets over `(from, to]`. They always sum to the number of `done` rows. */
export function completedBuckets(
  done: readonly ItemRow[],
  window: OverviewWindow,
  fromMs: number,
  toMs: number,
  tz: string | null,
): OverviewResponse['completed']['buckets'] {
  if (window === '24h') {
    const format = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      hourCycle: 'h23',
      timeZone: effectiveZone(tz),
    });
    const buckets = Array.from({ length: 24 }, (_, k) => {
      const start = new Date(fromMs + k * HOUR_MS).toISOString();
      return { key: start, label: hourLabel(start, format), count: 0 };
    });
    for (const i of done) {
      const k = Math.ceil((ms(i.closed_at!) - fromMs) / HOUR_MS) - 1;
      buckets[Math.min(23, Math.max(0, k))]!.count++;
    }
    return buckets;
  }
  // `from` itself is outside the window, so the first day starts just after it.
  const first = localDay(new Date(fromMs + 1).toISOString(), tz);
  const last = localDay(new Date(toMs).toISOString(), tz);
  const buckets: OverviewResponse['completed']['buckets'] = [];
  const byDay = new Map<string, (typeof buckets)[number]>();
  for (let day = first; day <= last; day = nextDay(day)) {
    const bucket = { key: day, label: dayText(day), count: 0 };
    buckets.push(bucket);
    byDay.set(day, bucket);
  }
  for (const i of done) byDay.get(localDay(i.closed_at!, tz))!.count++;
  return buckets;
}

// ---- The response ----

function workloadOf(s: Scoped, open: readonly ItemRow[]): OverviewResponse['workload'] {
  const groups = new Map<string | null, OverviewResponse['workload'][number]>();
  for (const i of open) {
    const key = i.epic_id;
    let g = groups.get(key);
    if (!g) {
      const epic = key ? s.items.get(key) : undefined;
      g = {
        epic_id: key,
        title: epic?.title ?? null,
        project: epic?.project_key ?? null,
        total: 0,
        counts: { review: 0, progress: 0, ready: 0, blocked: 0, planning: 0, inbox: 0 },
      };
      groups.set(key, g);
    }
    const bucket = (s.index.state(i.id).blocked ? 'blocked' : i.status) as WorkloadBucket;
    if (bucket in g.counts) {
      g.counts[bucket]++;
      g.total++;
    }
  }
  return [...groups.values()].sort(
    (a, b) =>
      b.total - a.total ||
      Number(a.epic_id === null) - Number(b.epic_id === null) ||
      compareIds(a.epic_id ?? '', b.epic_id ?? ''),
  );
}

export function overviewOf(
  s: Scoped,
  window: OverviewWindow,
  extra: { tz: string | null; lastBackupAt: string | null },
): OverviewResponse {
  const toMs = ms(s.now);
  const span = OVERVIEW_WINDOW_MS[window];
  const fromMs = toMs - span;
  const priorMs = fromMs - span;
  const items = [...s.items.values()];
  const done = completedIn(items, fromMs, toMs);
  const open = items.filter(isOpenTicket);
  const progress = open.filter((i) => i.status === 'progress').length;
  const review = open.filter((i) => i.status === 'review').length;
  return {
    window,
    from: new Date(fromMs).toISOString(),
    to: s.now,
    prior_from: new Date(priorMs).toISOString(),
    completed: {
      count: done.length,
      prior: completedIn(items, priorMs, fromMs).length,
      granularity: window === '24h' ? 'hour' : 'day',
      buckets: completedBuckets(done, window, fromMs, toMs, extra.tz),
    },
    in_flight: { count: progress + review, progress, review },
    blocked: open.filter((i) => s.index.state(i.id).blocked).length,
    workload: workloadOf(s, open),
    last_backup_at: extra.lastBackupAt,
  };
}

// ---- The lists behind the numbers ----

const byPriority = (a: ItemRow, b: ItemRow) => a.priority - b.priority || compareIds(a.id, b.id);

export function overviewItemsOf(
  s: Scoped,
  metric: OverviewMetric,
  window: OverviewWindow,
): OverviewItemsResponse {
  const toMs = ms(s.now);
  const items = [...s.items.values()];
  const activity = metric.startsWith('agents_') ? storyActivity(s) : null;
  let picked: ItemRow[];
  switch (metric) {
    case 'completed':
      picked = completedIn(items, toMs - OVERVIEW_WINDOW_MS[window], toMs).sort(
        (a, b) => ms(b.closed_at!) - ms(a.closed_at!) || compareIds(a.id, b.id),
      );
      break;
    case 'agents_working':
    case 'agents_waiting': {
      const state = metric === 'agents_working' ? 'working' : 'waiting';
      picked = items.filter((i) => activity!.get(i.id)?.state === state).sort(byPriority);
      break;
    }
    case 'in_flight':
      picked = items
        .filter((i) => isOpenTicket(i) && (i.status === 'progress' || i.status === 'review'))
        .sort(byPriority);
      break;
    case 'no_epic':
      picked = items.filter((i) => isOpenTicket(i) && i.epic_id === null).sort(byPriority);
      break;
  }
  const rows: OverviewItemRow[] = picked.slice(0, OVERVIEW_ITEMS_LIMIT).map((i) => ({
    id: i.id,
    title: i.title,
    type: i.type,
    status: i.status,
    blocked: isOpen(i.status) && s.index.state(i.id).blocked,
    project: i.project_key,
    epic_id: i.epic_id,
    epic_title: i.epic_id ? (s.items.get(i.epic_id)?.title ?? null) : null,
    closed_at: metric === 'completed' ? i.closed_at : null,
    agent: activity?.get(i.id)?.agent ?? null,
  }));
  return { metric, window, count: picked.length, rows };
}
