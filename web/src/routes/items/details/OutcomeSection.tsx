import type { ItemDetailResponse } from '@tasklite/shared';
import { Button, EmptyState, Section } from '../../../components/kit';

/**
 * Outcome (summary "n acceptance criteria"), with *Edit* in the header for
 * outcome, description and acceptance criteria (UI_SPEC §6.3 Inline
 * editing). US2 fills the read view; US7 wires the editor (kit InlineEditor).
 */
export function OutcomeSection({ data }: { data: ItemDetailResponse }) {
  const { item } = data;
  const n = item.acceptance.length;
  return (
    <Section
      sectionKey="outcome"
      title="Outcome"
      summary={n ? `${n} acceptance criteria` : undefined}
      extraHead={
        <Button variant="ghost" size="sm" aria-label="Edit outcome" disabled title="Lands with US7">
          Edit
        </Button>
      }
    >
      {item.outcome_md ? (
        <div className="prose">{item.outcome_md}</div>
      ) : (
        <EmptyState text="No outcome written yet." />
      )}
      {n > 0 && (
        <>
          <h3 style={{ marginTop: 14 }}>Acceptance</h3>
          {item.acceptance.map((a, i) => (
            <div className="lrow" key={i}>
              <span className="muted" aria-hidden="true">
                –
              </span>
              <span>{a}</span>
            </div>
          ))}
        </>
      )}
    </Section>
  );
}
