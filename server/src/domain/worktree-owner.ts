/**
 * Who an at-risk worktree is waiting on (B56; UI_SPEC §6.1, §6.6). Nothing new
 * is stored: this reads the Problems routing (decision 41), so a worktree only
 * "needs you" when its Problem is on Needs you, and the badge never changes.
 */
import type { AtRiskOwner, NeedsYouResponse, Problem } from '@docket/shared';
import { coordinatorOf, type WorkspaceFacts } from './recovery-model.js';

/** The Problems that are about what a worktree still holds. */
const WORKTREE_PROBLEMS: ReadonlySet<Problem['kind']> = new Set([
  'unpushed_work',
  'orphaned_resources',
]);

/** Statuses an agent can still be expected to pick up. */
const IN_PLAY: ReadonlySet<string> = new Set(['ready', 'progress', 'review']);

type Routed = Pick<NeedsYouResponse, 'problems' | 'agent_problems' | 'acknowledged'>;

export function atRiskOwner(
  f: WorkspaceFacts,
  view: Routed,
  /** Items with a live lead claim. */
  leading: ReadonlySet<string>,
  statusOf: (itemId: string) => string | undefined,
): AtRiskOwner {
  const runs = new Set(f.runs.map((r) => r.id));
  const about = (list: readonly Problem[] | undefined) =>
    (list ?? []).some(
      (p) => WORKTREE_PROBLEMS.has(p.kind) && p.run_id !== null && runs.has(p.run_id),
    );
  if (about(view.problems)) return 'you';
  if (f.kept) return 'kept';
  if (about(view.acknowledged)) return 'acknowledged';
  if (about(view.agent_problems)) return 'agents';
  // No Problem (yet): the same two owners the routing would pick, while the work is in play.
  const item = f.latest.item_id;
  if (leading.has(item)) return 'agents';
  const inPlay = IN_PLAY.has(statusOf(item) ?? '');
  return inPlay && f.runs.some((r) => coordinatorOf(r)) ? 'agents' : 'unknown';
}
