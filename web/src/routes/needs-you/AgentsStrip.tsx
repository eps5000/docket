import { Link } from 'react-router';
import type { NeedsYouResponse, RunState as RunStateValue } from '@tasklite/shared';
import { RunState } from '../../components/kit';
import { paths } from '../../lib/paths';

/**
 * The states the strip counts, in order (UI_SPEC §6.1), plus parked (US11):
 * a worker waiting on purpose is never hidden, so it can't be mistaken for
 * one that finished.
 */
export const STRIP_STATES: readonly RunStateValue[] = [
  'live',
  'reported',
  'needs_input',
  'parked',
  'stale',
  'failed',
];

/** One line: a count per run state that has any, plus *All runs →*. Empty: "No active runs". */
export function AgentsStrip({ counts }: { counts: NeedsYouResponse['agent_counts'] }) {
  const shown = STRIP_STATES.filter((s) => (counts[s] ?? 0) > 0);
  return (
    <div className="pulse" data-card="agents-strip">
      <b>Agents</b>
      {shown.length === 0 ? (
        <span className="muted">No active runs</span>
      ) : (
        shown.map((s) => (
          <span key={s} className="row" style={{ gap: 4 }}>
            <RunState state={s} />
            <span className="muted">× {counts[s]}</span>
          </span>
        ))
      )}
      <Link to={paths.agents()} style={{ marginLeft: 'auto' }}>
        All runs →
      </Link>
    </div>
  );
}
