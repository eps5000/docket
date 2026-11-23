/**
 * The daily brief (owner decision 48; BUILD_SPEC §5.29): what finished and what
 * changed in decisions on one day in the configured timezone, and what's stuck
 * now. Read-only and advisory. What needs the owner is `GET /api/needs-you`.
 * There is no cost section until measured data exists, and never an estimate.
 */
import { BRIEF_ROWS, type BriefDecision, type BriefResponse, type WaitCard } from '@docket/shared';
import { effectiveZone, localDay } from './forecast.js';
import { nextDay } from './flow.js';
import { leaseExpired, ms, type RunRow } from './model.js';
import { completedIn, isOpenTicket } from './overview.js';
import type { Scoped } from './views.js';
import { WaitReader } from './wait.js';

const HOUR_MS = 3_600_000;

/**
 * The first instant of a local calendar day. Searched rather than computed, so
 * a day that starts at 01:00 because of a clock change still starts correctly.
 */
export function dayStart(day: string, tz: string | null): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const midnightUtc = Date.UTC(y, m - 1, d);
  // Wider than any UTC offset, so `low` is always before the day and `high` inside or after it.
  let low = midnightUtc - 15 * HOUR_MS;
  let high = midnightUtc + 15 * HOUR_MS;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (localDay(new Date(middle).toISOString(), tz) >= day) high = middle;
    else low = middle;
  }
  return high;
}

const capped = <T>(rows: readonly T[]) => ({
  count: rows.length,
  rows: rows.slice(0, BRIEF_ROWS),
});

/** Until B58 lands the wait card has no `held_by`, and this group stays empty. */
type HeldCard = WaitCard & { held_by?: { decision_id: string; title: string } | null };

function stuckNow(s: Scoped): BriefResponse['stuck'] {
  const now = ms(s.now);
  const leads = s.db.sqlite
    .prepare(
      `SELECT * FROM runs WHERE is_lead = 1
       AND (state IN ('open', 'needs_input', 'parked') OR producer_hold_until IS NOT NULL)`,
    )
    .all() as RunRow[];

  const reader = new WaitReader(s.db, s.now, s.index);
  const parked: BriefResponse['stuck']['parked']['rows'] = [];
  const held: BriefResponse['stuck']['held']['rows'] = [];
  const owned = new Set<string>();
  for (const run of leads) {
    const active = ['open', 'needs_input', 'parked'].includes(run.state);
    if (active ? !leaseExpired(run, s.now) : ms(run.producer_hold_until!) > now) {
      owned.add(run.item_id);
    }
    const item = s.items.get(run.item_id);
    if (run.state !== 'parked' || !item || !isOpenTicket(item)) continue;
    const card = reader.card(run) as HeldCard;
    const base = { id: item.id, title: item.title, project: item.project_key };
    if (card.held_by) {
      held.push({
        ...base,
        since: card.waited_since,
        decision_id: card.held_by.decision_id,
        decision_title: card.held_by.title,
      });
    } else {
      parked.push({
        ...base,
        since: card.waited_since,
        // The step for a run that can resume names its run ID, which means nothing to the owner.
        next: card.resume_ready
          ? 'What it waited for has cleared, so it can resume.'
          : `Next step on ${card.next_owner.step}`,
      });
    }
  }
  const longestFirst = (a: { since: string; id: string }, b: { since: string; id: string }) =>
    ms(a.since) - ms(b.since) || a.id.localeCompare(b.id);
  parked.sort(longestFirst);
  held.sort(longestFirst);

  // How many open tickets each open ticket holds up.
  const blocks = new Map<string, number>();
  for (const item of s.items.values()) {
    if (!isOpenTicket(item)) continue;
    for (const id of s.index.state(item.id).blocked_by) {
      blocks.set(id, (blocks.get(id) ?? 0) + 1);
    }
  }
  const unowned = [...blocks].flatMap(([id, count]) => {
    const item = s.items.get(id);
    return item && isOpenTicket(item) && !owned.has(id) ? [{ item, count }] : [];
  });
  unowned.sort(
    (a, b) =>
      b.count - a.count || a.item.priority - b.item.priority || a.item.id.localeCompare(b.item.id),
  );

  return {
    parked: capped(parked),
    unowned_blockers: capped(
      unowned.map(({ item, count }) => ({
        id: item.id,
        title: item.title,
        project: item.project_key,
        status: item.status,
        blocks: count,
      })),
    ),
    held: capped(held),
  };
}

