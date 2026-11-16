import { useId, useState } from 'react';
import { Button, Callout, Dialog, DialogCancel, ErrorState } from '../../components/kit';
import { apiClient } from '../../app/queryClient';

/**
 * Delete project (UI_SPEC §6.7; BUILD_SPEC §5.12): destructive, Cancel
 * focused first; *Delete project* is enabled only when the typed key
 * matches. Not undoable. `onDeleted` resets the scope and toasts.
 */
export function DeleteProjectDialog({
  project,
  keepDays = 14,
  onClose,
  onDeleted,
}: {
  project: { key: string; name: string; items: number; documents: number };
  /** Backup retention, from Settings (TASKLITE_BACKUP_KEEP). */
  keepDays?: number;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const inputId = useId();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const ok = typed === project.key && !busy;
  const remove = async () => {
    if (!ok) return;
    setError(null);
    setBusy(true);
    try {
      await apiClient['projects.delete']({
        params: { key: project.key },
        body: { confirm_key: project.key },
      });
      onDeleted?.();
      onClose();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`Delete ${project.name}?`}
      destructive
      onClose={onClose}
      footer={
        <>
          <DialogCancel onClick={onClose} />
          <Button variant="danger" disabled={!ok} onClick={() => void remove()}>
            Delete project
          </Button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        This permanently removes <b>{project.items} work items</b>, their checklists, runs and
        history, and <b>{project.documents} local documents</b> including handoff packets. Agents
        will get “not found” for these IDs.
      </p>
      <Callout tone="warn">
        Backups keep a copy until their {keepDays}-day retention ends. Removing the Docker container
        alone doesn’t delete data.
      </Callout>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void remove();
        }}
      >
        <label className="f" htmlFor={inputId}>
          Type <b className="mono">{project.key}</b> to confirm
        </label>
        <input
          id={inputId}
          className="input"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
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
