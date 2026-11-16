import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { AgentRow } from '@tasklite/shared';
import { Card, Chip, EmptyState, Provenance, RunState, Skeleton } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { QueryState } from '../../app/QueryState';
import { useShell } from '../../app/ShellState';
import { queryKeys } from '../../lib/api';
import { formatAge } from '../../lib/format';
import { paths } from '../../lib/paths';

/** "How we know" (UI_SPEC §6.6). */
function HowWeKnow({ row }: { row: AgentRow }) {
  if (row.run_state === 'live') return <span className="src">Client heartbeat</span>;
  if (row.run_state === 'stale') return <Chip kind="neutral">Unknown: no heartbeat</Chip>;
  if (row.provenance && row.provenance !== 'ci') return <Provenance kind={row.provenance} />;
  return <span className="src">Client heartbeat</span>;
}

const LEASE: Record<AgentRow['lease'], string> = {
  held: 'Until',
  expired: 'Expires',
  paused: 'Paused',
  released: 'Released',
  none: '—',
};

/**
 * The runs table: State, Agent, Item, Doing / did, Last signal, Lease, How
 * we know. Rows link to the item. Empty: "No runs yet. Connect an agent from
 * Settings." US2 (T084) fills the sort and the lease times.
 */
export function RunsCard() {
  const { scope } = useShell();
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
                  <tr key={r.run_id ?? `log-${i}`}>
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
                    <td className="muted">
                      {r.last_signal_at ? `${formatAge(r.last_signal_at)} ago` : '—'}
                    </td>
                    <td className="src">{LEASE[r.lease]}</td>
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
