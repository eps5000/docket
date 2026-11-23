import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { QUESTION_FORM, TEXT_LIMITS, type QuestionForm } from '@docket/shared';
import { Button, Dialog, DialogCancel } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { showToast } from '../../lib/undo';
import { useSteer } from './steer';
import './question-answer.css';

/** "Something else" in the option group: never a real option's label, because it isn't text. */
const OTHER = Symbol('something else');
type Picked = string | typeof OTHER;

interface Draft {
  picked: Picked;
  note: string;
  other: string;
}

export const recommendedOption = (form: QuestionForm) =>
  form.options.find((o) => o.recommended) ?? form.options[0]!;

/**
 * The plain question's action (decision 47; UI_SPEC §6.1, §6.3): the
 * recommended option and *Answer*, which opens the dialog. The draft lives
 * here, so closing the dialog by accident doesn't lose what the owner typed.
 */
export function QuestionAnswer({
  itemId,
  questionId,
  question,
  form,
  agent,
  buttonLabel,
}: {
  itemId: string;
  questionId: string;
  question: string;
  form: QuestionForm;
  agent: string;
  /** The button's accessible name; it must contain "Answer". */
  buttonLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => ({
    picked: recommendedOption(form).label,
    note: '',
    other: '',
  }));
  return (
    <>
      <Button size="sm" variant="primary" aria-label={buttonLabel} onClick={() => setOpen(true)}>
        Answer
      </Button>
      {open && (
        <QuestionDialog
          itemId={itemId}
          questionId={questionId}
          question={question}
          form={form}
          agent={agent}
          draft={draft}
          onDraft={setDraft}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** "Recommended: Per serving", under the question on the row and the banner. */
export function RecommendedLine({ form }: { form: QuestionForm }) {
  return (
    <div className="q-rec">
      <span className="q-rec-tag">Recommended</span> {recommendedOption(form).label}
    </div>
  );
}

function QuestionDialog({
  itemId,
  questionId,
  question,
  form,
  agent,
  draft,
  onDraft,
  onClose,
}: {
  itemId: string;
  questionId: string;
  question: string;
  form: QuestionForm;
  agent: string;
  draft: Draft;
  onDraft: (d: Draft) => void;
  onClose: () => void;
}) {
  const formId = useId();
  const groupName = useId();
  const noteId = useId();
  const otherId = useId();
  const otherRef = useRef<HTMLTextAreaElement>(null);
  const checkedRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const steer = useSteer(itemId);
  const isOther = draft.picked === OTHER;

  const send = async () => {
    if (busy) return;
    const other = draft.other.trim();
    if (isOther && !other) {
      showToast('Write your answer first.');
      otherRef.current?.focus();
      return;
    }
    const note = draft.note.trim();
    const body = isOther
      ? { question_id: questionId, text: other }
      : {
          question_id: questionId,
          option: draft.picked as string,
          ...(note ? { note } : {}),
        };
    setBusy(true);
    const res = await steer(
      () => apiClient['items.answer']({ params: { id: itemId }, body }),
      `Answer posted to ${itemId}. ${agent} reads it on its next query.`,
    );
    setBusy(false);
    if (res) onClose();
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send();
  };
  const sendOnCtrlEnter = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <Dialog
      title={question}
      className="q-dialog"
      onClose={onClose}
      initialFocus={() => checkedRef.current}
      footer={
        <>
          <span className="src q-foot">{agent} reads it on its next query.</span>
          <DialogCancel onClick={onClose}>Cancel</DialogCancel>
          <Button type="submit" form={formId} variant="primary" disabled={busy}>
            Send answer
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit}>
        <h3 className="q-head">Background</h3>
        <p className="q-text">{form.context}</p>
        <h3 className="q-head">Why this matters</h3>
        <p className="q-text">{form.why_it_matters}</p>

        <fieldset className="q-options">
          <legend className="q-head">Your choice</legend>
          {form.options.map((o) => {
            const checked = draft.picked === o.label;
            return (
              <label key={o.label} className={checked ? 'q-option on' : 'q-option'}>
                <input
                  ref={checked ? checkedRef : undefined}
                  type="radio"
                  name={groupName}
                  checked={checked}
                  onChange={() => onDraft({ ...draft, picked: o.label })}
                />
                <span className="q-option-body">
                  <span className="q-option-title">
                    <b>{o.label}</b>
                    {o.recommended && <span className="q-rec-tag">Recommended</span>}
                  </span>
                  <span className="q-option-line">{o.description}</span>
                  <span className="q-option-line">
                    <b>If you choose this:</b> {o.consequences}
                  </span>
                  {o.recommended && (
                    <span className="q-option-line">
                      <b>Why it’s recommended:</b> {form.recommendation_reason}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
          <label className={isOther ? 'q-option on' : 'q-option'}>
            <input
              ref={isOther ? checkedRef : undefined}
              type="radio"
              name={groupName}
              checked={isOther}
              onChange={() => onDraft({ ...draft, picked: OTHER })}
            />
            <span className="q-option-body">
              <span className="q-option-title">
                <b>Something else</b>
              </span>
              <span className="q-option-line">Write your own answer instead.</span>
            </span>
          </label>
        </fieldset>

        {isOther ? (
          <>
            <label className="f" htmlFor={otherId}>
              Your answer
            </label>
            <textarea
              id={otherId}
              ref={otherRef}
              className="input"
              value={draft.other}
              maxLength={TEXT_LIMITS.question}
              onChange={(e) => onDraft({ ...draft, other: e.target.value })}
              onKeyDown={sendOnCtrlEnter}
            />
          </>
        ) : (
          <>
            <label className="f" htmlFor={noteId}>
              Add a note (optional)
            </label>
            <textarea
              id={noteId}
              className="input"
              value={draft.note}
              maxLength={QUESTION_FORM.note}
              onChange={(e) => onDraft({ ...draft, note: e.target.value })}
              onKeyDown={sendOnCtrlEnter}
            />
          </>
        )}

        {form.details && (
          <details className="q-details">
            <summary>Technical details</summary>
            <div className="q-text mono">{form.details}</div>
          </details>
        )}
      </form>
    </Dialog>
  );
}
