import type { ItemDetailResponse } from '@docket/shared';
import { EmptyState, Section } from '../../../components/kit';
import { Markdown } from '../../shared/Markdown';
import { AcceptanceEdit, InlineTextEdit } from '../InlineEdit';

/**
 * Outcome (summary "n acceptance criteria"), with *Edit* for the outcome in
 * the section header, then the description and the acceptance criteria,
 * each with its own *Edit* (UI_SPEC §6.3 Inline editing; US7, T126).
 */
export function OutcomeSection({ data }: { data: ItemDetailResponse }) {
  const { item } = data;
  const n = item.acceptance.length;
  return (
    <Section
      sectionKey="outcome"
      title="Outcome"
      summary={n ? `${n} acceptance criteria` : undefined}
    >
      <InlineTextEdit item={item} field="outcome_md" name="outcome" value={item.outcome_md}>
        {item.outcome_md ? (
          <Markdown text={item.outcome_md} />
        ) : (
          <EmptyState text="No outcome written yet." />
        )}
      </InlineTextEdit>
      <h3 style={{ marginTop: 14 }}>Description</h3>
      <InlineTextEdit
        item={item}
        field="description_md"
        name="description"
        value={item.description_md}
      >
        {item.description_md ? (
          <Markdown text={item.description_md} />
        ) : (
          <EmptyState text="No description." />
        )}
      </InlineTextEdit>
      <AcceptanceEdit item={item}>
        {n === 0 ? (
          <EmptyState text="No acceptance criteria yet." />
        ) : (
          item.acceptance.map((a, i) => (
            <div className="lrow" key={i}>
              <span className="muted" aria-hidden="true">
                –
              </span>
              <span>{a}</span>
            </div>
          ))
        )}
      </AcceptanceEdit>
    </Section>
  );
}
