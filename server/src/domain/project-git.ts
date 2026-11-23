/**
 * A project's git settings (owner decision 49): its GitHub repository and the
 * branch naming rule. No row means the defaults. The rule is advisory: it can
 * add a warning, and it never blocks a claim, a status change or a hand-off.
 */
import { DEFAULT_BRANCH_EXEMPT, DEFAULT_BRANCH_RULE, type BranchRule } from '@docket/shared';
import type { Db } from '../db/client.js';
import { branchNamesKey, isExemptBranch, suggestedBranch } from './git-naming.js';

export interface ProjectGit {
  github_repo: string | null;
  branch_rule: BranchRule;
  branch_exempt: string[];
}

export function projectGit(db: Db, key: string): ProjectGit {
  const row = db.sqlite
    .prepare(
      'SELECT github_repo, branch_rule, branch_exempt FROM project_git WHERE project_key = ?',
    )
    .get(key) as
    | { github_repo: string | null; branch_rule: BranchRule; branch_exempt: string | null }
    | undefined;
  let exempt: string[] = [...DEFAULT_BRANCH_EXEMPT];
  if (row?.branch_exempt) {
    try {
      const parsed = JSON.parse(row.branch_exempt) as unknown;
      if (Array.isArray(parsed)) exempt = parsed.filter((p): p is string => typeof p === 'string');
    } catch {
      // A damaged list falls back to the defaults.
    }
  }
  return {
    github_repo: row?.github_repo ?? null,
    branch_rule: row?.branch_rule ?? DEFAULT_BRANCH_RULE,
    branch_exempt: exempt,
  };
}

interface NamedItem {
  id: string;
  project_key: string;
  jira_key?: string | null;
}

/** Whether this branch breaks the project's naming rule for this ticket. */
export function branchLacksKey(git: ProjectGit, item: NamedItem, branch: string): boolean {
  if (git.branch_rule !== 'warn' || isExemptBranch(branch, git.branch_exempt)) return false;
  return !branchNamesKey(branch, [item.id, item.jira_key ?? null]);
}

/** The agent's warning for a reported branch, or null. Short: it costs tokens every time. */
export function branchWarning(db: Db, item: NamedItem & { title: string }, branch: string) {
  const git = projectGit(db, item.project_key);
  if (!branchLacksKey(git, item, branch)) return null;
  return `Branch ${branch} doesn't name ${item.id}. Use ${suggestedBranch(item.id, item.title)}.`;
}

/** What a claim that named no branch is told to use; null when the rule is off. */
export function claimBranchHint(
  db: Db,
  item: NamedItem & { title: string },
  branch: string | null | undefined,
): string | undefined {
  if (branch?.trim()) return undefined;
  if (projectGit(db, item.project_key).branch_rule !== 'warn') return undefined;
  return suggestedBranch(item.id, item.title);
}
