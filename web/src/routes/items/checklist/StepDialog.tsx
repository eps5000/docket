import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { LIMITS, type StepHistoryEntry, type WorkStep, type WorkStepState } from '@docket/shared';
import {
  Button,
  Chip,
  Dialog,
  EmptyState,
  InlineEditor,
  Provenance,
  type ChipKind,
} from '../../../components/kit';
import { apiClient } from '../../../app/queryClient';
import { isConflict, queryKeys } from '../../../lib/api';
import { formatStamp, isoTitle } from '../../../lib/format';
import { showToast, toastSuccess, withWarnings } from '../../../lib/undo';
import { Markdown } from '../../shared/Markdown';
import { ConflictCallout, SAVED_MESSAGE } from '../InlineEdit';

const STATE: Record<WorkStepState, { label: string; kind: ChipKind }> = {
  todo: { label: 'To do', kind: 'neutral' },
  current: { label: 'Current', kind: 'info' },
  done: { label: 'Done', kind: 'ok' },
  blocked: { label: 'Blocked', kind: 'bad' },
  skipped: { label: 'Skipped', kind: 'neutral' },
};

/** A Jira issue key ("GF-123"): only these link to the project's Jira site. */
const JIRA_KEY = /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/;

/** The step's query: a sub-key of the item's, so the live stream's item refreshes reach it. */
export const stepQueryKey = (itemId: string, stepId: string) =>
  [...queryKeys.item(itemId), 'step', stepId] as const;

const who = (by: string) => (by === 'owner' ? 'you' : by);
const quote = (text: string | null | undefined) => (text ? `“${text}”` : '(none)');

/** One history line: what changed, by whom; the time is shown beside it. */
function historyText(h: StepHistoryEntry): string {
  switch (h.change) {
    case 'added':
      return `Added by ${who(h.by)}`;
    case 'text':
      return `Reworded by ${who(h.by)}: ${quote(h.from)} → ${quote(h.to)}`;
    case 'state':
      return `${who(h.by)} set it to ${STATE[h.to as WorkStepState]?.label.toLowerCase() ?? h.to}${
        h.from ? ` (was ${STATE[h.from as WorkStepState]?.label.toLowerCase() ?? h.from})` : ''
      }`;
    case 'details':
      return `${who(h.by)} ${h.to === 'v0' ? 'cleared' : 'edited'} the details (${h.from} → ${h.to})`;
    case 'source':
      return h.to ? `${who(h.by)} set the source to ${h.to}` : `${who(h.by)} cleared the source`;
  }
}

type Conflict = {
  current: { details_md: string | null; details_version: number };
  changed_by: string | null;
  changed_at: string;
  mine: string;
};

/**
 * The step dialog (owner decision 33; UI_SPEC §6.3.1a). Opened from a work
 * step's title or its details icon; rows never expand inline.
 *
 * - **Contents:** the title, a status chip and the source (a Jira key links
 *   to the issue when the project was imported from Jira), the details
 *   rendered as sanitised Markdown, the history (wording changes with their
 *   reasons, state changes by whom and when, details edits) and subagent
 *   notes with their provenance.
 * - **Edit details:** the inline editor, saved against the `details_version`
 *   the owner opened (a `409` shows the conflict callout), `Ctrl+Enter`
 *   saves, `Esc` cancels. Owner and agent steps alike.
 * - **Moving:** *Previous* and *Next*, and ← → when focus isn't in the
 *   editor. Esc closes; the caller returns focus to the step's row.
 * - Up to 960px wide and 85vh tall, the body scrolling.
 */
