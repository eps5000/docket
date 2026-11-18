/**
 * Documents (BUILD_SPEC §5.10; MCP_SPEC §5.6 `put_document`; FR-070,
 * FR-071): the `documents` service (US7, T124).
 *
 * - Every store with the same `(item, name)` (or, for a project document,
 *   `(project, name)`) is a new immutable version: the bytes go to a new
 *   path, `<docs>/<KEY>/<document_id>/v<n>/<safe file name>`, written with
 *   `wx`, so nothing is ever overwritten. `sha256` is recorded.
 * - `put_document` takes up to 25 MB inline (text or base64).
 *   `/agent-upload` streams up to 500 MB: `stage` hashes and writes the
 *   bytes to `<docs>/.staging/` as they arrive, with the limit enforced while
 *   streaming, before any transaction; `commitUpload` records the version
 *   and moves the staged file into place.
 * - Names never reach the file system as given: the stored file name is
 *   the name's last path segment, cleaned, so no name climbs out of the
 *   docs directory. The document keeps its name as given.
 * - Kind `brief` is written only by `claim_lead`/`start_run` (B10), so it
 *   is refused here, and a brief can't be versioned through `put_document`.
 *   Briefs are served like any other document.
 * - `content`: the preview formats are `inline` with their type (text with
 *   `charset=utf-8`); everything else is an `attachment` served as
 *   `application/octet-stream`. The route adds `nosniff` and a sandboxing CSP.
 */
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { AGENT_UPLOAD_MAX_BYTES, LIMITS, ToolError } from '@docket/shared';
import type {
  DocumentContent,
  DocumentsService,
  In,
  Out,
  ServiceDeps,
  StagedFile,
  UploadFields,
} from './contracts.js';
import { newId } from './ids.js';
import { callerName, ms, requireItem } from './model.js';
import type { WriteContext } from './write.js';

// ---- MIME types and previews (BUILD_SPEC §5.10) ----

const MIME_BY_EXT: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  log: 'text/plain',
  json: 'application/json',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  csv: 'text/csv',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  pdf: 'application/pdf',
  html: 'text/html',
  htm: 'text/html',
  zip: 'application/zip',
};

const OCTET = 'application/octet-stream';

/** The MIME type for a file name, from its extension. */
export function guessMime(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return OCTET;
  return MIME_BY_EXT[name.slice(dot + 1).toLowerCase()] ?? OCTET;
}

/** The types the UI previews (BUILD_SPEC §5.10). Anything else is download only. */
export const PREVIEW_MIMES: readonly string[] = [
  'text/markdown',
  'text/plain',
  'application/json',
  'application/yaml',
  'text/yaml',
  'application/x-yaml',
  'text/csv',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'video/mp4',
  'video/webm',
  'application/pdf',
];

const baseMime = (mime: string) => mime.split(';')[0]!.trim().toLowerCase();

export function previewable(mime: string): boolean {
  return PREVIEW_MIMES.includes(baseMime(mime));
}

const TEXTUAL = new Set([
  'text/markdown',
  'text/plain',
  'text/csv',
  'text/yaml',
  'application/json',
  'application/yaml',
  'application/x-yaml',
]);

// ---- File names ----

/**
 * The file name stored on disk for a document name: its last path segment
 * (either separator), with reserved and control characters replaced and
 * leading dots dropped. Never empty, never `.` or `..`.
 */
export function safeFileName(name: string): string {
  const last = name.split(/[\\/]/).pop() ?? '';
  const cleaned = last
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  return (cleaned || 'file').slice(0, 120);
}

const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

function tooLarge(name: string): ToolError {
  return new ToolError(
    'validation',
    `${name} is larger than 500 MB, the /agent-upload limit. Split the file or store a smaller one.`,
    { details: { too_large: true, limit_bytes: AGENT_UPLOAD_MAX_BYTES } },
  );
}

// ---- The service ----

interface Target {
  project_key: string;
  item_id: string | null;
}

