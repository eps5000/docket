/**
 * What a state file must satisfy before the relay acts on it (B55b). A failure
 * means `hold_reconcile`. Times against the clock are checked in relay.mjs.
 */
import { ITEM_RE, KNOWN_KINDS } from './classify.mjs';
import { continuationProblem } from './continuation.mjs';

const CURSOR = /^\d{1,15}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXPECTED_ACTORS = new Set(['owner', 'system']);

const isMap = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isTime = (value) => typeof value === 'number' && Number.isFinite(value);

function eventProblem(event, cursor) {
  if (!isMap(event) || typeof event.key !== 'string') return 'event_shape';
  if (!CURSOR.test(event.cursor ?? '') || !event.key.startsWith(`${event.cursor}:`)) {
    return 'event_cursor';
  }
  if (Number(event.cursor) > cursor) return 'event_past_cursor';
  if (
    !Array.isArray(event.kinds) ||
    event.kinds.length === 0 ||
    !event.kinds.every((kind) => KNOWN_KINDS.has(kind))
  ) {
    return 'event_kinds';
  }
  if (typeof event.immediate !== 'boolean' || !EXPECTED_ACTORS.has(event.expect)) {
    return 'event_shape';
  }
  return isTime(event.event_ms) ? null : 'event_time';
}

function batchProblem(item, batch, cursor) {
  if (!isMap(batch) || batch.item_id !== item || !ITEM_RE.test(item)) return 'batch_item';
  if (!UUID.test(batch.id ?? '')) return 'batch_id';
  if (!Array.isArray(batch.events) || batch.events.length === 0) return 'batch_events';
  const keys = new Set();
  for (const event of batch.events) {
    const problem = eventProblem(event, cursor);
    if (problem) return problem;
    if (keys.has(event.key)) return 'event_repeated';
    keys.add(event.key);
  }
  if (
    !isTime(batch.first_at) ||
    !isTime(batch.last_at) ||
    batch.first_at > batch.last_at ||
    !isTime(batch.next_attempt_at ?? 0) ||
    !Number.isInteger(batch.defers ?? 0) ||
    (batch.defers ?? 0) < 0
  ) {
    return 'batch_clock';
  }
  if (batch.in_flight !== undefined) {
    const flying = batch.in_flight?.keys;
    if (!Array.isArray(flying) || flying.length === 0 || !flying.every((key) => keys.has(key))) {
      return 'in_flight';
    }
  }
  return null;
}

/** A short code for the first broken invariant, or null. */
export function stateProblem(s) {
  const continuation = continuationProblem(s.continuations);
  if (continuation) return continuation;
  if (s.cursor === null) {
    if (s.anchor !== null) return 'anchor_without_cursor';
    if (Object.keys(s.seen).length > 0) return 'seen_ahead';
    return Object.keys(s.batches).length > 0 ? 'batches_without_cursor' : null;
  }
  if (typeof s.cursor !== 'string' || !CURSOR.test(s.cursor)) return 'cursor';
  if (Number(s.cursor) === 0) {
    if (s.anchor !== null) return 'anchor_mismatch';
  } else if (
    !isMap(s.anchor) ||
    s.anchor.cursor !== s.cursor ||
    typeof s.anchor.at !== 'string' ||
    s.anchor.at.length === 0
  ) {
    return 'anchor_mismatch';
  }
  for (const [item, batch] of Object.entries(s.batches)) {
    const problem = batchProblem(item, batch, Number(s.cursor));
    if (problem) return problem;
  }
  for (const times of Object.values(s.rate)) {
    if (!Array.isArray(times) || !times.every(isTime)) return 'rate';
  }
  for (const [key, at] of Object.entries(s.seen)) {
    const cursor = key.slice(0, key.indexOf(':'));
    if (!isTime(at) || !CURSOR.test(cursor)) return 'seen';
    if (Number(cursor) > Number(s.cursor)) return 'seen_ahead';
  }
  return null;
}
