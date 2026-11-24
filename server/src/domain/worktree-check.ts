/**
 * What is really left in a worktree (owner decision 41; BUILD_SPEC §5.16).
 *
 * "Unpushed work" used to repeat what the agent last reported, so a commit
 * already on main could still read "1 commit not pushed". This check uses what
 * git says, as read by the helper on the host (B76; Docket runs no git):
 *
 * - the worktrees source (B68) counts a listed worktree's uncommitted files and
 *   its commits on no remote, and says whether its head is on main;
 * - the git source checks each ended run's commit (`headRequest`): on main, on
 *   a remote, and how many commits are on neither, even when its worktree is
 *   gone.
 *
 * It runs with the radar, never on a read, and the result is stored on the run
 * as bookkeeping (`runs.worktree_check`, no event). Without fresh facts (no
 * repository, the helper hasn't reported, or its facts are stale) it clears the
 * check, so the Problem says its state is unverified and gives the last
 * reported one. A commit the helper's pass didn't reach leaves the stored check
 * as it was.
 */
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { RunRow } from './model.js';
import { freshHostGit } from './host-git.js';
import { hostChecks, hostFactsFor, isFresh } from './host-worktrees.js';
import {
  storedWorkspace,
  treeKey,
  unpushedRisks,
  type StoredWorkspace,
  type WorktreeCheck,
} from './recovery-model.js';

export { treeKey };

const SHORT_SHA = /^[0-9a-f]{7,64}$/i;

/** The ended runs of a project that left work behind and are still unhandled. */
function risksOf(db: Db, project: string) {
  const runs = db.sqlite
    .prepare(
      `SELECT r.* FROM runs r JOIN items i ON i.id = r.item_id
       WHERE i.project_key = ? AND r.state IN ('finished', 'failed', 'interrupted')
         AND r.workspace IS NOT NULL AND r.unpushed_handled_at IS NULL`,
    )
    .all(project) as RunRow[];
  return unpushedRisks(db, runs);
}

const projectRow = (db: Db, project: string) =>
  db.sqlite
    .prepare('SELECT repo_path, main_branch FROM projects WHERE key = ? AND deleted_at IS NULL')
    .get(project) as { repo_path: string | null; main_branch: string } | undefined;

/** Each fresh worktree's head from the worktrees source, by `treeKey`. */
function treeHeads(
  db: Db,
  project: string,
  p: { repo_path: string; main_branch: string },
  now: string,
): Map<string, string> {
  const out = new Map<string, string>();
  const nowMs = Date.parse(now);
  for (const t of hostFactsFor(db, { key: project, ...p })?.trees ?? []) {
    if (t.head && isFresh(t.checked_at, nowMs)) out.set(treeKey(t.path), t.head);
  }
  return out;
}

/** The commit to check for a run: its worktree's head now, else the one it reported. */
function headOf(ws: StoredWorkspace | null, heads: ReadonlyMap<string, string>): string | null {
  const head = (ws?.path ? heads.get(treeKey(ws.path)) : undefined) ?? ws?.head_sha ?? null;
  return head && SHORT_SHA.test(head) ? head.toLowerCase() : null;
}

/** B76: the commits the helper on the host checks for this project's ended runs. */
export function headRequest(db: Db, project: string, now: string): string[] {
  const p = projectRow(db, project);
  if (!p?.repo_path) return [];
  const risks = risksOf(db, project);
  if (risks.length === 0) return [];
  const heads = treeHeads(db, project, { ...p, repo_path: p.repo_path }, now);
  const out = new Set<string>();
  for (const risk of risks) {
    const head = headOf(storedWorkspace(risk.run), heads);
    if (head) out.add(head);
  }
  return [...out];
}

/**
 * Check the worktrees of a project's ended runs that left work behind, from
 * the helper's facts, and store what git says. Returns how many it confirmed.
 * A run that changed meanwhile isn't written.
 */
export async function checkProjectWorktrees(
  db: Db,
  _config: Config,
  project: string,
  now: string,
  signal?: AbortSignal,
): Promise<number> {
  const risks = risksOf(db, project);
  if (risks.length === 0) return 0;
  const store = db.sqlite.prepare(
    `UPDATE runs SET worktree_check = @check WHERE id = @id AND state = @state
       AND workspace IS @workspace AND unpushed_handled_at IS NULL`,
  );
  const save = (run: RunRow, check: WorktreeCheck | null) =>
    store.run({
      check: check ? JSON.stringify(check) : null,
      id: run.id,
      state: run.state,
      workspace: run.workspace,
    });

  const p = projectRow(db, project);
  if (!p?.repo_path) {
    for (const risk of risks) save(risk.run, null);
    return 0;
  }
  const repo = { ...p, repo_path: p.repo_path };
  const fromHost = hostChecks(db, { key: project, ...repo }, now);
  const git = freshHostGit(db, { key: project, ...repo }, now);
  const heads = treeHeads(db, project, repo, now);
  let read = 0;
  for (const risk of risks) {
    if (signal?.aborted) break;
    const ws = storedWorkspace(risk.run);
    const tree = ws?.path ? fromHost.get(treeKey(ws.path)) : undefined;
    const head = headOf(ws, heads);
    const fact = git && head ? git.heads[head] : undefined;
    let check: WorktreeCheck | null;
    if (tree) {
      // The worktree as the helper read it; whether its commit is on a remote, from the git source.
      const sameHead = fact?.read === 'ok' && fact.head === tree.head_sha.toLowerCase();
      check = { ...tree, on_remote: sameHead ? fact.on_remote : null };
    } else if (!git || !head) {
      check = null;
    } else if (!fact || fact.read === 'unknown') {
      // The helper's pass didn't reach it: leave the stored check as it is.
      continue;
    } else if (fact.read === 'missing' || !fact.head) {
      check = null;
    } else {
      check = {
        checked_at: git.checked_at,
        head_sha: fact.head,
        on_main: fact.on_main === true,
        on_remote: fact.on_remote,
        unpushed_commits: fact.unpushed,
        uncommitted_files: null,
      };
    }
    if (check) read += 1;
    save(risk.run, check);
  }
  return read;
}
