/**
 * The token-use collector (owner decision 48; B63; BUILD_SPEC §5.31), called
 * directly with synthetic logs built from the documented field names. It never
 * reads a real log: every test passes its own temporary roots.
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { open, opendir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeWorkspace as sharedNormalize, usageRecordSchema } from '@docket/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const source = await import(
  /* @vite-ignore */ pathToFileURL(join(ROOT, 'tools', 'docket-sync', 'sources', 'usage.mjs')).href
);
const { collect, enabled, intervalMs, name, normalizeWorkspace } = source;

const SECRET = 'PLANTED-SECRET-do-not-store-7f3a';
const WORK = 'C:/work/app-feature';
const OTHER = 'C:/private/other-project';
const AT = '2026-11-20T10:00:00.000Z';

interface Rec {
  key: string;
  client: string;
  session_id: string;
  at: string;
  workspace: string;
  model: string | null;
  fresh_input: number;
  cached_input: number;
  cache_write: number;
  cache_write_1h: number;
  output: number;
}
interface Result {
  records: Rec[];
  state: unknown;
}

let dir: string;
let roots: { codex: string; claude: string };
let logs: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'docket-usage-'));
  roots = { codex: join(dir, 'codex'), claude: join(dir, 'claude') };
  mkdirSync(roots.codex, { recursive: true });
  mkdirSync(roots.claude, { recursive: true });
  logs = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const settingsFor = (workspaces: string[] = [WORK], on = true) => ({
  enabled: on,
  workspaces: on ? workspaces : [],
});
const logTo = (event: string, fields: unknown) => logs.push(JSON.stringify({ event, fields }));

const run = (
  state: unknown = undefined,
  over: { workspaces?: string[]; limits?: Record<string, number>; on?: boolean } = {},
): Promise<Result> =>
  collect(
    {
      state,
      log: logTo,
      signal: new AbortController().signal,
      settings: settingsFor(over.workspaces, over.on ?? true),
      docket: { get: () => Promise.reject(new Error('The usage source reads no Docket route.')) },
    },
    { roots, now: Date.parse('2026-11-21T00:00:00.000Z'), limits: over.limits },
  );

const write = (root: string, file: string, lines: unknown[]) => {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
  return path;
};

const claudeLine = (
  id: string,
  usage: Record<string, unknown>,
  over: Record<string, unknown> = {},
) => ({
  type: 'assistant',
  sessionId: 'sess-claude-1',
  cwd: WORK,
  timestamp: AT,
  gitBranch: `feature/${SECRET}`,
  message: {
    id,
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text: `The answer is ${SECRET}` }],
    usage,
  },
  ...over,
});

const usage = (input: number, output: number, read = 0, write = 0, oneHour = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
  cache_creation: {
    ephemeral_5m_input_tokens: write - oneHour,
    ephemeral_1h_input_tokens: oneHour,
  },
});

const codexMeta = (cwd = WORK, id = 'sess-codex-1') => ({
  timestamp: AT,
  type: 'session_meta',
  payload: { session_id: id, cwd, instructions: `Be careful with ${SECRET}` },
});
const codexContext = (model = 'gpt-5.5', cwd = WORK) => ({
  timestamp: AT,
  type: 'turn_context',
  payload: { model, cwd, user_instructions: SECRET },
});
const tokens = (input: number, cached: number, output: number, extra = {}) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
  reasoning_output_tokens: 3,
  total_tokens: input + output,
  ...extra,
});
const codexCount = (last: unknown, total: unknown, at = AT) => ({
  timestamp: at,
  type: 'event_msg',
  payload: { type: 'token_count', info: { last_token_usage: last, total_token_usage: total } },
});

