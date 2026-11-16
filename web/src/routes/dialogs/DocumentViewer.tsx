import { useEffect, useState } from 'react';
import { Button, Dialog, EmptyState, ErrorState, Skeleton } from '../../components/kit';
import { formatStamp } from '../../lib/format';
import { Markdown } from '../shared/Markdown';

/**
 * Document viewer (UI_SPEC §6.9; BUILD_SPEC §5.10; FR-071): title + version
 * + "by · when", the preview, and *Download* (for every type, including
 * unknown ones). Previews by MIME type:
 * - Markdown: rendered and sanitised (markdown-it + DOMPurify);
 * - text, log, JSON, YAML, CSV: monospaced, JSON pretty-printed;
 * - PNG, JPEG, GIF, WebP and SVG: an `<img>` (an SVG is never inlined);
 * - MP4 and WebM: `<video controls>`;
 * - PDF: the browser's viewer in a sandboxed iframe;
 * - anything else: download only.
 * Bytes come from `GET /api/documents/:versionId/content`.
 */

type Preview = 'markdown' | 'text' | 'json' | 'image' | 'video' | 'pdf' | 'none';

const BY_EXT: Record<string, string> = {
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
};

/** Text previews stop here; larger files are download only. */
export const TEXT_PREVIEW_MAX = 2 * 1024 * 1024;

export function mimeOf(name: string, mime?: string): string {
  const base = mime?.split(';')[0]?.trim().toLowerCase();
  if (base && base !== 'application/octet-stream') return base;
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return BY_EXT[ext] ?? 'application/octet-stream';
}

export function previewOf(mime: string): Preview {
  if (mime === 'text/markdown') return 'markdown';
  if (mime === 'application/json') return 'json';
  if (
    ['text/plain', 'text/csv', 'application/yaml', 'text/yaml', 'application/x-yaml'].includes(mime)
  )
    return 'text';
  if (['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'].includes(mime))
    return 'image';
  if (mime === 'video/mp4' || mime === 'video/webm') return 'video';
  if (mime === 'application/pdf') return 'pdf';
  return 'none';
}

const contentUrl = (versionId: string) => `/api/documents/${encodeURIComponent(versionId)}/content`;

function TextPreview({ url, kind, name }: { url: string; kind: Preview; name: string }) {
  const [state, setState] = useState<{ text?: string; error?: unknown }>({});
  useEffect(() => {
    let live = true;
    fetch(url, { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Couldn’t load ${name} (HTTP ${res.status}).`);
        return res.text();
      })
      .then((text) => live && setState({ text }))
      .catch((error: unknown) => live && setState({ error }));
    return () => {
      live = false;
    };
  }, [url, name]);
  if (state.error) return <ErrorState error={state.error} />;
  if (state.text === undefined) return <Skeleton lines={4} label={`Loading ${name}`} />;
  if (kind === 'markdown') return <Markdown text={state.text} label={`${name} preview`} />;
  let text = state.text;
  if (kind === 'json') {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // Not valid JSON: show it as it is.
    }
  }
  return (
    <pre className="docpre" tabIndex={0} aria-label={`${name} preview`}>
      {text}
    </pre>
  );
}

export function DocumentViewer({
  doc,
  onClose,
}: {
  /** `version` when known; `caption` for a packet attachment; `mime` and `size` when known. */
  doc: {
    versionId: string;
    name: string;
    version?: number;
    by: string;
    at: string;
    caption?: string | null;
    mime?: string;
    size?: number;
  };
  onClose: () => void;
}) {
  const url = contentUrl(doc.versionId);
  const mime = mimeOf(doc.name, doc.mime);
  let kind = previewOf(mime);
  const tooBig =
    (kind === 'markdown' || kind === 'text' || kind === 'json') &&
    doc.size !== undefined &&
    doc.size > TEXT_PREVIEW_MAX;
  if (tooBig) kind = 'none';
  return (
    <Dialog
      title={doc.name}
      onClose={onClose}
      className="docdialog"
      footer={
        <>
          <a className="btn" href={url} download={doc.name}>
            Download
          </a>
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      <div className="src" style={{ marginBottom: 8 }} data-doc-meta="">
        {doc.version !== undefined && `v${doc.version} · `}
        {doc.caption && `${doc.caption} · `}
        {doc.by} · {formatStamp(doc.at)}
      </div>
      <div className="docview" data-preview={kind}>
        {kind === 'markdown' || kind === 'text' || kind === 'json' ? (
          <TextPreview url={url} kind={kind} name={doc.name} />
        ) : kind === 'image' ? (
          <img src={url} alt={doc.caption ?? doc.name} className="docimg" />
        ) : kind === 'video' ? (
          <video src={url} controls className="docvideo" aria-label={doc.name} />
        ) : kind === 'pdf' ? (
          <iframe src={url} title={`${doc.name} preview`} sandbox="" className="docpdf" />
        ) : (
          <EmptyState
            text={
              tooBig
                ? 'Too large to preview here. Download it to open it.'
                : 'No preview for this type. Download it to open it.'
            }
          />
        )}
      </div>
    </Dialog>
  );
}
