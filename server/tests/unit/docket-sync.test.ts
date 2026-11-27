/**
 * tools/docket-sync (owner decision 49): the runner, the GitHub source and the
 * `gh` wrapper. **No test calls real GitHub or uses the host's login.** The
 * source gets a fake object, and the end-to-end tests put a fake `gh` first on
 * PATH (POSIX only, so CI runs them) with a fake Docket on loopback.
 */
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TOOL = join(ROOT, 'tools', 'docket-sync');
const lib = (name: string) =>
  import(/* @vite-ignore */ pathToFileURL(join(TOOL, 'lib', name)).href);

const { assertReadOnly, childEnv, classifyFailure, createGh, findGh } = await lib('gh.mjs');
const { MAX_REQUESTS, RATE_FLOOR, collectWith, isMergeQueue, keysInText, toRecord } =
  await lib('github.mjs');
const { BATCH_SIZE, backoffMs, createRunner, loadSources } = await lib('runner.mjs');
const { DocketError } = await lib('docket.mjs');
const { acquireLock, createLog, openStore, redact } = await lib('store.mjs');
const source = await import(
  /* @vite-ignore */ pathToFileURL(join(TOOL, 'sources', 'github.mjs')).href
);

const TOKEN = `ghp_${'Z9y8'.repeat(10)}`;
const NOW = Date.parse('2026-11-23T12:00:00.000Z');
const SETTINGS = { enabled: true, repos: [{ repo: 'acme/web', projects: ['GF'] }] };

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'docket-sync-test-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const logs = () => {
  const lines: string[] = [];
  const log = (event: string, fields: Record<string, unknown> = {}) =>
    lines.push(`${event} ${JSON.stringify(fields)}`);
  return { lines, log };
};

const prNode = (number: number, over: Record<string, unknown> = {}) => ({
  number,
  title: `Change ${number}`,
  state: 'OPEN',
  isDraft: false,
  headRefName: `dev/GF-${number}-x`,
  headRefOid: 'a'.repeat(40),
  createdAt: '2026-11-23T10:00:00Z',
  updatedAt: '2026-11-23T11:00:00Z',
  mergedAt: null,
  body: `Private body text for GF-${number + 1}.`,
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  ...over,
});

const page = (nodes: unknown[], over: { next?: string; remaining?: number } = {}) => ({
  data: {
    rateLimit: { remaining: over.remaining ?? 4900, resetAt: '2026-11-23T13:00:00Z' },
    repository: {
      pullRequests: {
        pageInfo: { hasNextPage: !!over.next, endCursor: over.next ?? null },
        nodes,
      },
    },
  },
});

function fakeGh(pages: (query: string, vars: Record<string, string>) => unknown) {
  const calls: { query: string; vars: Record<string, string> }[] = [];
  return {
    calls,
    authStatus: async () => {},
    graphql: async (query: string, vars: Record<string, string>) => {
      calls.push({ query, vars });
      return pages(query, vars);
    },
  };
}

const collect = (gh: unknown, state: unknown = {}, settings: unknown = SETTINGS) =>
  collectWith(gh, { state, log: logs().log, signal: undefined, settings }, () => NOW);

