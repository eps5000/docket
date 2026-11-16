import type { ItemDetailResponse } from '@tasklite/shared';
import { Chip, EmptyState, RunState, Section, leadName } from '../../../components/kit';
import { WhereTheWorkLives } from './WhereTheWorkLives';

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
 * Lead and runs (summary "codex · orca-w1 · stale" or "unclaimed";
 * UI_SPEC §6.3.2): run rows, each with its "Where the work lives" block.
 * US2 fills the read view; US6 (release, return to Ready) and US11
 * (recovery: resources, resume note) fill the actions.
 */
export function LeadAndRunsSection({ data }: { data: ItemDetailResponse }) {
  const runs = data.item.runs;
  const lead = data.item.lead;
  return (
    <Section
      sectionKey="runs"
      title="Lead and runs"
      summary={lead ? `${leadName(lead)} · ${lead.run_state.replace('_', ' ')}` : 'unclaimed'}
    >
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
              />
            </div>
            {r.summary && <div className="src">{r.summary}</div>}
            {r.error && <div className="err">{r.error}</div>}
            <WhereTheWorkLives run={r} />
          </div>
        ))
      )}
    </Section>
  );
}
