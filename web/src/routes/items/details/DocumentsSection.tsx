import { useState } from 'react';
import type { ItemDetailResponse } from '@tasklite/shared';
import { Chip, EmptyState, Icon, Section } from '../../../components/kit';
import { formatAge, isoTitle } from '../../../lib/format';
import { DocumentViewer } from '../../dialogs/DocumentViewer';

type Doc = ItemDetailResponse['item']['documents'][number];

const KIND_LABEL: Partial<Record<Doc['kind'], string>> = {
  brief: 'Run brief',
  packet_attachment: 'Attachment',
  import_report: 'Import report',
};

/** The item's documents, newest version of each; a row opens the Document viewer. */
export function DocumentList({ docs }: { docs: readonly Doc[] }) {
  const [open, setOpen] = useState<Doc | null>(null);
  return (
    <>
      {docs.map((d) => (
        <div className="lrow docrow" key={d.document_id} data-document={d.name}>
          <Icon name="doc" />
          <button
            type="button"
            className="linkbtn grow one"
            onClick={() => setOpen(d)}
            title={`Open ${d.name}`}
          >
            {d.name}
          </button>
          {KIND_LABEL[d.kind] && <Chip kind="neutral">{KIND_LABEL[d.kind]}</Chip>}
          <span className="src" title={isoTitle(d.latest.created_at)}>
            v{d.latest.version_no} · {d.latest.created_by} · {formatAge(d.latest.created_at)}
          </span>
        </div>
      ))}
      {open && (
        <DocumentViewer
          doc={{
            versionId: open.latest.document_version_id,
            name: open.name,
            version: open.latest.version_no,
            by: open.latest.created_by,
            at: open.latest.created_at,
            mime: open.latest.mime,
            size: open.latest.size,
          }}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

/** Documents (summary: count). Rows open the Document viewer (UI_SPEC §6.9; US7, T127). */
export function DocumentsSection({ data }: { data: ItemDetailResponse }) {
  const docs = data.item.documents;
  return (
    <Section sectionKey="docs" title="Documents" summary={String(docs.length)}>
      {docs.length === 0 ? (
        <EmptyState text="No documents yet. Planning docs (PRD, UX, TDD) and handoff packets appear here." />
      ) : (
        <DocumentList docs={docs} />
      )}
    </Section>
  );
}
