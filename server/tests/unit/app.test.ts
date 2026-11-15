import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../../src/app.js';
import { createRuntime, type Runtime } from '../../src/runtime.js';
import { tempDir, type TempDir } from '../helpers.js';

const BASE = 'http://127.0.0.1:7420';

let tmp: TempDir;
let webRoot: string;
let runtime: Runtime;
let app: Hono;
const get = (path: string, init?: RequestInit) =>
  Promise.resolve(app.request(`${BASE}${path}`, init));

beforeEach(() => {
  tmp = tempDir('tasklite-app-');
  webRoot = join(tmp.dir, 'web');
  mkdirSync(join(webRoot, 'assets'), { recursive: true });
  writeFileSync(
    join(webRoot, 'index.html'),
    '<!doctype html><title>Task Lite</title><div id="root"></div>',
  );
  writeFileSync(join(webRoot, 'assets', 'app.js'), 'console.log("app");');
  mkdirSync(join(tmp.dir, 'data'));
  runtime = createRuntime({ dataDir: join(tmp.dir, 'data'), env: {} });
  app = createApp(runtime, { webRoot });
});

afterEach(async () => {
  await runtime.close();
  tmp.cleanup();
});

describe('health endpoints', () => {
  it('GET /healthz answers ok while the process is up', async () => {
    const res = await get('/healthz');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('GET /readyz is ready when the volume, database and docs are writable and migrations are current', async () => {
    const res = await get('/readyz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'ready',
      checks: { data_dir: 'ok', database: 'ok', docs_dir: 'ok', migrations: 'ok' },
    });
  });

  it('GET /readyz leaves no trace of its database probe', async () => {
    await get('/readyz');
    const n = runtime.db.sqlite.prepare('SELECT count(*) AS n FROM settings').get() as {
      n: number;
    };
    expect(n.n).toBe(0);
  });

  it('GET /readyz is 503 when the docs directory is not writable', async () => {
    rmSync(runtime.config.paths.docs, { recursive: true, force: true });
    writeFileSync(runtime.config.paths.docs, 'not a directory');
    const res = await get('/readyz');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; checks: Record<string, string> };
    expect(body.status).toBe('not_ready');
    expect(body.checks.docs_dir).not.toBe('ok');
  });

  it('GET /readyz is 503 when migrations are not current', async () => {
    runtime.db.sqlite
      .prepare(
        'DELETE FROM __drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM __drizzle_migrations)',
      )
      .run();
    const res = await get('/readyz');
    expect(res.status).toBe(503);
    expect(((await res.json()) as { checks: Record<string, string> }).checks.migrations).toBe(
      'pending',
    );
  });
});

describe('web build', () => {
  it('serves index.html at /', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toContain('<div id="root"></div>');
  });

  it('serves static assets', async () => {
    const res = await get('/assets/app.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('console.log');
  });

  it('falls back to index.html for client-side routes', async () => {
    const res = await get('/work/board?project=RCP');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toContain('<div id="root"></div>');
  });

  it('does not fall back for a missing asset', async () => {
    const res = await get('/assets/missing.js');
    expect(res.status).toBe(404);
  });

  it.each(['/api/anything', '/mcp'])(
    'does not fall back for %s (it is guarded instead)',
    async (path) => {
      const res = await get(path);
      expect(res.status).toBe(401);
    },
  );

  it('does not fall back for non-GET requests', async () => {
    const res = await get('/work', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});
