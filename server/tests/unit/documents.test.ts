/**
 * Documents (tasks.md T124; BUILD_SPEC §5.10; MCP_SPEC §5.6 `put_document`;
 * FR-070, FR-071).
 *
 * - `put_document` stores text or base64 bytes as an immutable version with
 *   its sha256; the same name again is a new version and the old bytes stay.
 * - Item or project documents; kind `brief` is written only by
 *   `claim_lead`/`start_run` (refused here, and a brief's name can't be
 *   versioned through `put_document`).
 * - Over 25 MB is `validation`. The MIME type is guessed from the name.
 * - Files live under the docs directory only: a name can't climb out.
 * - `content`: inline for the preview formats, else an attachment served as
 *   `application/octet-stream`.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { LIMITS } from '@docket/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { In } from '../../src/domain/contracts.js';
import { guessMime, previewable, safeFileName } from '../../src/domain/documents.js';
import { startDomain, type Domain } from '../us1-helpers.js';

let d: Domain;
beforeEach(() => {
  d = startDomain();
});
afterEach(() => d.cleanup());

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const docs = () => d.server.runtime.config.paths.docs;
const put = (input: Partial<In<'put_document'>>) =>
  d.write(d.agent('claude'), (w, s) =>
    s.documents.put(w, { kind: 'planning', ...input } as In<'put_document'>),
  );
const fileOf = (versionId: string) =>
  d.row<{ path: string }>('SELECT path FROM document_versions WHERE id = ?', versionId).path;

describe('put_document', () => {
  it('stores text as version 1 with its sha256, under docs/<KEY>/<doc>/v1/<name>', () => {
    const text = '# Pantry PRD\n\nWhat is in the cupboard.\n';
    const out = put({ item_id: 'RCP-2', name: 'pantry-research.md', content_text: text });
    expect(out).toMatchObject({
      version_no: 1,
      sha256: sha(text),
      size: Buffer.byteLength(text),
    });
    expect(out.document_id).toMatch(/^doc_/);
    expect(out.document_version_id).toMatch(/^dv_/);
    const path = fileOf(out.document_version_id);
    expect(path).toBe(`RCP/${out.document_id}/v1/pantry-research.md`);
    expect(readFileSync(join(docs(), path), 'utf8')).toBe(text);
    expect(
      d.row('SELECT mime, created_by FROM document_versions WHERE id = ?', out.document_version_id),
    ).toEqual({ mime: 'text/markdown', created_by: 'claude' });
    expect(
      d.row<{ type: string; summary: string }>(
        "SELECT type, summary FROM events WHERE item_id = 'RCP-2' ORDER BY seq DESC LIMIT 1",
      ),
    ).toEqual({
      type: 'document.added',
      summary: `claude added pantry-research.md (v1, ${Buffer.byteLength(text)} bytes)`,
    });
  });

  it('the same name again is a new immutable version; the old bytes stay', () => {
    const v1 = put({ item_id: 'RCP-2', name: 'pantry-research.md', content_text: 'one' });
    const v2 = put({ item_id: 'RCP-2', name: 'pantry-research.md', content_text: 'two' });
    expect(v2.document_id).toBe(v1.document_id);
    expect(v2.version_no).toBe(2);
    expect(readFileSync(join(docs(), fileOf(v1.document_version_id)), 'utf8')).toBe('one');
    expect(readFileSync(join(docs(), fileOf(v2.document_version_id)), 'utf8')).toBe('two');
    const view = d.services.items.get(d.read(), {
      id: 'RCP-2',
      view: 'full',
    } as In<'get_item'>).item;
    expect(view.documents?.find((x) => x.name === 'pantry-research.md')?.latest.version_no).toBe(2);
  });

  it('stores base64 bytes exactly', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255]);
    const out = put({
      item_id: 'RCP-12',
      name: 'drag-touch.png',
      kind: 'packet_attachment',
      content_base64: bytes.toString('base64'),
    });
    expect(out).toMatchObject({ size: 12, sha256: sha(bytes) });
    expect(readFileSync(join(docs(), fileOf(out.document_version_id)))).toEqual(bytes);
    expect(
      d.row('SELECT mime FROM document_versions WHERE id = ?', out.document_version_id),
    ).toEqual({ mime: 'image/png' });
  });

  it('a project document (no item) versions by name within the project', () => {
    const a = put({ project: 'DOC', name: 'style-guide.md', content_text: 'a' });
    const b = put({ project: 'DOC', name: 'style-guide.md', content_text: 'b' });
    expect(b).toMatchObject({ document_id: a.document_id, version_no: 2 });
    const c = put({ project: 'RCP', name: 'style-guide.md', content_text: 'c' });
    expect(c.document_id).not.toBe(a.document_id);
  });

  it('an explicit mime wins over the guess', () => {
    const out = put({
      item_id: 'RCP-2',
      name: 'notes',
      content_text: 'x',
      mime: 'text/plain',
    });
    expect(
      d.row('SELECT mime FROM document_versions WHERE id = ?', out.document_version_id),
    ).toEqual({ mime: 'text/plain' });
  });

  it('kind brief is refused; brief documents come from claim_lead and start_run', () => {
    const err = d.fails(
      d.agent(),
      (w, s) =>
        s.documents.put(w, {
          item_id: 'RCP-2',
          name: 'brief.md',
          kind: 'brief',
          content_text: 'x',
        } as unknown as In<'put_document'>),
      'validation',
    );
    expect(err.message).toBe(
      'Briefs are written by claim_lead and start_run (pass brief there); use kind planning, packet_attachment or other.',
    );
  });

  it('a brief cannot get a new version through put_document', () => {
    const agent = d.agent('claude');
    const { run_id } = d.write(agent, (w, s) =>
      s.runs.claim(w, { id: 'RCP-17', brief: 'Fix the jump.' } as In<'claim_lead'>),
    );
    const err = d.fails(
      agent,
      (w, s) =>
        s.documents.put(w, {
          item_id: 'RCP-17',
          name: `brief-${run_id}.md`,
          kind: 'other',
          content_text: 'Rewritten.',
        } as In<'put_document'>),
      'validation',
    );
    expect(err.message).toMatch(/^brief-run_\w+\.md is a run brief/);
  });

  it('over 25 MB is validation, and nothing is written', () => {
    const before = d.row<{ n: number }>('SELECT count(*) AS n FROM document_versions').n;
    const err = d.fails(
      d.agent(),
      (w, s) =>
        s.documents.put(w, {
          item_id: 'RCP-2',
          name: 'big.bin',
          kind: 'other',
          content_base64: Buffer.alloc(LIMITS.document_mcp_bytes + 1).toString('base64'),
        } as In<'put_document'>),
      'validation',
    );
    expect(err.message).toBe(
      'big.bin is 25.0 MB; put_document takes up to 25 MB. POST larger files to /agent-upload (up to 500 MB) and pass the document_version_id.',
    );
    expect(d.row<{ n: number }>('SELECT count(*) AS n FROM document_versions').n).toBe(before);
  });

  it('an unknown item or project is not_found', () => {
    d.fails(
      d.agent(),
      (w, s) =>
        s.documents.put(w, {
          item_id: 'RCP-999',
          name: 'a.md',
          kind: 'planning',
          content_text: 'x',
        } as In<'put_document'>),
      'not_found',
    );
    d.fails(
      d.agent(),
      (w, s) =>
        s.documents.put(w, {
          project: 'ZZZ',
          name: 'a.md',
          kind: 'planning',
          content_text: 'x',
        } as In<'put_document'>),
      'not_found',
    );
  });

  it.each([
    '../../../etc/passwd',
    '..\\..\\secrets\\agent-token',
    '/abs/olute.md',
    'C:\\temp\\x.md',
    '..',
    '.hidden',
    'a/b/../../c.md',
    'nul\u0000byte.md',
  ])('a name can’t leave the docs directory (%j)', (name) => {
    const out = put({ item_id: 'RCP-2', name, content_text: 'x' });
    const full = resolve(docs(), fileOf(out.document_version_id));
    const rel = relative(resolve(docs()), full);
    expect(rel.startsWith('..')).toBe(false);
    expect(rel.split(sep)).toHaveLength(4); // KEY / doc / vN / file
    expect(existsSync(full)).toBe(true);
    // The document keeps the name the agent gave it.
    expect(
      d.row<{ name: string }>('SELECT name FROM documents WHERE id = ?', out.document_id).name,
    ).toBe(name);
  });
});

describe('content', () => {
  it('serves preview formats inline with their type, everything else as an attachment', () => {
    const md = put({ item_id: 'RCP-2', name: 'prd.md', content_text: '# Hi' });
    const html = put({ item_id: 'RCP-2', name: 'page.html', content_text: '<script>1</script>' });
    const svg = put({ item_id: 'RCP-2', name: 'logo.svg', content_text: '<svg/>' });
    const c = (id: string) => d.services.documents.content(d.read(), { version_id: id });
    expect(c(md.document_version_id)).toMatchObject({
      name: 'prd.md',
      mime: 'text/markdown; charset=utf-8',
      disposition: 'inline',
      size: 4,
    });
    expect(c(html.document_version_id)).toMatchObject({
      mime: 'application/octet-stream',
      disposition: 'attachment',
    });
    expect(c(svg.document_version_id)).toMatchObject({
      mime: 'image/svg+xml',
      disposition: 'inline',
    });
    expect(readFileSync(c(md.document_version_id).path, 'utf8')).toBe('# Hi');
  });

  it('serves a run brief like any other document', () => {
    const agent = d.agent('claude');
    d.write(agent, (w, s) =>
      s.runs.claim(w, { id: 'RCP-17', brief: 'Fix the jump.' } as In<'claim_lead'>),
    );
    const brief = d.row<{ id: string }>(
      "SELECT v.id FROM document_versions v JOIN documents doc ON doc.id = v.document_id WHERE doc.kind = 'brief' AND doc.item_id = 'RCP-17'",
    );
    const out = d.services.documents.content(d.read(), { version_id: brief.id });
    expect(out).toMatchObject({ disposition: 'inline', mime: 'text/markdown; charset=utf-8' });
    expect(readFileSync(out.path, 'utf8')).toBe('Fix the jump.');
  });

  it('an unknown version is not_found', () => {
    expect(() => d.services.documents.content(d.read(), { version_id: 'dv_nope' })).toThrow(
      /No document version dv_nope/,
    );
  });
});

describe('helpers', () => {
  it('guesses MIME types from the name', () => {
    expect(
      ['a.md', 'a.txt', 'a.log', 'a.json', 'a.yaml', 'a.yml', 'a.csv', 'a.PNG', 'a.jpg', 'a.jpeg']
        .concat(['a.gif', 'a.webp', 'a.svg', 'a.mp4', 'a.webm', 'a.pdf', 'a.bin', 'noext'])
        .map(guessMime),
    ).toEqual([
      'text/markdown',
      'text/plain',
      'text/plain',
      'application/json',
      'application/yaml',
      'application/yaml',
      'text/csv',
      'image/png',
      'image/jpeg',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'image/svg+xml',
      'video/mp4',
      'video/webm',
      'application/pdf',
      'application/octet-stream',
      'application/octet-stream',
    ]);
  });

  it('only the safe formats preview', () => {
    expect(previewable('text/markdown')).toBe(true);
    expect(previewable('application/pdf')).toBe(true);
    expect(previewable('text/html')).toBe(false);
    expect(previewable('application/javascript')).toBe(false);
    expect(previewable('application/octet-stream')).toBe(false);
  });

  it('safe file names keep the readable part', () => {
    expect(safeFileName('pantry-prd.md')).toBe('pantry-prd.md');
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('..')).toBe('file');
    expect(safeFileName('.env')).toBe('env');
    expect(safeFileName('a:b*c?.md')).toBe('a_b_c_.md');
  });

  it('nothing is staged after a put', () => {
    put({ item_id: 'RCP-2', name: 'a.md', content_text: 'x' });
    const staging = join(docs(), '.staging');
    expect(existsSync(staging) ? readdirSync(staging) : []).toEqual([]);
  });
});
