/**
 * The relay (owner decision 46, B55b): watch the feed, batch what concerns each
 * ticket, and send its coordinator a pointer through Orca.
 *
 * It never writes to Docket and never calls MCP `get_item`, so it can't resume,
 * park, claim or use up a one-time delivery. Everything it owes is in the state
 * file before the cursor moves past it, so a restart neither loses nor repeats
 * it. After a long stop, or when it can't trust its position, it enters
 * `hold_reconcile` (hold.mjs): nothing is sent and the cursor stays put.
 */
import { randomUUID } from 'node:crypto';
import { runContinuationLoop } from './continuation.mjs';
import { recordEvent } from './batch.mjs';
import { buildMessage, orderKinds } from './classify.mjs';
import { checkFeed, holdRecord, pageIsCoherent, readAnchor } from './hold.mjs';
import { stateProblem } from './invariants.mjs';
import { requestIdFor } from './orca.mjs';
import { liveLead, partialLead, resolveCoordinator } from './target.mjs';

export const DEFAULTS = {
  /** A ticket's edits go out once it has been quiet this long… */
  quietMs: 60_000,
  /** …and no later than this after its first change. */
  maxWaitMs: 120_000,
  /** A gap this long since the last feed read, or a batch held this long, means a hold. */
  windowMs: 24 * 60 * 60 * 1000,
  /** A stored time further ahead of the clock than this can't be trusted. */
  clockSkewMs: 5 * 60 * 1000,
  pollTimeoutS: 50,
  /** Tries before holding the message for later. */
  sendAttempts: 3,
  retryDelayMs: 750,
  /** Per address. */
  rateLimit: 6,
  rateWindowMs: 10 * 60 * 1000,
  deferMinMs: 5_000,
  deferMaxMs: 5 * 60 * 1000,
  backoffMinMs: 1_000,
  backoffMaxMs: 30_000,
  tickMs: 1_000,
  seenLimit: 5_000,
  undeliveredLimit: 50,
};

const abortableSleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });

const kindsOf = (events) => orderedKinds(events.flatMap((event) => event.kinds));
const orderedKinds = (kinds) => [
  ...(kinds.includes('partial') ? ['partial'] : []),
  ...orderKinds(kinds),
  ...(kinds.includes('resume') ? ['resume'] : []),
];

