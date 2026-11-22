/**
 * The installed `docket-wait` script (owner decision 40), both versions,
 * against a real HTTP server: exit codes, the compact output, the address from
 * the connection file, the token in protected mode, and a Docket restart.
 *
 * A shell that isn't on this machine is skipped. Scripts run with an async
 * `spawn`, because the server lives in this process.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WAIT_EXIT, waitPs1, waitSh } from '../../src/domain/wait-scripts.js';
import { tempDir, type TempDir } from '../helpers.js';
import { createTestServer, PROTECTED_MODE, type TestServer } from './harness.js';

function findBash(): string | null {
  const candidates =
    process.platform === 'win32'
      ? ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe']
      : ['bash'];
  for (const c of candidates) {
    if (process.platform === 'win32' && !existsSync(c)) continue;
    if (spawnSync(c, ['-c', 'command -v curl'], { stdio: 'ignore' }).status === 0) return c;
  }
  return null;
}

function findPowerShell(): string | null {
  for (const c of process.platform === 'win32' ? ['powershell', 'pwsh'] : ['pwsh']) {
    const ok = spawnSync(c, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' });
    if (ok.status === 0) return c;
  }
  return null;
}

const SHELLS = { bash: findBash(), powershell: findPowerShell() };
type Shell = keyof typeof SHELLS;
const available = (Object.keys(SHELLS) as Shell[]).filter((k) => SHELLS[k]);

const freePort = () =>
  new Promise<number>((resolve) => {
    const srv = createServer().listen(0, '127.0.0.1', () => {
      const p = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });

const listen = (s: TestServer, port: number) =>
  new Promise<ServerType>((resolve) => {
    const http: ServerType = serve({ fetch: s.app.fetch, hostname: '127.0.0.1', port }, () =>
      resolve(http),
    );
  });

const stop = (http: ServerType) =>
  new Promise<void>((resolve) => {
    (http as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    http.close(() => resolve());
  });

let tmp: TempDir;
let dir: string;

/** Run the installed script; resolves with its exit code and output. */
function runWait(shell: Shell, args: string[], env: Record<string, string | undefined> = {}) {
  const exe = SHELLS[shell]!;
  const argv =
    shell === 'bash'
      ? [join(dir, 'docket-wait.sh').replace(/\\/g, '/'), ...args]
      : [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(dir, 'docket-wait.ps1'),
          ...args,
        ];
  const { DOCKET_TOKEN: _token, DOCKET_URL: _url, ...base } = process.env;
  return new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(exe, argv, { env: { ...base, ...env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    const timer = setTimeout(() => child.kill(), 40_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: out.replace(/\r\n/g, '\n'), err });
    });
  });
}

const latest = (s: TestServer) =>
  (
    s.runtime.db.sqlite.prepare('SELECT coalesce(max(seq), 0) AS m FROM events').get() as {
      m: number;
    }
  ).m;

/** Commit one event, through the write path, so the waiters wake. */
function commit(s: TestServer): void {
  s.runtime.write.run(
    {
      actor: { kind: 'system', client: null, label: null },
      operation: 'test.event',
      args: {},
    },
    (w) => w.event({ type: 'project.created', summary: 'A test change', project_key: null }),
  );
}

const until = async (check: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};

beforeAll(() => {
  tmp = tempDir('docket-wait-');
  dir = join(tmp.dir, 'repo', '.claude');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'docket-wait.sh'), waitSh());
  writeFileSync(join(dir, 'docket-wait.ps1'), waitPs1());
});
afterAll(() => tmp.cleanup());

