import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
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
import { AT_RISK_NEXT } from './atRisk';
import { WorktreeCleanup } from './WorktreeCleanup';

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

/** What the at-risk row needs, if anything (B56). Only "you" links to an action. */
function AtRiskNext({ row }: { row: WorkspaceRow }) {
  if (row.state !== 'at_risk') return <span className="muted">—</span>;
  const owner = row.at_risk_owner ?? 'unknown';
  return (
    <span data-at-risk-owner={owner}>
      {AT_RISK_NEXT[owner]}
      {owner === 'you' && (
        <>
          {' '}
          <Link to={`${paths.overview()}#problems`}>
            See Problems<span className="sr"> for {row.item_id}</span>
          </Link>
        </>
      )}
    </span>
  );
}

/** The workspaces query, shared by Agents and Overview's Health line. */
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
  const [params, setParams] = useSearchParams();
  // Decision 48: every worktree of the repository, not only the ones agents recorded.
  const everyWorktree = params.get('worktrees') === 'all';
  const showEvery = (on: boolean) => {
    const next = new URLSearchParams(params);
    if (on) next.set('worktrees', 'all');
    else next.delete('worktrees');
    setParams(next, { replace: true, preventScrollReset: true });
  };
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
          <div className="seg" role="group" aria-label="Which worktrees to show">
            <button type="button" aria-pressed={!everyWorktree} onClick={() => showEvery(false)}>
              Recorded by agents
            </button>
            <button type="button" aria-pressed={everyWorktree} onClick={() => showEvery(true)}>
              Every worktree
            </button>
          </div>
          {!everyWorktree && (
            <FilterChip
              label="Hide safe to prune"
              pressed={hideSafe}
              onClick={() => setHideSafe(!hideSafe)}
            />
          )}
          <HelpLink anchor="agents.workspaces" />
        </>
      }
    >
      {everyWorktree ? (
        <WorktreeCleanup />
      ) : (
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
              <>
                {d.rows.some((r) => r.state === 'at_risk') && (
                  <p className="src ws-risk-note" data-at-risk-note>
                    <b>At risk</b> means nothing is running in the worktree, but work could still be
                    lost: uncommitted changes, commits that aren’t pushed, something left running,
                    or a run that ended unexpectedly. Leave the worktree in place until that’s dealt
                    with. <b>What to do</b> says whether it needs you.
                  </p>
                )}
                <div className="tablewrap">
                  <table aria-label="Workspaces">
                    <thead>
                      <tr>
                        <th scope="col">State</th>
                        <th scope="col">What to do</th>
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
                          <td className="ws-next">
                            <AtRiskNext row={r} />
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
              </>
            );
          }}
        </QueryState>
      )}
    </Section>
  );
}
