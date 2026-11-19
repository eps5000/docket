/**
 * Project connection files (owner decision 32; BUILD_SPEC §5.17a; FR-144):
 * the agent-files install into a repo also writes the client's project MCP
 * configuration, so connecting an agent needs no commands.
 *
 * - **Claude Code:** `.mcp.json`, `{"mcpServers": {"docket": {"type": "http",
 *   "url": "…/mcp"}}}`; in protected mode it adds
 *   `"headers": {"Authorization": "Bearer ${DOCKET_TOKEN}"}`, which Claude
 *   Code expands from the environment.
 * - **Codex:** `.codex/config.toml`, a `[mcp_servers.docket]` table with
 *   `url`, and `bearer_token_env_var = "DOCKET_TOKEN"` in protected mode.
 * - Neither ever holds a secret.
 *
 * **Merging** adds or replaces only the `docket` entry, and keeps every other
 * byte of the file. A file that isn't valid (as far as these scanners check),
 * or that defines `docket` in a form they can't update, is refused, never
 * overwritten.
 *
 * **Checking** compares only the `docket` entry, as canonical text, so other
 * servers in the same file never read as drift:
 * - JSON: the entry's value with the whitespace outside strings removed;
 * - TOML: the table's lines, from its header to the next header, each
 *   trimmed, without blank and comment lines, joined with `\n`.
 * The manifest's sha256 is the canonical text's.
 *
 * The same scanners exist three times, and must agree byte for byte: here
 * (push install, push check, drift), in awk (`CONNECTION_AWK`: the bash
 * install step and the bash check command) and in PowerShell
 * (`CONNECTION_PS1`: the PowerShell install step and check command).
 * install-shell.test.ts runs all three over the same files.
 */
import type { InstallClient } from './enums.js';

/** The manifest key of an install's connection file (one per install). */
export const CONNECTION_KEY = 'connection';
/** The MCP server's name in the connection files. */
export const CONNECTION_SERVER = 'docket';
/** The environment variable that holds the agent token, in protected mode. */
export const CONNECTION_TOKEN_ENV = 'DOCKET_TOKEN';

/** Each client's project connection file, relative to the repo. */
export const CONNECTION_FILES: Record<InstallClient, string> = {
  claude: '.mcp.json',
  codex: '.codex/config.toml',
};

/** The "version" a connection file was sent at: which mode wrote it (it has no stored versions). */
export const connectionVersionId = (protectedMode: boolean): string =>
  protectedMode ? 'connection:protected' : 'connection:local';

export const isConnectionVersionId = (id: string): boolean =>
  id === 'connection:protected' || id === 'connection:local';

/**
 * The text Docket inserts: for `.mcp.json`, the `docket` entry's value,
 * indented for its place (two levels in); for `config.toml`, the whole table,
 * ending in a newline.
 */
export function connectionEntry(
  client: InstallClient,
  url: string,
  protectedMode: boolean,
): string {
  if (client === 'codex') {
    return [
      `[mcp_servers.${CONNECTION_SERVER}]`,
      `url = ${JSON.stringify(url)}`,
      ...(protectedMode ? [`bearer_token_env_var = "${CONNECTION_TOKEN_ENV}"`] : []),
      '',
    ].join('\n');
  }
  const lines = ['{', '      "type": "http",', `      "url": ${JSON.stringify(url)}`];
  if (protectedMode) {
    lines[2] += ',';
    lines.push(
      '      "headers": {',
      `        "Authorization": "Bearer \${${CONNECTION_TOKEN_ENV}}"`,
      '      }',
    );
  }
  lines.push('    }');
  return lines.join('\n');
}

/** The canonical text of the entry Docket writes (what the manifest's sha256 is of). */
export function connectionCanonical(
  client: InstallClient,
  url: string,
  protectedMode: boolean,
): string {
  const entry = connectionEntry(client, url, protectedMode);
  return client === 'codex'
    ? tomlCanonicalLines(entry.split('\n'))
    : compactJson(entry, 0, entry.length);
}

