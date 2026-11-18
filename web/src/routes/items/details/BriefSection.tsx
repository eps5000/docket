import type { ItemDetailResponse } from '@docket/shared';
import { EmptyState, Section } from '../../../components/kit';
import { plural } from '../../../lib/format';
import { Markdown } from '../../shared/Markdown';
import { InlineTextEdit } from '../InlineEdit';
import { DocumentList } from './DocumentsSection';

/**
 * Epic: Brief and documents (summary: document count). The brief is the
 * epic's outcome, edited inline (decision 22); documents open the viewer.
 */
export function BriefSection({ data }: { data: ItemDetailResponse }) {
  const { item } = data;
  const n = item.documents.length;
  return (
    <Section
      sectionKey="brief"
      title="Brief and documents"
      summary={n ? plural(n, 'document') : undefined}
    >
      <InlineTextEdit item={item} field="outcome_md" name="brief" value={item.outcome_md}>
        {item.outcome_md ? (
          <Markdown text={item.outcome_md} />
        ) : (
          <EmptyState text="No brief yet." />
        )}
      </InlineTextEdit>
      {n > 0 && (
        <>
          <h3 style={{ marginTop: 14 }}>Documents</h3>
          <DocumentList docs={item.documents} />
        </>
      )}
    </Section>
  );
}
