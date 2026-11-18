import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import type { WorkspaceRow, WorkspaceState } from '@docket/shared';
import {
  EmptyState,
  FilterChip,
  IconButton,
  Section,
  Skeleton,
  WorkspaceStateChip,
} from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { QueryState } from '../../app/QueryState';
import { useShell } from '../../app/ShellState';
import { queryKeys } from '../../lib/api';
import { formatAge, middleTruncate } from '../../lib/format';
import { paths } from '../../lib/paths';
import { copyText } from '../items/activity/copy';
import { HelpLink } from '../../help/HelpLink';

/** Sort order: At risk, In use, Parked, Unknown, Safe to prune (UI_SPEC §6.6). */
export const WORKSPACE_ORDER: readonly WorkspaceState[] = [
  'at_risk',
  'in_use',
  'parked',
  'unknown',
  'safe_to_prune',
];

export function sortWorkspaces(rows: readonly WorkspaceRow[], hideSafe: boolean): WorkspaceRow[] {
  return rows
    .filter((r) => !hideSafe || r.state !== 'safe_to_prune')
    .sort((a, b) => WORKSPACE_ORDER.indexOf(a.state) - WORKSPACE_ORDER.indexOf(b.state));
}

/** The workspaces query, shared by Agents and the Needs you strip ("n workspaces at risk"). */
export function useWorkspaces() {
  const { scope } = useShell();
  return useQuery({
    queryKey: queryKeys.workspaces({ scope }),
    queryFn: () => apiClient['workspaces.list']({ query: { scope } }),
  });
}

/**
 * Workspaces (owner decision 26; UI_SPEC §6.6): every recorded worktree, so
 * you and a coordinator can see what's safe to prune. Second on Agents
 * (B20), its header says "n at risk"; `/agents#workspaces` lands here. "Hide
 * safe to prune" is on by default. Reads `GET /api/workspaces` (US11): the
 * state is derived from what agents reported, never from the host.
 */
export function WorkspacesCard() {
  const [hideSafe, setHideSafe] = useState(true);
  const query = useWorkspaces();
  const atRisk = query.data?.rows.filter((r) => r.state === 'at_risk').length;
  return (
    <Section
      sectionKey="agents-workspaces"
      id="workspaces"
      title="Workspaces"
      summary={atRisk === undefined ? undefined : `${atRisk} at risk`}
      extraHead={
        <>
          <FilterChip
            label="Hide safe to prune"
            pressed={hideSafe}
            onClick={() => setHideSafe(!hideSafe)}
          />
          <HelpLink anchor="agents.workspaces" />
        </>
      }
    >
      <QueryState
        query={query}
        skeleton={
          <div className="pad">
            <Skeleton lines={3} label="Loading workspaces" />
          </div>
        }
      >
        {(d) => {
          const rows = sortWorkspaces(d.rows, hideSafe);
          if (d.rows.length === 0)
            return (
              <EmptyState text="No workspaces recorded yet. Agents report theirs when they claim work." />
            );
          return (
            <div className="tablewrap">
              <table aria-label="Workspaces">
                <thead>
                  <tr>
                    <th scope="col">State</th>
                    <th scope="col">Path</th>
                    <th scope="col">Branch</th>
                    <th scope="col">Item</th>
                    <th scope="col">Last activity</th>
                    <th scope="col">Pushed</th>
                    <th scope="col">Resources</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.path}>
                      <td>
                        <WorkspaceStateChip state={r.state} />
                      </td>
                      <td className="mono" title={r.path}>
                        <span className="row" style={{ gap: 4 }}>
                          {middleTruncate(r.path)}
                          <IconButton
                            icon="copy"
                            bare
                            aria-label={`Copy path ${r.path}`}
                            onClick={() => copyText(r.path, 'the path')}
                          />
                        </span>
                      </td>
                      <td className="mono">{r.branch ?? '—'}</td>
                      <td>
                        <Link className="mono" to={paths.item(r.item_id)}>
                          {r.item_id}
                        </Link>
                      </td>
                      <td className="muted">{formatAge(r.last_activity_at)}</td>
                      <td title={r.pushed_sha ? `pushed ${r.pushed_sha}` : undefined}>
                        {r.unpushed_commits === null
                          ? '—'
                          : r.unpushed_commits === 0
                            ? '✓'
                            : `${r.unpushed_commits} behind`}
                      </td>
                      <td>{r.unreleased_resources}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }}
      </QueryState>
    </Section>
  );
}