describe('reading GitHub', () => {
  it('turns a PR into a record and never carries its body', () => {
    const record = toRecord('acme/web', prNode(7));
    expect(record).toMatchObject({
      key: 'acme/web#7',
      head_branch: 'dev/GF-7-x',
      ci: 'passed',
      state: 'open',
      related_keys: ['GF-8'],
    });
    expect(JSON.stringify(record)).not.toContain('Private body');
  });

  it('finds keys in prose as whole tokens', () => {
    expect(keysInText('See GF-12, GF-12 and AB-3. Not XGF-1x or sha-256.')).toEqual([
      'GF-12',
      'AB-3',
    ]);
  });

  it('recognises Mergify merge-queue PRs', () => {
    expect(isMergeQueue({ title: 'merge queue: embarking #1', headRefName: 'x' })).toBe(true);
    expect(isMergeQueue({ title: 'x', headRefName: 'mergify/merge-queue/abc' })).toBe(true);
    expect(isMergeQueue({ title: 'Fix the merge queue', headRefName: 'dev/GF-1' })).toBe(false);
  });

  it('leaves merge-queue PRs out, and reports the repository', async () => {
    const gh = fakeGh(() => page([prNode(1), prNode(2, { title: 'merge queue: batch' })]));
    const { records, state } = await collect(gh);
    expect(records.filter((r: { kind: string }) => r.kind === 'pr')).toHaveLength(1);
    expect(records.find((r: { kind: string }) => r.kind === 'repo')).toMatchObject({
      key: 'repo:acme/web',
      ok: true,
    });
    expect(state.repos['acme/web'].since).toBe(new Date(NOW - 120_000).toISOString());
  });

  it('stops at the watermark', async () => {
    const old = prNode(3, { updatedAt: '2026-11-20T00:00:00Z' });
    let changedPages = 0;
    const gh = fakeGh((query) => {
      if (query.includes('states:OPEN')) return page([]);
      changedPages += 1;
      return page([prNode(4), old], { next: 'more' });
    });
    const { records } = await collect(gh, {
      repos: { 'acme/web': { since: '2026-11-22T00:00:00Z' } },
    });
    expect(changedPages).toBe(1);
    expect(records.map((r: { key: string }) => r.key)).not.toContain('acme/web#3');
  });

  it('never goes past the request budget', async () => {
    const repos = Array.from({ length: 12 }, (_, k) => ({ repo: `acme/r${k}`, projects: ['GF'] }));
    const gh = fakeGh(() => page([prNode(1)], { next: 'more' }));
    await collect(gh, {}, { enabled: true, repos });
    expect(gh.calls.length).toBeLessThanOrEqual(MAX_REQUESTS);
  });

  it('stops and waits near the rate limit', async () => {
    const gh = fakeGh(() => page([prNode(1)], { remaining: RATE_FLOOR - 1, next: 'more' }));
    const first = await collect(gh);
    expect(gh.calls).toHaveLength(1);
    expect(first.state.paused_until).toBe('2026-11-23T13:00:00Z');
    // Still waiting: a failure, so it can't read as a fresh sync, and no request is made.
    await expect(collect(gh, first.state)).rejects.toMatchObject({ code: 'rate_limited' });
    expect(gh.calls).toHaveLength(1);
    const after = { ...first.state, paused_until: '2026-11-23T11:00:00Z' };
    await collect(gh, after);
    expect(gh.calls.length).toBeGreaterThan(1);
  });

  it('keeps going when one repository is gone', async () => {
    const settings = {
      enabled: true,
      repos: [
        { repo: 'acme/gone', projects: ['GF'] },
        { repo: 'acme/web', projects: ['GF'] },
      ],
    };
    const gh = fakeGh((_q, vars) =>
      vars.name === 'gone' ? { errors: [{ type: 'NOT_FOUND' }], data: null } : page([prNode(1)]),
    );
    const { records } = await collect(gh, {}, settings);
    expect(records.find((r: { key: string }) => r.key === 'repo:acme/gone')).toMatchObject({
      ok: false,
      error: 'repo_not_found',
    });
    expect(records.some((r: { key: string }) => r.key === 'acme/web#1')).toBe(true);
  });

  it('is on only with the setting and a repository', () => {
    expect(source.name).toBe('github');
    expect(source.enabled(SETTINGS)).toBe(true);
    expect(source.enabled({ enabled: false, repos: SETTINGS.repos })).toBe(false);
    expect(source.enabled({ enabled: true, repos: [] })).toBe(false);
    expect(source.enabled(undefined)).toBe(false);
  });
});

