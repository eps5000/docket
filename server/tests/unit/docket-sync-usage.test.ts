/**
 * The real B63 usage source under the real docket-sync runner (owner decisions
 * 48 and 49), with fixture logs and a fake Docket. **It never reads the owner's
 * logs:** the in-process tests pass their own roots, and the command-line tests
 * point CLAUDE_CONFIG_DIR, CODEX_HOME and the home folder at a temporary directory.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { open, opendir, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TOOL = join(ROOT, 'tools', 'docket-sync');
const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(join(TOOL, file)).href);

const usage = await load('sources/usage.mjs');
const { createRunner, loadSources } = await load('lib/runner.mjs');
const { createDocket } = await load('lib/docket.mjs');
const { openStore } = await load('lib/store.mjs');

const WORK = '/work/app-feature';
const AT = '2026-11-20T10:00:00.000Z';
const SECRET = 'PLANTED-FIXTURE-TEXT-7f3a';

interface Posted {
  records: { key: string; output: number }[];
  run: { ok: boolean; partial?: boolean; error?: string; interval_ms: number };
}

let dir: string;
let config: string;
let server: Server;
let url: string;
let on: boolean;
let failPosts: boolean;
let posts: Posted[];
let reads: string[];

const logLine = (id: string, output: number) =>
  JSON.stringify({
    type: 'assistant',
    sessionId: 'sess-fixture-1',
    cwd: WORK,
    timestamp: AT,
    gitBranch: `feature/${SECRET}`,
    message: {
      id,
      model: 'claude-fixture',
      role: 'assistant',
      content: [{ type: 'text', text: SECRET }],
      usage: {
        input_tokens: 10,
        output_tokens: output,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 0,
      },
    },
  });

const writeLog = (...lines: string[]) => {
  const file = join(config, 'projects', 'fixture', 'session.jsonl');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.map((l) => `${l}\n`).join(''));
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'docket-sync-usage-'));
  config = join(dir, 'claude');
  on = true;
  failPosts = false;
  posts = [];
  reads = [];
  writeLog(logLine('msg_fixture_1', 7), logLine('msg_fixture_2', 9));
  server = createServer((req, res) => {
    reads.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.url !== '/api/sync/usage') {
      // The GitHub source is left out: this Docket doesn't know it.
      res.statusCode = 404;
      res.end('{}');
      return;
    }
    if (req.method === 'GET') {
      res.end(
        JSON.stringify({
          name: 'usage',
          settings: { enabled: on, workspaces: on ? [WORK] : [] },
          status: {},
        }),
      );
      return;
    }
    let text = '';
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => {
      if (failPosts) {
        res.statusCode = 503;
        res.end('{}');
        return;
      }
      const body = JSON.parse(text) as Posted;
      posts.push(body);
      res.end(JSON.stringify({ accepted: body.records.length, changed: 0, ignored: 0 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

const cli = (...args: string[]) =>
  new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, [join(TOOL, 'docket-sync.mjs'), ...args], {
      env: {
        PATH: dirname(process.execPath),
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: dir,
        USERPROFILE: dir,
        CLAUDE_CONFIG_DIR: config,
        CODEX_HOME: join(dir, 'codex'),
        DOCKET_SYNC_HOME: join(dir, 'state'),
        DOCKET_SYNC_URL: url,
      },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('close', (code) => resolve({ code, out, err }));
  });

const savedState = () =>
  JSON.parse(readFileSync(join(dir, 'state', 'state.json'), 'utf8')) as {
    sources: Record<string, { state: { files?: Record<string, unknown> }; last_error: unknown }>;
  };
const filesTracked = () => Object.keys(savedState().sources.usage?.state.files ?? {}).length;
const everything = () =>
  ['state.json', 'sync.log'].map((f) => readFileSync(join(dir, 'state', f), 'utf8')).join('\n');

describe('the real usage source under the runner', () => {
  it('is found in the sources folder, with the GitHub source', async () => {
    const names = (await loadSources(() => {})).map((s: { name: string }) => s.name);
    expect(names.sort()).toEqual(['github', 'usage']);
  });

  it('off: makes no log call at all', async () => {
    on = false;
    const calls: string[] = [];
    const io = {
      open: (...a: Parameters<typeof open>) => (calls.push('open'), open(...a)),
      opendir: (...a: Parameters<typeof opendir>) => (calls.push('opendir'), opendir(...a)),
      stat: (...a: Parameters<typeof stat>) => (calls.push('stat'), stat(...a)),
    };
    let collected = 0;
    const source = {
      name: usage.name,
      intervalMs: usage.intervalMs,
      enabled: usage.enabled,
      collect: (ctx: unknown) => {
        collected += 1;
        return usage.collect(ctx, {
          io,
          roots: { codex: join(dir, 'codex'), claude: join(config, 'projects') },
        });
      },
    };
    const runner = createRunner({
      docket: createDocket({ baseUrl: url }),
      sources: [source],
      store: openStore(join(dir, 'state')),
      log: () => {},
    });
    expect(await runner.once()).toEqual({ usage: 'disabled' });
    expect(collected).toBe(0);
    expect(calls).toEqual([]);
    expect(posts).toEqual([]);
  });

  it('on: reads through the same seam, so the off test above can see a read', async () => {
    const calls: string[] = [];
    const io = {
      open: (...a: Parameters<typeof open>) => (calls.push('open'), open(...a)),
      opendir: (...a: Parameters<typeof opendir>) => (calls.push('opendir'), opendir(...a)),
      stat: (...a: Parameters<typeof stat>) => (calls.push('stat'), stat(...a)),
    };
    const source = {
      name: usage.name,
      intervalMs: usage.intervalMs,
      enabled: usage.enabled,
      collect: (ctx: unknown) =>
        usage.collect(ctx, {
          io,
          now: Date.parse('2026-11-21T00:00:00.000Z'),
          roots: { codex: join(dir, 'codex'), claude: join(config, 'projects') },
        }),
    };
    const runner = createRunner({
      docket: createDocket({ baseUrl: url }),
      sources: [source],
      store: openStore(join(dir, 'state')),
      log: () => {},
    });
    expect(await runner.once()).toEqual({ usage: 'ran' });
    expect(calls).toContain('open');
    expect(posts[0]!.records).toHaveLength(2);
  });

  it('off, from the command line: posts nothing and tracks no file', async () => {
    on = false;
    const out = await cli('once');
    expect(out.code, out.err).toBe(0);
    expect(out.out).toContain('usage: disabled');
    expect(reads.filter((r) => r.startsWith('POST'))).toEqual([]);
    expect(filesTracked()).toBe(0);
  });

  it('on, from the command line: posts to POST /api/sync/usage in the run shape', async () => {
    const out = await cli('once');
    expect(out.code, out.err).toBe(0);
    expect(out.out).toContain('usage: ran');
    expect(reads).toContain('POST /api/sync/usage');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.records.map((r) => r.output).sort()).toEqual([7, 9]);
    expect(posts[0]!.run).toMatchObject({ ok: true, partial: false, interval_ms: 300_000 });
    expect(filesTracked()).toBe(1);
  });

  it('saves its state only after a successful post, then does not resend', async () => {
    failPosts = true;
    expect((await cli('once')).code).toBe(1);
    expect(filesTracked()).toBe(0);
    expect(savedState().sources.usage!.last_error).toBe('docket_error');

    failPosts = false;
    expect((await cli('once')).code).toBe(0);
    expect(filesTracked()).toBe(1);
    expect(savedState().sources.usage!.last_error).toBeNull();
    expect(posts.at(-1)!.records).toHaveLength(2);

    // Nothing new in the log: the saved offset means nothing is sent again.
    expect((await cli('once')).code).toBe(0);
    expect(posts.at(-1)!.records).toEqual([]);

    // One new line: only that one is sent.
    writeLog(
      logLine('msg_fixture_1', 7),
      logLine('msg_fixture_2', 9),
      logLine('msg_fixture_3', 11),
    );
    expect((await cli('once')).code).toBe(0);
    expect(posts.at(-1)!.records.map((r) => r.output)).toEqual([11]);
  });

  it('keeps fixture text out of what it sends, stores and logs', async () => {
    expect((await cli('once')).code).toBe(0);
    expect(JSON.stringify(posts)).not.toContain(SECRET);
    expect(everything()).not.toContain(SECRET);
  });
});