export class ConnectionFileError extends Error {
  constructor(file: string, kind: 'json' | 'toml', detail: string) {
    super(
      detail === 'docket defined another way'
        ? `${file} defines the docket MCP server in a form Docket can't update; make it a [mcp_servers.docket] table, then install again. Nothing was written.`
        : `${file} isn't valid ${kind === 'json' ? 'JSON' : 'TOML'} (${detail}). Fix it, then install again. Nothing was written.`,
    );
    this.name = 'ConnectionFileError';
  }
}

// ---- JSON ----

export type JsonScan =
  | { ok: false; error: string }
  | {
      ok: true;
      /** False when the text is only whitespace. */
      nonEmpty: boolean;
      topOpen: number;
      topClose: number;
      topEmpty: boolean;
      /** The `mcpServers` object's `{` and `}`, or -1. */
      srvOpen: number;
      srvClose: number;
      srvEmpty: boolean;
      /** The `docket` entry's value: start, and end (exclusive), or -1. */
      dkStart: number;
      dkEnd: number;
    };

const WS = new Set([' ', '\t', '\n', '\r']);
const LITERAL_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.+-';
const LITERAL = /^(true|false|null|-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?)$/;

class ScanFail extends Error {}
const fail = (detail: string): never => {
  throw new ScanFail(detail);
};

/**
 * Scan a JSON text: validate it, and find the top object, its `mcpServers`
 * object and that object's `docket` entry. Keys compare as written (no
 * escapes decoded); a repeated `mcpServers` or `docket` is refused.
 */
export function scanJson(s: string): JsonScan {
  try {
    return scanJsonOrThrow(s);
  } catch (err) {
    if (err instanceof ScanFail) return { ok: false, error: err.message };
    throw err;
  }
}

function scanJsonOrThrow(s: string): JsonScan {
  const n = s.length;
  // States: V value, A value or ], K key or }, Q key, L colon, C comma or close, E end.
  let st = 'V';
  const stack: string[] = [];
  let key1 = '';
  let key2 = '';
  let topOpen = -1;
  let topClose = -1;
  let topEmpty = true;
  let srvOpen = -1;
  let srvClose = -1;
  let srvEmpty = true;
  let inSrv = false;
  let dkStart = -1;
  let dkEnd = -1;
  let dkTrack = false;
  let nonEmpty = false;

  const afterValue = (end: number) => {
    if (dkTrack && stack.length === 2) {
      dkEnd = end;
      dkTrack = false;
    }
    st = stack.length === 0 ? 'E' : 'C';
  };
  const valueStart = (i: number, c: string) => {
    if (stack.length === 0 && c !== '{') fail('not an object');
    if (stack.length === 1 && key1 === '"mcpServers"') {
      if (srvOpen >= 0) fail('mcpServers appears twice');
      if (c !== '{') fail('mcpServers is not an object');
      srvOpen = i;
      inSrv = true;
    } else if (stack.length === 2 && inSrv && key2 === '"docket"') {
      if (dkStart >= 0) fail('docket appears twice');
      dkStart = i;
      dkTrack = true;
    }
  };
  const close = (i: number, c: string) => {
    const want = c === '}' ? 'o' : 'a';
    if (stack[stack.length - 1] !== want) fail('mismatched bracket');
    if (inSrv && stack.length === 2) {
      srvClose = i;
      inSrv = false;
    }
    stack.pop();
    if (stack.length === 0) topClose = i;
    afterValue(i + 1);
  };
  const readString = (i: number): number => {
    let j = i + 1;
    while (j < n) {
      const d = s[j]!;
      if (d === '\\') {
        j += 2;
        continue;
      }
      if (d === '"') break;
      if (d.charCodeAt(0) < 32) fail('control character in a string');
      j++;
    }
    if (j >= n) fail('unclosed string');
    return j + 1;
  };

  let i = 0;
  while (i < n) {
    const c = s[i]!;
    if (WS.has(c)) {
      i++;
      continue;
    }
    nonEmpty = true;
    if (st === 'E') fail('text after the end');
    if (st === 'V' || st === 'A') {
      if (st === 'A' && c === ']') {
        close(i, c);
        i++;
        continue;
      }
      valueStart(i, c);
      if (c === '{' || c === '[') {
        if (stack.length === 0) topOpen = i;
        stack.push(c === '{' ? 'o' : 'a');
        st = c === '{' ? 'K' : 'A';
        i++;
      } else if (c === '"') {
        i = readString(i);
        afterValue(i);
      } else {
        let j = i;
        while (j < n && LITERAL_CHARS.includes(s[j]!)) j++;
        if (j === i) fail('unexpected character');
        if (!LITERAL.test(s.slice(i, j))) fail('unexpected value');
        i = j;
        afterValue(i);
      }
      continue;
    }
    if (st === 'K' || st === 'Q') {
      if (st === 'K' && c === '}') {
        close(i, c);
        i++;
        continue;
      }
      if (c !== '"') fail('unexpected character');
      const j = readString(i);
      const key = s.slice(i, j);
      if (stack.length === 1) {
        key1 = key;
        topEmpty = false;
      } else if (stack.length === 2 && inSrv) {
        key2 = key;
        srvEmpty = false;
      }
      i = j;
      st = 'L';
      continue;
    }
    if (st === 'L') {
      if (c !== ':') fail('unexpected character');
      st = 'V';
      i++;
      continue;
    }
    // st === 'C'
    if (c === ',') {
      st = stack[stack.length - 1] === 'o' ? 'Q' : 'V';
      i++;
    } else if (c === '}' || c === ']') {
      close(i, c);
      i++;
    } else {
      fail('unexpected character');
    }
  }
  if (nonEmpty && st !== 'E') fail('ends early');
  return {
    ok: true,
    nonEmpty,
    topOpen,
    topClose,
    topEmpty,
    srvOpen,
    srvClose,
    srvEmpty,
    dkStart,
    dkEnd,
  };
}

