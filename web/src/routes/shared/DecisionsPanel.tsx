import { useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { LIMITS, type DecisionRecord, type DecisionScopeKind } from '@docket/shared';
import { Button, Callout, DecisionRow, EmptyState, Section } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { queryKeys } from '../../lib/api';
import { runOwnerMutation, showToast } from '../../lib/undo';
import { HelpLink } from '../../help/HelpLink';

/** Where a Decisions section sits (UI_SPEC §6.3.5), and what it can scope a new record to. */
export type DecisionsPlace =
  | { kind: 'ticket'; project: string; id: string; epic: { id: string; title: string } | null }
  | { kind: 'epic'; project: string; id: string; title: string }
  | { kind: 'label'; project: string; name: string }
  | { kind: 'project'; project: string; name: string };

interface Scope {
  kind: DecisionScopeKind;
  id?: string;
}

const scopeKey = (s: Scope) => (s.kind === 'project' ? 'project' : `${s.kind}:${s.id ?? ''}`);

/** The scopes a new record can take here: on a ticket, this item, its epic or the project. */
function scopeOptions(place: DecisionsPlace): { scope: Scope; label: string }[] {
  switch (place.kind) {
    case 'ticket':
      return [
        { scope: { kind: 'item', id: place.id }, label: 'This item' },
        ...(place.epic
          ? [
              {
                scope: { kind: 'epic' as const, id: place.epic.id },
                label: `◆ ${place.epic.title}`,
              },
            ]
          : []),
        { scope: { kind: 'project' }, label: 'Project' },
      ];
    case 'epic':
      return [{ scope: { kind: 'epic', id: place.id }, label: `◆ ${place.title}` }];
    case 'label':
      return [{ scope: { kind: 'label', id: place.name }, label: `#${place.name}` }];
    case 'project':
      return [{ scope: { kind: 'project' }, label: 'Project' }];
  }
}

/** The scope chip on ticket Details, where records are inherited. */
function scopeChip(d: DecisionRecord, place: DecisionsPlace): string | undefined {
  if (place.kind !== 'ticket') return undefined;
  switch (d.scope.kind) {
    case 'project':
      return 'Project';
    case 'epic':
      return `◆ ${place.epic && place.epic.id === d.scope.id ? place.epic.title : d.scope.id}`;
    case 'label':
      return `#${d.scope.id}`;
    case 'item':
      return 'This item';
  }
}

const WITHDRAWN_DEFAULT = 'Withdrawn by the owner.';

/**
 * A Decisions section (UI_SPEC §6.3.5): header "Decisions" with "n in scope ·
 * n by agents" and *+ Record a decision*; the inline record form; one
 * `DecisionRow` per active record (owner first, then newest, as the server
 * orders them), with *Confirm*, *Supersede* and *Withdraw…*; and *Show
 * withdrawn and superseded*. Every owner action toasts with Undo.
 */
export function DecisionsPanel({
  place,
  records,
  hideWhenEmpty = false,
}: {
  place: DecisionsPlace;
  /** Active and inactive records, owner first then newest. */
  records: readonly DecisionRecord[];
  hideWhenEmpty?: boolean;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const recordButtonId = useId();
  const focusRecordButton = () => document.getElementById(recordButtonId)?.focus();
  /** Close the form and put focus back on *+ Record a decision* (the form held it). */
  const closeForm = () => {
    setForm(null);
    requestAnimationFrame(focusRecordButton);
  };
  const active = records.filter((d) => d.status === 'active');
  const inactive = records.filter((d) => d.status !== 'active');
  if (hideWhenEmpty && active.length === 0 && !form) return null;
  const byAgents = active.filter((d) => d.authority === 'agent').length;
  const options = scopeOptions(place);

  const refresh = () => qc.invalidateQueries({ queryKey: queryKeys.all });
  const act = async <T extends { mutation_id: string; warnings?: string[] }>(
    fn: () => Promise<T>,
    success: string,
  ): Promise<T | null> => {
    try {
      return await runOwnerMutation(fn, { success, refetch: [queryKeys.all] });
    } catch (err) {
      showToast(err instanceof Error && err.message ? err.message : 'That didn’t work. Try again.');
      return null;
    } finally {
      await refresh();
    }
  };

  const confirm = (d: DecisionRecord) =>
    act(
      () =>
        apiClient['decisions.confirm']({
          params: { id: d.id },
          body: { expected_version: d.version },
        }),
      `Confirmed “${d.title}”. It is now an owner decision.`,
    );
  // The row's buttons go away with it: focus moves to *+ Record a decision*.
  const withdraw = (d: DecisionRecord, reason: string) => {
    focusRecordButton();
    return act(
      () =>
        apiClient['decisions.withdraw']({
          params: { id: d.id },
          body: { reason: reason || WITHDRAWN_DEFAULT, expected_version: d.version },
        }),
      `Withdrew “${d.title}”.`,
    );
  };

  const rows = (list: readonly DecisionRecord[]) =>
    list.map((d) => (
      <DecisionRow
        key={d.id}
        record={d}
        canAct
        scopeLabel={scopeChip(d, place)}
        onConfirm={() => void confirm(d)}
        onWithdraw={(reason) => void withdraw(d, reason)}
        onSupersede={() =>
          setForm({
            title: d.title,
            decision: d.decision_md,
            rationale: d.rationale_md ?? '',
            scope: { kind: d.scope.kind, id: d.scope.id ?? undefined },
            supersedes: d,
          })
        }
      />
    ));

  return (
    <Section
      sectionKey="decisions"
      title="Decisions"
      summary={`${active.length} in scope · ${byAgents} by agents`}
      extraHead={
        <>
          <Button
            id={recordButtonId}
            variant="ghost"
            size="sm"
            aria-expanded={form !== null}
            onClick={() =>
              setForm(
                form ? null : { title: '', decision: '', rationale: '', scope: options[0]!.scope },
              )
            }
          >
            + Record a decision
          </Button>
          <HelpLink anchor="decisions.section" />
        </>
      }
    >
      {form && (
        <RecordForm
          key={form.supersedes?.id ?? 'new'}
          initial={form}
          options={
            form.supersedes && !options.some((o) => scopeKey(o.scope) === scopeKey(form.scope))
              ? [{ scope: form.scope, label: scopeLabelOf(form.scope) }, ...options]
              : options
          }
          onCancel={closeForm}
          onSave={async (value) => {
            const result = await act(
              () =>
                apiClient['decisions.create']({
                  body: {
                    project: place.project,
                    scope: value.scope.kind === 'project' ? { kind: 'project' } : value.scope,
                    title: value.title,
                    decision: value.decision,
                    ...(value.rationale ? { rationale: value.rationale } : {}),
                    ...(form.supersedes ? { supersedes: form.supersedes.id } : {}),
                  },
                }),
              form.supersedes
                ? `Recorded “${value.title}”. “${form.supersedes.title}” is superseded.`
                : `Recorded “${value.title}”.`,
            );
            if (result) closeForm();
          }}
        />
      )}
      {active.length === 0 && !form ? (
        <EmptyState text="No decisions recorded. Agents record conventions and choices here; yours are authoritative." />
      ) : (
        rows(active)
      )}
      {inactive.length > 0 && (
        <div className="row" style={{ marginTop: 8 }}>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={showInactive}
            onClick={() => setShowInactive(!showInactive)}
          >
            {showInactive ? 'Hide' : 'Show'} withdrawn and superseded ({inactive.length})
          </Button>
        </div>
      )}
      {showInactive && rows(inactive)}
    </Section>
  );
}

function scopeLabelOf(s: Scope): string {
  if (s.kind === 'project') return 'Project';
  if (s.kind === 'label') return `#${s.id ?? ''}`;
  if (s.kind === 'epic') return `◆ ${s.id ?? ''}`;
  return s.id ?? 'This item';
}

interface FormState {
  title: string;
  decision: string;
  rationale: string;
  scope: Scope;
  supersedes?: DecisionRecord;
}

/**
 * The record form (UI_SPEC §6.3.5), inline under the header: Title
 * (required, ≤ 120), Decision (required, Markdown, ≤ 4,000), Why
 * (optional), Scope (preset to where you are). *Save* and *Cancel*.
 */
function RecordForm({
  initial,
  options,
  onSave,
  onCancel,
}: {
  initial: FormState;
  options: { scope: Scope; label: string }[];
  onSave: (value: FormState) => Promise<void>;
  onCancel: () => void;
}) {
  const ids = { title: useId(), decision: useId(), why: useId(), scope: useId() };
  const [title, setTitle] = useState(initial.title);
  const [decision, setDecision] = useState(initial.decision);
  const [rationale, setRationale] = useState(initial.rationale);
  const [scope, setScope] = useState(scopeKey(initial.scope));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const chosen = options.find((o) => scopeKey(o.scope) === scope) ?? options[0]!;
  const submit = async () => {
    if (!title.trim() || !decision.trim()) {
      setError(!title.trim() ? 'Title is required.' : 'Decision is required.');
      (!title.trim() ? titleRef.current : document.getElementById(ids.decision))?.focus();
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await onSave({
        title: title.trim(),
        decision: decision.trim(),
        rationale: rationale.trim(),
        scope: chosen.scope,
      });
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      className="decform"
      data-decision-form
      aria-label={
        initial.supersedes ? `Supersede ${initial.supersedes.title}` : 'Record a decision'
      }
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      {initial.supersedes && (
        <Callout tone="info">
          Saving supersedes “{initial.supersedes.title}”. It stays readable in history.
        </Callout>
      )}
      <label className="f" htmlFor={ids.title} style={{ marginTop: 0 }}>
        Title <b className="req">(required)</b>
      </label>
      <input
        id={ids.title}
        ref={titleRef}
        className="input"
        maxLength={LIMITS.decision_title}
        value={title}
        autoFocus
        aria-invalid={error === 'Title is required.' || undefined}
        onChange={(e) => setTitle(e.target.value)}
      />
      <label className="f" htmlFor={ids.decision}>
        Decision <b className="req">(required)</b> <span className="src">Markdown</span>
      </label>
      <textarea
        id={ids.decision}
        rows={3}
        maxLength={LIMITS.decision_md}
        value={decision}
        aria-invalid={error === 'Decision is required.' || undefined}
        onChange={(e) => setDecision(e.target.value)}
      />
      <label className="f" htmlFor={ids.why}>
        Why <span className="src">(optional)</span>
      </label>
      <textarea
        id={ids.why}
        rows={2}
        maxLength={LIMITS.rationale_md}
        value={rationale}
        onChange={(e) => setRationale(e.target.value)}
      />
      {options.length > 1 ? (
        <>
          <label className="f" htmlFor={ids.scope}>
            Scope
          </label>
          <select
            id={ids.scope}
            value={scopeKey(chosen.scope)}
            onChange={(e) => setScope(e.target.value)}
          >
            {options.map((o) => (
              <option key={scopeKey(o.scope)} value={scopeKey(o.scope)}>
                {o.label}
              </option>
            ))}
          </select>
        </>
      ) : (
        <div className="row" style={{ gap: 6, marginTop: 10 }}>
          <span className="f" style={{ margin: 0 }}>
            Scope
          </span>
          <span className="src" data-scope>
            {chosen.label}
          </span>
        </div>
      )}
      {error && (
        <div className="field-err" role="alert">
          {error}
        </div>
      )}
      <div className="row" style={{ gap: 6, marginTop: 10, justifyContent: 'flex-end' }}>
        <Button size="sm" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={saving}>
          Save
        </Button>
      </div>
    </form>
  );
}