describe('the gh wrapper', () => {
  it('allows only auth status and a GraphQL query', () => {
    expect(() => assertReadOnly(['auth', 'status'])).not.toThrow();
    expect(() =>
      assertReadOnly(['api', 'graphql', '-f', 'query=query { viewer { login } }']),
    ).not.toThrow();
    for (const args of [
      ['api', 'graphql', '-f', 'query=mutation { addComment }'],
      ['api', 'graphql', '-f', 'query=query { x } mutation { y }'],
      ['pr', 'merge', '1'],
      ['pr', 'comment', '1'],
      ['api', 'repos/acme/web/issues', '-X', 'POST'],
      ['auth', 'token'],
    ]) {
      expect(() => assertReadOnly(args), args.join(' ')).toThrow('not_read_only');
    }
  });

  it('passes no token to gh', () => {
    const env = childEnv({
      PATH: '/bin',
      HOME: '/home/x',
      GH_TOKEN: TOKEN,
      GITHUB_TOKEN: TOKEN,
      GH_ENTERPRISE_TOKEN: TOKEN,
      NODE_OPTIONS: '--require evil.js',
      GH_HOST: 'evil.example',
    });
    expect(JSON.stringify(env)).not.toContain(TOKEN);
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.GH_HOST).toBeUndefined();
    expect(env.GH_PROMPT_DISABLED).toBe('1');
  });

  it('only takes gh from an absolute PATH entry', () => {
    const name = process.platform === 'win32' ? 'gh.exe' : 'gh';
    writeFileSync(join(home, name), '');
    expect(findGh({ PATH: `.${delimiter}relative` })).toBeNull();
    expect(findGh({ PATH: home })).toBe(join(home, name));
  });

  it('sorts failures by kind', () => {
    expect(classifyFailure('API rate limit exceeded')).toBe('rate_limited');
    expect(classifyFailure('To get started, run: gh auth login')).toBe('gh_signed_out');
    expect(classifyFailure('dial tcp: could not resolve host')).toBe('network');
    expect(classifyFailure('something else')).toBe('gh_error');
  });

  it('says gh is missing', async () => {
    await expect(createGh({ env: { PATH: home } }).authStatus()).rejects.toMatchObject({
      code: 'gh_missing',
    });
  });
});