describe('the source contract', () => {
  it('has the runner interface, and is off unless Settings turned it on', () => {
    expect(name).toBe('usage');
    expect(intervalMs).toBeGreaterThan(0);
    expect(enabled({ enabled: true, workspaces: [] })).toBe(true);
    expect(enabled({ enabled: false, workspaces: [WORK] })).toBe(false);
    expect(enabled({ enabled: true })).toBe(false);
    expect(enabled({})).toBe(false);
    expect(enabled(undefined)).toBe(false);
  });

  it('normalizes a folder exactly as the server does', () => {
    for (const path of [
      'C:\\Users\\Me\\Work\\',
      'c:/users/me/work',
      '/home/me/Work/',
      '/home//me///Work',
      '  /srv/app  ',
      '/',
      'D:\\',
    ]) {
      expect(normalizeWorkspace(path), path).toBe(sharedNormalize(path));
    }
  });
});

describe('with the source off', () => {
  it('opens, lists and stats no log file', async () => {
    write(roots.claude, 'p/a.jsonl', [claudeLine('msg_1', usage(1, 2))]);
    const calls: string[] = [];
    const io = {
      open: (...a: Parameters<typeof open>) => (calls.push('open'), open(...a)),
      opendir: (...a: Parameters<typeof opendir>) => (calls.push('opendir'), opendir(...a)),
      stat: (...a: Parameters<typeof stat>) => (calls.push('stat'), stat(...a)),
    };
    const rootsRead: string[] = [];
    const watched = new Proxy(roots, {
      get: (t, k: 'codex' | 'claude') => (rootsRead.push(String(k)), t[k]),
    });
    const state = { v: 1, files: { keep: { o: 5, i: '1' } } };
    const out = (await collect(
      { state, log: logTo, settings: settingsFor([WORK], false) },
      { roots: watched, io },
    )) as Result;
    expect(out.records).toEqual([]);
    expect(out.state).toEqual(state);
    expect(calls).toEqual([]);
    expect(rootsRead).toEqual([]);
    expect(logs).toEqual([]);

    // The same fixture with it on does read the file, so the check above can fail.
    const on = (await collect(
      { state: undefined, log: () => {}, settings: settingsFor([WORK], true) },
      { roots, io, now: Date.parse(AT) },
    )) as Result;
    expect(on.records).toHaveLength(1);
    expect(calls).toContain('open');
  });

  it('reads nothing when no folder is known yet', async () => {
    write(roots.claude, 'p/a.jsonl', [claudeLine('msg_1', usage(1, 2))]);
    expect((await run(undefined, { workspaces: [] })).records).toEqual([]);
  });
});

describe('Claude Code logs', () => {
  it('keeps the four token kinds apart', async () => {
    write(roots.claude, 'p/a.jsonl', [claudeLine('msg_1', usage(10, 20, 3000, 400, 100))]);
    const { records } = await run();
    expect(records).toEqual([
      {
        key: 'claude-code:msg_1',
        client: 'claude-code',
        session_id: 'sess-claude-1',
        at: AT,
        workspace: normalizeWorkspace(WORK),
        model: 'claude-opus-5-5',
        fresh_input: 10,
        cached_input: 3000,
        cache_write: 400,
        cache_write_1h: 100,
        output: 20,
      },
    ]);
    expect(usageRecordSchema.safeParse(records[0]).success).toBe(true);
  });

  it('counts one API response once across several lines, with its largest numbers', async () => {
    write(roots.claude, 'p/a.jsonl', [
      claudeLine('msg_1', usage(10, 1, 500)),
      claudeLine('msg_1', usage(10, 7, 500)),
      claudeLine('msg_1', usage(10, 42, 500)),
      claudeLine('msg_2', usage(5, 5)),
    ]);
    const { records } = await run();
    expect(records.map((r) => [r.key, r.output])).toEqual([
      ['claude-code:msg_1', 42],
      ['claude-code:msg_2', 5],
    ]);
  });

  it('counts a response in a subagent log and its parent once', async () => {
    write(roots.claude, 'p/parent.jsonl', [claudeLine('msg_1', usage(10, 20))]);
    write(roots.claude, 'p/parent/subagents/agent-a.jsonl', [
      claudeLine('msg_1', usage(10, 20)),
      claudeLine('msg_sub', usage(7, 8), { isSidechain: true }),
    ]);
    const { records } = await run();
    expect(records.map((r) => r.key).sort()).toEqual(['claude-code:msg_1', 'claude-code:msg_sub']);
  });

  it('matches a subfolder to its workspace and reports only the workspace', async () => {
    write(roots.claude, 'p/a.jsonl', [
      claudeLine('msg_1', usage(1, 2), { cwd: `${WORK}\\src\\deep` }),
    ]);
    expect((await run()).records[0]!.workspace).toBe(normalizeWorkspace(WORK));
  });

  it('skips a response with no tokens', async () => {
    write(roots.claude, 'p/a.jsonl', [claudeLine('msg_0', usage(0, 0))]);
    expect((await run()).records).toEqual([]);
  });
});

