/**
 * The relay's local files: state written atomically, a small log with no
 * message content, and the one-instance lock.
 */
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
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
  seen: {},
  batches: {},
  rate: {},
  undelivered: [],
  counters: {
    ignored: 0,
    expired: 0,
    delivered: 0,
    via_coordinator: 0,
    no_live_lead: 0,
    not_owner: 0,
    undelivered: 0,
    send_failures: 0,
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

export function openStore(home) {
  mkdirSync(home, { recursive: true });
  const path = join(home, 'state.json');
  let state = emptyState();
  let recovered = false;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed?.version !== STATE_VERSION) throw new Error('version');
    const base = emptyState();
    state = { ...base, ...parsed, counters: { ...base.counters, ...parsed.counters } };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // An unreadable file can't say where it stopped: start at the end, never replay.
      recovered = true;
      try {
        renameSync(path, `${path}.corrupt`);
      } catch {
        // Nothing to keep.
      }
    }
  }
  return {
    path,
    state,
    recovered,
    save: () => writeAtomic(path, JSON.stringify(state)),
  };
}

/** Read-only, for `status`: never moves or rewrites anything. */
export function readState(home) {
  try {
    const parsed = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
    return parsed?.version === STATE_VERSION ? parsed : null;
  } catch {
    return null;
  }
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
