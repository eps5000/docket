/**
 * The collector's local files: state written atomically, a small log with no
 * content and no secrets, and the one-instance lock, which also carries the
 * graceful `stop`. State lives outside the repository.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
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

const STATE_VERSION = 1;
const LOG_LIMIT = 256 * 1024;
const INSTANCE_FILE = 'instance.json';

export function defaultHome(env = process.env, platform = process.platform) {
  if (env.DOCKET_SYNC_HOME) return env.DOCKET_SYNC_HOME;
  if (platform === 'win32' && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, 'docket-sync');
  return join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'docket-sync');
}

export const emptyState = () => ({ version: STATE_VERSION, sources: {} });

/** What the runner keeps for one source. `state` is the source's own and opaque here. */
export const emptySource = () => ({
  state: {},
  next_at: 0,
  failures: 0,
  last_attempt_at: null,
  last_success_at: null,
  last_error: null,
  records_sent: 0,
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

function parseState(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isMap(parsed) || parsed.version !== STATE_VERSION || !isMap(parsed.sources)) return null;
  if (!Object.values(parsed.sources).every((s) => isMap(s) && isMap(s.state))) return null;
  const sources = Object.fromEntries(
    Object.entries(parsed.sources).map(([name, s]) => [name, { ...emptySource(), ...s }]),
  );
  return { version: STATE_VERSION, sources };
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
 * is kept as a copy and the sources start again: every record is idempotent,
 * so that costs one full read and loses nothing. A file the OS won't let us
 * read is left alone: this throws `state_unavailable`.
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
  let recovered = false;
  if (text !== null) {
    const parsed = parseState(text);
    if (parsed) {
      state = parsed;
    } else {
      copyFileSync(path, `${path}.corrupt-${now()}`);
      writeAtomic(path, JSON.stringify(state));
      recovered = true;
    }
  }
  return {
    path,
    state,
    recovered,
    source(name) {
      state.sources[name] ??= emptySource();
      return state.sources[name];
    },
    save: () => writeAtomic(path, JSON.stringify(state)),
  };
}

/** Read-only, for `status`: never moves or rewrites anything. */
export function inspectState(home) {
  let text;
  try {
    text = readWithRetry(join(home, 'state.json'));
  } catch (err) {
    return { state: null, unreadable: err.code !== 'ENOENT' };
  }
  const state = parseState(text);
  return { state, unreadable: state === null };
}

/** GitHub token shapes, and anything after a credential word. Never written anywhere. */
const SECRET_SHAPES = [
  /\bgh[opsur]_[A-Za-z0-9_]{10,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{10,}/g,
  /\b(token|authorization|password|secret|bearer)\b\s*[:=]?\s*\S+/gi,
];

export function redact(text) {
  return SECRET_SHAPES.reduce((out, shape) => out.replace(shape, '[withheld]'), String(text));
}

/** `log(event, fields)`: names, counts and error codes only. Values are redacted as well. */
export function createLog(home, { echo = false } = {}) {
  mkdirSync(home, { recursive: true });
  const path = join(home, 'sync.log');
  return (event, fields = {}) => {
    const detail = Object.entries(fields)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => `${key}=${redact(Array.isArray(value) ? value.join('+') : value)}`)
      .join(' ');
    const line = `${new Date().toISOString()} ${redact(event)}${detail ? ` ${detail}` : ''}\n`;
    try {
      if (statSync(path).size > LOG_LIMIT) renameSync(path, `${path}.1`);
    } catch {
      // No log yet.
    }
    try {
      appendFileSync(path, line, { mode: 0o600 });
    } catch {
      // Logging must never stop a sync.
    }
    if (echo) process.stdout.write(line);
  };
}

/** POSIX limits a socket's path to about 104 bytes. */
const SOCKET_PATH_MAX = 100;

/**
 * Per state folder. On POSIX it sits in that folder, so two processes with
 * different temp folders still share one lock.
 */
export function lockAddress(home, platform = process.platform) {
  const id = createHash('sha256').update(home.toLowerCase()).digest('hex').slice(0, 24);
  if (platform === 'win32') return `\\\\.\\pipe\\docket-sync-${id}`;
  const inHome = join(home, 'sync.sock');
  return Buffer.byteLength(inHome) < SOCKET_PATH_MAX
    ? inHome
    : join(tmpdir(), `docket-sync-${id}.sock`);
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

const sameText = (a, b) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * Asks the running instance to stop, over its lock. The token sits in the
 * user's own state folder, so only someone who can read that folder can ask.
 * Resolves to `stopping`, `refused` or `unreachable`.
 */
export function requestStop(home, timeoutMs = 3000) {
  let token;
  try {
    token = JSON.parse(readFileSync(join(home, INSTANCE_FILE), 'utf8')).stop_token;
  } catch {
    return Promise.resolve('refused');
  }
  return new Promise((resolve) => {
    const socket = net.connect(lockAddress(home));
    let reply = '';
    const done = (answer) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => done('unreachable'));
    socket.once('connect', () => socket.write(`stop ${token}\n`));
    socket.on('data', (chunk) => {
      reply += chunk;
      if (reply.includes('\n')) done(reply.trim() === 'stopping' ? 'stopping' : 'refused');
    });
    socket.once('error', () => done('unreachable'));
    socket.once('end', () => done(reply.trim() === 'stopping' ? 'stopping' : 'refused'));
  });
}

/**
 * The lock is a listening pipe or socket: the OS frees it when the process
 * dies, so a crash can't leave a stale lock or be fooled by a reused PID.
 * Resolves to a release function, or null when another instance holds it.
 * With `onStop`, a client holding the stop token can ask this instance to stop.
 */
export async function acquireLock(home, { onStop } = {}) {
  mkdirSync(home, { recursive: true });
  const address = lockAddress(home);
  const token = onStop ? randomBytes(24).toString('hex') : null;
  const answer = (socket) => {
    let text = '';
    socket.setEncoding('utf8');
    socket.setTimeout(2000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      text += chunk;
      if (text.length > 256) {
        socket.destroy();
        return;
      }
      if (!text.includes('\n')) return;
      const accepted = token !== null && sameText(text.trim(), `stop ${token}`);
      socket.end(accepted ? 'stopping\n' : 'refused\n');
      if (accepted) onStop();
    });
  };
  const listen = () =>
    new Promise((resolve, reject) => {
      const server = net.createServer(answer);
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
  // Who this instance is, for `stop` and for manage.ps1. A hard kill leaves it behind.
  const instancePath = join(home, INSTANCE_FILE);
  if (token) {
    mkdirSync(home, { recursive: true });
    writeAtomic(
      instancePath,
      JSON.stringify({
        pid: process.pid,
        started_ms: Math.round(Date.now() - process.uptime() * 1000),
        exe: process.execPath,
        script: process.argv[1],
        stop_token: token,
      }),
    );
  }
  return () =>
    new Promise((resolve) => {
      if (token) rmSync(instancePath, { force: true });
      server.close(() => resolve());
    });
}
