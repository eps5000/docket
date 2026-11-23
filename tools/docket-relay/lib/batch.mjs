/** Adding a feed event to its ticket's batch. An event is never dropped for its age. */
import { randomUUID } from 'node:crypto';
import { classifyEvent } from './classify.mjs';

/** What the event means, or null when it was seen before or doesn't count. */
export function recordEvent(s, event, t) {
  const key = `${event.cursor}:${event.at}`;
  if (s.seen[key] !== undefined) return null;
  const meaning = classifyEvent(event);
  if (!meaning) {
    s.counters.ignored += 1;
    return null;
  }
  s.seen[key] = t;
  const eventMs = Date.parse(event.at);
  const batch = (s.batches[event.item_id] ??= {
    id: randomUUID(),
    item_id: event.item_id,
    events: [],
    first_at: t,
    last_at: t,
    next_attempt_at: 0,
    defers: 0,
  });
  batch.events.push({
    key,
    cursor: String(event.cursor),
    kinds: meaning.kinds,
    immediate: meaning.immediate,
    expect: meaning.expect,
    event_ms: Number.isFinite(eventMs) ? eventMs : t,
  });
  batch.last_at = t;
  s.last_event = { at: event.at, item: event.item_id, kinds: meaning.kinds };
  return meaning;
}
