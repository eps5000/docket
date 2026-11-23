/**
 * `hold_reconcile` (B55b): after a long stop, or when the relay can't trust its
 * own position, it sends nothing and doesn't move its cursor until an operator
 * runs `reconcile`. Nothing leaves the hold automatically, and no event is
 * dropped without a record. Only ids, kinds, counts and times are kept here.
 */
import { recordEvent } from './batch.mjs';
import { classifyEvent } from './classify.mjs';
import { DocketError } from './docket.mjs';

export const HOLD_STATE = 'hold_reconcile';
/** The stored position can't be proved, so only `--skip-to-end` can leave the hold. */
const NO_POSITION = new Set(['state_unreadable', 'feed_reset', 'cursor_ahead']);
const RECORDS_KEPT = 20;
const ITEMS_RECORDED = 100;
const REASON_MAX = 200;

export const holdRecord = (reason, t, cursor = null) => ({
  state: HOLD_STATE,
  reason,
  since: new Date(t).toISOString(),
  cursor,
});

/** Whether `--deliver` has a position it can read the backlog from. */
export const canDeliver = (s) =>
  s.cursor !== null && !NO_POSITION.has(s.hold?.reason) && (s.anchor !== null || s.cursor === '0');

/** The feed's row at `cursor`, kept so a replaced feed can be told from the one we read. */
export async function readAnchor(docket, cursor, signal) {
  if (Number(cursor) === 0) return null;
  const page = await docket.wait({
    cursor: String(Number(cursor) - 1),
    timeoutS: 0,
    limit: 1,
    signal,
  });
  const row = page?.events[0];
  if (!row || String(row.cursor) !== String(cursor)) throw new DocketError('bad_response');
  return { cursor: String(row.cursor), at: row.at };
}

/** Null when the feed still holds the row we stopped at, or the reason it can't be trusted. */
export async function checkFeed(docket, s, signal) {
  if (!s.anchor) return null;
  const page = await docket.wait({
    cursor: String(Number(s.anchor.cursor) - 1),
    timeoutS: 0,
    limit: 1,
    signal,
  });
  if (!page) throw new DocketError('bad_response');
  const row = page.events[0];
  if (!row) return 'cursor_ahead';
  return String(row.cursor) === s.anchor.cursor && row.at === s.anchor.at ? null : 'feed_reset';
}

/** Reads from `from` to the end of the feed. Read-only. */
async function scanFeed(docket, from, onEvent, signal) {
  let cursor = from;
  let total = 0;
  let last = null;
  for (;;) {
    const page = await docket.wait({ cursor, timeoutS: 0, signal });
    if (!page) throw new DocketError('bad_response');
    if (Number(page.next_cursor) < Number(cursor)) throw new DocketError('cursor_ahead');
    for (const event of page.events) {
      total += 1;
      last = event;
      onEvent(event);
    }
    const stuck = page.next_cursor === cursor;
    cursor = page.next_cursor;
    if (!page.full || stuck) return { end: cursor, total, last };
  }
}

function createTally() {
  const items = new Map();
  let events = 0;
  let first = null;
  let latest = null;
  return {
    add(item, kinds, ms) {
      events += 1;
      const seen = items.get(item) ?? new Set();
      for (const kind of kinds) seen.add(kind);
      items.set(item, seen);
      if (Number.isFinite(ms)) {
        first = first === null ? ms : Math.min(first, ms);
        latest = latest === null ? ms : Math.max(latest, ms);
      }
    },
    addBatches(s) {
      for (const batch of Object.values(s.batches)) {
        for (const event of batch.events) this.add(batch.item_id, event.kinds, event.event_ms);
      }
    },
    addFeedEvent(event) {
      const meaning = classifyEvent(event);
      if (meaning) this.add(event.item_id, meaning.kinds, Date.parse(event.at));
    },
    facts: () => ({
      events,
      tickets: items.size,
      first_at: first === null ? null : new Date(first).toISOString(),
      last_at: latest === null ? null : new Date(latest).toISOString(),
    }),
    items: () =>
      [...items.entries()]
        .slice(0, ITEMS_RECORDED)
        .map(([item, kinds]) => ({ item, kinds: [...kinds] })),
  };
}

/**
 * For `status`: how many events wait and their time range, with no content.
 * `complete` is false when the feed couldn't be counted.
 */
export async function holdFacts(s, docket, signal) {
  const tally = createTally();
  tally.addBatches(s);
  let complete = false;
  if (canDeliver(s)) {
    try {
      if ((await checkFeed(docket, s, signal)) === null) {
        await scanFeed(docket, s.cursor, (event) => tally.addFeedEvent(event), signal);
        complete = true;
      }
    } catch {
      // Docket is down: report what the state file holds.
    }
  }
  return { ...tally.facts(), complete };
}