/** `s[from, to)` with the whitespace outside strings removed. */
function compactJson(s: string, from: number, to: number): string {
  let out = '';
  let inStr = false;
  for (let i = from; i < to; i++) {
    const c = s[i]!;
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += s[i + 1] ?? '';
        i++;
      } else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (!WS.has(c)) out += c;
  }
  return out;
}

function mergeJson(existing: string | null, entry: string, file: string) {
  const fresh = `{\n  "mcpServers": {\n    "docket": ${entry}\n  }\n}\n`;
  if (existing === null) return { text: fresh, how: 'created' as const };
  const r = scanJson(existing);
  if (!r.ok) throw new ConnectionFileError(file, 'json', r.error);
  const s = existing;
  if (!r.nonEmpty) return { text: fresh, how: 'added' as const };
  if (r.dkStart >= 0) {
    return { text: s.slice(0, r.dkStart) + entry + s.slice(r.dkEnd), how: 'replaced' as const };
  }
  if (r.srvOpen >= 0) {
    const text = r.srvEmpty
      ? `${s.slice(0, r.srvOpen + 1)}\n    "docket": ${entry}\n  ${s.slice(r.srvClose)}`
      : `${s.slice(0, r.srvOpen + 1)}\n    "docket": ${entry},${s.slice(r.srvOpen + 1)}`;
    return { text, how: 'added' as const };
  }
  const block = `\n  "mcpServers": {\n    "docket": ${entry}\n  }`;
  const text = r.topEmpty
    ? `${s.slice(0, r.topOpen + 1)}${block}\n${s.slice(r.topClose)}`
    : `${s.slice(0, r.topOpen + 1)}${block},${s.slice(r.topOpen + 1)}`;
  return { text, how: 'added' as const };
}

// ---- TOML (one table) ----