describe('the runner', () => {
  const makeDocket = (over: Record<string, unknown> = {}) => {
    const posts: { name: string; body: { records: unknown[]; run: Record<string, unknown> } }[] =
      [];
    return {
      posts,
      readSource: async () => ({ settings: SETTINGS }),
      post: async (name: string, body: never) => {
        posts.push({ name, body });
        return { accepted: 0, changed: 0, ignored: 0 };
      },
      reader: () => ({ get: async () => ({}) }),
      ...over,
    };
  };
  const makeSource = (collectFn: (ctx: { state: unknown }) => unknown, over = {}) => ({
    name: 'test',
    intervalMs: 60_000,
    enabled: () => true,
    collect: collectFn,
    ...over,
  });
  const clock = () => {
    const t = { now: NOW };
    return { t, now: () => t.now };
  };

  it('runs the Orca audit on its own cadence while another source is awaiting I/O', async () => {
    let releaseOther = () => {};
    const blocked = new Promise<void>((resolve) => {
      releaseOther = resolve;
    });
    let audits = 0;
    const other = makeSource(
      async () => {
        await blocked;
        return { records: [], state: {} };
      },
      { name: 'other' },
    );
    const audit = makeSource(
      () => {
        audits += 1;
        return { records: [], state: {} };
      },
      { name: 'orca-audit', intervalMs: 5, independent: true },
    );
    const controller = new AbortController();
    const runner = createRunner({
      docket: makeDocket(),
      sources: [other, audit],
      store: openStore(home),
      log: logs().log,
    });
    const running = runner.run(controller.signal);
    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(audits).toBeGreaterThanOrEqual(2);
    } finally {
      controller.abort();
      releaseOther();
      await running;
    }
  });

  it('saves state only after every batch is accepted', async () => {
    const store = openStore(home);
    const records = Array.from({ length: BATCH_SIZE + 1 }, (_, k) => ({ key: `k${k}` }));
    let failSecond = true;
    const docket = makeDocket({
      post: async (_n: string, body: { run: { partial?: boolean } }) => {
        if (!body.run.partial && failSecond) throw new DocketError('unreachable');
        return {};
      },
    });
    const c = clock();
    const runner = createRunner({
      docket,
      sources: [makeSource(() => ({ records, state: { mark: 2 } }))],
      store,
      log: logs().log,
      now: c.now,
    });
    await runner.once();
    expect(store.source('test').state).toEqual({});
    expect(store.source('test').failures).toBe(1);
    failSecond = false;
    await runner.once();
    expect(store.source('test').state).toEqual({ mark: 2 });
    expect(store.source('test').failures).toBe(0);
  });

  it('sends one batch, closing the run, even with no records', async () => {
    const docket = makeDocket();
    const runner = createRunner({
      docket,
      sources: [makeSource(() => ({ records: [], state: {} }))],
      store: openStore(home),
      log: logs().log,
    });
    await runner.once();
    expect(docket.posts).toHaveLength(1);
    expect(docket.posts[0]!.body.run).toMatchObject({ ok: true, partial: false });
  });

  it('spends nothing on the source while Docket is down, then recovers', async () => {
    let up = false;
    let collected = 0;
    const docket = makeDocket({
      readSource: async () => {
        if (!up) throw new DocketError('unreachable');
        return { settings: SETTINGS };
      },
    });
    const c = clock();
    const store = openStore(home);
    const s = makeSource(() => {
      collected += 1;
      return { records: [], state: {} };
    });
    const runner = createRunner({ docket, sources: [s], store, log: logs().log, now: c.now });
    expect(await runner.runSource(s)).toBe('failed');
    expect(collected).toBe(0);
    expect(store.source('test').last_error).toBe('unreachable');
    expect(await runner.runSource(s)).toBe('skipped');
    c.t.now += backoffMs(1);
    up = true;
    expect(await runner.runSource(s)).toBe('ran');
    expect(store.source('test').last_error).toBeNull();
  });

  it('tells Docket when a collection fails', async () => {
    const docket = makeDocket();
    const err = Object.assign(new Error(`contains ${TOKEN}`), { code: 'gh_signed_out' });
    const { lines, log } = logs();
    const store = openStore(home);
    const runner = createRunner({
      docket,
      sources: [
        makeSource(() => {
          throw err;
        }),
      ],
      store,
      log,
    });
    await runner.once();
    expect(docket.posts[0]!.body.run).toMatchObject({ ok: false, error: 'gh_signed_out' });
    expect(lines.join('\n')).not.toContain(TOKEN);
    expect(JSON.stringify(store.state)).not.toContain(TOKEN);
  });

  it('reduces an unknown failure to a code', async () => {
    const docket = makeDocket();
    const store = openStore(home);
    const runner = createRunner({
      docket,
      sources: [
        makeSource(() => {
          throw new Error(`boom ${TOKEN}`);
        }),
      ],
      store,
      log: logs().log,
    });
    await runner.once();
    expect(store.source('test').last_error).toBe('collect_failed');
    expect(JSON.stringify(docket.posts)).not.toContain(TOKEN);
  });

  it('backs off exponentially, longer for a rate limit, and caps', () => {
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(2)).toBe(120_000);
    expect(backoffMs(20)).toBe(30 * 60_000);
    expect(backoffMs(1, 'rate_limited')).toBe(15 * 60_000);
  });

  it('never calls a source that is off', async () => {
    let collected = 0;
    const s = makeSource(
      () => {
        collected += 1;
        return { records: [], state: {} };
      },
      { enabled: () => false },
    );
    const runner = createRunner({
      docket: makeDocket(),
      sources: [s],
      store: openStore(home),
      log: logs().log,
    });
    expect(await runner.runSource(s, { force: true })).toBe('disabled');
    expect(collected).toBe(0);
  });

  it('skips a source this Docket does not know', async () => {
    const s = makeSource(() => ({ records: [], state: {} }));
    const runner = createRunner({
      docket: makeDocket({ readSource: async () => null }),
      sources: [s],
      store: openStore(home),
      log: logs().log,
    });
    expect(await runner.runSource(s, { force: true })).toBe('unknown');
  });

  it('gives a source exactly the contract’s context', async () => {
    let keys: string[] = [];
    const s = makeSource((ctx) => {
      keys = Object.keys(ctx as object).sort();
      return { records: [], state: {} };
    });
    const runner = createRunner({
      docket: makeDocket(),
      sources: [s],
      store: openStore(home),
      log: logs().log,
    });
    await runner.once();
    expect(keys).toEqual(['docket', 'log', 'settings', 'signal', 'state']);
  });

  it('loads the sources folder and skips a broken file', async () => {
    const dir = join(home, 'sources');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'good.mjs'),
      `export const name='good'; export const intervalMs=1000; export const enabled=()=>true; export const collect=async()=>({records:[],state:{}});`,
    );
    writeFileSync(
      join(dir, 'also.mjs'),
      `export default {name:'also',intervalMs:1000,enabled:()=>true,collect:async()=>({records:[],state:{}})};`,
    );
    writeFileSync(join(dir, 'bad.mjs'), `export const name = 'NOT VALID';`);
    const { lines, log } = logs();
    const loaded = await loadSources(log, dir);
    expect(loaded.map((m: { name: string }) => m.name).sort()).toEqual(['also', 'good']);
    expect(lines.join('\n')).toContain('source_invalid');
  });
});

