import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { TEXT_LIMITS, type ItemText, type RouteBodyInput } from '@docket/shared';
import { Button, Callout, IconButton, InlineEditor, showCounter } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { isConflict, queryKeys } from '../../lib/api';
import { formatClock } from '../../lib/format';
import { showToast, toastSuccess, withWarnings } from '../../lib/undo';
import { Markdown } from '../shared/Markdown';

/**
 * Inline editing (UI_SPEC §6.3; owner decision 22; FR-064a): the owner
 * edits the title, description, outcome and acceptance criteria in place.
 *
 * - Save sends `expected_version`; success toasts "Saved. Agents see it on
 *   their next read." with Undo, plus the write-check warnings.
 * - A `409` keeps the editor open with the owner's text, and shows the
 *   `--warn` callout "codex changed this at 10:52. Their version is shown
 *   above; your text is kept below to copy back.", their text, *Use mine
 *   anyway* (re-sends against the new version) and *Keep theirs*.
 * - Focus moves into the field on open and back to the Edit button on close.
 */

export const SAVED_MESSAGE = 'Saved. Agents see it on their next read.';

type PatchBody = Omit<RouteBodyInput<'items.patch'>, 'expected_version'>;

/** The latest text and who changed it, as a `409` on `PATCH /api/items/:id` carries it. */
export type EditConflict = ItemText & { changed_by: string | null; changed_at: string };

export type SaveOutcome = { ok: true } | { ok: false; conflict: EditConflict | null };

/** `PATCH /api/items/:id` with the save toast; a conflict comes back for the callout. */
export async function savePatch(
  queryClient: QueryClient,
  item: { id: string; version: number },
  body: PatchBody,
  success: string = SAVED_MESSAGE,
): Promise<SaveOutcome> {
  try {
    const res = await apiClient['items.patch']({
      params: { id: item.id },
      body: { expected_version: item.version, ...body },
    });
    toastSuccess(withWarnings(success, res.warnings), res.mutation_id);
    await queryClient.invalidateQueries({ queryKey: queryKeys.all });
    return { ok: true };
  } catch (err) {
    if (isConflict(err)) {
      await queryClient.invalidateQueries({ queryKey: queryKeys.item(item.id) });
      return { ok: false, conflict: (err.current as EditConflict | undefined) ?? null };
    }
    showToast(err instanceof Error && err.message ? err.message : 'Couldn’t save. Try again.');
    return { ok: false, conflict: null };
  }
}

/** The conflict callout: who changed it and when, their text, and the two ways out. */
export function ConflictCallout({
  conflict,
  theirs,
  markdown,
  onUseMine,
  onKeepTheirs,
}: {
  /** Who changed it and when (an item's text, or a step's details in the step dialog). */
  conflict: Pick<EditConflict, 'changed_by' | 'changed_at'>;
  theirs: ReactNode | string;
  markdown?: boolean;
  onUseMine: () => void;
  onKeepTheirs: () => void;
}) {
  const who = conflict.changed_by ?? 'Someone';
  return (
    <Callout tone="warn" role="alert" className="conflict">
      <div>
        {who === 'you' ? 'You' : who} changed this at {formatClock(conflict.changed_at)}. Their
        version is shown above; your text is kept below to copy back.
      </div>
      <div className="theirs" aria-label="Their version">
        {typeof theirs === 'string' ? (
          markdown && theirs ? (
            <Markdown text={theirs} />
          ) : (
            <div className="prose">{theirs || '(empty)'}</div>
          )
        ) : (
          theirs
        )}
      </div>
      <div className="row wrap">
        <Button size="sm" onClick={onUseMine}>
          Use mine anyway
        </Button>
        <Button size="sm" onClick={onKeepTheirs}>
          Keep theirs
        </Button>
      </div>
    </Callout>
  );
}

type TextField = 'title' | 'outcome_md' | 'description_md';

