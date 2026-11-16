import { useState } from 'react';
import type { ItemDetailResponse, WorkStep } from '@tasklite/shared';
import { Button, EmptyState, Icon, Provenance, Section } from '../../../components/kit';
import { apiClient } from '../../../app/queryClient';
import { formatAge, isoTitle } from '../../../lib/format';
import { useSteer } from '../../shared/steer';
import { ChecklistHistory } from '../../dialogs/ChecklistHistory';
import type { ItemKind } from '../ItemPage';
import { AddRow } from './AddRow';

const GLYPH: Partial<Record<WorkStep['state'], string>> = { done: '✓', blocked: '!' };

/** One work step (UI_SPEC §6.3.1); the owner's own show *Remove* while not done. */
function StepRow({ step, onRemove }: { step: WorkStep; onRemove?: () => void }) {
  return (
    <div className="ck" data-step={step.id}>
      <span className={`sicon s-${step.state}`} aria-hidden="true">
        {GLYPH[step.state] ?? ''}
      </span>
      <div style={{ minWidth: 0 }}>
        <div>
          <b>{step.text}</b> {step.was_text && <s className="muted">{step.was_text}</s>}
          <span className="sr"> ({step.state})</span>
        </div>
        {step.change_reason && <div className="changed">Changed: {step.change_reason}</div>}
        {step.from_review && (
          <div className="src">
            <Icon name="person" small /> Added from your review, round {step.from_review.round}
          </div>
        )}
        {step.state === 'blocked' && (
          <div className="changed bad">Stopped here: see the failed run</div>
        )}
        {step.subagents.map((sub, i) => (
          <div className="contrib" key={`${sub.name}-${i}`}>
            <div className="row wrap">
              <Provenance kind={sub.provenance} />
              <b>{sub.name}</b>
              {sub.evidence && <span className="src">{sub.evidence}</span>}
            </div>
            <div>{sub.outcome}</div>
          </div>
        ))}
        {step.added_by === 'owner' && <div className="hrby">added by you</div>}
      </div>
      <div className="src" style={{ textAlign: 'right' }}>
        {step.state_by ?? 'not started'}
        {step.state_at && (
          <>
            <br />
            <span title={isoTitle(step.state_at)}>{formatAge(step.state_at)}</span>
          </>
        )}
        {onRemove && (
          <div>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Remove step “${step.text}”`}
              onClick={onRemove}
            >
              Remove
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Work (summary "n/N done · the agent's plan"; *Checklist history* in the
 * header when there are revisions). Rows show state, who and when, revised
 * text struck through with "Changed: …", review-added steps, the failed
 * step, and subagent contributions with their provenance (UI_SPEC §6.3.1).
 * The owner adds steps of their own (the add row; Enter adds) and removes
 * them while they aren't done; agents keep them (BUILD_SPEC §5.5).
 */
export function WorkSection({ kind, data }: { kind: ItemKind; data: ItemDetailResponse }) {
  const [history, setHistory] = useState(false);
  const steer = useSteer(data.item.id);
  const work = data.item.checklist.work;
  const done = work.filter((w) => w.state === 'done').length;
  const open = !['done', 'canceled'].includes(data.item.status);
  const add = (text: string) =>
    void steer(
      () => apiClient['steps.add']({ params: { id: data.item.id }, body: { text } }),
      'Step added. The agent sees it on its next read.',
    );
  const remove = (step: WorkStep) =>
    void steer(
      () => apiClient['steps.remove']({ params: { id: data.item.id, stepId: step.id } }),
      'Step removed.',
    );
  return (
    <Section
      sectionKey="work"
      title="Work"
      summary={`${done}/${work.length} done · the agent’s plan`}
      extraHead={
        data.plan_history.length > 1 ? (
          <Button variant="ghost" size="sm" onClick={() => setHistory(true)}>
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
          <StepRow
            key={w.id}
            step={w}
            onRemove={
              open && w.added_by === 'owner' && w.state !== 'done' ? () => remove(w) : undefined
            }
          />
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
          onAdd={add}
        />
      )}
      {history && (
        <ChecklistHistory
          itemId={data.item.id}
          versions={data.plan_history}
          onClose={() => setHistory(false)}
        />
      )}
    </Section>
  );
}
