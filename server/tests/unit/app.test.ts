import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';

let root: string;
let webRoot: string;
let dataDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tasklite-app-'));
  webRoot = join(root, 'web');
  dataDir = join(root, 'data');
  mkdirSync(join(webRoot, 'assets'), { recursive: true });
  mkdirSync(dataDir);
  writeFileSync(
    join(webRoot, 'index.html'),
    '<!doctype html><title>Task Lite</title><div id="root"></div>',
  );
  writeFileSync(join(webRoot, 'assets', 'app.js'), 'console.log("app");');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('health endpoints', () => {
  it('GET /healthz answers ok while the process is up', async () => {
    const res = await createApp({ webRoot, dataDir }).request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('GET /readyz is ready when the data directory is writable', async () => {
    const res = await createApp({ webRoot, dataDir }).request('/readyz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ready', checks: { data_dir: 'ok' } });
  });

  it('GET /readyz is 503 when the data directory is missing', async () => {
    const res = await createApp({ webRoot, dataDir: join(root, 'missing') }).request('/readyz');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; checks: { data_dir: string } };
    expect(body.status).toBe('not_ready');
    expect(body.checks.data_dir).not.toBe('ok');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'GET /readyz is 503 when the data directory is read-only',
    async () => {
      chmodSync(dataDir, 0o555);
      try {
        const res = await createApp({ webRoot, dataDir }).request('/readyz');
        expect(res.status).toBe(503);
      } finally {
        chmodSync(dataDir, 0o755);
      }
    },
  );
});

describe('web build', () => {
  it('serves index.html at /', async () => {
    const res = await createApp({ webRoot, dataDir }).request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toContain('<div id="root"></div>');
  });

  it('serves static assets', async () => {
    const res = await createApp({ webRoot, dataDir }).request('/assets/app.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('console.log');
  });

  it('falls back to index.html for client-side routes', async () => {
    const res = await createApp({ webRoot, dataDir }).request('/work/board?project=RCP');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toContain('<div id="root"></div>');
  });

  it('does not fall back for a missing asset', async () => {
    const res = await createApp({ webRoot, dataDir }).request('/assets/missing.js');
    expect(res.status).toBe(404);
  });

  it.each(['/api/anything', '/mcp'])('does not fall back for %s', async (path) => {
    const res = await createApp({ webRoot, dataDir }).request(path);
    expect(res.status).toBe(404);
  });

  it('does not fall back for non-GET requests', async () => {
    const res = await createApp({ webRoot, dataDir }).request('/work', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});
