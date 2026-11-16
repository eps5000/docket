import type { ItemDetailResponse } from '@tasklite/shared';
import { EmptyState, Section } from '../../../components/kit';
import { plural } from '../../../lib/format';

/** Epic: Brief and documents (summary: document count). US2 fills it. */
export function BriefSection({ data }: { data: ItemDetailResponse }) {
  const { item } = data;
  const n = item.documents.length;
  return (
    <Section
      sectionKey="brief"
      title="Brief and documents"
      summary={n ? plural(n, 'document') : undefined}
    >
      {item.outcome_md ? (
        <div className="prose">{item.outcome_md}</div>
      ) : (
        <EmptyState text="No brief yet." />
      )}
    </Section>
  );
}
