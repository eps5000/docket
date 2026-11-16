import type { ItemDetailResponse } from '@tasklite/shared';
import { Button, EmptyState, Section } from '../../../components/kit';
import type { ItemKind } from '../ItemPage';
import { AddRow } from './AddRow';

/**
 * Work (summary "n/N done · the agent's plan"; *Checklist history* in the
 * header when there are revisions). US2 fills the rows (UI_SPEC §6.3.1);
 * the history button opens routes/dialogs/ChecklistHistory.tsx.
 */
export function WorkSection({ kind, data }: { kind: ItemKind; data: ItemDetailResponse }) {
  const work = data.item.checklist.work;
  const done = work.filter((w) => w.state === 'done').length;
  const open = !['done', 'canceled'].includes(data.item.status);
  return (
    <Section
      sectionKey="work"
      title="Work"
      summary={`${done}/${work.length} done · the agent’s plan`}
      extraHead={
        data.plan_history.length > 1 ? (
          <Button variant="ghost" size="sm" disabled title="Lands with US2">
            Checklist history
          </Button>
        ) : undefined
      }
    >
      {work.length === 0 ? (
        <EmptyState
          text={
            kind === 'epic'
              ? 'No epic-level steps yet.'
              : ['inbox', 'planning'].includes(data.item.status)
                ? 'The agent writes its work steps when it claims the ticket.'
                : 'No work steps yet.'
          }
        />
      ) : (
        work.map((w) => (
          <div className="ck" key={w.id}>
            <span className={`sicon s-${w.state}`} aria-hidden="true" />
            <div>
              <b>{w.text}</b>
              <span className="sr"> ({w.state})</span>
            </div>
            <span className="src">{w.state_by ?? 'not started'}</span>
          </div>
        ))
      )}
      {open && (
        <AddRow
          label="New work step"
          placeholder={
            kind === 'epic'
              ? 'Add a step for the agent, e.g. Update the release notes'
              : 'Add a step for the agent, e.g. Handle an empty week plan'
          }
        />
      )}
    </Section>
  );
}
