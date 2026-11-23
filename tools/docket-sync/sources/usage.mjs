/**
 * The token-use source for the docket-sync runner (owner decision 48; B63;
 * BUILD_SPEC §5.30). Off by default. It reads the local Codex and Claude Code
 * session logs and reports how many tokens each model response used.
 *
 * Privacy is the point of how this file is written:
 * - With the source off it opens no log file. It asks Docket first.
 * - It keeps only numbers, model, session ID, time and working folder. A line is
 *   parsed, the allowed fields are copied out one by one and validated, and the
 *   parsed line is dropped. No message text is put in a record, the state or a
 *   log line. Parse errors are never logged, because they can quote the input.
 * - A session whose folder isn't a known workspace of a Docket project is never
 *   sent. Its folder isn't kept either, only short hashes, so the turns can be
 *   picked up if that folder later becomes known.
 *
 * Read-only and incremental by byte offset. A partial last line waits for the
 * next pass, a rotated file starts again (keys make a re-read harmless), and
 * each pass has a limit on bytes, time, records and line length.
 *
 * Counting:
 * - Codex: each `last_token_usage`, never the cumulative totals. A repeated
 *   token_count event has the same cumulative total, so the same key.
 * - Claude Code: one API response can span several log lines. Its `message.id`
 *   is the key, in any file, so subagent logs and resumed sessions count once.
 *   The largest value of each field wins, here and on the server.
 */
import { createHash } from 'node:crypto';
import { open, opendir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const name = 'usage';
export const intervalMs = 5 * 60_000;

/** The runner's check. Docket's answer in `collect` is what really decides. */
export function enabled(settings) {
  return settings?.usage?.enabled === true;
}

export const DEFAULT_LIMITS = Object.freeze({
  /** Bytes read in one pass. */
  maxBytes: 64 * 1024 * 1024,
  /** Wall-clock time in one pass. */
  maxMs: 8_000,
  /** Records in one pass (the sync route's limit). */
  maxRecords: 1000,
  /** A longer line can't be a usage line worth keeping in memory, and is skipped. */
  maxLineBytes: 4 * 1024 * 1024,
  /** Log files looked at in one pass. */
  maxFiles: 20_000,
  /** A file not seen before and older than this is left alone. */
  maxAgeDays: 60,
  chunkBytes: 256 * 1024,
});

const MAX_DEPTH = 8;
const MAX_ANCESTORS = 24;

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,120}$/;
const MODEL = /^[A-Za-z0-9._:/[\]-]{1,100}$/;

const shortHash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** Identical to `normalizeWorkspace` in shared/src/api/usage.ts (a test holds them together). */
export function normalizeWorkspace(path) {
  let out = path.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (out.length > 1) out = out.replace(/\/+$/, '');
  if (/^[A-Za-z]:(\/|$)/.test(out)) out = out.toLowerCase();
  return out;
}

/** The folder and each parent, nearest first. */
function ancestors(folder) {
  const out = [];
  let at = folder;
  while (at && out.length < MAX_ANCESTORS) {
    out.push(at);
    const cut = at.lastIndexOf('/');
    if (cut <= 0) break;
    at = at.slice(0, cut);
  }
  return out;
}

/** The longest known workspace holding `cwd`, or null. */
function matchWorkspace(cwd, known) {
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > 4096) return null;
  for (const folder of ancestors(normalizeWorkspace(cwd))) {
    if (known.set.has(folder)) return folder;
  }
  return null;
}

/** Remember an unknown folder as hashes only, so it can be recognised if it becomes known. */
function rememberUnknown(entry, cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > 4096) return;
  const seen = new Set(entry.u ?? []);
  for (const folder of ancestors(normalizeWorkspace(cwd))) {
    if (seen.size >= MAX_ANCESTORS) break;
    seen.add(shortHash(folder));
  }
  entry.u = [...seen];
}