describe('Codex logs', () => {
  it('uses each turn, never the cumulative totals', async () => {
    write(roots.codex, '2026/11/20/rollout.jsonl', [
      codexMeta(),
      codexContext(),
      codexCount(tokens(100, 80, 10), tokens(100, 80, 10)),
      codexCount(tokens(200, 150, 20), tokens(300, 230, 30)),
    ]);
    const { records } = await run();
    expect(records.map((r) => [r.fresh_input, r.cached_input, r.output])).toEqual([
      [20, 80, 10],
      [50, 150, 20],
    ]);
    expect(records.reduce((n, r) => n + r.output, 0)).toBe(30);
    expect(records[0]!.model).toBe('gpt-5.5');
    expect(records[0]!.session_id).toBe('sess-codex-1');
    for (const r of records) expect(usageRecordSchema.safeParse(r).success).toBe(true);
  });

  it('counts a repeated token_count event once', async () => {
    const event = codexCount(tokens(100, 80, 10), tokens(100, 80, 10));
    write(roots.codex, 'a.jsonl', [codexMeta(), codexContext(), event, event, event]);
    expect((await run()).records).toHaveLength(1);
  });

  it('accepts the short field names, and separates cache writes from fresh input', async () => {
    const last = { input: 100, cached_input: 50, cache_write_input: 20, output: 5, total: 105 };
    write(roots.codex, 'a.jsonl', [codexMeta(), codexContext(), codexCount(last, last)]);
    const [r] = (await run()).records;
    expect([r!.fresh_input, r!.cached_input, r!.cache_write, r!.output]).toEqual([30, 50, 20, 5]);
  });

  it('keeps input as it is when the total shows cached tokens were counted on top', async () => {
    const last = tokens(30, 50, 5, { total_tokens: 85 });
    write(roots.codex, 'a.jsonl', [codexMeta(), codexContext(), codexCount(last, last)]);
    const [r] = (await run()).records;
    expect([r!.fresh_input, r!.cached_input]).toEqual([30, 50]);
  });

  it('ignores a token_count with only cumulative numbers', async () => {
    const event = {
      timestamp: AT,
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: tokens(9, 0, 9) } },
    };
    write(roots.codex, 'a.jsonl', [codexMeta(), codexContext(), event]);
    expect((await run()).records).toEqual([]);
  });

  it('keeps the session and model across passes', async () => {
    const path = write(roots.codex, 'a.jsonl', [
      codexMeta(),
      codexContext('gpt-5.4'),
      codexCount(tokens(10, 0, 1), tokens(10, 0, 1)),
    ]);
    const first = await run();
    appendFileSync(path, `${JSON.stringify(codexCount(tokens(20, 0, 2), tokens(30, 0, 3)))}\n`);
    const second = await run(first.state);
    expect(second.records.map((r) => [r.session_id, r.model, r.output])).toEqual([
      ['sess-codex-1', 'gpt-5.4', 2],
    ]);
  });
});

