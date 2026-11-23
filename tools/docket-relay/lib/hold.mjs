/**
 * `hold_reconcile` (B55b): after a long stop, or when the relay can't trust its
 * own position, it sends nothing and doesn't move its cursor until an operator
 * runs `reconcile`. Nothing leaves the hold automatically, and no event is
 * dropped without a record. Only ids, kinds, counts and times are kept here.
 */
import { randomUUID } from 'node:crypto';
import { recordEvent } from './batch.mjs';
import { classifyEvent, ITEM_RE, KNOWN_KINDS } from './classify.mjs';
import { DocketError } from './docket.mjs';
import { stateProblem } from './invariants.mjs';

export const HOLD_STATE = 'hold_reconcile';
/** The stored position can't be proved, so only `--skip-to-end` can leave the hold. */
const NO_POSITION = new Set(['state_unreadable', 'feed_reset', 'cursor_ahead']);
const RECORDS_KEPT = 20;
const REASON_MAX = 200;

export const holdRecord = (reason, t, cursor = null, detail = null) => ({
  state: HOLD_STATE,
  reason,
  since: new Date(t).toISOString(),
  cursor,
  ...(detail ? { detail } : {}),
});

/** Whether `--deliver` has a position it can read the backlog from. */
export const canDeliver = (s) =>
  s.cursor !== null && !NO_POSITION.has(s.hold?.reason) && stateProblem(s) === null;

/** A page must continue exactly from `cursor`, in order, and end at its `next_cursor`. */
export function pageIsCoherent(page, cursor) {
  let previous = Number(cursor);
  for (const event of page.events) {
    const at = Number(event?.cursor);
    if (!Number.isSafeInteger(at) || at <= previous) return false;
    previous = at;
  }
  return Number(page.next_cursor) === previous;
}

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
    if (!pageIsCoherent(page, cursor)) throw new DocketError('feed_reset');
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

/** Counts by ticket. A state file's text never reaches a record: only valid ids and kinds do. */
function createTally() {
  const items = new Map();
  let events = 0;
  let first = null;
  let latest = null;
  return {
    add(item, kinds, ms) {
      events += 1;
      const name = typeof item === 'string' && ITEM_RE.test(item) ? item : 'invalid';
      const entry = items.get(name) ?? { kinds: new Set(), events: 0 };
      entry.events += 1;
      for (const kind of Array.isArray(kinds) ? kinds : []) {
        if (KNOWN_KINDS.has(kind)) entry.kinds.add(kind);
      }
      items.set(name, entry);
      if (Number.isFinite(ms)) {
        first = first === null ? ms : Math.min(first, ms);
        latest = latest === null ? ms : Math.max(latest, ms);
      }
    },
    addBatches(s) {
      for (const [item, batch] of Object.entries(s.batches)) {
        for (const event of batch.events) this.add(item, event?.kinds, event?.event_ms);
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
    /** Every ticket, with no cap. */
    items: () =>
      [...items.entries()].map(([item, entry]) => ({
        item,
        kinds: [...entry.kinds],
        events: entry.events,
      })),
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
        const counted = createTally();
        counted.addBatches(s);
        await scanFeed(docket, s.cursor, (event) => counted.addFeedEvent(event), signal);
        complete = true;
        return { ...counted.facts(), complete };
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

function recordProblem(store, log, problem) {
  const s = store.state;
  s.hold.reason = problem;
  store.save();
  log('hold_reconcile', { reason: problem, cursor: s.cursor });
  return { ok: false, code: 'needs_skip', reason: problem };
}

/** Leaves the hold by queueing the backlog per ticket. The next `start` sends it. */
export async function reconcileDeliver({ store, docket, log, now = Date.now, signal }) {
  const s = store.state;
  if (!s.hold) return { ok: false, code: 'not_in_hold' };
  if (!canDeliver(s)) return { ok: false, code: 'needs_skip', reason: s.hold.reason };
  const problem = await checkFeed(docket, s, signal);
  if (problem) return recordProblem(store, log, problem);
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
    if (err.code !== 'cursor_ahead' && err.code !== 'feed_reset') throw err;
    return recordProblem(store, log, err.code);
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

/**
 * Leaves the hold at the end of the feed. Every skipped ticket and its kinds go
 * to the append-only audit file first: if that write fails, nothing changes.
 */
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
      if (err.code !== 'cursor_ahead' && err.code !== 'feed_reset') throw err;
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
  const summary = {
    audit_id: randomUUID(),
    at: new Date(t).toISOString(),
    action: 'skip',
    reason: why,
    hold_reason: heldFor,
    from_cursor: from,
    to_cursor: end,
    backlog_known: backlogKnown,
    ...facts,
  };
  store.appendAudit({ ...summary, items: tally.items() });

  remember(s, summary);
  s.counters.skipped = (s.counters.skipped ?? 0) + facts.events;
  s.batches = {};
  // A replaced feed can end lower than the old one: its keys no longer mean anything.
  s.seen = Object.fromEntries(
    Object.entries(s.seen).filter(([key]) => Number(key.split(':', 1)[0]) <= Number(end)),
  );
  s.cursor = end;
  s.anchor = anchor;
  s.hold = null;
  s.active_at = t;
  store.save();
  log('reconcile_skip', {
    audit_id: summary.audit_id,
    reason: why,
    hold_reason: heldFor,
    from: from ?? 'unknown',
    to: end,
    events: facts.events,
    tickets: facts.tickets,
    first_at: facts.first_at,
    last_at: facts.last_at,
    backlog_known: backlogKnown,
  });
  return { ok: true, ...facts, backlog_known: backlogKnown, audit_id: summary.audit_id };
}