const whole = (value) => (Number.isSafeInteger(value) && value > 0 ? value : 0);
const timeOf = (value) => {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};
const modelOf = (value) => (typeof value === 'string' && MODEL.test(value) ? value : null);

/** Two reads of one response: the largest of each number. */
function addRecord(records, record) {
  const had = records.get(record.key);
  if (!had) {
    records.set(record.key, record);
    return;
  }
  for (const field of ['fresh_input', 'cached_input', 'cache_write', 'cache_write_1h', 'output']) {
    had[field] = Math.max(had[field], record[field]);
  }
  had.model ??= record.model;
}

const hasTokens = (r) => r.fresh_input + r.cached_input + r.cache_write + r.output > 0;

// ---- Claude Code ----

function claudeLine(line, entry, known, records) {
  const message = line.message;
  if (!message || typeof message !== 'object') return;
  const usage = message.usage;
  if (!usage || typeof usage !== 'object') return;
  if (typeof message.id !== 'string' || !MESSAGE_ID.test(message.id)) return;
  if (typeof line.sessionId !== 'string' || !SESSION_ID.test(line.sessionId)) return;
  const at = timeOf(line.timestamp);
  if (!at) return;
  const workspace = matchWorkspace(line.cwd, known);
  if (!workspace) {
    rememberUnknown(entry, line.cwd);
    return;
  }
  const details = usage.cache_creation;
  const record = {
    key: `claude-code:${message.id}`,
    client: 'claude-code',
    session_id: line.sessionId,
    at,
    workspace,
    model: modelOf(message.model),
    // Claude reports these separately: input_tokens excludes both cache counts.
    fresh_input: whole(usage.input_tokens),
    cached_input: whole(usage.cache_read_input_tokens),
    cache_write: whole(usage.cache_creation_input_tokens),
    cache_write_1h:
      details && typeof details === 'object' ? whole(details.ephemeral_1h_input_tokens) : 0,
    output: whole(usage.output_tokens),
  };
  record.cache_write_1h = Math.min(record.cache_write_1h, record.cache_write);
  if (hasTokens(record)) addRecord(records, record);
}

// ---- Codex ----

const field = (usage, key) => whole(usage[`${key}_tokens`] ?? usage[key]);

/**
 * Codex's input count normally includes its cached tokens. When the reported
 * total shows they were counted on top instead, input is already fresh.
 */
function codexTokens(usage) {
  const input = field(usage, 'input');
  const cached = field(usage, 'cached_input');
  const write = field(usage, 'cache_write_input');
  const output = field(usage, 'output');
  const total = field(usage, 'total');
  const separate = cached + write > 0 && total === input + cached + write + output;
  return {
    fresh_input: separate ? input : Math.max(0, input - cached - write),
    cached_input: cached,
    cache_write: write,
    cache_write_1h: 0,
    output,
  };
}

function codexLine(line, entry, known, records, lineOffset) {
  const payload = line.payload;
  if (!payload || typeof payload !== 'object') return;
  if (line.type === 'session_meta') {
    const id = payload.session_id ?? payload.id;
    if (typeof id === 'string' && SESSION_ID.test(id)) entry.sid = id;
    codexFolder(payload.cwd, entry, known);
    return;
  }
  if (line.type === 'turn_context') {
    entry.model = modelOf(payload.model);
    if (payload.cwd !== undefined) codexFolder(payload.cwd, entry, known);
    return;
  }
  if (line.type !== 'event_msg' || payload.type !== 'token_count') return;
  const last = payload.info?.last_token_usage;
  if (!last || typeof last !== 'object' || !entry.ws || !entry.sid) return;
  const at = timeOf(line.timestamp);
  if (!at) return;
  const cumulative = payload.info.total_token_usage;
  const total = cumulative && typeof cumulative === 'object' ? field(cumulative, 'total') : 0;
  const record = {
    key: `codex:${entry.sid}:${total > 0 ? total : `o${lineOffset}`}`,
    client: 'codex',
    session_id: entry.sid,
    at,
    workspace: entry.ws,
    model: entry.model ?? null,
    ...codexTokens(last),
  };
  if (hasTokens(record)) addRecord(records, record);
}