describe('reading incrementally', () => {
  it('leaves a partial last line for the next pass', async () => {
    const whole = JSON.stringify(claudeLine('msg_2', usage(3, 4)));
    const path = write(roots.claude, 'p/a.jsonl', [claudeLine('msg_1', usage(1, 2))]);
    appendFileSync(path, whole.slice(0, 40));
    const first = await run();
    expect(first.records.map((r) => r.key)).toEqual(['claude-code:msg_1']);
    appendFileSync(path, `${whole.slice(40)}\n`);
    const second = await run(first.state);
    expect(second.records.map((r) => r.key)).toEqual(['claude-code:msg_2']);
    expect((await run(second.state)).records).toEqual([]);
  });

  it('starts a rotated file again', async () => {
    const path = write(roots.claude, 'p/a.jsonl', [
      claudeLine('msg_1', usage(1, 2)),
      claudeLine('msg_2', usage(3, 4)),
    ]);
    const first = await run();
    writeFileSync(path, `${JSON.stringify(claudeLine('msg_3', usage(5, 6)))}\n`);
    expect(statSync(path).size).toBeGreaterThan(0);
    expect((await run(first.state)).records.map((r) => r.key)).toEqual(['claude-code:msg_3']);
  });

  it('skips a line over the limit without keeping it, and carries on', async () => {
    const path = write(roots.claude, 'p/a.jsonl', [claudeLine('msg_1', usage(1, 2))]);
    appendFileSync(path, `{"usage":"${'x'.repeat(5000)}"}\n`);
    appendFileSync(path, `${JSON.stringify(claudeLine('msg_2', usage(3, 4)))}\n`);
    const { records } = await run(undefined, {
      limits: { maxLineBytes: 2000, chunkBytes: 512 },
    });
    expect(records.map((r) => r.key)).toEqual(['claude-code:msg_1', 'claude-code:msg_2']);
    expect(logs.join('\n')).toContain('"long_lines":1');
  });

  it('stays inside a very long unfinished line between passes', async () => {
    const path = write(roots.claude, 'p/a.jsonl', []);
    appendFileSync(path, `{"usage":"${'x'.repeat(5000)}`);
    const first = await run(undefined, { limits: { maxLineBytes: 1000, chunkBytes: 512 } });
    appendFileSync(path, `"}\n${JSON.stringify(claudeLine('msg_1', usage(1, 2)))}\n`);
    const second = await run(first.state, { limits: { maxLineBytes: 1000, chunkBytes: 512 } });
    expect(second.records.map((r) => r.key)).toEqual(['claude-code:msg_1']);
  });

  it('stops at the byte budget and resumes without losing or repeating a turn', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => claudeLine(`msg_${i}`, usage(1, 2)));
    write(roots.claude, 'p/a.jsonl', lines);
    const seen: string[] = [];
    let state: unknown;
    for (let pass = 0; pass < 60; pass += 1) {
      const out = await run(state, { limits: { maxBytes: 1024, chunkBytes: 512 } });
      seen.push(...out.records.map((r) => r.key));
      state = out.state;
      if (new Set(seen).size === 40) break;
    }
    expect(new Set(seen).size).toBe(40);
    expect(seen).toHaveLength(40);
  });

  it('stops at the record limit and resumes', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => claudeLine(`msg_${i}`, usage(1, 2)));
    write(roots.claude, 'p/a.jsonl', lines);
    const first = await run(undefined, { limits: { maxRecords: 4 } });
    expect(first.records).toHaveLength(4);
    const second = await run(first.state, { limits: { maxRecords: 100 } });
    expect(second.records).toHaveLength(6);
  });

  it('leaves an old file it has not seen before alone', async () => {
    write(roots.claude, 'p/a.jsonl', [claudeLine('msg_1', usage(1, 2))]);
    const out = (await collect(
      { log: () => {}, settings: settingsFor() },
      { roots, now: Date.now() + 90 * 86_400_000 },
    )) as Result;
    expect(out.records).toEqual([]);
  });

  it('forgets a file that is gone', async () => {
    const path = write(roots.claude, 'p/a.jsonl', [claudeLine('msg_1', usage(1, 2))]);
    const first = await run();
    expect(Object.keys((first.state as { files: object }).files)).toHaveLength(1);
    rmSync(path);
    const second = await run(first.state);
    expect(Object.keys((second.state as { files: object }).files)).toHaveLength(0);
  });
});

