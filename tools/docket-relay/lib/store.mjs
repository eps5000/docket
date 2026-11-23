/**
 * The relay's local files: state written atomically, a small log with no
 * message content, and the one-instance lock.
 */
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { holdRecord } from './hold.mjs';

const STATE_VERSION = 1;
const LOG_LIMIT = 256 * 1024;

export function defaultHome(env = process.env, platform = process.platform) {
  if (env.DOCKET_RELAY_HOME) return env.DOCKET_RELAY_HOME;
  if (platform === 'win32' && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, 'docket-relay');
  return join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'docket-relay');
}

export const emptyState = () => ({
  version: STATE_VERSION,
  cursor: null,
  /** The feed row at the cursor, to tell a replaced feed from the one we read. */
  anchor: null,
  /** When the relay last read the feed. A gap of 24 hours or more means a hold. */
  active_at: null,
  /** Set while in `hold_reconcile`. Only the `reconcile` command clears it. */
  hold: null,
  /** What each `reconcile` did, newest last. */
  reconciles: [],
  seen: {},
  batches: {},
  rate: {},
  undelivered: [],
  counters: {
    ignored: 0,
    delivered: 0,
    no_live_lead: 0,
    not_owner: 0,
    undelivered: 0,
    send_failures: 0,
    skipped: 0,
  },
  docket: { connected: false, at: null, error: null },
  last_event: null,
  last_delivery: null,
  last_failure: null,
});

/** Writes beside the target and renames, so a crash leaves the old file or the new one. */
function writeAtomic(path, text) {
  const temp = `${path}.${process.pid}.tmp`;
  const fd = openSync(temp, 'w', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(temp, path);
      return;
    } catch (err) {
      // Windows: a virus scanner or reader can hold the target for a moment.
      if (attempt >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
        rmSync(temp, { force: true });
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
    }
  }
}

const isMap = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The state in `text` with defaults filled in, or null when it can't be trusted. */
function parseState(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isMap(parsed) || parsed.version !== STATE_VERSION) return null;
  const cursorOk =
    parsed.cursor === null ||
    (typeof parsed.cursor === 'string' && /^\d{1,15}$/.test(parsed.cursor));
  const batchesOk =
    isMap(parsed.batches) &&
    Object.values(parsed.batches).every(
      (batch) => isMap(batch) && Array.isArray(batch.events) && Number.isFinite(batch.first_at),
    );
  if (
    !cursorOk ||
    !batchesOk ||
    !isMap(parsed.seen) ||
    !isMap(parsed.rate) ||
    !isMap(parsed.counters) ||
    !Array.isArray(parsed.undelivered)
  ) {
    return null;
  }
  const base = emptyState();
  return { ...base, ...parsed, counters: { ...base.counters, ...parsed.counters } };
}

function readWithRetry(path) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return readFileSync(path, 'utf8');
    } catch (err) {
      if (attempt >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
    }
  }
}

/**
 * Opens the state. A missing file is a first run. A file that can't be parsed
 * is kept as a copy and replaced by a state in `hold_reconcile`, in that order,
 * so a crash between the two can't turn it into a first run. A file the OS
 * won't let us read is left alone: this throws `state_unavailable`.
 */
export function openStore(home, now = Date.now) {
  mkdirSync(home, { recursive: true });
  const path = join(home, 'state.json');
  let state = emptyState();
  let text = null;
  try {
    text = readWithRetry(path);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw Object.assign(new Error('state_unavailable'), { code: 'state_unavailable' });
    }
  }
  if (text !== null) {
    const parsed = parseState(text);
    if (parsed) {
      state = parsed;
    } else {
      const t = now();
      copyFileSync(path, `${path}.corrupt-${t}`);
      state.hold = holdRecord('state_unreadable', t);
      writeAtomic(path, JSON.stringify(state));
    }
  }
  return {
    path,
    state,
    save: () => writeAtomic(path, JSON.stringify(state)),
  };
}

/** Read-only, for `status`: never moves or rewrites anything. */
export function inspectState(home) {
  let text;
  try {
    // With retries: on Windows the relay's atomic save can briefly block a reader.
    text = readWithRetry(join(home, 'state.json'));
  } catch (err) {
    return { state: null, unreadable: err.code !== 'ENOENT' };
  }
  const state = parseState(text);
  return { state, unreadable: state === null };
}

/** `log(event, fields)`: ids, kinds and error codes only. Never a summary or message body. */
export function createLog(home, { echo = false } = {}) {
  mkdirSync(home, { recursive: true });
  const path = join(home, 'relay.log');
  return (event, fields = {}) => {
    const detail = Object.entries(fields)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join('+') : value}`)
      .join(' ');
    const line = `${new Date().toISOString()} ${event}${detail ? ` ${detail}` : ''}\n`;
    try {
      if (statSync(path).size > LOG_LIMIT) renameSync(path, `${path}.1`);
    } catch {
      // No log yet.
    }
    try {
      appendFileSync(path, line, { mode: 0o600 });
    } catch {
      // Logging must never stop a delivery.
    }
    if (echo) process.stdout.write(line);
  };
}

export function lockAddress(home, platform = process.platform) {
  const id = createHash('sha256').update(home.toLowerCase()).digest('hex').slice(0, 24);
  return platform === 'win32'
    ? `\\\\.\\pipe\\docket-relay-${id}`
    : join(tmpdir(), `docket-relay-${id}.sock`);
}

const connects = (address) =>
  new Promise((resolve) => {
    const socket = net.connect(address);
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });

/** Whether an instance holds the lock. */
export const isRunning = (home) => connects(lockAddress(home));

/**
 * The lock is a listening pipe or socket: the OS frees it when the process
 * dies, so a crash can't leave a stale lock or be fooled by a reused PID.
 * Resolves to a release function, or null when another instance holds it.
 */
export async function acquireLock(home) {
  const address = lockAddress(home);
  const listen = () =>
    new Promise((resolve, reject) => {
      const server = net.createServer((socket) => socket.end());
      server.once('error', reject);
      server.listen(address, () => {
        server.removeAllListeners('error');
        server.unref();
        resolve(server);
      });
    });
  let server;
  try {
    server = await listen();
  } catch (err) {
    if (err.code !== 'EADDRINUSE' || process.platform === 'win32') return null;
    if (await connects(address)) return null;
    // A socket file left by a crash on POSIX.
    rmSync(address, { force: true });
    try {
      server = await listen();
    } catch {
      return null;
    }
  }
  return () => new Promise((resolve) => server.close(() => resolve()));
}