const DECISION_EVENTS: Record<string, BriefDecision['change']> = {
  'decision.published': 'recorded',
  'decision.confirmed': 'confirmed',
  'decision.withdrawn': 'withdrawn',
  'decision.acknowledged': 'acknowledged',
};

/**
 * What changed in decisions in `(from, to]`, newest first. A replacement is one
 * line, on the new record. An undone change and its undo are both left out,
 * even when the undo fell just after the end of the day.
 */
function decisionChanges(s: Scoped, from: string, to: string): BriefResponse['decisions'] {
  const events = s.db.sqlite
    .prepare(
      `SELECT at, type, actor_kind, project_key, item_id, mutation_id,
         json_extract(data, '$.decision_id') AS decision_id,
         json_extract(data, '$.supersedes') AS supersedes,
         json_extract(data, '$.undo_of') AS undo_of
       FROM events
       WHERE type IN (SELECT value FROM json_each(?)) AND at > ?
       ORDER BY seq DESC`,
    )
    .all(JSON.stringify(Object.keys(DECISION_EVENTS)), from) as {
    at: string;
    type: string;
    actor_kind: string;
    project_key: string | null;
    item_id: string | null;
    mutation_id: string;
    decision_id: string | null;
    supersedes: string | null;
    undo_of: string | null;
  }[];
  const undone = new Set(events.flatMap((e) => (e.undo_of ? [e.undo_of] : [])));
  const kept = events.filter(
    (e) =>
      !e.undo_of &&
      !undone.has(e.mutation_id) &&
      e.decision_id !== null &&
      ms(e.at) <= ms(to) &&
      s.inScope(e.project_key),
  );
  const titles = new Map(
    (
      s.db.sqlite
        .prepare(
          'SELECT id, title FROM decision_records WHERE id IN (SELECT value FROM json_each(?))',
        )
        .all(JSON.stringify(kept.map((e) => e.decision_id))) as { id: string; title: string }[]
    ).map((d) => [d.id, d.title]),
  );
  const rows = kept.flatMap((e): BriefDecision[] => {
    const title = titles.get(e.decision_id!);
    if (!title) return [];
    return [
      {
        decision_id: e.decision_id!,
        title,
        change: e.supersedes ? 'replaced' : DECISION_EVENTS[e.type]!,
        by: e.actor_kind === 'owner' ? 'owner' : 'agent',
        at: e.at,
        project: e.project_key!,
        item_id: e.item_id,
      },
    ];
  });
  return capped(rows);
}

export function briefOf(
  s: Scoped,
  input: { day?: string | undefined },
  tz: string | null,
): BriefResponse {
  const today = localDay(s.now, tz);
  const asked = input.day ?? today;
  const day = asked > today ? today : asked;
  const fromMs = dayStart(day, tz) - 1;
  const toMs = Math.min(ms(s.now), dayStart(nextDay(day), tz) - 1);
  const from = new Date(fromMs).toISOString();
  const to = new Date(toMs).toISOString();
  const finished = completedIn(s.items.values(), fromMs, toMs).sort(
    (a, b) => ms(b.closed_at!) - ms(a.closed_at!) || a.id.localeCompare(b.id),
  );
  return {
    day,
    today,
    timezone: effectiveZone(tz),
    from,
    to,
    finished: capped(
      finished.map((i) => ({
        id: i.id,
        title: i.title,
        project: i.project_key,
        closed_at: i.closed_at!,
      })),
    ),
    stuck: stuckNow(s),
    decisions: decisionChanges(s, from, to),
  };
}
