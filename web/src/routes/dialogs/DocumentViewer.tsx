import { Button, Dialog, Icon } from '../../components/kit';
import { formatStamp } from '../../lib/format';

/**
 * Document viewer (UI_SPEC §6.9): title + version + "by · when", the
 * preview (BUILD_SPEC §5.10), and *Download*. US7 fills the preview
 * (Markdown via markdown-it + DOMPurify, images, PDFs) from
 * `GET /api/documents/:versionId/content`.
 */
export function DocumentViewer({
  doc,
  onClose,
}: {
  /** `version` when known; `caption` for a packet attachment. */
  doc: {
    versionId: string;
    name: string;
    version?: number;
    by: string;
    at: string;
    caption?: string | null;
  };
  onClose: () => void;
}) {
  return (
    <Dialog
      title={doc.name}
      onClose={onClose}
      footer={
        <>
          <a
            className="btn"
            href={`/api/documents/${encodeURIComponent(doc.versionId)}/content`}
            download={doc.name}
          >
            Download
          </a>
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      <div className="src" style={{ marginBottom: 8 }}>
        {doc.version !== undefined && `v${doc.version} · `}
        {doc.caption && `${doc.caption} · `}
        {doc.by} · {formatStamp(doc.at)}
      </div>
      <div className="media" data-preview="">
        <Icon name="clip" small /> {doc.version !== undefined ? `v${doc.version}: ` : ''}preview
        appears here
      </div>
    </Dialog>
  );
}
