import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Button } from './Button';
import { IconButton } from './Button';
import { Callout } from './Card';

/** A counter appears once 80% of the limit is used (UI_SPEC §6.3 Inline editing). */
export function showCounter(length: number, max: number): boolean {
  return length >= Math.ceil(max * 0.8);
}

export interface InlineEditorProps {
  /** "title", "outcome", "description": names the field for labels ("Edit title"). */
  field: string;
  initial: string;
  /** Single-line input (title) or an auto-growing Markdown textarea. */
  multiline?: boolean;
  /** Title 200, outcome and description 20,000, each criterion 500. */
  maxLength: number;
  /** Save; the editor stays open while it runs and closes when it resolves to true. */
  onSave: (value: string) => Promise<boolean> | boolean;
  onCancel: () => void;
  /**
   * Shown above the field: the conflict callout ("codex changed this at
   * 10:52…") with *Use mine anyway* and *Keep theirs* (UI_SPEC §6.3).
   */
  conflict?: ReactNode;
  /** Renders the *Preview* of a Markdown field. Without it, Preview shows the plain text. */
  renderPreview?: (text: string) => ReactNode;
}

/**
 * The inline editor primitive (UI_SPEC §6.3 "Inline editing"): *Save*
 * (primary) and *Cancel* (ghost); `Ctrl+Enter` saves; `Esc` cancels, asking
 * to confirm when something changed. Focus moves into the field on open.
 */
export function InlineEditor({
  field,
  initial,
  multiline = false,
  maxLength,
  onSave,
  onCancel,
  conflict,
  renderPreview,
}: InlineEditorProps) {
  const [value, setValue] = useState(initial);
  const [preview, setPreview] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const fieldRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const id = useId();
  const dirty = value !== initial;

  useEffect(() => {
    const el = fieldRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  // Auto-grow the textarea.
  useLayoutEffect(() => {
    const el = fieldRef.current;
    if (!multiline || !el || preview) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value, multiline, preview]);

  const save = async () => {
    if (saving || value.length > maxLength) return;
    setSaving(true);
    try {
      await onSave(value);
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    if (dirty && !confirming) {
      setConfirming(true);
      return;
    }
    onCancel();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void save();
    } else if (e.key === 'Enter' && !multiline) {
      e.preventDefault();
      void save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  };

  const label = `Edit ${field}`;
  return (
    <div className="ied" onKeyDown={onKeyDown} data-inline-editor={field}>
      {conflict}
      <label className="sr" htmlFor={id}>
        {label}
      </label>
      {preview && multiline ? (
        <div className="card pad" aria-label={`${field} preview`}>
          {renderPreview ? (
            renderPreview(value)
          ) : (
            <div style={{ whiteSpace: 'pre-wrap' }}>{value}</div>
          )}
        </div>
      ) : multiline ? (
        <textarea
          ref={fieldRef}
          id={id}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-invalid={value.length > maxLength || undefined}
        />
      ) : (
        <input
          ref={fieldRef}
          id={id}
          className={`input${field === 'title' ? ' ied-title' : ''}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
          aria-invalid={value.length > maxLength || undefined}
        />
      )}
      {showCounter(value.length, maxLength) && (
        <div className={`counter${value.length > maxLength ? ' over' : ''}`} aria-live="polite">
          {value.length.toLocaleString('en-US')} / {maxLength.toLocaleString('en-US')}
        </div>
      )}
      {confirming ? (
        <Callout tone="warn" role="alert">
          <div className="row wrap">
            <span className="grow">Discard your changes to the {field}?</span>
            <Button size="sm" onClick={() => setConfirming(false)} autoFocus>
              Keep editing
            </Button>
            <Button size="sm" variant="danger-text" onClick={onCancel}>
              Discard
            </Button>
          </div>
        </Callout>
      ) : (
        <div className="row wrap">
          <Button
            variant="primary"
            size="sm"
            onClick={() => void save()}
            disabled={saving || value.length > maxLength}
          >
            Save
          </Button>
          <Button variant="ghost" size="sm" onClick={cancel}>
            Cancel
          </Button>
          {multiline && (
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={preview}
              onClick={() => setPreview(!preview)}
            >
              Preview
            </Button>
          )}
          <span className="src">Ctrl+Enter saves · Esc cancels</span>
        </div>
      )}
    </div>
  );
}

/**
 * Text with an *Edit* pencil that appears on hover or focus, opening the
 * inline editor in place. Focus returns to the pencil when the editor closes.
 */
export function EditableText({
  field,
  value,
  children,
  ...editor
}: Omit<InlineEditorProps, 'initial' | 'onCancel' | 'onSave'> & {
  value: string;
  /** How the value reads when not editing (the h1, the outcome text). */
  children: ReactNode;
  onSave: (value: string) => Promise<boolean> | boolean;
}) {
  const [editing, setEditing] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const reopen = useRef(false);
  useEffect(() => {
    if (!editing && reopen.current) {
      reopen.current = false;
      btn.current?.focus();
    }
  }, [editing]);
  const close = () => {
    reopen.current = true;
    setEditing(false);
  };
  if (editing) {
    return (
      <InlineEditor
        field={field}
        initial={value}
        {...editor}
        onCancel={close}
        onSave={async (v) => {
          const ok = await editor.onSave(v);
          if (ok) close();
          return ok;
        }}
      />
    );
  }
  return (
    <div className="editable row" style={{ alignItems: 'flex-start' }}>
      <div className="grow">{children}</div>
      <IconButton
        ref={btn}
        className="editbtn"
        icon="pencil"
        aria-label={`Edit ${field}`}
        bare
        onClick={() => setEditing(true)}
      />
    </div>
  );
}