function codexFolder(cwd, entry, known) {
  const workspace = matchWorkspace(cwd, known);
  entry.ws = workspace;
  if (!workspace) rememberUnknown(entry, cwd);
}

// ---- Reading ----

const CLAUDE_MARKS = [Buffer.from('"usage"')];
const CODEX_MARKS = [
  Buffer.from('"token_count"'),
  Buffer.from('"session_meta"'),
  Buffer.from('"turn_context"'),
];

/** Parse a line that may hold what we need. The parsed value never leaves this pass. */
function handleLine(bytes, file, entry, known, records, lineOffset) {
  const marks = file.client === 'codex' ? CODEX_MARKS : CLAUDE_MARKS;
  if (!marks.some((mark) => bytes.includes(mark))) return;
  let line;
  try {
    line = JSON.parse(bytes.toString('utf8'));
  } catch {
    // Not logged: the error message can quote the line.
    return;
  }
  if (!line || typeof line !== 'object') return;
  if (file.client === 'codex') codexLine(line, entry, known, records, lineOffset);
  else claudeLine(line, entry, known, records);
}

/** Read complete lines from `entry.o`. Stops at the budget; `entry.o` is where to resume. */
async function readNew(file, entry, known, records, budget, io) {
  const handle = await io.open(file.path, 'r');
  try {
    const chunk = Buffer.allocUnsafe(budget.limits.chunkBytes);
    let position = entry.o;
    let lineStart = entry.o;
    let parts = [];
    let held = 0;
    let skipping = entry.x === 1;
    while (!budget.spent(records)) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      budget.bytes += bytesRead;
      let from = 0;
      while (from < bytesRead && !budget.spent(records)) {
        // The buffer is reused, so a newline past `bytesRead` is left over from an earlier read.
        const newline = chunk.indexOf(0x0a, from);
        const complete = newline !== -1 && newline < bytesRead;
        const end = complete ? newline : bytesRead;
        if (!skipping) {
          held += end - from;
          if (held > budget.limits.maxLineBytes) {
            skipping = true;
            parts = [];
            held = 0;
            budget.longLines += 1;
          } else if (end > from) {
            parts.push(Buffer.from(chunk.subarray(from, end)));
          }
        }
        if (!complete) {
          from = bytesRead;
          break;
        }
        if (!skipping && held > 0) {
          handleLine(Buffer.concat(parts, held), file, entry, known, records, lineStart);
        }
        parts = [];
        held = 0;
        skipping = false;
        from = end + 1;
        lineStart = position + from;
      }
      // Out of budget partway through this chunk: resume from `lineStart`.
      if (from < bytesRead) break;
      position += bytesRead;
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (skipping) {
      // Inside a line too long to keep: carry on from here, still skipping.
      entry.o = position;
      entry.x = 1;
    } else {
      // A partial last line waits for its newline.
      entry.o = lineStart;
      delete entry.x;
    }
  } finally {
    await handle.close();
  }
}

/** The `.jsonl` files under `root`, without following links. */
async function findLogs(root, client, limits, out, io) {
  const stack = [{ dir: root, depth: 0 }];
  let complete = true;
  while (stack.length > 0) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = await io.opendir(dir);
    } catch {
      continue;
    }
    try {
      for await (const item of entries) {
        if (item.isDirectory()) {
          if (depth < MAX_DEPTH) stack.push({ dir: join(dir, item.name), depth: depth + 1 });
        } else if (item.isFile() && item.name.endsWith('.jsonl')) {
          if (out.length >= limits.maxFiles) {
            complete = false;
            break;
          }
          out.push({ path: join(dir, item.name), client });
        }
      }
    } catch {
      complete = false;
    }
    if (out.length >= limits.maxFiles) break;
  }
  return complete;
}