export type TomlScan =
  | { ok: false; error: string }
  | {
      ok: true;
      /** The `[mcp_servers.docket]` header line's start, or -1. */
      hdrStart: number;
      /** Just after the table's last line that isn't blank or a comment. */
      regionEnd: number;
      /** The table's lines (header first), for the canonical text. */
      lines: string[];
    };

const KEY_PART = `([A-Za-z0-9_-]+|"[^"]*"|'[^']*')`;
const KEY_LINE = new RegExp(`^${KEY_PART}([ \\t]*[.][ \\t]*${KEY_PART})*[ \\t]*=`);
const DOCKET_TABLE = 'mcp_servers.docket';

/**
 * A table header line (trimmed, starting with `[`): `{array, name}`, or null
 * when it isn't one. Parsed by hand, the same way as the awk and PowerShell
 * versions.
 */
function parseHeader(t: string): { array: boolean; name: string } | null {
  const array = t.startsWith('[[');
  const rest = t.slice(array ? 2 : 1);
  const p = rest.indexOf(']');
  if (p <= 0) return null;
  const name = rest.slice(0, p);
  if (name.includes('[')) return null;
  let after = rest.slice(p);
  if (array) {
    if (!after.startsWith(']]')) return null;
    after = after.slice(2);
  } else after = after.slice(1);
  after = after.replace(/^[ \t]+/, '');
  if (after !== '' && !after.startsWith('#')) return null;
  return { array, name };
}

/** A dotted key with its whitespace and quotes removed: `mcp_servers . "docket"` → `mcp_servers.docket`. */
function normalizeKey(key: string): string {
  return key
    .split('.')
    .map((p) =>
      p
        .trim()
        .replace(/^"(.*)"$/, '$1')
        .replace(/^'(.*)'$/, '$1'),
    )
    .join('.');
}

const trimLine = (line: string): string => line.replace(/^[ \t\r]+|[ \t\r]+$/g, '');

/**
 * Scan a TOML text line by line: track multi-line strings and brackets, check
 * that every other line is blank, a comment, a table header or `key = value`,
 * and find the `[mcp_servers.docket]` table. `docket` defined any other way
 * (a dotted key, or an inline table under `[mcp_servers]`) is refused.
 */
export function scanToml(s: string): TomlScan {
  try {
    return scanTomlOrThrow(s);
  } catch (err) {
    if (err instanceof ScanFail) return { ok: false, error: err.message };
    throw err;
  }
}

