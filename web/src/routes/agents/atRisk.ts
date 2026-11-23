import type { AtRiskOwner, WorkspaceRow } from '@docket/shared';
import { plural } from '../../lib/format';

/**
 * The words for at-risk worktrees (B56; UI_SPEC §6.1, §6.6): what needs the
 * owner and what doesn't. The owner of each comes from the server's Problems
 * routing. It says so when that can't be told, and never suggests deleting.
 */
export type AtRiskTone = 'ok' | 'info' | 'warn';

export interface AtRiskSummary {
  tone: AtRiskTone;
  text: string;
  count: number;
}

/** The Workspaces table's "What to do" for each owner. */
export const AT_RISK_NEXT: Record<AtRiskOwner, string> = {
  you: 'Needs your choice.',
  agents: 'Nothing for you: an agent owns it.',
  kept: 'Nothing for you: you kept it for later.',
  acknowledged: 'Nothing for you: you acknowledged it.',
  unknown: 'Docket can’t tell who owns it. Ask your coordinator to check it.',
};

const ownerOf = (row: WorkspaceRow): AtRiskOwner => row.at_risk_owner ?? 'unknown';

/** Uncommitted or unpushed. Other at-risk worktrees hold interrupted or still-running work. */
const holdsUnsaved = (row: WorkspaceRow) => row.dirty === true || (row.unpushed_commits ?? 0) > 0;

/** "a, b, and c". */
function listWords(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`;
}

const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;

/** Null with nothing at risk. */
export function atRiskSummary(rows: readonly WorkspaceRow[]): AtRiskSummary | null {
  const risky = rows.filter((r) => r.state === 'at_risk');
  const n = risky.length;
  if (n === 0) return null;
  const count = (owner: AtRiskOwner) => risky.filter((r) => ownerOf(r) === owner).length;
  const you = count('you');
  const agents = count('agents');
  const kept = count('kept');
  const acknowledged = count('acknowledged');
  const unknown = count('unknown');
  const what = risky.every(holdsUnsaved) ? 'unsaved work' : 'unsaved or unfinished work';
  const head = `${plural(n, 'worktree')} ${n === 1 ? 'holds' : 'hold'} ${what}.`;

  // One worktree reads as "it"; several keep their numbers, so the parts add up to n.
  const one = n === 1;
  const others = [
    agents > 0 ? (one ? 'an agent owns it' : `agents own ${agents}`) : null,
    kept > 0 ? (one ? 'you kept it for later' : `you kept ${kept} for later`) : null,
    acknowledged > 0 ? (one ? 'you acknowledged it' : `you acknowledged ${acknowledged}`) : null,
    unknown > 0
      ? `Docket can’t tell who owns ${one ? 'it' : unknown === n ? 'them' : unknown}`
      : null,
  ].filter((p): p is string => p !== null);

  if (you > 0) {
    const mine = one
      ? 'it needs your choice'
      : `${you} ${you === 1 ? 'needs' : 'need'} your choice`;
    return { tone: 'warn', count: n, text: `${head} ${sentence(listWords([mine, ...others]))}` };
  }
  if (unknown > 0) {
    return { tone: 'info', count: n, text: `${head} ${sentence(listWords(others))}` };
  }
  const none = one ? 'It doesn’t need you' : 'None need you';
  return { tone: 'ok', count: n, text: `${head} ${none}: ${listWords(others)}.` };
}
