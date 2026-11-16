import type { ItemDetailResponse } from '@tasklite/shared';
import { EmptyState, Provenance, Section } from '../../../components/kit';
import type { ItemKind } from '../ItemPage';
import { AddRow } from './AddRow';

/** Agent review ("n/N passed · what the agent verifies itself"). US2 fills the rows (UI_SPEC §6.3.1). */
export function AgentReviewSection({ kind, data }: { kind: ItemKind; data: ItemDetailResponse }) {
  const checks = data.item.checklist.checks;
  const passed = checks.filter((c) => c.state === 'pass').length;
  const open = !['done', 'canceled'].includes(data.item.status);
  return (
    <Section
      sectionKey="agentrev"
      title="Agent review"
      summary={`${passed}/${checks.length} passed · what the agent verifies itself`}
    >
      {checks.length === 0 ? (
        <EmptyState
          text={kind === 'epic' ? 'No epic-level checks yet.' : 'No agent checks listed yet.'}
        />
      ) : (
        checks.map((c) => (
          <div className="ck" key={c.id}>
            <span className={`sicon s-${c.state}`} aria-hidden="true" />
            <div>
              <b>{c.text}</b>
              <span className="sr"> ({c.state})</span>
            </div>
            {c.state === 'todo' ? (
              <span className="src">not run yet</span>
            ) : (
              <Provenance kind={c.provenance} />
            )}
          </div>
        ))
      )}
      {open && (
        <AddRow
          label="New agent review item"
          placeholder="Add something the agent should verify, e.g. Run the full test suite on a clean checkout"
        />
      )}
    </Section>
  );
}