function remember(s, record) {
  s.reconciles = [...(s.reconciles ?? []), record].slice(-RECORDS_KEPT);
}

/** Leaves the hold by queueing the backlog per ticket. The next `start` sends it. */
export async function reconcileDeliver({ store, docket, log, now = Date.now, signal }) {
  const s = store.state;
  if (!s.hold) return { ok: false, code: 'not_in_hold' };
  if (!canDeliver(s)) return { ok: false, code: 'needs_skip', reason: s.hold.reason };
  const problem = await checkFeed(docket, s, signal);
  if (problem) {
    s.hold.reason = problem;
    store.save();
    log('hold_reconcile', { reason: problem, cursor: s.cursor });
    return { ok: false, code: 'needs_skip', reason: problem };
  }
  // Read everything first: a failure part-way leaves the hold and the cursor as they were.
  const found = [];
  let scan;
  try {
    scan = await scanFeed(
      docket,
      s.cursor,
      (event) => {
        if (classifyEvent(event)) found.push(event);
      },
      signal,
    );
  } catch (err) {
    if (err.code !== 'cursor_ahead') throw err;
    s.hold.reason = 'cursor_ahead';
    store.save();
    log('hold_reconcile', { reason: 'cursor_ahead', cursor: s.cursor });
    return { ok: false, code: 'needs_skip', reason: 'cursor_ahead' };
  }

  const t = now();
  const from = s.cursor;
  const heldFor = s.hold.reason;
  for (const event of found) recordEvent(s, event, t);
  s.counters.ignored += scan.total - found.length;
  if (scan.last) s.anchor = { cursor: String(scan.last.cursor), at: scan.last.at };
  s.cursor = scan.end;
  for (const batch of Object.values(s.batches)) {
    batch.first_at = t;
    batch.last_at = t;
    batch.next_attempt_at = 0;
    batch.defers = 0;
  }
  const tally = createTally();
  tally.addBatches(s);
  const facts = tally.facts();
  remember(s, {
    at: new Date(t).toISOString(),
    action: 'deliver',
    hold_reason: heldFor,
    from_cursor: from,
    to_cursor: scan.end,
    ...facts,
  });
  s.hold = null;
  s.active_at = t;
  store.save();
  log('reconcile_deliver', {
    hold_reason: heldFor,
    from: from,
    to: scan.end,
    events: facts.events,
    tickets: facts.tickets,
  });
  return { ok: true, ...facts };
}

/** One line of the operator's own words, or null. */
const cleanReason = (reason) => {
  const text = typeof reason === 'string' ? reason.trim() : '';
  // eslint-disable-next-line no-control-regex
  if (!text || text.length > REASON_MAX || /[\u0000-\u001f\u007f]/.test(text)) return null;
  return text;
};

/** Leaves the hold at the end of the feed, recording what was skipped. */
export async function reconcileSkip({ store, docket, log, now = Date.now, reason, signal }) {
  const s = store.state;
  if (!s.hold) return { ok: false, code: 'not_in_hold' };
  const why = cleanReason(reason);
  if (!why) return { ok: false, code: 'reason_required' };

  let tally = createTally();
  tally.addBatches(s);
  let end = null;
  let backlogKnown = false;
  if (canDeliver(s) && (await checkFeed(docket, s, signal)) === null) {
    try {
      const scan = await scanFeed(docket, s.cursor, (event) => tally.addFeedEvent(event), signal);
      end = scan.end;
      backlogKnown = true;
    } catch (err) {
      if (err.code !== 'cursor_ahead') throw err;
      // A partial count would mislead: go back to what the state file holds.
      tally = createTally();
      tally.addBatches(s);
    }
  }
  end ??= await docket.currentCursor({ signal });
  const anchor = await readAnchor(docket, end, signal);

  const t = now();
  const facts = tally.facts();
  const from = s.cursor;
  const heldFor = s.hold.reason;
  remember(s, {
    at: new Date(t).toISOString(),
    action: 'skip',
    reason: why,
    hold_reason: heldFor,
    from_cursor: from,
    to_cursor: end,
    backlog_known: backlogKnown,
    ...facts,
    items: tally.items(),
  });
  s.counters.skipped = (s.counters.skipped ?? 0) + facts.events;
  s.batches = {};
  s.cursor = end;
  s.anchor = anchor;
  s.hold = null;
  s.active_at = t;
  store.save();
  log('reconcile_skip', {
    reason: why,
    hold_reason: heldFor,
    from: from ?? 'unknown',
    to: end,
    events: facts.events,
    tickets: facts.tickets,
    first_at: facts.first_at,
    last_at: facts.last_at,
    backlog_known: backlogKnown,
    items: tally.items().map((entry) => entry.item),
  });
  return { ok: true, ...facts, backlog_known: backlogKnown };
}
