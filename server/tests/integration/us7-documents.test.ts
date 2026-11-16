/**
 * Documents over HTTP (tasks.md T124; BUILD_SPEC §5.10; MCP_SPEC §5.6).
 *
 * - `POST /agent-upload` (bearer, multipart) streams the file to disk and
 *   hashes it as it goes: a 100 MB upload, generated on the fly, keeps
 *   memory flat (the figures are printed for the PR).
 * - Over 500 MB is refused, by its Content-Length up front or while
 *   streaming, and no version or partial file is kept.
 * - Bad fields, a missing file or an unknown item leave nothing staged.
 * - `GET /api/documents/:versionId/content` sends `Content-Disposition`,
 *   `X-Content-Type-Options: nosniff` and a sandboxing CSP.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_UPLOAD_MAX_BYTES } from '@tasklite/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSampleSeed } from '../../src/db/seed/loader.js';
import { createTestServer, parseSetCookies, type TestServer } from './harness.js';

let s: TestServer;
beforeEach(() => {
  s = createTestServer();
  loadSampleSeed(s.runtime.db, { now: s.clock.now(), docsDir: s.runtime.config.paths.docs });
});
afterEach(async () => {
  await s.cleanup();
});

const MB = 1024 * 1024;
const BOUNDARY = '----tasklite-test-boundary-7f3a';
const docs = () => s.runtime.config.paths.docs;
const staged = () => {
  const dir = join(docs(), '.staging');
  return existsSync(dir) ? readdirSync(dir) : [];
};
const versions = () =>
  (
    s.runtime.db.sqlite.prepare('SELECT count(*) AS n FROM document_versions').get() as {
      n: number;
    }
  ).n;

/** A multipart body as a stream: fields, then a file of `size` bytes made on the fly. */
function multipartStream(
  fields: Record<string, string>,
  file: { name: string; type: string; size: number; fill?: number } | null,
  after: Record<string, string> = {},
): { body: ReadableStream<Uint8Array>; sha256: string } {
  const enc = new TextEncoder();
  const field = (k: string, v: string) =>
    enc.encode(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  const head: Uint8Array[] = Object.entries(fields).map(([k, v]) => field(k, v));
  const tail: Uint8Array[] = Object.entries(after).map(([k, v]) => field(k, v));
  tail.push(enc.encode(`--${BOUNDARY}--\r\n`));
  const hash = createHash('sha256');
  const chunk = new Uint8Array(MB).fill(file?.fill ?? 0x61);
  let left = file?.size ?? 0;
  let stage: 'head' | 'file' | 'tail' | 'done' = 'head';
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (stage === 'head') {
        for (const part of head) controller.enqueue(part);
        if (file) {
          controller.enqueue(
            enc.encode(
              `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
            ),
          );
        }
        stage = file ? 'file' : 'tail';
        return;
      }
      if (stage === 'file') {
        if (left > 0) {
          const n = Math.min(left, MB);
          const part = n === MB ? chunk : chunk.subarray(0, n);
          left -= n;
          controller.enqueue(part);
          return;
        }
        controller.enqueue(enc.encode('\r\n'));
        stage = 'tail';
        return;
      }
      if (stage === 'tail') {
        for (const part of tail) controller.enqueue(part);
        stage = 'done';
        return;
      }
      controller.close();
    },
  });
  if (file) {
    const full = Math.floor(file.size / MB);
    for (let i = 0; i < full; i++) hash.update(chunk);
    if (file.size % MB) hash.update(chunk.subarray(0, file.size % MB));
  }
  return { body, sha256: hash.digest('hex') };
}

function upload(body: RequestInit['body'], extra: Record<string, string> = {}) {
  return s.request('/agent-upload', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${s.runtime.secrets.agentToken()}`,
      'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      ...extra,
    },
    body,
    // Node's fetch needs duplex for a streamed body.
    duplex: 'half',
  });
}

async function unlock() {
  const res = await s.request('/api/session/unlock', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: s.runtime.secrets.ownerKey() }),
  });
  const cookies = parseSetCookies(res);
  return `tl_owner=${cookies.tl_owner!.value}; tl_csrf=${cookies.tl_csrf!.value}`;
}

const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string; message: string } }).error;

