import { useState } from 'react';
import {
  RUN_STATE_LABELS,
  activityText,
  type CoordinatorPark,
  type ItemDetailResponse,
  type RunActivity,
  type WaitCard,
} from '@docket/shared';
import {
  Button,
  Chip,
  RunLine,
  WorkspaceStateChip,
  leadName,
  parkedReason,
} from '../../components/kit';
import { formatAgo, formatClock, formatSince, formatStamp, isoTitle } from '../../lib/format';
import {
  CopyResumeNoteButton,
  canCopyResumeNote,
  canReleaseLead,
  currentStep,
  useReleaseLead,
} from './activity/leadActions';
import { RunInstructionsLine } from './activity/RunInstructions';
import { HelpLink } from '../../help/HelpLink';
import { PROBLEM_TITLES } from '../shared/problems';

/** Decision 44: who parked it and until when, or that their park just ran out. */
function coordinatorParkSentence(park: CoordinatorPark): string {
  return park.ended_at
    ? `Park by ${park.by} ran out at ${formatClock(park.ended_at)}. It has a short lease to call back.`
    : `Parked by ${park.by} until ${formatStamp(park.until)}`;
}

/** Decision 42: "Activity since parked: 2 commits", with what it means when the run is silent. */
function activitySentence(activity: RunActivity): string {
  const text = activityText(activity);
  const line = text.charAt(0).toUpperCase() + text.slice(1);
  return activity.kind === 'since_signal' ? `${line}. Its session may not have Docket.` : line;
}

/** Decision 45: what the parked lead waits for, who moves it, and how the same run resumes. */
function WaitCardLines({ wait }: { wait: WaitCard }) {
  const named = [
    ...wait.blockers.map((b) =>
      b.cleared ? `${b.id} cleared` : `${b.id} (${b.status}, clears when ${b.clears_when})`,
    ),
    wait.more_blockers > 0 ? `${wait.more_blockers} more` : null,
    wait.person ? 'a person' : null,
    wait.coordinator ? 'the coordinator' : null,
    wait.until ? `until ${formatStamp(wait.until)}` : null,
  ].filter(Boolean);
  return (
    <div className="ab-parked src" data-ab="wait">
      <span data-ab="wait-for">Waiting for {named.join(', ') || 'nothing named'}</span>
      <span data-ab="wait-since" title={isoTitle(wait.waited_since)}>
        Waited since {formatSince(wait.waited_since)}
      </span>
      <span data-ab="wait-next">
        Next: {wait.next_owner.name} · {wait.next_owner.step}
      </span>
      <span data-ab="wait-resume">{wait.resumes_when}</span>
      {wait.flags.map((f) => (
        <Chip key={`${f.kind}:${f.on}`} kind="warn">
          {PROBLEM_TITLES[f.kind]}: {f.on}
        </Chip>
      ))}
    </div>
  );
}

/** Decision 45: whoever picks this item up sees which parked runs it frees. */
function WaitingRunsLine({
  waiting,
}: {
  waiting: NonNullable<ItemDetailResponse['waiting_runs']>;
}) {
  return (
    <div className="ab-parked src" data-ab="waiting-runs">
      <span>
        Unblocks{' '}
        {waiting.rows
          .map(
            (x) =>
              `${x.item_id}${x.via ? ` (via ${x.via})` : ''}, waiting since ${formatSince(x.waited_since)}`,
          )
          .join('; ')}
        {waiting.total > waiting.rows.length ? `; ${waiting.total - waiting.rows.length} more` : ''}
      </span>
    </div>
  );
}

/**
 * The agent bar (B20; UI_SPEC §6.3): on every tab, under the title row, the
 * item's lead at a glance: the run-state line (`state · agent`), last signal,
 * the step it's on ("step 2/4"), the worktree's state, and *Release lead
 * claim…* / *Copy resume note* (the same actions as Activity → Lead and runs,
 * from leadActions.tsx). A parked lead adds a line: "Parked: waiting on the
 * coordinator since 10:57", plus "Ready to resume" once it can.
 *
 * With no lead it shows nothing, or a quiet "No agent on this" while the item
 * is In progress. It is a labelled region; it updates in place from the live
 * stream without moving focus, and a polite live region announces only a
 * change of run state (UI_SPEC §7).
 */