describe.skipIf(available.length === 0).each(available)('docket-wait (%s)', (shell) => {
  let s: TestServer;
  let http: ServerType;
  let port: number;
  let url: string;

  beforeAll(async () => {
    port = await freePort();
    url = `http://127.0.0.1:${port}`;
    s = createTestServer({ env: { DOCKET_ALLOWED_HOSTS: `127.0.0.1:${port}` }, log: () => {} });
    http = await listen(s, port);
  });
  afterAll(async () => {
    await stop(http);
    await s.cleanup();
  });

  it('blocks until a change, prints the cursor and one line per event, exits 0', async () => {
    const cursor = latest(s);
    const run = runWait(shell, ['--cursor', String(cursor), '--timeout', '25', '--url', url]);
    await until(() => s.runtime.changes.size === 1);
    commit(s);
    const r = await run;
    expect(r.code, r.err).toBe(WAIT_EXIT.changed);
    const lines = r.out.trimEnd().split('\n');
    expect(lines[0]).toBe(`changed cursor=${latest(s)} events=1`);
    expect(lines[1]).toBe(`${latest(s)} - project.created A test change`);
  }, 45_000);

  it('at --timeout prints the same cursor and exits 2', async () => {
    const cursor = latest(s);
    const r = await runWait(shell, ['--cursor', String(cursor), '--timeout', '1', '--url', url]);
    expect(r.code, r.err).toBe(WAIT_EXIT.timeout);
    expect(r.out.trim()).toBe(`timeout cursor=${cursor} events=0`);
  }, 45_000);

  it('without --cursor it starts from now', async () => {
    const r = await runWait(shell, ['--timeout', '1', '--url', url]);
    expect(r.code, r.err).toBe(WAIT_EXIT.timeout);
    expect(r.out.trim()).toBe(`timeout cursor=${latest(s)} events=0`);
  }, 45_000);

  it('finds the address in the connection file', async () => {
    const mcp = join(tmp.dir, 'repo', '.mcp.json');
    writeFileSync(
      mcp,
      `{\n  "mcpServers": {\n    "docket": {\n      "type": "http",\n      "url": "${url}/mcp"\n    }\n  }\n}\n`,
    );
    const r = await runWait(shell, ['--cursor', String(latest(s)), '--timeout', '1']);
    expect(r.code, r.err).toBe(WAIT_EXIT.timeout);
  }, 45_000);

  it('a bad flag or a refused wait exits 1, with the reason on stderr', async () => {
    const flag = await runWait(shell, ['--nope', '1', '--url', url]);
    expect(flag.code).toBe(WAIT_EXIT.error);
    expect(flag.err).toContain('unknown option');
    const types = await runWait(shell, ['--types', 'not.real', '--timeout', '1', '--url', url]);
    expect(types.code).toBe(WAIT_EXIT.error);
    expect(types.err).toContain('400');
  }, 45_000);

  it('survives a Docket restart and still sees the change', async () => {
    const cursor = latest(s);
    const run = runWait(shell, ['--cursor', String(cursor), '--timeout', '30', '--url', url]);
    await until(() => s.runtime.changes.size === 1);
    await stop(http);
    await new Promise((r) => setTimeout(r, 1_200));
    // The change lands while the server is down for the script.
    commit(s);
    http = await listen(s, port);
    const r = await run;
    expect(r.code, r.err).toBe(WAIT_EXIT.changed);
    expect(r.out).toContain(`changed cursor=${latest(s)} events=1`);
  }, 45_000);

  it('protected mode: DOCKET_TOKEN gets through, and no token exits 1', async () => {
    const p = await freePort();
    const secured = createTestServer({
      env: { ...PROTECTED_MODE, DOCKET_ALLOWED_HOSTS: `127.0.0.1:${p}` },
      log: () => {},
    });
    const server = await listen(secured, p);
    try {
      const base = ['--timeout', '1', '--url', `http://127.0.0.1:${p}`];
      const none = await runWait(shell, base);
      expect(none.code).toBe(WAIT_EXIT.error);
      expect(none.err).toContain('401');
      const ok = await runWait(shell, base, { DOCKET_TOKEN: secured.runtime.secrets.agentToken() });
      expect(ok.code, ok.err).toBe(WAIT_EXIT.timeout);
    } finally {
      await stop(server);
      await secured.cleanup();
    }
  }, 45_000);
});