export function StepDialog({
  itemId,
  steps,
  stepId,
  onMove,
  onClose,
}: {
  itemId: string;
  /** The current plan's steps, in order: Previous and Next walk them. */
  steps: readonly WorkStep[];
  stepId: string;
  onMove: (stepId: string) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const index = steps.findIndex((s) => s.id === stepId);
  const row = steps[index];
  const query = useQuery({
    queryKey: stepQueryKey(itemId, stepId),
    queryFn: () => apiClient['steps.get']({ params: { id: itemId, stepId } }),
  });
  const step: WorkStep | undefined = query.data?.step ?? row;
  const [editing, setEditing] = useState(false);
  const [base, setBase] = useState({ text: '', version: 0 });
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const refocusEdit = useRef(false);
  const prev = index > 0 ? steps[index - 1] : undefined;
  const next = index >= 0 && index < steps.length - 1 ? steps[index + 1] : undefined;

  // Previous, Next and the arrow keys are off while editing, so an edit never spans two steps.
  useEffect(() => {
    if (!editing && refocusEdit.current) {
      refocusEdit.current = false;
      editButton.current?.focus();
    }
  }, [editing]);

  // ← and → move between steps, unless focus is in a field or the editor is open.
  const move = useRef({ prev, next, editing, onMove });
  useEffect(() => {
    move.current = { prev, next, editing, onMove };
  });
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const target = e.target as HTMLElement | null;
      // Inside the dialog, or nowhere (a Previous or Next button that just disabled itself).
      if (target && target !== document.body && !target.closest('.step-dlg')) return;
      if (target?.closest('input, textarea, select, [contenteditable], [data-inline-editor]'))
        return;
      const m = move.current;
      if (m.editing) return;
      const to = e.key === 'ArrowLeft' ? m.prev : m.next;
      if (!to) return;
      e.preventDefault();
      m.onMove(to.id);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  if (!step) {
    return (
      <Dialog title="Step" onClose={onClose} className="step-dlg">
        <EmptyState text="This step is no longer on the plan." />
      </Dialog>
    );
  }

  const details = step.details_md ?? null;
  const version = step.details_version ?? 0;
  const site = query.data?.jira_site ?? null;
  const source = step.source;
  const jiraLink = !!site && !!source && JIRA_KEY.test(source);
  // A sub-task the Jira import made: the import "added" it as the owner, so say where it came from.
  const imported = jiraLink && step.added_by === 'owner';
  const moved = query.data?.history.some((h) => h.change === 'state') ?? false;

  const startEdit = () => {
    setBase({ text: details ?? '', version });
    setConflict(null);
    setEditing(true);
  };
  const stopEdit = () => {
    setConflict(null);
    refocusEdit.current = true;
    setEditing(false);
  };

  const send = async (text: string, expected: number): Promise<boolean> => {
    if (text === base.text && expected === base.version) {
      stopEdit();
      return true;
    }
    try {
      const res = await apiClient['steps.details']({
        params: { id: itemId, stepId: step.id },
        body: { details: text.trim() ? text : null, expected_version: expected },
      });
      toastSuccess(withWarnings(SAVED_MESSAGE, res.warnings), res.mutation_id);
      await queryClient.invalidateQueries({ queryKey: queryKeys.item(itemId) });
      stopEdit();
      return true;
    } catch (err) {
      if (isConflict(err)) {
        const current = err.current as WorkStep | undefined;
        // Who changed it and when: the latest details edit in its history.
        const fresh = await apiClient['steps.get']({
          params: { id: itemId, stepId: step.id },
        }).catch(() => null);
        const last = fresh?.history.filter((h) => h.change === 'details').at(-1);
        setConflict({
          current: {
            details_md: current?.details_md ?? fresh?.step.details_md ?? null,
            details_version: current?.details_version ?? fresh?.step.details_version ?? expected,
          },
          changed_by: last ? who(last.by) : null,
          changed_at: last?.at ?? new Date().toISOString(),
          mine: text,
        });
        await queryClient.invalidateQueries({ queryKey: queryKeys.item(itemId) });
        return false;
      }
      showToast(err instanceof Error && err.message ? err.message : 'Couldn’t save. Try again.');
      return false;
    }
  };

  const state = STATE[step.state];
  return (
    <Dialog
      title={step.text}
      onClose={onClose}
      className="step-dlg"
      initialFocus={() => editButton.current}
      footer={
        <>
          <span className="src grow" aria-live="polite">
            Step {index + 1} of {steps.length}
            <span className="hint"> · ← → move between steps</span>
          </span>
          <Button
            size="sm"
            disabled={!prev || editing}
            onClick={() => prev && onMove(prev.id)}
            aria-label={prev ? `Previous step: ${prev.text}` : 'Previous step'}
          >
            ← Previous
          </Button>
          <Button
            size="sm"
            disabled={!next || editing}
            onClick={() => next && onMove(next.id)}
            aria-label={next ? `Next step: ${next.text}` : 'Next step'}
          >
            Next →
          </Button>
          <Button size="sm" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <div className="step-meta row wrap" data-step-dialog={step.id}>
        <Chip kind={state.kind}>{state.label}</Chip>
        {source && (
          <span className="src" data-step-source={source}>
            Source:{' '}
            {jiraLink ? (
              <a
                className="ext"
                href={`${site}/browse/${encodeURIComponent(source)}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {source}
                <span className="sr"> (opens in Jira)</span>
              </a>
            ) : (
              <span className="mono">{source}</span>
            )}
          </span>
        )}
        <span className="src">
          {imported
            ? 'Imported from Jira'
            : step.added_by === 'owner'
              ? 'Added by you'
              : 'The agent’s step'}
          {step.state_by && step.state_at && !(imported && !moved) && (
            <>
              {' · '}
              {step.state} by {who(step.state_by)}{' '}
              <span title={isoTitle(step.state_at)}>{formatStamp(step.state_at)}</span>
            </>
          )}
        </span>
      </div>
      {step.change_reason && <div className="changed">Changed: {step.change_reason}</div>}

      <section className="step-sec" aria-labelledby={`${step.id}-details`}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3 id={`${step.id}-details`}>
            Details{version > 0 && <span className="src"> · v{version}</span>}
          </h3>
          {!editing && (
            <Button ref={editButton} variant="ghost" size="sm" onClick={startEdit}>
              Edit details
            </Button>
          )}
        </div>
        {editing ? (
          <InlineEditor
            field="details"
            initial={base.text}
            multiline
            maxLength={LIMITS.step_details}
            onSave={(text) => send(text, conflict?.current.details_version ?? base.version)}
            onCancel={stopEdit}
            renderPreview={(text) => <Markdown text={text} />}
            conflict={
              conflict && (
                <ConflictCallout
                  conflict={conflict}
                  theirs={conflict.current.details_md ?? ''}
                  markdown
                  onUseMine={() => void send(conflict.mine, conflict.current.details_version)}
                  onKeepTheirs={stopEdit}
                />
              )
            }
          />
        ) : details ? (
          <div className="step-details">
            <Markdown text={details} label={`Details of ${step.text}`} />
          </div>
        ) : (
          <EmptyState text="No details yet. Add context the agent should read before it works on this step." />
        )}
      </section>

      {step.subagents.length > 0 && (
        <section className="step-sec" aria-labelledby={`${step.id}-subagents`}>
          <h3 id={`${step.id}-subagents`}>Subagent notes</h3>
          {step.subagents.map((sub, i) => (
            <div className="contrib" key={`${sub.name}-${i}`}>
              <div className="row wrap">
                <Provenance kind={sub.provenance} />
                <b>{sub.name}</b>
                <span className="src" title={isoTitle(sub.at)}>
                  {formatStamp(sub.at)}
                </span>
                {sub.evidence && <span className="src">{sub.evidence}</span>}
              </div>
              <div>{sub.outcome}</div>
            </div>
          ))}
        </section>
      )}

      <section className="step-sec" aria-labelledby={`${step.id}-history`}>
        <h3 id={`${step.id}-history`}>History</h3>
        {query.isError ? (
          <EmptyState text="Couldn’t load the history. Close and open the step again." />
        ) : !query.data ? (
          <div className="src">Loading…</div>
        ) : (
          <ol className="step-history">
            {[...query.data.history].reverse().map((h, i) => (
              <li key={`${h.at}-${i}`} data-change={h.change}>
                <span className="src mono" title={isoTitle(h.at)}>
                  {formatStamp(h.at)}
                </span>
                <span>
                  {historyText(h)}
                  {h.note && (
                    <span className="changed">
                      {' '}
                      · {h.change === 'text' ? 'Changed: ' : ''}
                      {h.note}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </Dialog>
  );
}
