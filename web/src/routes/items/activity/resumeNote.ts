import type { Item, Run, WaitingOn } from '@tasklite/shared';
import { parkedReason } from '../../../components/kit/Badges';

/** "waiting on RCP-12" for a parked run (UI_SPEC §5; the kit's `parkedReason`). */
export function parkedDetail(parked: { waiting_on: WaitingOn }) {
  return parkedReason(parked.waiting_on);
}

/** A short SHA matches its long form. */
const sameSha = (a: string, b: string) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
};

/**
 * How many reported commits are not on the remote: 0 when the head is
 * pushed, the commits reported after the pushed one otherwise (at least 1),
 * null when no head was reported. `commits` is newest first (`Item.commits`).
 */
export function unpushedCommits(
  run: Pick<Run, 'workspace'>,
  commits: Item['commits'],
): number | null {
  const head = run.workspace?.head_sha;
  if (!head) return null;
  const pushed = run.workspace?.pushed_sha;
  if (pushed && sameSha(head, pushed)) return 0;
  const at = pushed ? commits.findIndex((c) => sameSha(c.sha, pushed)) : commits.length;
  return Math.max(1, at < 0 ? 1 : at);
}

/** Work steps done (or skipped) of the current plan, as the restart list counts them. */
export function checklistProgress(item: Pick<Item, 'checklist'>): { done: number; total: number } {
  const work = item.checklist.work;
  return {
    done: work.filter((s) => s.state === 'done' || s.state === 'skipped').length,
    total: work.length,
  };
}

/** Run states that get *Copy resume note* (UI_SPEC §6.3.2). */
export const RESUMABLE_RUN_STATES: readonly Run['run_state'][] = ['interrupted', 'stale', 'parked'];

/**
 * The plain-text block a coordinator re-dispatches from (UI_SPEC §6.3.2):
 *
 * ```text
 * Resume RCP-15: worktree <path> on <branch> @ <pushed_sha>
 * (<n> unpushed commits / uncommitted changes, or "clean"),
 * brief <document link>, checklist <done>/<total>, claim_lead first
 * ```
 */
export function resumeNote(
  item: Pick<Item, 'id' | 'checklist' | 'commits'>,
  run: Pick<Run, 'workspace' | 'brief_document_version_id'>,
  origin: string,
): string {
  const ws = run.workspace;
  const path = ws?.path ?? '(worktree not recorded)';
  const branch = ws?.branch ?? '(branch not recorded)';
  const pushed = ws?.pushed_sha ? ws.pushed_sha.slice(0, 7) : '(nothing pushed)';
  const n = unpushedCommits(run, item.commits);
  const risk = [
    n !== null && n > 0 ? `${n} unpushed ${n === 1 ? 'commit' : 'commits'}` : null,
    ws?.dirty ? 'uncommitted changes' : null,
  ].filter(Boolean);
  const state =
    risk.length > 0
      ? risk.join(' / ')
      : n === 0 && ws?.dirty === false
        ? 'clean'
        : 'push state not reported';
  const dv = run.brief_document_version_id;
  const brief = dv ? `${dv} (${origin}/api/documents/${dv}/content)` : 'not recorded';
  const { done, total } = checklistProgress(item);
  return [
    `Resume ${item.id}: worktree ${path} on ${branch} @ ${pushed}`,
    `(${state}),`,
    `brief ${brief}, checklist ${done}/${total}, claim_lead first`,
  ].join('\n');
}
