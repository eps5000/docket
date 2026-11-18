import { useEffect, useId, useRef, useState } from 'react';
import { TEXT_LIMITS } from '@docket/shared';
import { Button } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { showToast } from '../../lib/undo';
import { useSteer } from './steer';

/**
 * The answer to an agent's question (UI_SPEC §6.1 inline reply, §6.3 the
 * question banner): a textarea, *Send answer*, and an optional *Cancel*.
 * Enter adds a new line and Ctrl+Enter sends (UI_SPEC §7). The agent gets
 * the answer once, on its next `get_item` (BUILD_SPEC §5.7).
 */
export function AnswerBox({
  itemId,
  questionId,
  agent,
  label,
  hint,
  placeholder,
  autoFocus = false,
  onCancel,
  onSent,
}: {
  itemId: string;
  questionId: string;
  /** Who asked, for the toast: "codex reads it on its next query". */
  agent: string;
  label: string;
  hint: string;
  placeholder?: string;
  autoFocus?: boolean;
  onCancel?: () => void;
  onSent?: () => void;
}) {
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const steer = useSteer(itemId);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const send = async () => {
    const answer = text.trim();
    if (!answer) {
      showToast('Write an answer first.');
      ref.current?.focus();
      return;
    }
    setBusy(true);
    const res = await steer(
      () =>
        apiClient['items.answer']({
          params: { id: itemId },
          body: { question_id: questionId, text: answer },
        }),
      `Answer posted to ${itemId}. ${agent} reads it on its next query.`,
    );
    setBusy(false);
    if (res) {
      setText('');
      onSent?.();
    }
  };

  return (
    <div className="reply" data-answer={questionId}>
      <label className="f" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        ref={ref}
        className="input"
        value={text}
        maxLength={TEXT_LIMITS.question}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void send();
          }
          if (e.key === 'Escape' && onCancel) onCancel();
        }}
      />
      <div className="row wrap">
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void send()}>
          Send answer
        </Button>
        {onCancel && (
          <Button size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <span className="src">{hint}</span>
      </div>
    </div>
  );
}