export function defaultRoots(env = process.env) {
  const home = homedir();
  return {
    codex: join(env.CODEX_HOME || join(home, '.codex'), 'sessions'),
    claude: join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects'),
  };
}

/** A file whose unknown folder has since become a known workspace is read again. */
function becameKnown(entry, known) {
  return Array.isArray(entry.u) && entry.u.some((hash) => known.hashes.has(hash));
}

function say(log, line) {
  if (typeof log === 'function') log(line);
  else log?.info?.(line);
}

/**
 * One pass. `options` is for tests: `roots`, `limits`, `now` and `io` (the file calls).
 * Returns `{ records, state }`. The runner saves `state` only after it has
 * posted the records, so a failed post just reads the same lines again.
 */
export async function collect(ctx, options = {}) {
  const { state, log, signal, docket } = ctx;
  const previous = state && state.v === 1 && state.files ? state : { v: 1, files: {} };

  // Ask first. With the source off, no log file is opened or even listed.
  const config = await docket.get('/api/sync/usage');
  if (config?.enabled !== true) return { records: [], state: previous };

  const workspaces = (config.workspaces ?? []).map(normalizeWorkspace);
  const known = {
    set: new Set(workspaces),
    hashes: new Set(workspaces.map(shortHash)),
  };
  if (known.set.size === 0) return { records: [], state: previous };

  const io = options.io ?? { open, opendir, stat };
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const roots = options.roots ?? defaultRoots();
  const now = options.now ?? Date.now();
  const started = Date.now();
  const records = new Map();
  const files = { ...previous.files };
  const budget = {
    limits,
    bytes: 0,
    longLines: 0,
    spent(held) {
      return (
        this.bytes >= limits.maxBytes ||
        held.size >= limits.maxRecords ||
        Date.now() - started >= limits.maxMs ||
        signal?.aborted === true
      );
    },
  };

  const logs = [];
  const completeCodex = await findLogs(roots.codex, 'codex', limits, logs, io);
  const completeClaude = await findLogs(roots.claude, 'claude-code', limits, logs, io);

  const seen = new Set();
  const work = [];
  for (const file of logs) {
    const id = shortHash(file.path);
    seen.add(id);
    let info;
    try {
      info = await io.stat(file.path);
    } catch {
      continue;
    }
    let entry = files[id];
    if (!entry && now - info.mtimeMs > limits.maxAgeDays * 86_400_000) continue;
    const inode = String(info.ino);
    if (!entry || entry.i !== inode || info.size < entry.o) {
      // New or rotated: start again. Keys make counting it twice impossible.
      entry = { o: 0, i: inode };
    } else if (becameKnown(entry, known)) {
      entry = { o: 0, i: inode };
    }
    files[id] = entry;
    if (info.size > entry.o) work.push({ file, id, mtime: info.mtimeMs });
  }
  work.sort((a, b) => a.mtime - b.mtime);

  let read = 0;
  for (const { file, id } of work) {
    if (budget.spent(records)) break;
    const entry = { ...files[id] };
    try {
      await readNew(file, entry, known, records, budget, io);
      files[id] = entry;
      read += 1;
    } catch {
      // A file that vanished or can't be read is tried again next pass.
    }
  }

  // Forget files that are gone, but only when the listing was complete.
  if (completeCodex && completeClaude) {
    for (const id of Object.keys(files)) if (!seen.has(id)) delete files[id];
  }

  const out = [...records.values()];
  say(
    log,
    `usage: read ${read} of ${work.length} changed logs, ${out.length} turns` +
      (budget.longLines > 0 ? `, skipped ${budget.longLines} very long lines` : ''),
  );
  return { records: out, state: { v: 1, files } };
}

export default { name, intervalMs, enabled, collect };