/** Opens an editor in place of its read view; the Edit button gets focus back on close. */
function useEditing() {
  const [editing, setEditing] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const reopen = useRef(false);
  useEffect(() => {
    if (!editing && reopen.current) {
      reopen.current = false;
      button.current?.focus();
    }
  }, [editing]);
  return {
    editing,
    button,
    open: () => setEditing(true),
    close: () => {
      reopen.current = true;
      setEditing(false);
    },
  };
}

/**
 * A text field the owner edits inline: the read view with an Edit button
 * (a pencil for the title), or the editor with the conflict callout.
 */
export function InlineTextEdit({
  item,
  field,
  name,
  value,
  children,
  pencil = false,
  editLabel,
}: {
  item: ItemText;
  field: TextField;
  /** "title", "outcome", "description", "brief": names the field ("Edit outcome"). */
  name: string;
  value: string;
  children: ReactNode;
  /** The title's pencil (hover or focus) rather than a text *Edit* button. */
  pencil?: boolean;
  /** Visible text of the Edit button. */
  editLabel?: string;
}) {
  const queryClient = useQueryClient();
  const { editing, button, open, close } = useEditing();
  const [conflict, setConflict] = useState<{ current: EditConflict; mine: string } | null>(null);
  const max = field === 'title' ? TEXT_LIMITS.title : TEXT_LIMITS.markdown;
  const markdown = field !== 'title';

  // The version and text the owner started from: a save is checked against
  // them, not against what the live stream has refetched since (FR-064a).
  const [base, setBase] = useState({ version: item.version, value });
  const start = () => {
    setBase({ version: item.version, value });
    setConflict(null);
    open();
  };

  const send = async (text: string, version: number) => {
    if (text === base.value && version === base.version) {
      close();
      return true;
    }
    const out = await savePatch(queryClient, { id: item.id, version }, { [field]: text });
    if (out.ok) {
      setConflict(null);
      close();
      return true;
    }
    if (out.conflict) setConflict({ current: out.conflict, mine: text });
    return false;
  };

  if (editing) {
    return (
      <div className="ied-wrap" data-editing={field}>
        <InlineEditor
          field={name}
          initial={base.value}
          multiline={markdown}
          maxLength={max}
          onSave={(text) => send(text, conflict?.current.version ?? base.version)}
          onCancel={() => {
            setConflict(null);
            close();
          }}
          renderPreview={markdown ? (text) => <Markdown text={text} /> : undefined}
          conflict={
            conflict && (
              <ConflictCallout
                conflict={conflict.current}
                theirs={conflict.current[field]}
                markdown={markdown}
                onUseMine={() => void send(conflict.mine, conflict.current.version)}
                onKeepTheirs={() => {
                  setConflict(null);
                  close();
                }}
              />
            )
          }
        />
      </div>
    );
  }
  return (
    <div className={pencil ? 'editable row' : 'row'} style={{ alignItems: 'flex-start' }}>
      <div className="grow">{children}</div>
      {pencil ? (
        <IconButton
          ref={button}
          className="editbtn"
          icon="pencil"
          aria-label={`Edit ${name}`}
          bare
          onClick={start}
        />
      ) : (
        <Button ref={button} variant="ghost" size="sm" aria-label={`Edit ${name}`} onClick={start}>
          {editLabel ?? 'Edit'}
        </Button>
      )}
    </div>
  );
}

/**
 * Acceptance criteria: one input per line, *+ Add criterion*, a remove (×)
 * on each, Save and Cancel, `Ctrl+Enter` and `Esc`; each criterion ≤ 500.
 */
