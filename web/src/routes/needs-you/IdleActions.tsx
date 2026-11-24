import { useId, useState } from 'react';
import type { IdleAction, Problem } from '@docket/shared';
import { Button, Dialog, DialogCancel } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { queryKeys } from '../../lib/api';
import { runOwnerMutation, showToast } from '../../lib/undo';

/** Each way forward for an idle ticket (owner decision 62): what it does, and the toast. */
export const IDLE_ACTION_TEXT: Record<IdleAction, { label: string; help: string; toast: string }> =
  {
    ready: {
      label: 'Move it to Ready',
      help: 'Any agent can pick it up again. Its branches stay listed.',
      toast: 'Moved to Ready.',
    },
    planning: {
      label: 'Move it to Planning',
      help: 'It needs shaping again before anyone starts it.',
      toast: 'Moved to Planning.',
    },
    inbox: {
      label: 'Move it to Inbox',
      help: 'Back to an idea: nobody plans it until you or a planner do.',
      toast: 'Moved to Inbox.',
    },
    cancel: {
      label: 'Cancel it',
      help: 'Nobody will do it. You can reopen it later.',
      toast: 'Canceled.',
    },
    clear_branches: {
      label: 'Clear its branches',
      help: 'It stays In progress, and the radar stops using its old branches.',
      toast: 'Branches cleared. The radar no longer checks them.',
    },
  };

const ORDER: readonly IdleAction[] = ['ready', 'planning', 'inbox', 'cancel', 'clear_branches'];

const refetch = [
  queryKeys.family('needsYou'),
  queryKeys.family('bootstrap'),
  queryKeys.family('work'),
  queryKeys.family('item'),
];

/**
 * *Decide…* on an idle ticket's problem (decision 62): one dialog with the
 * ways forward, each saying what it does. Every choice can be undone.
 */
export function IdleActions({ problem }: { problem: Problem }) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<IdleAction>('ready');
  const [busy, setBusy] = useState(false);
  const name = useId();
  const id = problem.item_id;
  if (!id) return null;
  const apply = async () => {
    setBusy(true);
    try {
      await runOwnerMutation(
        () => apiClient['items.settleIdle']({ params: { id }, body: { action: choice } }),
        { success: `${id}: ${IDLE_ACTION_TEXT[choice].toast}`, refetch },
      );
      setOpen(false);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'That didn’t work. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} title={`Move, cancel or clear ${id}`}>
        Decide…
      </Button>
      {open && (
        <Dialog
          title={`What happens to ${id}?`}
          onClose={() => setOpen(false)}
          destructive={choice === 'cancel'}
          footer={
            <>
              <DialogCancel onClick={() => setOpen(false)}>Cancel</DialogCancel>
              <Button
                variant="primary"
                aria-disabled={busy || undefined}
                onClick={() => {
                  if (!busy) void apply();
                }}
              >
                {IDLE_ACTION_TEXT[choice].label}
              </Button>
            </>
          }
        >
          <p>
            Nobody has worked on {id} for days: no agent, no run and no activity. You can undo what
            you choose.
          </p>
          <fieldset className="overlap-modes" data-idle-actions="">
            <legend className="f">Choose one</legend>
            {ORDER.map((a) => (
              <label key={a} className="overlap-mode">
                <input
                  type="radio"
                  name={name}
                  value={a}
                  checked={choice === a}
                  onChange={() => setChoice(a)}
                />
                <span>
                  <span className="overlap-mode-name">{IDLE_ACTION_TEXT[a].label}</span>
                  <span className="src overlap-mode-help">{IDLE_ACTION_TEXT[a].help}</span>
                </span>
              </label>
            ))}
          </fieldset>
        </Dialog>
      )}
    </>
  );
}