export function createRelay({
  docket,
  orca,
  store,
  log = () => {},
  now = Date.now,
  sleep = abortableSleep,
  continuationMappings = [],
  options = {},
}) {
  const opts = { ...DEFAULTS, ...options };
  const s = store.state;
  let wake = null;
  let woken = false;
  let flushing = null;
  let halt = null;
  /** A hold waiting for the send in flight to finish and be recorded. */
  let pendingHold = null;
  let sendInFlight = false;
  /** The whole state file is checked once, before the relay first acts on it. */
  let invariantsChecked = false;
  /** The feed must be re-checked after every start and every lost connection. */
  let feedVerified = false;
  /** Nothing goes out until the backlog is read, so a catch-up is one message per ticket. */
  let draining = true;

  const notify = () => {
    woken = true;
    wake?.();
    wake = null;
  };

  /** Once true, no new send starts, nothing is ingested and the cursor stays put. */
  const blocked = () => s.hold !== null || pendingHold !== null;

  /** Writes the hold, unless a send is in flight: its result is recorded first. */
  function commitHold() {
    if (!pendingHold || s.hold || sendInFlight) return;
    const { reason, detail } = pendingHold;
    pendingHold = null;
    s.hold = holdRecord(reason, now(), s.cursor, detail);
    log('hold_reconcile', { reason, detail, cursor: s.cursor ?? 'none' });
    store.save();
  }

  function enterHold(reason, detail = null) {
    if (!blocked()) pendingHold = { reason, detail };
    commitHold();
    halt?.();
    notify();
    return true;
  }

  /** True when in a hold, entering one if the stored position or a held batch calls for it. */
  function assess(t = now()) {
    if (blocked()) {
      halt?.();
      notify();
      return true;
    }
    if (!invariantsChecked) {
      invariantsChecked = true;
      const problem = stateProblem(s);
      if (problem) return enterHold('state_untrusted', problem);
    }
    if (s.cursor === null) return false;
    if (!Number.isFinite(s.active_at)) return enterHold('state_untrusted', 'no_activity_time');
    if (s.active_at > t + opts.clockSkewMs) {
      return enterHold('state_untrusted', 'activity_in_future');
    }
    if (t - s.active_at >= opts.windowMs) return enterHold('stale');
    if (Object.values(s.batches).some((batch) => t - batch.first_at >= opts.windowMs)) {
      return enterHold('batch_past_window');
    }
    return false;
  }

  function prune(t) {
    const horizon = t - opts.windowMs - 60 * 60 * 1000;
    let entries = Object.entries(s.seen).filter(([, at]) => at >= horizon);
    if (entries.length > opts.seenLimit) {
      entries = entries.sort((a, b) => a[1] - b[1]).slice(-opts.seenLimit);
    }
    s.seen = Object.fromEntries(entries);
    for (const [address, times] of Object.entries(s.rate)) {
      const recent = times.filter((at) => t - at < opts.rateWindowMs);
      if (recent.length > 0) s.rate[address] = recent;
      else delete s.rate[address];
    }
  }

  /** Records a page and moves the cursor in one atomic write. */
  function ingest(page) {
    if (blocked()) return;
    const t = now();
    let immediate = false;
    for (const event of page.events) {
      immediate = recordEvent(s, event, t)?.immediate === true || immediate;
    }
    const last = page.events.at(-1);
    if (last) s.anchor = { cursor: String(last.cursor), at: last.at };
    s.cursor = page.next_cursor;
    s.active_at = t;
    prune(t);
    store.save();
    if (immediate) notify();
  }

  const isDue = (batch, t) =>
    t >= (batch.next_attempt_at ?? 0) &&
    (batch.events.some((event) => event.immediate) ||
      t - batch.last_at >= opts.quietMs ||
      t - batch.first_at >= opts.maxWaitMs);

  /** Removes what was handled. Anything that arrived meanwhile stays, on a fresh clock. */
  function settle(batch, handled) {
    if (s.hold) return;
    const keys = new Set(handled.map((event) => event.key));
    batch.events = batch.events.filter((event) => !keys.has(event.key));
    delete batch.in_flight;
    if (batch.events.length === 0) {
      delete s.batches[batch.item_id];
    } else {
      const t = now();
      batch.id = randomUUID();
      batch.first_at = t;
      batch.last_at = t;
      batch.next_attempt_at = 0;
      batch.defers = 0;
      if (batch.events.some((event) => event.immediate)) notify();
    }
    store.save();
  }

  function undeliver(batch, handled, reason) {
    if (s.hold) return;
    s.counters.undelivered += 1;
    s.undelivered.push({
      at: new Date(now()).toISOString(),
      item: batch.item_id,
      kinds: kindsOf(handled),
      reason,
    });
    s.undelivered = s.undelivered.slice(-opts.undeliveredLimit);
    log('undelivered', { item: batch.item_id, kinds: kindsOf(handled), reason });
    settle(batch, handled);
  }

  /** Try again later. A batch past the window is never expired: it puts the relay in a hold. */
  function defer(batch, reason, untilMs) {
    if (s.hold) return;
    const t = now();
    if (t - batch.first_at >= opts.windowMs) {
      s.last_failure = { at: new Date(t).toISOString(), reason };
      enterHold('batch_past_window');
      return;
    }
    batch.defers = (batch.defers ?? 0) + 1;
    const backoff = Math.min(opts.deferMinMs * 2 ** (batch.defers - 1), opts.deferMaxMs);
    batch.next_attempt_at = untilMs ?? t + backoff;
    s.last_failure = { at: new Date(t).toISOString(), reason };
    log('deferred', { item: batch.item_id, reason, retry_in_ms: batch.next_attempt_at - t });
    store.save();
  }

  const rateSlot = (address, t) => {
    const recent = (s.rate[address] ?? []).filter((at) => t - at < opts.rateWindowMs);
    return recent.length < opts.rateLimit ? null : recent[0] + opts.rateWindowMs;
  };

  async function sendWithRetries(pending, signal) {
    let result = { ok: false, code: 'not_sent', transient: true };
    for (let attempt = 1; attempt <= opts.sendAttempts; attempt += 1) {
      // A hold or a stop lets the current attempt finish, and starts no other.
      if (attempt > 1 && (blocked() || signal?.aborted)) return result;
      result = await orca.send({
        to: pending.to,
        subject: pending.subject,
        body: pending.body,
        requestId: pending.request_id,
      });
      if (result.ok || !result.transient) return result;
      s.counters.send_failures += 1;
      if (attempt < opts.sendAttempts && !blocked()) {
        await sleep(opts.retryDelayMs * attempt, signal);
      }
    }
    return result;
  }

  /**
   * Works out the message from what Docket and Orca say now, or handles the
   * batch and returns null. Stored state supplies only which events to name:
   * never a recipient and never message text. The request ID comes from the
   * batch and recipient alone, so a rebuilt message can't be delivered twice to
   * the same coordinator; if the coordinator changed, the old send is gone.
   */
  async function prepare(batch, signal) {
    const flying = batch.in_flight ? new Set(batch.in_flight.keys) : null;
    const events = flying
      ? batch.events.filter((event) => flying.has(event.key))
      : [...batch.events];
    const item = batch.item_id;

    let detail;
    try {
      detail = await docket.readItem(item, { signal });
    } catch (err) {
      if (signal?.aborted || blocked()) return null;
      if (err.code === 'needs_local_trust') undeliver(batch, events, 'needs_local_trust');
      else defer(batch, 'docket_unavailable');
      return null;
    }
    if (blocked()) return null;
    if (detail === null) {
      s.counters.no_live_lead += 1;
      settle(batch, events);
      return null;
    }

    // The feed has no actor kind; the item's activity does.
    const genuine = events.filter((event) => {
      const kind = detail.activity.get(event.cursor);
      return kind === undefined || kind === event.expect;
    });
    if (genuine.length < events.length) {
      s.counters.not_owner += events.length - genuine.length;
      log('ignored_not_owner', { item, count: events.length - genuine.length });
    }
    if (genuine.length === 0) {
      settle(batch, events);
      return null;
    }

    // Decision 61: a partial exit goes to the producer of the run that left it, live or ended.
    const partial = genuine.some((event) => event.kinds.includes('partial'));
    const lead = (partial ? partialLead(detail.runs) : null) ?? liveLead(detail.runs);
    if (!lead) {
      s.counters.no_live_lead += 1;
      log('no_live_lead', { item, kinds: kindsOf(genuine) });
      settle(batch, events);
      return null;
    }

    let target;
    try {
      target = await resolveCoordinator(lead, (id) => orca.showDispatch(id));
    } catch {
      if (!signal?.aborted && !blocked()) defer(batch, 'orca_unavailable');
      return null;
    }
    if (blocked()) return null;
    if (!target.coordinator) {
      undeliver(batch, events, 'no_target');
      return null;
    }

    const kinds = kindsOf(genuine);
    const message = buildMessage({ item, kinds, implementer: target.implementer });
    return {
      to: target.coordinator,
      ...message,
      kinds,
      handled: events,
      keys: events.map((event) => event.key),
      newest_ms: Math.max(...genuine.map((event) => event.event_ms)),
      request_id: requestIdFor(batch.id, target.coordinator),
    };
  }

  function recordResult(batch, pending, result, startedAt) {
    const item = batch.item_id;
    // `request_mismatch`: Orca already took this request ID with other text, so it was sent.
    if (result.ok || result.code === 'request_mismatch') {
      const sentAt = now();
      (s.rate[pending.to] ??= []).push(sentAt);
      s.counters.delivered += 1;
      const latencyMs = sentAt - pending.newest_ms;
      s.last_delivery = {
        at: new Date(sentAt).toISOString(),
        item,
        kinds: pending.kinds,
        to: pending.to,
        latency_ms: latencyMs,
      };
      log('delivered', { item, kinds: pending.kinds, to: pending.to, latency_ms: latencyMs });
      settle(batch, pending.handled);
      return;
    }
    s.last_failure = { at: new Date(startedAt).toISOString(), reason: result.code };
    log('send_failed', { item, to: pending.to, code: result.code });
    // Orca may only be busy: keep it for later. A refusal is final.
    if (result.transient) {
      defer(batch, 'orca_unavailable');
      return;
    }
    s.counters.send_failures += 1;
    undeliver(batch, pending.handled, 'send_failed');
  }

  async function deliver(batch, signal) {
    const pending = await prepare(batch, signal);
    if (!pending || blocked()) return;

    const t = now();
    const freeAt = rateSlot(pending.to, t);
    if (freeAt !== null) {
      defer(batch, 'rate_limited', freeAt);
      return;
    }
    batch.in_flight = { keys: pending.keys };
    store.save();

    // From here a hold waits: the send finishes, and its result is saved, before it is written.
    sendInFlight = true;
    try {
      const result = await sendWithRetries(pending, signal);
      recordResult(batch, pending, result, t);
    } finally {
      sendInFlight = false;
      commitHold();
    }
  }

  /** Sends everything due, one at a time. */
  function flushDue(signal) {
    if (flushing) return flushing;
    const current = (async () => {
      if (draining || assess()) return;
      for (const batch of Object.values(s.batches)) {
        if (signal?.aborted || blocked()) break;
        if (s.batches[batch.item_id] === batch && isDue(batch, now())) {
          await deliver(batch, signal);
        }
      }
    })();
    flushing = current;
    const clear = () => {
      if (flushing === current) flushing = null;
    };
    current.then(clear, clear);
    return current;
  }

  function setDocket(connected, error = null) {
    const changed = s.docket.connected !== connected || s.docket.error !== error;
    s.docket = { connected, error, at: new Date(now()).toISOString() };
    if (changed) {
      log(connected ? 'docket_connected' : 'docket_down', { error });
      store.save();
    }
  }

  /** The first run starts at the end of the feed, so old history is never replayed. */
  async function ensureCursor(signal) {
    if (s.cursor !== null) return;
    const cursor = await docket.currentCursor({ signal });
    const anchor = await readAnchor(docket, cursor, signal);
    s.cursor = cursor;
    s.anchor = anchor;
    s.active_at = now();
    feedVerified = true;
    log('started_at_cursor', { cursor });
    store.save();
  }

  async function readPage(signal, timeoutS) {
    await ensureCursor(signal);
    if (!feedVerified) {
      const problem = await checkFeed(docket, s, signal);
      if (blocked()) return null;
      if (problem) {
        enterHold(problem);
        return null;
      }
      feedVerified = true;
    }
    // While catching up, don't wait: what's already held shouldn't sit behind a long-poll.
    return docket.wait({ cursor: s.cursor, timeoutS: draining ? 0 : timeoutS, signal });
  }

  async function pollOnce(signal, timeoutS = opts.pollTimeoutS) {
    if (assess()) return null;
    let page;
    try {
      page = await readPage(signal, timeoutS);
    } catch (err) {
      feedVerified = false;
      draining = true;
      throw err;
    }
    if (blocked()) return null;
    setDocket(true);
    if (!page) return null;
    // The host may have slept through that wait, or the feed may have shrunk under it.
    if (assess()) return null;
    if (Number(page.next_cursor) < Number(s.cursor)) {
      enterHold('cursor_ahead');
      return null;
    }
    if (!pageIsCoherent(page, s.cursor)) {
      enterHold('feed_reset', 'incoherent_page');
      return null;
    }
    ingest(page);
    draining = page.full === true;
    return page;
  }

  async function pollLoop(signal) {
    let delay = opts.backoffMinMs;
    while (!signal.aborted) {
      try {
        await pollOnce(signal);
        delay = opts.backoffMinMs;
      } catch (err) {
        if (signal.aborted) break;
        setDocket(false, err.code ?? 'error');
        await sleep(Math.max(delay, err.retryAfterMs ?? 0), signal);
        delay = Math.min(delay * 2, opts.backoffMaxMs);
      }
    }
  }

  async function flushLoop(signal) {
    while (!signal.aborted) {
      woken = false;
      try {
        await flushDue(signal);
      } catch (err) {
        log('flush_error', { error: err?.code ?? err?.name ?? 'error' });
      }
      if (signal.aborted) break;
      // An answer that arrived during that flush goes now, not on the next tick.
      if (woken) continue;
      await Promise.race([
        sleep(opts.tickMs, signal),
        new Promise((resolve) => {
          wake = resolve;
        }),
      ]);
    }
  }

  /** Runs until `signal` aborts or the relay enters a hold. Resolves to the hold, or null. */
  async function run(signal) {
    const loops = new AbortController();
    const stop = () => {
      loops.abort();
      notify();
    };
    halt = stop;
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
    if (!assess()) {
      await Promise.all([
        pollLoop(loops.signal),
        flushLoop(loops.signal),
        runContinuationLoop(
          {
            mappings: continuationMappings,
            state: s,
            save: store.save,
            docket,
            orca,
            now,
            log,
          },
          loops.signal,
          sleep,
        ),
      ]);
    }
    // Whatever was in flight has finished and been recorded before the hold is reported.
    await flushing;
    commitHold();
    store.save();
    signal.removeEventListener('abort', stop);
    halt = null;
    return s.hold;
  }

  return { ingest, flushDue, pollOnce, run, state: s };
}
