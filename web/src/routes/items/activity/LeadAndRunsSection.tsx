import { useState } from 'react';
import type { ItemDetailResponse, Run } from '@tasklite/shared';
import {
  Button,
  Callout,
  Chip,
  EmptyState,
  RunLine,
  Section,
  leadName,
} from '../../../components/kit';
import { apiClient } from '../../../app/queryClient';
import { formatAge, formatAgo, formatClock, isoTitle } from '../../../lib/format';
import { useSteer } from '../../shared/steer';
import { canReleaseLead, currentStep, useReleaseLead } from './leadActions';
import { parkedDetail } from './resumeNote';
import { WhereTheWorkLives } from './WhereTheWorkLives';

/** "waiting on RCP-12" for a parked run (UI_SPEC §5). */
export { parkedDetail } from './resumeNote';
export { silentFor } from './leadActions';

/** "Working on: …", from the step the run is on. */
function working(data: ItemDetailResponse, run: Run): string | null {
  const step = currentStep(data, run);
  return step ? `Working on: ${step.text}` : null;
}

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
 * UI_SPEC §6.3.2): the full run history, each run with its "Where the work
 * lives" block. Each run's first line is the one run-state line (`state ·
 * reason · agent`, B20), the same as the agent bar above the tabs. US2 fills
 * the read view and US11 the recovery actions (resources, resume note). US6
 * adds the claim-conflict callout, *Release lead claim…* on a stale or parked
 * lead (a destructive dialog whose focus starts on Cancel; Undo in the toast),
 * and *Return to Ready* after a failed run. The agent bar shares these actions
 * (leadActions.tsx).
 */
export function LeadAndRunsSection({ data }: { data: ItemDetailResponse }) {
  const item = data.item;
  const runs = item.runs;
  const lead = item.lead;
  const conflict = claimConflict(data);
  const steer = useSteer(item.id);
  const release = useReleaseLead(data);
  const [busy, setBusy] = useState(false);
  // The newest lead run: *Return to Ready* sits under it when it failed and nobody leads now.
  const lastLead = runs
    .filter((r) => r.is_lead)
    .sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
  const canReturn =
    !lead && item.status === 'progress' && lastLead?.run_state === 'failed' ? lastLead : null;

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
              <RunLine
                state={r.run_state}
                reason={r.parked ? parkedDetail(r.parked) : undefined}
                agent={leadName(r)}
                age={formatAge(r.last_signal_at)}
                ageTitle={`Last signal ${isoTitle(r.last_signal_at)}`}
              />
              {r.is_lead && <Chip kind="neutral">lead</Chip>}
              <span className="src" title={isoTitle(r.started_at)}>
                started {formatAgo(r.started_at)}
              </span>
            </div>
            {(r.summary || working(data, r)) && (
              <div className="src">{r.summary ?? working(data, r)}</div>
            )}
            {r.error && <pre className="err">{r.error}</pre>}
            {canReleaseLead(data, r) && (
              <div className="leadact">
                <div className="row wrap">
                  <Button size="sm" disabled={release.busy} onClick={() => release.request(r)}>
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
      {release.dialog}
    </Section>
  );
}