describe('the store', () => {
  it('survives a damaged state file and keeps a copy', () => {
    writeFileSync(join(home, 'state.json'), '{not json');
    const store = openStore(home);
    expect(store.recovered).toBe(true);
    expect(store.state.sources).toEqual({});
    expect(readdirSync(home).some((f) => f.startsWith('state.json.corrupt-'))).toBe(true);
  });

  it('writes state with no temp file left behind', () => {
    const store = openStore(home);
    store.source('github').state = { mark: 1 };
    store.save();
    expect(readdirSync(home).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).sources.github.state).toEqual(
      { mark: 1 },
    );
  });

  it('runs one instance per state folder', async () => {
    const release = await acquireLock(home);
    expect(release).toBeTruthy();
    expect(await acquireLock(home)).toBeNull();
    await release();
    const again = await acquireLock(home);
    expect(again).toBeTruthy();
    await again();
  });

  it('never logs a token', () => {
    const log = createLog(home);
    log('failed', { detail: `token ${TOKEN}`, other: TOKEN });
    expect(readFileSync(join(home, 'sync.log'), 'utf8')).not.toContain(TOKEN);
    expect(redact(`x ${TOKEN} y`)).toBe('x [withheld] y');
  });
});

describe('the install script', () => {
  const manage = readFileSync(join(TOOL, 'manage.ps1'), 'utf8');
  const list = (name: string) => {
    const m = new RegExp(`\\$script:${name} = @\\(([^)]*)\\)`).exec(manage);
    return [...(m?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
  };

  it('lists exactly the files in the tool', () => {
    const files = (dir: string) =>
      readdirSync(join(TOOL, dir), { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .sort();
    expect(list('AppFiles')).toEqual(files('.'));
    expect(list('LibFiles')).toEqual(files('lib'));
    expect(list('SourceFiles')).toEqual(files('sources'));
  });

  it('never kills a process or deletes recursively', () => {
    const code = manage
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(/Stop-Process|taskkill|-Recurse|\.Kill\(/i);
    expect(code).not.toMatch(/Start-ScheduledTask/);
  });

  it('is a separate tool from the relay', () => {
    expect(manage).not.toMatch(/relay/i);
    expect(existsSync(join(ROOT, 'tools', 'docket-relay', 'docket-relay.mjs'))).toBe(true);
  });
});

/** A fake `gh`, first on PATH. It writes down its arguments and environment. */
const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TMPDIR + '/gh-calls.jsonl', JSON.stringify({
  args: args.map((a) => a.startsWith('query=') ? 'query=…' : a),
  tokens: Object.keys(process.env).filter((k) => /TOKEN/.test(k)),
}) + '\\n');
const mode = fs.readFileSync(process.env.TMPDIR + '/gh-mode', 'utf8').trim();
if (args[0] === 'auth') {
  if (mode === 'signed_out') { console.error('You are not logged into any GitHub hosts. To log in, run: gh auth login'); process.exit(1); }
  console.log('Logged in, Token: ${TOKEN}');
  process.exit(0);
}
if (mode === 'network') { console.error('error connecting to api.github.com: could not resolve host'); process.exit(1); }
console.log(JSON.stringify({ data: {
  rateLimit: { remaining: 4900, resetAt: '2026-11-23T13:00:00Z' },
  repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{
    number: 42, title: 'A change', state: 'OPEN', isDraft: false, headRefName: 'dev/GF-42-x',
    headRefOid: '${'b'.repeat(40)}', createdAt: '2026-11-23T10:00:00Z', updatedAt: new Date().toISOString(),
    mergedAt: null, body: 'Secret plans', commits: { nodes: [] },
  }] } },
} }));
`;

describe.skipIf(process.platform === 'win32')('end to end, with a fake gh on PATH', () => {
  let server: Server;
  let url: string;
  let received: { records: { key: string }[]; run: Record<string, unknown> }[];
  let docketUp: boolean;
  let bin: string;
  let tmp: string;

  beforeEach(async () => {
    received = [];
    docketUp = true;
    bin = join(home, 'bin');
    tmp = join(home, 'tmp');
    mkdirSync(bin);
    mkdirSync(tmp);
    writeFileSync(join(bin, 'gh'), FAKE_GH);
    chmodSync(join(bin, 'gh'), 0o755);
    writeFileSync(join(tmp, 'gh-mode'), 'ok');
    server = createServer((req, res) => {
      if (!docketUp) {
        res.statusCode = 503;
        res.end('{}');
        return;
      }
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET') {
        // This fixture exercises GitHub only; the installed Orca source has no CLI on CI runners.
        const isGithub = req.url === '/api/sync/github';
        res.end(
          JSON.stringify({
            name: isGithub ? 'github' : 'orca-presence',
            settings: isGithub ? SETTINGS : { enabled: false },
            status: {},
          }),
        );
        return;
      }
      let text = '';
      req.on('data', (c) => (text += c));
      req.on('end', () => {
        received.push(JSON.parse(text));
        res.end(JSON.stringify({ accepted: 1, changed: 1, ignored: 0 }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise((resolve) => server.close(resolve)));

  const run = (...args: string[]) =>
    new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const nodeDir = dirname(process.execPath);
      const child = spawn(process.execPath, [join(TOOL, 'docket-sync.mjs'), ...args], {
        env: {
          PATH: `${bin}${delimiter}${nodeDir}${delimiter}/usr/bin${delimiter}/bin`,
          HOME: home,
          TMPDIR: tmp,
          DOCKET_SYNC_HOME: join(home, 'state'),
          DOCKET_SYNC_URL: url,
          GH_TOKEN: TOKEN,
          GITHUB_TOKEN: TOKEN,
        },
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (err += c));
      child.on('close', (code) => resolve({ code, out, err }));
    });

  const everything = () =>
    readdirSync(join(home, 'state'))
      .filter((f) => !f.endsWith('.sock'))
      .map((f) => readFileSync(join(home, 'state', f), 'utf8'))
      .join('\n');
  const ghCalls = () =>
    readFileSync(join(tmp, 'gh-calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { args: string[]; tokens: string[] });

  it('collects, posts and keeps no secret anywhere', async () => {
    const out = await run('once');
    expect(out.code, out.err).toBe(0);
    const keys = received.flatMap((b) => b.records.map((r) => r.key));
    expect(keys).toEqual(expect.arrayContaining(['acme/web#42', 'repo:acme/web']));
    const posted = JSON.stringify(received);
    expect(posted).not.toContain('Secret plans');
    expect(posted).not.toContain(TOKEN);
    expect(everything()).not.toContain(TOKEN);
    expect(everything()).not.toContain('Secret plans');
    for (const call of ghCalls()) {
      expect(call.tokens).toEqual([]);
      expect(['auth', 'api']).toContain(call.args[0]);
    }
  });

  it('reports a signed-out gh to Docket, then recovers', async () => {
    writeFileSync(join(tmp, 'gh-mode'), 'signed_out');
    expect((await run('once')).code).toBe(1);
    expect(received.at(-1)!.run).toMatchObject({ ok: false, error: 'gh_signed_out' });
    writeFileSync(join(tmp, 'gh-mode'), 'ok');
    expect((await run('once')).code).toBe(0);
    expect(received.at(-1)!.run).toMatchObject({ ok: true });
  });

  it('reports no network, keeps its state, and spends no gh call while Docket is down', async () => {
    writeFileSync(join(tmp, 'gh-mode'), 'network');
    expect((await run('once')).code).toBe(1);
    expect(received.at(-1)!.run).toMatchObject({ ok: false, error: 'network' });
    writeFileSync(join(tmp, 'gh-mode'), 'ok');
    docketUp = false;
    const before = ghCalls().length;
    expect((await run('once')).code).toBe(1);
    expect(ghCalls().length).toBe(before);
    const status = await run('status', '--json');
    expect(JSON.parse(status.out).sources.github.last_error).toBe('docket_error');
  });

  it('does not run a second instance', async () => {
    const release = await acquireLock(join(home, 'state'));
    const out = await run('once');
    await release();
    expect(out.code).toBe(2);
    expect(out.err).toContain('already running');
  });

  it('shows help and refuses an unknown command', async () => {
    expect((await run('help')).out).toContain('docket-sync');
    expect((await run('nonsense')).code).toBe(1);
  });
});
