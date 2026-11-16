import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import type { AgentRow } from '@tasklite/shared';
import { Card, Chip, EmptyState, Provenance, RunState, Skeleton } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { QueryState } from '../../app/QueryState';
import { useShell } from '../../app/ShellState';
import { queryKeys } from '../../lib/api';
import { formatAgo, formatClock, isoTitle } from '../../lib/format';
import { paths } from '../../lib/paths';

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
 * we know. Rows link to the item. Empty: "No runs yet. Connect an agent from
 * Settings." The server sorts: needs input, stale, failed, live, reported,
 * then the rest by recency.
 */
export function RunsCard() {
  const { scope } = useShell();
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: queryKeys.agents({ scope }),
    queryFn: () => apiClient['agents.list']({ query: { scope } }),
  });
  return (
    <Card style={{ overflow: 'auto' }} data-card="runs">
      <QueryState
        query={query}
        skeleton={
          <div className="pad">
            <Skeleton lines={5} label="Loading runs" />
          </div>
        }
      >
        {(d) =>
          d.rows.length === 0 ? (
            <div className="pad">
              <EmptyState text="No runs yet. Connect an agent from Settings." />
            </div>
          ) : (
            <table>
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
                {d.rows.map((r, i) => (
                  <tr
                    key={r.run_id ? `${r.row_kind}:${r.run_id}` : `log-${i}`}
                    className="clickrow"
                    data-row={r.run_id ?? `log-${i}`}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest('a')) return;
                      navigate(paths.item(r.item_id));
                    }}
                  >
                    <td>
                      {r.run_state ? (
                        <RunState state={r.run_state} />
                      ) : (
                        <span className="src">log entry</span>
                      )}
                    </td>
                    <td>
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
          )
        }
      </QueryState>
    </Card>
  );
}
