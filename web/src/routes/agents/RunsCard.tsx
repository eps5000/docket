import { Link, useNavigate } from 'react-router';
import type { AgentRow, RunState as RunStateValue } from '@docket/shared';
import { Chip, EmptyState, Provenance, RunLine, Section, leadReason } from '../../components/kit';
import { formatAgo, formatClock, isoTitle } from '../../lib/format';
import { paths } from '../../lib/paths';
import { HelpLink } from '../../help/HelpLink';

/**
 * Active now, in this order (B20; UI_SPEC §6.6): what needs you first, then
 * what may be in trouble, then what's waiting on purpose, then what's working.
 */
export const ACTIVE_STATES: readonly RunStateValue[] = [
  'needs_input',
  'failed',
  'stale',
  'parked',
  'live',
  'reported',
];

/** Recent: runs that ended normally or were interrupted, in the last 24 h. */
export const RECENT_STATES: readonly RunStateValue[] = ['finished', 'interrupted'];
export const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** `?state=parked` on `/agents`, when it names an active state (the Needs you strip links). */
export function stateFilter(value: string | null): RunStateValue | null {
  return value && (ACTIVE_STATES as readonly string[]).includes(value)
    ? (value as RunStateValue)
    : null;
}

/** Active now: the active run rows, in ACTIVE_STATES order, newest signal first within a state. */
export function activeRows(rows: readonly AgentRow[], only?: RunStateValue | null): AgentRow[] {
  const rank = (r: AgentRow) => ACTIVE_STATES.indexOf(r.run_state!);
  return rows
    .filter((r) => r.row_kind === 'run' && r.run_state && ACTIVE_STATES.includes(r.run_state))
    .filter((r) => !only || r.run_state === only)
    .sort((a, b) => rank(a) - rank(b) || b.at.localeCompare(a.at));
}

/**
 * Recent: finished and interrupted runs from the last 24 h, newest first.
 * Subagent log entries aren't runs; they show on their item's Checklist.
 */
export function recentRows(rows: readonly AgentRow[], now: Date = new Date()): AgentRow[] {
  return rows
    .filter(
      (r) =>
        r.row_kind === 'run' &&
        r.run_state &&
        RECENT_STATES.includes(r.run_state) &&
        now.getTime() - new Date(r.at).getTime() < RECENT_WINDOW_MS,
    )
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** "How we know" (UI_SPEC §6.6). */
function HowWeKnow({ row }: { row: AgentRow }) {
  if (row.run_state === 'live') return <span className="src">Client heartbeat</span>;
  if (row.run_state === 'stale') return <Chip kind="neutral">Unknown: no heartbeat</Chip>;
  if (row.provenance === 'agent')
    return <Provenance kind="agent" label="Agent-reported · no heartbeat" />;
  if (row.provenance && row.provenance !== 'ci') return <Provenance kind={row.provenance} />;
  return <span className="src">Client heartbeat</span>;
}

/** The Lease column: "Until 12:02", "Expires 11:13", "Paused", "Released", "—" (UI_SPEC §6.6). */
export function leaseText(row: Pick<AgentRow, 'lease' | 'lease_expires_at'>): string {
  const at = row.lease_expires_at ? formatClock(row.lease_expires_at) : null;
  switch (row.lease) {
    case 'held':
      return at ? `Until ${at}` : 'Held';
    case 'expired':
      return at ? `Expires ${at}` : 'Expired';
    case 'paused':
      return 'Paused';
    case 'released':
      return 'Released';
    default:
      return '—';
  }
}

/**
 * The runs table: State, Agent, Item, Doing / did, Last signal, Lease, How
 * we know (UI_SPEC §6.6). The State cell is the run-state line (`state ·
 * reason`; the agent has its own column). Rows link to the item.
 */
export function RunsTable({ rows, label }: { rows: readonly AgentRow[]; label: string }) {
  const navigate = useNavigate();
  return (
    <div className="tablewrap">
      <table aria-label={label}>
        <thead>
          <tr>
            <th scope="col">State</th>
            <th scope="col">Agent</th>
            <th scope="col">Item</th>
            <th scope="col">Doing / did</th>
            <th scope="col">Last signal</th>
            <th scope="col">Lease</th>
            <th scope="col">How we know</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={r.run_id ?? `row-${i}`}
              className="clickrow"
              data-row={r.run_id ?? `row-${i}`}
              data-state={r.run_state ?? undefined}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest('a')) return;
                navigate(paths.item(r.item_id));
              }}
            >
              <td>
                {r.run_state && <RunLine state={r.run_state} reason={leadReason(r.lead_parked)} />}
              </td>
              <td className="nowrap">
                <b>{r.label ? `${r.client} · ${r.label}` : r.client}</b>
              </td>
              <td>
                <Link className="mono" to={paths.item(r.item_id)}>
                  {r.item_id}
                </Link>
              </td>
              <td>{r.doing}</td>
              <td className="muted" title={isoTitle(r.last_signal_at ?? r.at)}>
                {formatAgo(r.last_signal_at ?? r.at)}
              </td>
              <td className="src">{leaseText(r)}</td>
              <td>
                <HowWeKnow row={r} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Active now (B20): needs input, failed, stale, parked, live, reported. With
 * `?state=` (the Needs you strip's links) only that state, with *Show all*.
 * Empty: "No runs yet. Connect an agent from Settings." when nothing has ever
 * run, else "No active runs."
 */
export function ActiveRunsSection({
  rows,
  only,
}: {
  rows: readonly AgentRow[];
  only: RunStateValue | null;
}) {
  const active = activeRows(rows, only);
  const anyRuns = rows.some((r) => r.row_kind === 'run');
  const label = only ? only.replace('_', ' ') : null;
  return (
    <Section
      sectionKey="agents-active"
      title="Active now"
      summary={label ? `${active.length} ${label}` : String(active.length)}
      extraHead={
        <>
          {only && (
            <Link to={paths.agents()} className="btn sm ghost" data-filter={only}>
              Show all
            </Link>
          )}
          <HelpLink anchor="agents.active-now" />
        </>
      }
    >
      {active.length > 0 ? (
        <RunsTable rows={active} label={label ? `Active runs: ${label}` : 'Active runs'} />
      ) : (
        <EmptyState
          text={
            !anyRuns
              ? 'No runs yet. Connect an agent from Settings.'
              : label
                ? `No ${label} runs right now.`
                : 'No active runs.'
          }
        />
      )}
    </Section>
  );
}

/** Recent (B20): finished and interrupted runs from the last 24 h, collapsed by default. */
export function RecentRunsSection({ rows }: { rows: readonly AgentRow[] }) {
  const recent = recentRows(rows);
  return (
    <Section
      sectionKey="agents-recent"
      title="Recent"
      summary={`${recent.length} in the last 24 h`}
      defaultCollapsed
      extraHead={<HelpLink anchor="agents.recent" />}
    >
      {recent.length > 0 ? (
        <RunsTable rows={recent} label="Recent runs" />
      ) : (
        <EmptyState text="No runs ended in the last 24 h." />
      )}
    </Section>
  );
}