interface DocRow {
  id: string;
  kind: string;
}

export function createDocumentsService(deps: ServiceDeps): DocumentsService {
  const docsDir = () => resolve(deps.config.paths.docs);

  /** An absolute path under the docs directory, or an error: nothing is served from outside it. */
  function inDocs(path: string): string {
    const full = resolve(docsDir(), path);
    const rel = relative(docsDir(), full);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new ToolError('internal', 'A document path points outside the docs directory.');
    }
    return full;
  }

  function target(w: WriteContext, input: { item_id?: string; project?: string }): Target {
    if (input.item_id) {
      const item = requireItem(w.db, input.item_id);
      return { project_key: item.project_key, item_id: item.id };
    }
    const project = w.db.sqlite
      .prepare('SELECT key FROM projects WHERE key = ? AND deleted_at IS NULL')
      .get(input.project ?? '') as { key: string } | undefined;
    if (!project) {
      throw new ToolError(
        'not_found',
        `No project ${input.project ?? '(none)'}. Check the key with list_projects.`,
      );
    }
    return { project_key: project.key, item_id: null };
  }

  function checkKind(kind: string): void {
    if (kind === 'brief') {
      throw new ToolError(
        'validation',
        'Briefs are written by claim_lead and start_run (pass brief there); use kind planning, packet_attachment or other.',
        { details: { fields: { kind: 'brief is written only by claim_lead and start_run' } } },
      );
    }
  }

  function existing(w: WriteContext, t: Target, name: string): DocRow | undefined {
    return (
      t.item_id
        ? w.db.sqlite
            .prepare('SELECT id, kind FROM documents WHERE item_id = ? AND name = ?')
            .get(t.item_id, name)
        : w.db.sqlite
            .prepare(
              'SELECT id, kind FROM documents WHERE project_key = ? AND item_id IS NULL AND name = ?',
            )
            .get(t.project_key, name)
    ) as DocRow | undefined;
  }

  /**
   * Record a new version of `name` on the target. `place(path)` puts the
   * bytes at the new path (relative to the docs directory) before the rows
   * are inserted; the path is new, so nothing is overwritten.
   */
  function record(
    w: WriteContext,
    input: {
      target: Target;
      name: string;
      kind: string;
      mime: string;
      size: number;
      sha256: string;
      place: (full: string) => void;
    },
  ): Out<'put_document'> {
    const { target: t, name } = input;
    const doc = existing(w, t, name);
    if (doc?.kind === 'brief') {
      throw new ToolError(
        'validation',
        `${name} is a run brief; briefs are written only by claim_lead and start_run. Store your document under another name.`,
        { details: { fields: { name: 'is a run brief' } } },
      );
    }
    const at = ms(w.now);
    const documentId = doc?.id ?? newId('doc', at);
    const versionNo = doc
      ? (
          w.db.sqlite
            .prepare(
              'SELECT coalesce(max(version_no), 0) + 1 AS n FROM document_versions WHERE document_id = ?',
            )
            .get(documentId) as { n: number }
        ).n
      : 1;
    const versionId = newId('dv', at);
    const path = `${t.project_key}/${documentId}/v${versionNo}/${safeFileName(name)}`;
    const full = inDocs(path);
    mkdirSync(dirname(full), { recursive: true });
    input.place(full);

    const who = callerName(w.db, w.actor);
    if (doc) {
      w.update('documents', doc.id, {});
    } else {
      w.insert('documents', {
        id: documentId,
        project_key: t.project_key,
        item_id: t.item_id,
        name,
        kind: input.kind,
      });
    }
    w.insert('document_versions', {
      id: versionId,
      document_id: documentId,
      version_no: versionNo,
      mime: input.mime,
      size: input.size,
      sha256: input.sha256,
      path,
      created_by: who,
    });
    w.event({
      type: 'document.added',
      summary: `${who} added ${name} (v${versionNo}, ${input.size.toLocaleString('en-US')} bytes)`,
      item_id: t.item_id,
      project_key: t.project_key,
      data: {
        document_id: documentId,
        document_version_id: versionId,
        version_no: versionNo,
        kind: doc?.kind ?? input.kind,
        size: input.size,
        sha256: input.sha256,
      },
      objects: [{ kind: 'document', id: documentId }],
    });
    return {
      document_id: documentId,
      version_no: versionNo,
      document_version_id: versionId,
      sha256: input.sha256,
      size: input.size,
    };
  }

  return {
    put(w, input: In<'put_document'>) {
      checkKind(input.kind as string);
      const t = target(w, input);
      const bytes =
        input.content_base64 !== undefined
          ? Buffer.from(input.content_base64, 'base64')
          : Buffer.from(input.content_text ?? '', 'utf8');
      if (bytes.length > LIMITS.document_mcp_bytes) {
        throw new ToolError(
          'validation',
          `${input.name} is ${megabytes(bytes.length)}; put_document takes up to 25 MB. POST larger files to /agent-upload (up to 500 MB) and pass the document_version_id.`,
          { details: { fields: { content: 'is over 25 MB' }, size: bytes.length } },
        );
      }
      return record(w, {
        target: t,
        name: input.name,
        kind: input.kind,
        mime: input.mime ?? guessMime(input.name),
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        place: (full) => writeFileSync(full, bytes, { flag: 'wx' }),
      });
    },

    async stage(_r, file) {
      const dir = join(docsDir(), '.staging');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${randomUUID()}.part`);
      const hash = createHash('sha256');
      const out = createWriteStream(path, { flags: 'wx' });
      let size = 0;
      const reader = file.stream().getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > AGENT_UPLOAD_MAX_BYTES) throw tooLarge(file.name || 'The file');
          hash.update(value);
          if (!out.write(value)) await once(out, 'drain');
        }
        await new Promise<void>((done, fail) =>
          out.end((err?: Error | null) => (err ? fail(err) : done())),
        );
      } catch (err) {
        await reader.cancel().catch(() => {});
        out.destroy();
        await once(out, 'close').catch(() => {});
        rmSync(path, { force: true });
        throw err;
      }
      return {
        path,
        size,
        sha256: hash.digest('hex'),
        mime: file.type ? baseMime(file.type) : OCTET,
        original_name: file.name || 'upload',
      } satisfies StagedFile;
    },

    commitUpload(w, input: { fields: UploadFields; staged: StagedFile }) {
      const { fields, staged } = input;
      checkKind(fields.kind as string);
      const name = fields.name ?? staged.original_name;
      const t = target(w, fields);
      return record(w, {
        target: t,
        name,
        kind: fields.kind,
        mime: fields.mime ?? (staged.mime !== OCTET ? staged.mime : guessMime(name)),
        size: staged.size,
        sha256: staged.sha256,
        place: (full) => renameSync(staged.path, full),
      });
    },

    content(r, input): DocumentContent {
      const row = r.db.sqlite
        .prepare(
          `SELECT v.id, v.mime, v.size, v.sha256, v.path, d.name
           FROM document_versions v
           JOIN documents d ON d.id = v.document_id
           JOIN projects p ON p.key = d.project_key
           WHERE v.id = ? AND p.deleted_at IS NULL`,
        )
        .get(input.version_id) as
        | { id: string; mime: string; size: number; sha256: string; path: string; name: string }
        | undefined;
      if (!row) {
        throw new ToolError('not_found', `No document version ${input.version_id}.`);
      }
      const inline = previewable(row.mime);
      const base = baseMime(row.mime);
      return {
        document_version_id: row.id,
        name: row.name,
        mime: inline ? (TEXTUAL.has(base) ? `${base}; charset=utf-8` : base) : OCTET,
        size: row.size,
        sha256: row.sha256,
        path: inDocs(row.path),
        disposition: inline ? 'inline' : 'attachment',
      };
    },
  };
}