describe('POST /agent-upload', () => {
  it('stores a small file from a FormData body and returns the version', async () => {
    const form = new FormData();
    form.set('item_id', 'RCP-2');
    form.set('kind', 'planning');
    form.set('agent_label', 'orca-w3');
    form.set('file', new Blob(['# Pantry PRD\n'], { type: 'text/markdown' }), 'pantry-notes.md');
    const res = await s.request('/agent-upload', {
      method: 'POST',
      headers: { authorization: `Bearer ${s.runtime.secrets.agentToken()}` },
      body: form,
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, unknown>;
    expect(out).toMatchObject({
      version_no: 1,
      size: 13,
      sha256: createHash('sha256').update('# Pantry PRD\n').digest('hex'),
    });
    const row = s.runtime.db.sqlite
      .prepare(
        'SELECT v.path, v.mime, v.created_by, doc.name, doc.kind FROM document_versions v JOIN documents doc ON doc.id = v.document_id WHERE v.id = ?',
      )
      .get(out.document_version_id) as Record<string, string>;
    expect(row).toMatchObject({
      name: 'pantry-notes.md',
      kind: 'planning',
      mime: 'text/markdown',
      created_by: 'agent · orca-w3',
    });
    expect(readFileSync(join(docs(), row.path!), 'utf8')).toBe('# Pantry PRD\n');
    expect(staged()).toEqual([]);
  });

  it('accepts fields after the file, a name override, and a project target', async () => {
    const { body } = multipartStream(
      { project: 'DOC' },
      { name: 'raw.bin', type: 'application/octet-stream', size: 1000 },
      { kind: 'other', name: 'report.csv' },
    );
    const res = await upload(body);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { document_version_id: string; size: number };
    expect(out.size).toBe(1000);
    const row = s.runtime.db.sqlite
      .prepare(
        'SELECT doc.name, doc.item_id, doc.project_key, v.mime FROM document_versions v JOIN documents doc ON doc.id = v.document_id WHERE v.id = ?',
      )
      .get(out.document_version_id);
    expect(row).toEqual({
      name: 'report.csv',
      item_id: null,
      project_key: 'DOC',
      mime: 'text/csv',
    });
  });

  it('streams 100 MB to disk with flat memory and the right sha256', async () => {
    const size = 100 * MB;
    const { body, sha256 } = multipartStream(
      { item_id: 'RCP-2', kind: 'other' },
      { name: 'big.bin', type: 'application/octet-stream', size },
    );
    global.gc?.();
    const base = process.memoryUsage();
    let peak = { rss: base.rss, heapUsed: base.heapUsed, arrayBuffers: base.arrayBuffers };
    const timer = setInterval(() => {
      const m = process.memoryUsage();
      peak = {
        rss: Math.max(peak.rss, m.rss),
        heapUsed: Math.max(peak.heapUsed, m.heapUsed),
        arrayBuffers: Math.max(peak.arrayBuffers, m.arrayBuffers),
      };
    }, 20);
    const started = Date.now();
    const res = await upload(body);
    clearInterval(timer);
    const ms = Date.now() - started;
    expect(res.status).toBe(200);
    const out = (await res.json()) as { document_version_id: string; size: number; sha256: string };
    expect(out).toMatchObject({ size, sha256 });
    const path = (
      s.runtime.db.sqlite
        .prepare('SELECT path FROM document_versions WHERE id = ?')
        .get(out.document_version_id) as { path: string }
    ).path;
    expect(statSync(join(docs(), path)).size).toBe(size);
    const growth = {
      rss: (peak.rss - base.rss) / MB,
      heapUsed: (peak.heapUsed - base.heapUsed) / MB,
      arrayBuffers: (peak.arrayBuffers - base.arrayBuffers) / MB,
    };
    console.log(
      `agent-upload 100 MB in ${ms} ms; peak growth over baseline: rss +${growth.rss.toFixed(1)} MB, heapUsed +${growth.heapUsed.toFixed(1)} MB, arrayBuffers +${growth.arrayBuffers.toFixed(1)} MB`,
    );
    // Buffering the upload would grow these by at least the file's 100 MB.
    expect(growth.heapUsed + growth.arrayBuffers).toBeLessThan(48);
    expect(staged()).toEqual([]);
  }, 120_000);

  it('refuses an over-limit Content-Length before reading the body', async () => {
    const res = await upload('x', {
      'content-length': String(AGENT_UPLOAD_MAX_BYTES + 2 * MB),
    });
    expect(res.status).toBe(413);
    expect(await errorOf(res)).toEqual({
      code: 'validation',
      message:
        'The upload is larger than 500 MB, the /agent-upload limit. Split the file or store a smaller one.',
    });
    expect(versions()).toBeGreaterThan(0);
  });

  it('refuses a file that streams past 500 MB, keeping no version and no partial file', async () => {
    const before = versions();
    const { body } = multipartStream(
      { item_id: 'RCP-2', kind: 'other' },
      { name: 'huge.bin', type: 'application/octet-stream', size: AGENT_UPLOAD_MAX_BYTES + 1 },
    );
    const res = await upload(body);
    expect(res.status).toBe(413);
    expect((await errorOf(res)).message).toBe(
      'huge.bin is larger than 500 MB, the /agent-upload limit. Split the file or store a smaller one.',
    );
    expect(versions()).toBe(before);
    expect(staged()).toEqual([]);
    const names = s.runtime.db.sqlite
      .prepare("SELECT count(*) AS n FROM documents WHERE name = 'huge.bin'")
      .get() as { n: number };
    expect(names.n).toBe(0);
  }, 180_000);

  it('a bad field, a missing file or an unknown item leave nothing staged', async () => {
    const bad = multipartStream(
      { item_id: 'RCP-2', kind: 'other', kindd: 'x' },
      { name: 'a.txt', type: 'text/plain', size: 10 },
    );
    let res = await upload(bad.body);
    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toContain('Unknown field "kindd"; did you mean "kind"?');
    expect(staged()).toEqual([]);

    res = await upload(multipartStream({ item_id: 'RCP-2', kind: 'other' }, null).body);
    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toContain('file is required');

    const unknown = multipartStream(
      { item_id: 'RCP-999', kind: 'other' },
      { name: 'a.txt', type: 'text/plain', size: 10 },
    );
    res = await upload(unknown.body);
    expect(res.status).toBe(404);
    expect(staged()).toEqual([]);
  });

  it('a malformed body is validation', async () => {
    const res = await upload('not multipart at all');
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('validation');
    expect(staged()).toEqual([]);
  });
});

describe('GET /api/documents/:versionId/content', () => {
  async function store(name: string, text: string) {
    const form = new FormData();
    form.set('item_id', 'RCP-2');
    form.set('kind', 'other');
    form.set('file', new Blob([text]), name);
    const res = await s.request('/agent-upload', {
      method: 'POST',
      headers: { authorization: `Bearer ${s.runtime.secrets.agentToken()}` },
      body: form,
    });
    return ((await res.json()) as { document_version_id: string }).document_version_id;
  }

  it('sends Content-Disposition, nosniff and a sandboxing CSP', async () => {
    const md = await store('pantry prd.md', '# Pantry');
    const html = await store('page.html', '<script>alert(1)</script>');
    const cookie = await unlock();
    const get = (id: string) => s.request(`/api/documents/${id}/content`, { headers: { cookie } });

    let res = await get(md);
    expect(res.status).toBe(200);
    expect(Object.fromEntries(res.headers)).toMatchObject({
      'content-type': 'text/markdown; charset=utf-8',
      'content-length': '8',
      'content-disposition': "inline; filename*=UTF-8''pantry%20prd.md",
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    });
    expect(await res.text()).toBe('# Pantry');

    res = await get(html);
    expect(Object.fromEntries(res.headers)).toMatchObject({
      'content-type': 'application/octet-stream',
      'content-disposition': "attachment; filename*=UTF-8''page.html",
      'x-content-type-options': 'nosniff',
    });
    await res.body?.cancel();

    res = await get('dv_nope');
    expect(res.status).toBe(404);
  });

  it('needs the owner session, not the agent token', async () => {
    const md = await store('a.md', 'x');
    const res = await s.request(`/api/documents/${md}/content`, {
      headers: { authorization: `Bearer ${s.runtime.secrets.agentToken()}` },
    });
    expect(res.status).toBe(401);
  });
});