function scanTomlOrThrow(s: string): TomlScan {
  let ml = '';
  let depth = 0;
  let table = '';
  let hdrStart = -1;
  let hdrIndex = -1;
  let endIndex = -1;
  const lines = s.split('\n');
  const starts: number[] = [];
  const kinds: string[] = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }

  /** Scan a value's characters from `i`: strings, comments and brackets. */
  const scanValue = (line: string, from: number) => {
    let i = from;
    while (i < line.length) {
      const c = line[i]!;
      if (c === '#') return;
      if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
        const delim = line.slice(i, i + 3);
        const close = line.indexOf(delim, i + 3);
        if (close < 0) {
          ml = delim;
          return;
        }
        i = close + 3;
      } else if (c === '"') {
        let j = i + 1;
        while (j < line.length && line[j] !== '"') j += line[j] === '\\' ? 2 : 1;
        if (j >= line.length) fail('unclosed string');
        i = j + 1;
      } else if (c === "'") {
        const j = line.indexOf("'", i + 1);
        if (j < 0) fail('unclosed string');
        i = j + 1;
      } else {
        if (c === '[' || c === '{') depth++;
        if (c === ']' || c === '}') depth--;
        if (depth < 0) fail('unexpected bracket');
        i++;
      }
    }
  };

  lines.forEach((line, n) => {
    if (ml !== '') {
      const close = line.indexOf(ml);
      kinds.push('cont');
      if (close >= 0) {
        ml = '';
        scanValue(line, close + 3);
      }
      return;
    }
    if (depth > 0) {
      kinds.push('cont');
      scanValue(line, 0);
      return;
    }
    const t = trimLine(line);
    if (t === '') {
      kinds.push('blank');
      return;
    }
    if (t.startsWith('#')) {
      kinds.push('comment');
      return;
    }
    if (t.startsWith('[')) {
      const h = parseHeader(t);
      if (!h) fail(`bad table header on line ${n + 1}`);
      kinds.push('header');
      table = normalizeKey(h!.name);
      if (hdrIndex >= 0 && endIndex < 0) endIndex = n;
      if (table === DOCKET_TABLE && !h!.array) {
        if (hdrIndex >= 0) fail('docket table twice');
        hdrIndex = n;
        hdrStart = starts[n]!;
      }
      return;
    }
    const m = KEY_LINE.exec(t);
    if (!m) fail(`bad line ${n + 1}`);
    kinds.push('key');
    const key = normalizeKey(m![0].slice(0, -1));
    const full = table === '' ? key : `${table}.${key}`;
    const inDocket = table === DOCKET_TABLE || table.startsWith(`${DOCKET_TABLE}.`);
    if ((full === DOCKET_TABLE || full.startsWith(`${DOCKET_TABLE}.`)) && !inDocket) {
      fail('docket defined another way');
    }
    scanValue(t, m![0].length);
  });
  if (ml !== '') fail('unclosed string');
  if (depth !== 0) fail('unclosed bracket');
  if (hdrIndex < 0) return { ok: true, hdrStart: -1, regionEnd: -1, lines: [] };
  if (endIndex < 0) endIndex = lines.length;
  let last = endIndex - 1;
  while (last > hdrIndex && (kinds[last] === 'blank' || kinds[last] === 'comment')) last--;
  return {
    ok: true,
    hdrStart,
    regionEnd: starts[last]! + lines[last]!.length + 1,
    lines: lines.slice(hdrIndex, endIndex),
  };
}

/** The canonical text of a table's lines: trimmed, no blank or comment lines. */
function tomlCanonicalLines(lines: string[]): string {
  return lines
    .map(trimLine)
    .filter((l) => l !== '' && !l.startsWith('#'))
    .join('\n');
}

function mergeToml(existing: string | null, entry: string, file: string) {
  if (existing === null) return { text: entry, how: 'created' as const };
  const r = scanToml(existing);
  if (!r.ok) throw new ConnectionFileError(file, 'toml', r.error);
  const s = existing;
  if (r.hdrStart >= 0) {
    return {
      text: s.slice(0, r.hdrStart) + entry + s.slice(r.regionEnd),
      how: 'replaced' as const,
    };
  }
  if (s === '') return { text: entry, how: 'added' as const };
  return { text: `${s}${s.endsWith('\n') ? '\n' : '\n\n'}${entry}`, how: 'added' as const };
}

// ---- Merge and check ----

/**
 * Add or replace the `docket` entry in a connection file's text (null: no
 * file yet), keeping every other byte. Throws `ConnectionFileError` for a
 * file it can't update safely.
 */
export function mergeConnection(
  client: InstallClient,
  existing: string | null,
  entry: string,
  file: string = CONNECTION_FILES[client],
): { text: string; how: 'created' | 'replaced' | 'added' } {
  return client === 'codex' ? mergeToml(existing, entry, file) : mergeJson(existing, entry, file);
}

/**
 * The installed `docket` entry as the check compares it: its canonical text,
 * null when the file has none, `invalid` when the file can't be scanned.
 */
export function installedConnection(
  client: InstallClient,
  text: string,
): string | null | 'invalid' {
  if (client === 'codex') {
    const r = scanToml(text);
    if (!r.ok) return 'invalid';
    return r.hdrStart < 0 ? null : tomlCanonicalLines(r.lines);
  }
  const r = scanJson(text);
  if (!r.ok) return 'invalid';
  return r.dkStart < 0 ? null : compactJson(text, r.dkStart, r.dkEnd);
}
