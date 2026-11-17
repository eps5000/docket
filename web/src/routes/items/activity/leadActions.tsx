/**
 * The lead actions shared by the item's agent bar (B20) and Lead and runs
 * (UI_SPEC §6.3.2): *Release lead claim…* with its destructive dialog, *Copy
 * resume note*, and the step a run is on. One copy of the logic; both places
 * call it.
 */
import { useState } from 'react';
import { OPEN_RUN_STATES, type ItemDetailResponse, type Run } from '@tasklite/shared';
import { Button, Dialog, DialogCancel, leadName } from '../../../components/kit';
import { apiClient } from '../../../app/queryClient';
import { plural } from '../../../lib/format';
import { useSteer } from '../../shared/steer';
import { RESUMABLE_RUN_STATES, resumeNote } from './resumeNote';
import { copyText } from './copy';

/** The step a run is on: the one its heartbeat named, else, for an open lead, the plan step marked current. */
export function currentStep(
  data: ItemDetailResponse,
  run: Run,
): { n: number; total: number; text: string } | null {
  const work = data.item.checklist.work;
  const open = (OPEN_RUN_STATES as readonly string[]).includes(run.run_state);
  const at = run.current_step_id
    ? work.findIndex((w) => w.id === run.current_step_id)
    : run.is_lead && open
      ? work.findIndex((w) => w.state === 'current')
      : -1;
  return at < 0 ? null : { n: at + 1, total: work.length, text: work[at]!.text };
}

/** *Release lead claim…* sits on the current lead while it is stale or parked (UI_SPEC §6.3.2). */
export function canReleaseLead(data: ItemDetailResponse, run: Run): boolean {
  return (
    run.is_lead &&
    run.run_id === data.item.lead?.run_id &&
    (run.run_state === 'stale' || run.run_state === 'parked')
  );
}

/** *Copy resume note* sits on interrupted, stale and parked lead runs (UI_SPEC §6.3.2). */
export function canCopyResumeNote(run: Run): boolean {
  return run.is_lead && RESUMABLE_RUN_STATES.includes(run.run_state);
}

export function copyResumeNote(data: ItemDetailResponse, run: Run): void {
  copyText(resumeNote(data.item, run, window.location.origin), 'the resume note');
}

/** Copy resume note, as a button. */
export function CopyResumeNoteButton({ data, run }: { data: ItemDetailResponse; run: Run }) {
  return (
    <Button size="sm" icon="copy" onClick={() => copyResumeNote(data, run)}>
      Copy resume note
    </Button>
  );
}

/**
 * *Release lead claim…*: `request(run)` opens the destructive dialog (focus
 * starts on Cancel); render `dialog` where the dialog belongs. Undo is in the
 * toast.
 */
export function useReleaseLead(data: ItemDetailResponse) {
  const item = data.item;
  const steer = useSteer(item.id);
  const [releasing, setReleasing] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  const release = async (run: Run) => {
    setBusy(true);
    const res = await steer(
      () =>
        apiClient['items.release']({
          params: { id: item.id },
          body: { expected_version: item.version },
        }),
      `Released ${leadName(run)}’s claim. ${item.id} is back in Ready.`,
    );
    setBusy(false);
    if (res) setReleasing(null);
  };
  return {
    busy,
    request: (run: Run) => setReleasing(run),
    dialog: releasing ? (
      <ReleaseDialog
        itemId={item.id}
        run={releasing}
        busy={busy}
        onCancel={() => setReleasing(null)}
        onConfirm={() => void release(releasing)}
      />
    ) : null,
  };
}

/** "47 minutes", "2 hours", "3 days": how long a run has been silent or parked. */
export function silentFor(since: string, now: Date = new Date()): string {
  const min = Math.max(1, Math.round((now.getTime() - new Date(since).getTime()) / 60_000));
  if (min < 120) return plural(min, 'minute');
  const h = Math.round(min / 60);
  return h < 48 ? plural(h, 'hour') : plural(Math.round(h / 24), 'day');
}

/**
 * *Release lead claim* (UI_SPEC §6.3.2): a destructive dialog whose focus
 * starts on Cancel. It says what releasing does: the run is interrupted,
 * not finished; its work stays; the item goes back to Ready.
 */
function ReleaseDialog({
  itemId,
  run,
  busy,
  onCancel,
  onConfirm,
}: {
  itemId: string;
  run: Run;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const who = leadName(run);
  const since = run.run_state === 'parked' && run.parked ? run.parked.since : run.last_signal_at;
  return (
    <Dialog
      title={`Release lead claim on ${itemId}?`}
      onClose={onCancel}
      destructive
      footer={
        <>
          <DialogCancel onClick={onCancel} />
          <Button variant="danger" disabled={busy} onClick={onConfirm}>
            Release claim
          </Button>
        </>
      }
    >
      <p className="mt0">
        {who} has been {run.run_state === 'parked' ? 'parked' : 'silent'} for {silentFor(since)}.
        Releasing will:
      </p>
      <ul className="releaselist">
        <li>
          mark run <span className="mono">{run.run_id}</span> as <b>interrupted</b>, not finished
        </li>
        <li>keep its checklist, log and partial work on the ticket</li>
        <li>move {itemId} back to Ready so another agent can claim it</li>
      </ul>
      <div className="src">
        If {run.client} comes back, it gets a conflict response with the current state.
      </div>
    </Dialog>
  );
}
