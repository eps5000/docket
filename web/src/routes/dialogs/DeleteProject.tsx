import { useId, useState } from 'react';
import { Button, Callout, Dialog, DialogCancel, ErrorState } from '../../components/kit';
import { apiClient } from '../../app/queryClient';

/**
 * Delete project (UI_SPEC §6.7): destructive, Cancel focused first; *Delete
 * project* is enabled only when the typed key matches. US10 wires the
 * after-delete flow (scope reset, toast).
 */
export function DeleteProjectDialog({
  project,
  onClose,
  onDeleted,
}: {
  project: { key: string; name: string; items: number; documents: number };
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const inputId = useId();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<unknown>(null);
  const ok = typed === project.key;
  const remove = async () => {
    setError(null);
    try {
      await apiClient['projects.delete']({
        params: { key: project.key },
        body: { confirm_key: project.key },
      });
      onDeleted?.();
      onClose();
    } catch (err) {
      setError(err);
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
        Backups keep a copy until their 14-day retention ends. Removing the Docker container alone
        doesn’t delete data.
      </Callout>
      <label className="f" htmlFor={inputId}>
        Type <b className="mono">{project.key}</b> to confirm
      </label>
      <input
        id={inputId}
        className="input"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        autoComplete="off"
      />
      {error !== null && (
        <div style={{ marginTop: 10 }}>
          <ErrorState error={error} />
        </div>
      )}
    </Dialog>
  );
}
