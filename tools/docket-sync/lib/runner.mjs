/**
 * Runs each source on its interval. For one source:
 *
 * 1. read its settings from Docket; if Docket is down, nothing else happens,
 *    so no GitHub request is spent on data that couldn't be delivered;
 * 2. `collect`, then post the records in batches;
 * 3. save the source's `state` only after every batch was accepted.
 *
 * A failure keeps the old state and backs off. Every record is idempotent by
 * its `key`, so sending a batch twice changes nothing.
 */
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const BATCH_SIZE = 200;
export const TICK_MS = 30_000;
const BACKOFF_START_MS = 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;
const RATE_BACKOFF_MS = 15 * 60_000;

const SOURCES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'sources');

const isSource = (mod) =>
  typeof mod?.name === 'string' &&
  /^[a-z][a-z0-9-]{0,39}$/.test(mod.name) &&
  Number.isFinite(mod.intervalMs) &&
  mod.intervalMs > 0 &&
  typeof mod.enabled === 'function' &&
  typeof mod.collect === 'function';

/** Every valid source in `sources/`, by file name. A broken file is logged and skipped. */
export async function loadSources(log, dir = SOURCES_DIR) {
  const sources = [];
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.mjs'))
    .sort()) {
    try {
      const imported = await import(pathToFileURL(join(dir, file)).href);
      const mod = imported.default ?? imported;
      if (isSource(mod)) sources.push(mod);
      else log('source_invalid', { file });
    } catch (err) {
      log('source_invalid', { file, error: err.code ?? 'load_failed' });
    }
  }
  return sources;
}

/** A source may send smaller batches (B76: its records can be larger), never larger ones. */
const batchOf = (source) =>
  Number.isInteger(source.batchSize) && source.batchSize > 0
    ? Math.min(source.batchSize, BATCH_SIZE)
    : BATCH_SIZE;

export function backoffMs(failures, code) {
  const exponential = Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** Math.max(0, failures - 1));
  return code === 'rate_limited' ? Math.max(RATE_BACKOFF_MS, exponential) : exponential;
}

/** A short code for what went wrong. Never an error message, which could quote output. */
const codeOf = (err) =>
  typeof err?.code === 'string' && /^[a-z0-9_]{1,40}$/.test(err.code) ? err.code : 'collect_failed';

/** Errors from Docket's side: there's no one to report them to. */
const DOCKET_CODES = new Set([
  'unreachable',
  'docket_error',
  'needs_local_trust',
  'bad_response',
  'rejected',
]);

export function createRunner({ docket, sources, store, log, now = Date.now }) {
  const fail = async (source, entry, err, signal) => {
    const code = codeOf(err);
    entry.failures += 1;
    entry.last_error = code;
    entry.next_at = now() + backoffMs(entry.failures, code);
    log('source_failed', { source: source.name, error: code, failures: entry.failures });
    store.save();
    // Tell Settings why, unless the failure is that Docket can't be told.
    if (DOCKET_CODES.has(code)) return;
    try {
      await docket.post(
        source.name,
        { records: [], run: { ok: false, error: code, interval_ms: source.intervalMs } },
        { signal },
      );
    } catch (postErr) {
      if (signal?.aborted) return;
      log('report_failed', { source: source.name, error: codeOf(postErr) });
    }
  };

  /** One source, once. Returns `ran`, `skipped`, `disabled`, `unknown` or `failed`. */
  const runSource = async (source, { signal, force = false } = {}) => {
    const entry = store.source(source.name);
    if (!force && now() < entry.next_at) return 'skipped';
    let info;
    try {
      info = await docket.readSource(source.name, { signal });
    } catch (err) {
      if (signal?.aborted) return 'skipped';
      await fail(source, entry, err, signal);
      return 'failed';
    }
    if (info === null) {
      log('source_unknown', { source: source.name });
      entry.next_at = now() + source.intervalMs;
      store.save();
      return 'unknown';
    }
    const settings = info.settings ?? {};
    if (!source.enabled(settings)) {
      // Off: no GitHub call. Check again soon, so turning it on takes effect quickly.
      entry.next_at = now() + TICK_MS;
      entry.failures = 0;
      entry.last_error = null;
      store.save();
      return 'disabled';
    }
    entry.last_attempt_at = new Date(now()).toISOString();
    try {
      const result = await source.collect({
        state: structuredClone(entry.state),
        log,
        signal,
        settings,
        docket: docket.reader(),
      });
      const records = Array.isArray(result?.records) ? result.records : [];
      const size = batchOf(source);
      const total = Math.max(1, Math.ceil(records.length / size));
      for (let i = 0; i < total; i += 1) {
        const batch = records.slice(i * size, (i + 1) * size);
        await docket.post(
          source.name,
          {
            records: batch,
            // The last batch closes the run, so a run cut short never looks finished.
            run: { ok: i === total - 1, partial: i < total - 1, interval_ms: source.intervalMs },
          },
          { signal },
        );
      }
      entry.state = result?.state ?? entry.state;
      entry.failures = 0;
      entry.last_error = null;
      entry.last_success_at = new Date(now()).toISOString();
      entry.records_sent += records.length;
      entry.next_at = now() + source.intervalMs;
      store.save();
      log('source_ok', { source: source.name, records: records.length });
      return 'ran';
    } catch (err) {
      if (signal?.aborted) return 'skipped';
      await fail(source, entry, err, signal);
      return 'failed';
    }
  };

  return {
    runSource,

    /** Every source once, ignoring its schedule. Resolves to `{ name: outcome }`. */
    async once({ signal } = {}) {
      const out = {};
      for (const source of sources) {
        if (signal?.aborted) break;
        out[source.name] = await runSource(source, { signal, force: true });
      }
      return out;
    },

    /** Until `signal` aborts. One source at a time, so memory and API use stay small. */
    async run(signal, tickMs = TICK_MS) {
      while (!signal.aborted) {
        for (const source of sources) {
          if (signal.aborted) break;
          await runSource(source, { signal });
        }
        await new Promise((resolve) => {
          const timer = setTimeout(done, tickMs);
          function done() {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
          }
          signal.addEventListener('abort', done, { once: true });
        });
      }
    },
  };
}