export function AcceptanceEdit({ item, children }: { item: ItemText; children: ReactNode }) {
  const queryClient = useQueryClient();
  const { editing, button, open, close } = useEditing();
  const [rows, setRows] = useState<string[]>(item.acceptance);
  const [conflict, setConflict] = useState<{ current: EditConflict; mine: string[] } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  const ids = useId();
  const max = TEXT_LIMITS.step;
  // What the owner started from: saves are checked against this version (FR-064a).
  const [base, setBase] = useState({ version: item.version, list: item.acceptance });
  const clean = (list: string[]) => list.map((r) => r.trim()).filter(Boolean);
  const dirty = clean(rows).join('\n') !== base.list.join('\n');
  const tooLong = rows.some((r) => r.length > max);

  useEffect(() => {
    if (editing) first.current?.focus();
  }, [editing]);

  const start = () => {
    setBase({ version: item.version, list: item.acceptance });
    setRows(item.acceptance.length > 0 ? item.acceptance : ['']);
    setConflict(null);
    setConfirming(false);
    open();
  };
  const stop = () => {
    setConflict(null);
    setConfirming(false);
    close();
  };

  const send = async (list: string[], version: number) => {
    if (saving || list.some((r) => r.length > max)) return;
    const next = clean(list);
    if (next.join('\n') === base.list.join('\n') && version === base.version) {
      stop();
      return;
    }
    setSaving(true);
    try {
      const out = await savePatch(queryClient, { id: item.id, version }, { acceptance: next });
      if (out.ok) stop();
      else if (out.conflict) setConflict({ current: out.conflict, mine: list });
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send(rows, conflict?.current.version ?? base.version);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (dirty && !confirming) setConfirming(true);
      else stop();
    }
  };

  if (!editing) {
    return (
      <>
        <div className="row" style={{ justifyContent: 'space-between', marginTop: 14 }}>
          <h3 style={{ margin: 0 }}>Acceptance</h3>
          <Button
            ref={button}
            variant="ghost"
            size="sm"
            aria-label="Edit acceptance criteria"
            onClick={start}
          >
            Edit
          </Button>
        </div>
        {children}
      </>
    );
  }

  return (
    <div className="ied" onKeyDown={onKeyDown} data-inline-editor="acceptance criteria">
      <h3 style={{ marginTop: 14 }}>Acceptance</h3>
      {conflict && (
        <ConflictCallout
          conflict={conflict.current}
          theirs={
            conflict.current.acceptance.length > 0 ? (
              <ul className="acc-theirs">
                {conflict.current.acceptance.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            ) : (
              '(no criteria)'
            )
          }
          onUseMine={() => void send(conflict.mine, conflict.current.version)}
          onKeepTheirs={stop}
        />
      )}
      {rows.map((row, i) => (
        <div className="acc-row" key={i}>
          <label className="sr" htmlFor={`${ids}-${i}`}>
            Acceptance criterion {i + 1}
          </label>
          <input
            ref={i === 0 ? first : undefined}
            id={`${ids}-${i}`}
            className="input"
            value={row}
            autoComplete="off"
            aria-invalid={row.length > max || undefined}
            onChange={(e) => setRows(rows.map((r, j) => (j === i ? e.target.value : r)))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                setRows([...rows.slice(0, i + 1), '', ...rows.slice(i + 1)]);
              }
            }}
          />
          <IconButton
            icon="x"
            aria-label={`Remove criterion ${i + 1}`}
            bare
            onClick={() => setRows(rows.filter((_, j) => j !== i))}
          />
          {showCounter(row.length, max) && (
            <span className={`counter${row.length > max ? ' over' : ''}`} aria-live="polite">
              {row.length} / {max}
            </span>
          )}
        </div>
      ))}
      <div>
        <Button variant="ghost" size="sm" onClick={() => setRows([...rows, ''])}>
          + Add criterion
        </Button>
      </div>
      {confirming ? (
        <Callout tone="warn" role="alert">
          <div className="row wrap">
            <span className="grow">Discard your changes to the acceptance criteria?</span>
            <Button size="sm" onClick={() => setConfirming(false)} autoFocus>
              Keep editing
            </Button>
            <Button size="sm" variant="danger-text" onClick={stop}>
              Discard
            </Button>
          </div>
        </Callout>
      ) : (
        <div className="row wrap">
          <Button
            variant="primary"
            size="sm"
            disabled={saving || tooLong}
            onClick={() => void send(rows, conflict?.current.version ?? base.version)}
          >
            Save
          </Button>
          <Button variant="ghost" size="sm" onClick={() => (dirty ? setConfirming(true) : stop())}>
            Cancel
          </Button>
          <span className="src">Ctrl+Enter saves · Esc cancels</span>
        </div>
      )}
    </div>
  );
}
