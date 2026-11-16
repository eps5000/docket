import { useState } from 'react';
import { OPEN_RUN_STATES, type ItemDetailResponse, type Run } from '@tasklite/shared';
import {
  Button,
  Callout,
  Chip,
  Dialog,
  DialogCancel,
  EmptyState,
  RunState,
  Section,
  leadName,
} from '../../../components/kit';
import { apiClient } from '../../../app/queryClient';
import { formatAge, formatAgo, formatClock, isoTitle, plural } from '../../../lib/format';
import { useSteer } from '../../shared/steer';
import { parkedDetail } from './resumeNote';
import { WhereTheWorkLives } from './WhereTheWorkLives';

/**
 * The step a run is on, "Working on: …": the one its heartbeat named, else,
 * for an open lead, the plan step marked current.
 */
function current(data: ItemDetailResponse, run: Run): string | null {
  const work = data.item.checklist.work;
  const open = (OPEN_RUN_STATES as readonly string[]).includes(run.run_state);
  const step = run.current_step_id
    ? work.find((w) => w.id === run.current_step_id)
    : run.is_lead && open
      ? work.find((w) => w.state === 'current')
      : undefined;
  return step ? `Working on: ${step.text}` : null;
}

/** "waiting on RCP-12" for a parked run (UI_SPEC §5). */
export { parkedDetail } from './resumeNote';

/**
 * The latest rejected claim while the current lead holds the item (UI_SPEC
 * §6.3.2 "Claim conflict"), from the item's activity.
 */
export function claimConflict(data: ItemDetailResponse) {
  const lead = data.item.runs.find((r) => r.is_lead && r.run_id === data.item.lead?.run_id);
  if (!lead) return null;
  return data.activity.find((a) => a.type === 'claim.rejected' && a.at >= lead.started_at) ?? null;
}

/**
 * Lead and runs (summary "codex · orca-w1 · stale" or "unclaimed";
 * UI_SPEC §6.3.2): run rows, each with its "Where the work lives" block.
 * US2 fills the read view and US11 the recovery actions (resources, resume
 * note). US6 adds the claim-conflict callout, *Release lead claim…* on a
 * stale or parked lead (a destructive dialog whose focus starts on Cancel;
 * Undo in the toast), and *Return to Ready* after a failed run.
 */
export function LeadAndRunsSection({ data }: { data: ItemDetailResponse }) {
  const item = data.item;
  const runs = item.runs;
  const lead = item.lead;
  const conflict = claimConflict(data);
  const steer = useSteer(item.id);
  const [releasing, setReleasing] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  // The newest lead run: *Return to Ready* sits under it when it failed and nobody leads now.
  const lastLead = runs
    .filter((r) => r.is_lead)
    .sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
  const canReturn =
    !lead && item.status === 'progress' && lastLead?.run_state === 'failed' ? lastLead : null;

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

  const returnToReady = async () => {
    setBusy(true);
    await steer(
      () =>
        apiClient['items.returnToReady']({
          params: { id: item.id },
          body: { expected_version: item.version },
        }),
      `${item.id} is back in Ready. A connected agent picks it up next.`,
    );
    setBusy(false);
  };

  return (
    <Section
      sectionKey="runs"
      title="Lead and runs"
      summary={lead ? `${leadName(lead)} · ${lead.run_state.replace('_', ' ')}` : 'unclaimed'}
    >
      {conflict && lead && (
        <Callout tone="warn" className="mb">
          {conflict.actor} tried to claim lead at{' '}
          <span title={isoTitle(conflict.at)}>{formatClock(conflict.at)}</span>. Rejected:{' '}
          {leadName(lead)} still holds the lease.
        </Callout>
      )}
      {runs.length === 0 ? (
        <EmptyState text="Unclaimed. The next agent that asks for ready work can claim it." />
      ) : (
        runs.map((r) => (
          <div className="runrow" key={r.run_id} data-run={r.run_id}>
            <div className="row wrap">
              <b>{leadName(r)}</b>
              {r.is_lead && <Chip kind="neutral">lead</Chip>}
              <RunState
                state={r.run_state}
                detail={r.parked ? parkedDetail(r.parked) : undefined}
                age={formatAge(r.last_signal_at)}
              />
              <span className="src" title={isoTitle(r.started_at)}>
                started {formatAgo(r.started_at)}
              </span>
            </div>
            {(r.summary || current(data, r)) && (
              <div className="src">{r.summary ?? current(data, r)}</div>
            )}
            {r.error && <pre className="err">{r.error}</pre>}
            {r.is_lead &&
              r.run_id === lead?.run_id &&
              (r.run_state === 'stale' || r.run_state === 'parked') && (
                <div className="leadact">
                  <div className="row wrap">
                    <Button size="sm" onClick={() => setReleasing(r)}>
                      Release lead claim…
                    </Button>
                  </div>
                  {r.run_state === 'stale' && r.lease_expires_at && (
                    <div className="src">
                      Or wait: the lease expires on its own at{' '}
                      <span title={isoTitle(r.lease_expires_at)}>
                        {formatClock(r.lease_expires_at)}
                      </span>
                      .
                    </div>
                  )}
                </div>
              )}
            {canReturn?.run_id === r.run_id && (
              <div className="leadact">
                <div className="row wrap">
                  <Button size="sm" disabled={busy} onClick={() => void returnToReady()}>
                    Return to Ready
                  </Button>
                </div>
                <div className="src">
                  This service never launches agents. A connected agent picks it up next.
                </div>
              </div>
            )}
            <WhereTheWorkLives run={r} data={data} />
          </div>
        ))
      )}
      {releasing && (
        <ReleaseDialog
          itemId={item.id}
          run={releasing}
          busy={busy}
          onCancel={() => setReleasing(null)}
          onConfirm={() => void release(releasing)}
        />
      )}
    </Section>
  );
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