export function AgentBar({ data }: { data: ItemDetailResponse }) {
  const item = data.item;
  const lead = item.lead;
  const run = lead ? item.runs.find((r) => r.run_id === lead.run_id) : undefined;
  const release = useReleaseLead(data);

  // Announce a change of run state (not the first render, not ages ticking).
  const key = run ? `${run.run_id}:${run.run_state}` : 'none';
  const [seen, setSeen] = useState(key);
  const [announce, setAnnounce] = useState('');
  if (seen !== key) {
    setSeen(key);
    setAnnounce(
      run
        ? `${leadName(run)} is ${RUN_STATE_LABELS[run.run_state].label} on ${item.id}.`
        : `No agent leads ${item.id} now.`,
    );
  }
  const live = (
    <span className="sr" aria-live="polite">
      {announce}
    </span>
  );

  if (item.type === 'Epic') return null;
  if (!lead || !run) {
    // Decision 45: a blocker nobody leads is exactly where "this frees a parked run" matters.
    const frees = data.waiting_runs ? <WaitingRunsLine waiting={data.waiting_runs} /> : null;
    if (item.status !== 'progress' && !frees) return <div className="agentbar-none">{live}</div>;
    const hold = item.producer_hold;
    return (
      <section className="agentbar quiet" aria-label="Lead agent" data-agent-bar="none">
        {item.status === 'progress' && (
          <span className="src" data-ab="between-workers">
            {hold
              ? `Between workers: ${hold.producer} holds this until ${formatClock(hold.until)}`
              : 'No agent on this'}
          </span>
        )}
        {frees}
        {live}
      </section>
    );
  }

  const step = currentStep(data, run);
  const ws = run.workspace;
  const parked = run.run_state === 'parked' ? run.parked : null;
  const waiting = parked ? parkedReason(parked.waiting_on) : undefined;
  return (
    <section className="agentbar" aria-label="Lead agent" data-agent-bar={run.run_state}>
      <div className="ab-line">
        <RunLine state={run.run_state} agent={leadName(run)} />
        <span className="src" title={isoTitle(run.last_signal_at)} data-ab="signal">
          last signal {formatAgo(run.last_signal_at)}
        </span>
        {step && (
          <span className="src" title={step.text} data-ab="step">
            step {step.n}/{step.total}
          </span>
        )}
        {ws && <WorkspaceStateChip state={ws.state} />}
        <span className="ab-acts">
          {canReleaseLead(data, run) && (
            <Button size="sm" disabled={release.busy} onClick={() => release.request(run)}>
              Release lead claim…
            </Button>
          )}
          {canCopyResumeNote(run) && <CopyResumeNoteButton data={data} run={run} />}
          <HelpLink anchor="item.agent-bar" />
        </span>
      </div>
      <RunInstructionsLine data={data} runId={run.run_id} compact />
      {parked && (
        <div className="ab-parked src" data-ab="parked" title={parked.reason || undefined}>
          <span>
            Parked: {waiting ?? 'waiting'} since{' '}
            <span title={isoTitle(parked.since)}>{formatSince(parked.since)}</span>
          </span>
          {parked.resume_ready && <Chip kind="ok">Ready to resume</Chip>}
        </div>
      )}
      {parked && data.wait && <WaitCardLines wait={data.wait} />}
      {data.waiting_runs && <WaitingRunsLine waiting={data.waiting_runs} />}
      {(run.producer || run.status_update || run.coordinator_park || run.activity) && (
        <div className="ab-parked src" data-ab="status">
          {run.producer && <span data-ab="producer">Producer {run.producer}</span>}
          {run.coordinator_park ? (
            <span data-ab="coordinator-park" title={isoTitle(run.coordinator_park.until)}>
              {coordinatorParkSentence(run.coordinator_park)}
            </span>
          ) : (
            run.status_update && (
              <span data-ab="updated-by" title={isoTitle(run.status_update.at)}>
                Status updated by {run.status_update.by}
              </span>
            )
          )}
          {run.activity && (
            <span data-ab="activity" title={`Since ${isoTitle(run.activity.since)}`}>
              {activitySentence(run.activity)}
            </span>
          )}
        </div>
      )}
      {live}
      {release.dialog}
    </section>
  );
}
