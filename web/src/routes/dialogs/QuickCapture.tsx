import { useQueryClient } from '@tanstack/react-query';
import { pausedMark } from '../../lib/format';
import { useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ITEM_TYPES, TYPE_MEANINGS, type ItemType } from '@docket/shared';
import { Button, Dialog, DialogCancel, ErrorState } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { useShell } from '../../app/ShellState';
import { useBootstrap } from '../../app/useBootstrap';
import { queryKeys } from '../../lib/api';
import { paths } from '../../lib/paths';
import { showToast, toastSuccess } from '../../lib/undo';

/** Opens Quick capture when the shell asks (+ New, or *+ New item in this epic*). */
export function QuickCaptureHost() {
  const { capture, setCapture } = useShell();
  if (!capture) return null;
  return <QuickCapture epic={capture.epic} onClose={() => setCapture(null)} />;
}

/**
 * Quick capture (UI_SPEC §6.9): Title (required, focused), Type (Story),
 * Project (the scope, else the first project), Epic (optional; fixed from an
 * epic), Notes. *Create* puts the item in Inbox and opens it; from an epic you
 * stay and get a toast. Empty title: toast "Give it a title" and focus it.
 */
export function QuickCapture({
  epic,
  onClose,
}: {
  epic?: { id: string; title: string; project: string };
  onClose: () => void;
}) {
  const { scope } = useShell();
  const boot = useBootstrap();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const titleRef = useRef<HTMLInputElement>(null);
  const ids = { title: useId(), type: useId(), project: useId(), notes: useId() };
  const projects = boot.data?.projects ?? [];
  const [title, setTitle] = useState('');
  const [type, setType] = useState<ItemType>('Implementation');
  const [project, setProject] = useState(
    epic?.project ?? (scope !== 'all' ? scope : (projects[0]?.key ?? '')),
  );
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!title.trim()) {
      showToast('Give it a title');
      titleRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await apiClient['items.create']({
        body: {
          title: title.trim(),
          type,
          project,
          ...(epic ? { epic: epic.id } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        },
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.all });
      onClose();
      if (epic) toastSuccess(`${res.item.id} added to ${epic.title}`, res.mutation_id);
      else navigate(paths.item(res.item.id));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={epic ? `New item in ◆ ${epic.title}` : 'New item in Inbox'}
      onClose={onClose}
      initialFocus={() => titleRef.current}
      footer={
        <>
          <DialogCancel onClick={onClose} />
          <Button variant="primary" onClick={() => void create()} disabled={busy}>
            Create
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <label className="f" htmlFor={ids.title} style={{ marginTop: 0 }}>
          Title <b className="req">(required)</b>
        </label>
        <input
          ref={titleRef}
          id={ids.title}
          className="input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Let me star favourite recipes"
          autoComplete="off"
          maxLength={200}
        />
        <div className="row wrap" style={{ gap: 10, marginTop: 10 }}>
          <span>
            <label className="f" htmlFor={ids.type} style={{ marginTop: 0 }}>
              Type
            </label>
            <select
              id={ids.type}
              value={type}
              onChange={(e) => setType(e.target.value as ItemType)}
            >
              {/* Decision 67: an epic is created with its Release, so Release isn't offered. */}
              {ITEM_TYPES.filter((t) => t !== 'Release' && !(epic && t === 'Epic')).map((t) => (
                <option key={t} title={TYPE_MEANINGS[t].use}>
                  {t}
                </option>
              ))}
            </select>
          </span>
          <span>
            <label className="f" htmlFor={ids.project} style={{ marginTop: 0 }}>
              Project
            </label>
            <select
              id={ids.project}
              value={project}
              onChange={(e) => setProject(e.target.value)}
              disabled={!!epic}
            >
              {projects.length === 0 && <option value="">No projects loaded</option>}
              {projects.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.short_name}
                  {pausedMark(p)}
                </option>
              ))}
            </select>
          </span>
          {epic && (
            <span>
              <span className="f" style={{ marginTop: 0 }}>
                Epic
              </span>
              <span>◆ {epic.title}</span>
            </span>
          )}
        </div>
        <label className="f" htmlFor={ids.notes}>
          Notes (optional)
        </label>
        <textarea
          id={ids.notes}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Anything you already know. You’ll shape it properly in Planning."
        />
      </form>
      {error !== null && (
        <div style={{ marginTop: 10 }}>
          <ErrorState error={error} />
        </div>
      )}
    </Dialog>
  );
}
