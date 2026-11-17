import { Link } from 'react-router';
import type { NeedsYouResponse, RunState as RunStateValue } from '@tasklite/shared';
import { RunState } from '../../components/kit';
import { plural } from '../../lib/format';
import { paths } from '../../lib/paths';
import { HelpLink } from '../../help/HelpLink';

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

/**
 * One line: a count per run state that has any, each a link to Agents → Active
 * now filtered to that state (`/agents?state=…`, B20); "n workspaces at risk"
 * when any are, linking to Agents → Workspaces; then *All runs →*. Empty: "No
 * active runs".
 */
export function AgentsStrip({
  counts,
  atRisk = 0,
}: {
  counts: NeedsYouResponse['agent_counts'];
  /** Workspaces at risk (unpushed or uncommitted work), from `/api/workspaces`. */
  atRisk?: number;
}) {
  const shown = STRIP_STATES.filter((s) => (counts[s] ?? 0) > 0);
  return (
    <nav className="pulse" data-card="agents-strip" aria-label="Agents">
      <b>Agents</b>
      <HelpLink anchor="needs-you.agents-strip" />
      {shown.length === 0 ? (
        <span className="muted">No active runs</span>
      ) : (
        shown.map((s) => (
          <Link
            key={s}
            className="pulselink"
            to={paths.agents({ state: s })}
            data-state={s}
            title={`Show the ${s.replace('_', ' ')} runs on Agents`}
          >
            <RunState state={s} />
            <span className="muted">× {counts[s]}</span>
          </Link>
        ))
      )}
      {atRisk > 0 && (
        <Link
          className="pulselink risk"
          to={paths.agents({ section: 'workspaces' })}
          data-state="workspaces-at-risk"
        >
          {plural(atRisk, 'workspace')} at risk
        </Link>
      )}
      <Link to={paths.agents()} style={{ marginLeft: 'auto' }}>
        All runs →
      </Link>
    </nav>
  );
}
