import { OPEN_RUN_STATES, type ItemDetailResponse, type Run } from '@tasklite/shared';
import { Callout, Chip, EmptyState, RunState, Section, leadName } from '../../../components/kit';
import { formatAge, formatAgo, formatClock, isoTitle } from '../../../lib/format';
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
export function parkedDetail(parked: {
  waiting_on: { items?: string[]; orchestrator?: boolean; person?: boolean };
}) {
  const w = parked.waiting_on;
  if (w.items?.length) return `waiting on ${w.items.join(', ')}`;
  if (w.orchestrator) return 'waiting on the coordinator';
  if (w.person) return 'waiting on a person';
  return undefined;
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
 * UI_SPEC §6.3.2): run rows, each with its "Where the work lives" block.
 * US2 fills the read view; US6 (release, return to Ready) and US11
 * (recovery: resources, resume note) fill the actions.
 */
export function LeadAndRunsSection({ data }: { data: ItemDetailResponse }) {
  const runs = data.item.runs;
  const lead = data.item.lead;
  const conflict = claimConflict(data);
  return (
    <Section
      sectionKey="runs"
      title="Lead and runs"
      summary={lead ? `${leadName(lead)} · ${lead.run_state.replace('_', ' ')}` : 'unclaimed'}
    >
      {conflict && (
        <Callout tone="warn" className="mb">
          {conflict.summary}
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
            {r.is_lead && r.run_state === 'stale' && r.lease_expires_at && (
              <div className="src">
                The lease expires on its own at{' '}
                <span title={isoTitle(r.lease_expires_at)}>{formatClock(r.lease_expires_at)}</span>.
              </div>
            )}
            <WhereTheWorkLives run={r} />
          </div>
        ))
      )}
    </Section>
  );
}
