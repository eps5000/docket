import type { Check, ItemDetailResponse } from '@tasklite/shared';
import { Button, EmptyState, Provenance, Section } from '../../../components/kit';
import { apiClient } from '../../../app/queryClient';
import { useSteer } from '../../shared/steer';
import type { ItemKind } from '../ItemPage';
import { AddRow } from './AddRow';

/**
 * Agent review ("n/N passed · what the agent verifies itself"): each check's
 * state, evidence and provenance, or "not run yet" (UI_SPEC §6.3.1). The
 * owner adds checks of their own and removes them while still todo.
 */
export function AgentReviewSection({ kind, data }: { kind: ItemKind; data: ItemDetailResponse }) {
  const steer = useSteer(data.item.id);
  const checks = data.item.checklist.checks;
  const passed = checks.filter((c) => c.state === 'pass').length;
  const open = !['done', 'canceled'].includes(data.item.status);
  const add = (text: string) =>
    void steer(
      () => apiClient['checks.add']({ params: { id: data.item.id }, body: { text } }),
      'Check added. The agent sees it on its next read.',
    );
  const remove = (c: Check) =>
    void steer(
      () => apiClient['checks.remove']({ params: { id: data.item.id, checkId: c.id } }),
      'Check removed.',
    );
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
          <div className="ck" key={c.id} data-check={c.id}>
            <span className={`sicon s-${c.state}`} aria-hidden="true">
              {c.state === 'pass' ? '✓' : c.state === 'fail' ? '×' : ''}
            </span>
            <div style={{ minWidth: 0 }}>
              <b>{c.text}</b>
              <span className="sr"> ({c.state === 'todo' ? 'not run yet' : c.state})</span>
              {c.evidence && <div className="src">{c.evidence}</div>}
              {c.added_by === 'owner' && <div className="hrby">added by you</div>}
            </div>
            <div className="src" style={{ textAlign: 'right' }}>
              {c.state === 'todo' ? 'not run yet' : <Provenance kind={c.provenance} />}
              {open && c.added_by === 'owner' && c.state === 'todo' && (
                <div>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove check “${c.text}”`}
                    onClick={() => remove(c)}
                  >
                    Remove
                  </Button>
                </div>
              )}
            </div>
          </div>
        ))
      )}
      {open && (
        <AddRow
          label="New agent review item"
          placeholder="Add something the agent should verify, e.g. Run the full test suite on a clean checkout"
          onAdd={add}
        />
      )}
    </Section>
  );
}