describe('unknown workspaces', () => {
  it('sends nothing for a session outside every known workspace', async () => {
    write(roots.claude, 'p/a.jsonl', [claudeLine('msg_1', usage(1, 2), { cwd: OTHER })]);
    write(roots.codex, 'b.jsonl', [
      codexMeta(OTHER),
      codexContext('gpt-5.5', OTHER),
      codexCount(tokens(10, 0, 1), tokens(10, 0, 1)),
    ]);
    expect((await run()).records).toEqual([]);
  });

  it('does not match a folder that only starts with the same letters', async () => {
    write(roots.claude, 'p/a.jsonl', [claudeLine('msg_1', usage(1, 2), { cwd: `${WORK}-2` })]);
    expect((await run()).records).toEqual([]);
  });

  it('keeps no trace of the folder in its state', async () => {
    write(roots.claude, 'other-project/a.jsonl', [
      claudeLine('msg_1', usage(1, 2), { cwd: OTHER }),
    ]);
    const { state } = await run();
    const text = JSON.stringify(state).toLowerCase();
    expect(text).not.toContain('private');
    expect(text).not.toContain('other-project');
  });

  it('picks the turns up when the folder becomes known', async () => {
    write(roots.claude, 'p/a.jsonl', [claudeLine('msg_1', usage(1, 2), { cwd: `${OTHER}/sub` })]);
    const first = await run();
    expect(first.records).toEqual([]);
    const second = await run(first.state, { workspaces: [WORK, OTHER] });
    expect(second.records.map((r) => r.workspace)).toEqual([normalizeWorkspace(OTHER)]);
  });
});

describe('privacy', () => {
  it('lets no planted text reach a record, the state or the log', async () => {
    write(roots.claude, 'p/a.jsonl', [
      claudeLine('msg_1', usage(1, 2)),
      // In every string field a line can carry, including ones the collector reads.
      claudeLine('msg_2', usage(3, 4), { sessionId: `s ${SECRET}` }),
      claudeLine(`msg ${SECRET}`, usage(5, 6)),
      claudeLine('msg_3', usage(7, 8), { timestamp: SECRET }),
      claudeLine('msg_4', usage(9, 10), { cwd: `C:/${SECRET}/folder` }),
      {
        ...claudeLine('msg_5', usage(11, 12)),
        message: {
          id: 'msg_5',
          model: `model ${SECRET}`,
          content: SECRET,
          usage: { ...usage(11, 12), note: SECRET, input_tokens: 11 },
        },
      },
      { type: 'user', sessionId: 'sess-claude-1', cwd: WORK, message: { content: SECRET } },
    ]);
    const path = write(roots.codex, 'a.jsonl', [
      codexMeta(),
      codexContext(`model ${SECRET}`),
      { timestamp: AT, type: 'response_item', payload: { type: 'message', content: SECRET } },
      codexCount(tokens(10, 0, 1), tokens(10, 0, 1)),
    ]);
    // Broken lines: a JSON error message can quote the input.
    appendFileSync(path, `{"type":"token_count","broken":"${SECRET}\n`);
    appendFileSync(path, `not json usage ${SECRET}\n`);

    const out = await run();
    expect(out.records.length).toBeGreaterThan(0);
    const everything = JSON.stringify({ records: out.records, state: out.state, logs });
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain('PLANTED');

    const allowed = [
      'key',
      'client',
      'session_id',
      'at',
      'workspace',
      'model',
      'fresh_input',
      'cached_input',
      'cache_write',
      'cache_write_1h',
      'output',
    ].sort();
    for (const r of out.records) {
      expect(Object.keys(r).sort()).toEqual(allowed);
      expect(usageRecordSchema.safeParse(r).success).toBe(true);
    }
    const bad = out.records.find((r) => r.key === 'claude-code:msg_5');
    expect(bad?.model).toBeNull();
  });
});
