import type { ItemDetailResponse } from '@tasklite/shared';
import { EmptyState, Icon, Section } from '../../../components/kit';

/**
 * Documents (summary: count). Rows open the Document viewer dialog
 * (routes/dialogs/DocumentViewer.tsx); US7 fills them.
 */
export function DocumentsSection({ data }: { data: ItemDetailResponse }) {
  const docs = data.item.documents;
  return (
    <Section sectionKey="docs" title="Documents" summary={String(docs.length)}>
      {docs.length === 0 ? (
        <EmptyState text="No documents yet. Planning docs (PRD, UX, TDD) and handoff packets appear here." />
      ) : (
        docs.map((d) => (
          <div className="lrow" key={d.document_id}>
            <Icon name="doc" />
            <span>{d.name}</span>
          </div>
        ))
      )}
    </Section>
  );
}
