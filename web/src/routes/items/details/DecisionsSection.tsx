import type { ItemDetailResponse } from '@tasklite/shared';
import { Button, DecisionRow, EmptyState, Section } from '../../../components/kit';
import type { ItemKind } from '../ItemPage';

/**
 * Decisions (UI_SPEC §6.3.5): summary "n in scope · n by agents", *+ Record
 * a decision* in the header. Hidden on a ticket when there are none. US5
 * fills the rows' actions and the record form.
 */
export function DecisionsSection({ data, kind }: { data: ItemDetailResponse; kind: ItemKind }) {
  const active = data.decisions.filter((d) => d.status === 'active');
  if (kind === 'ticket' && data.decisions.length === 0) return null;
  const byAgents = active.filter((d) => d.authority === 'agent').length;
  return (
    <Section
      sectionKey="decisions"
      title="Decisions"
      summary={`${active.length} in scope · ${byAgents} by agents`}
      extraHead={
        <Button variant="ghost" size="sm" disabled title="Lands with US5">
          + Record a decision
        </Button>
      }
    >
      {data.decisions.length === 0 ? (
        <EmptyState text="No decisions recorded. Agents record conventions and choices here; yours are authoritative." />
      ) : (
        data.decisions.map((d) => <DecisionRow key={d.id} record={d} canAct={false} />)
      )}
    </Section>
  );
}
