/**
 * The worktree cleanup view (owner decision 48; BUILD_SPEC §5.32; UI_SPEC
 * §6.6): every worktree of a project's repository, with a plain verdict.
 *
 * **Docket never deletes or prunes a worktree, and runs no git (B76).** The
 * helper on the host reads every worktree read-only (B68,
 * `tools/docket-sync/sources/worktrees.mjs`) and posts the facts
 * (host-worktrees.ts). For a *Safe to remove* row this offers a command for the
 * owner to check and run, without `--force`, so git itself still refuses a
 * worktree that changed since.
 *
 * The verdict is worked out on every read from the helper's last scan and the
 * live runs, so a run that starts is *In use* at once. A read with no answer,
 * or facts too old to rely on, is *Unknown*, and *Unknown* is never safe.
 */
import type { WorktreeVerdict } from '@docket/shared';
import { FACTS_FRESH_MS } from './host-worktrees.js';
import type { WorkspaceFacts } from './recovery-model.js';

export const cleanupLimits = {
  /** Older git facts no longer count as known. */
  freshMs: FACTS_FRESH_MS,
  /** Something Docket has no run for may still be in use if it changed this recently. */
  untrackedQuietMs: 24 * 3_600_000,
};

/** `stale` (B68): the host helper's facts for it are too old to use. */
export type TreeRead = 'ok' | 'outside' | 'missing' | 'timed_out' | 'unreadable' | 'stale';

export interface ScannedTree {
  path: string;
  branch: string | null;
  head: string | null;
  is_main: boolean;
  locked: boolean;
  read: TreeRead;
  uncommitted_files: number | null;
  unpushed_commits: number | null;
  merged: boolean | null;
  /** The latest of the head commit and the worktree's own git activity. */
  last_git_at: string | null;
}

// ---- The verdict ----

/** Paths a single-quoted argument carries unchanged in both bash and PowerShell. */
const PLAIN_PATH = /^(?:[A-Za-z]:)?[\\/][A-Za-z0-9 _.,@+~\\/-]*$/;

/**
 * The command for a *Safe to remove* row, for the owner to check and run.
 * Never `--force`. Null when a path has characters a shell might act on.
 */
export function removeCommand(mainPath: string | null, path: string): string | null {
  if (!mainPath || !PLAIN_PATH.test(mainPath) || !PLAIN_PATH.test(path)) return null;
  return `git -C '${mainPath}' worktree remove '${path}'`;
}

const files = (n: number) => `${n} uncommitted ${n === 1 ? 'file' : 'files'}`;
const commits = (n: number) => `${n} ${n === 1 ? 'commit' : 'commits'} not on a remote`;

const UNREAD: Record<Exclude<TreeRead, 'ok'>, string> = {
  outside: 'It’s outside the folder Docket can read, so it can’t be checked.',
  missing: 'Git lists it, but its folder isn’t there, so it can’t be checked.',
  timed_out: 'Git didn’t answer in time, so it can’t be told what this holds.',
  unreadable: 'Docket couldn’t read it, so it can’t be told what this holds.',
  stale: 'The helper’s last check is too old to rely on.',
};

export interface VerdictInput {
  tree: ScannedTree;
  /** Docket's runs in this worktree; null when it has none. */
  facts: WorkspaceFacts | null;
  /** A run here ended unexpectedly and its work hasn't been picked up. */
  awaitsRestart: boolean;
  /** When the git facts were read. */
  checkedAt: string;
  now: string;
}

/**
 * One worktree's verdict. What Docket knows is running comes first, because it
 * holds even when git can't be read; anything git couldn't answer is Unknown.
 */
export function worktreeVerdict(input: VerdictInput): { verdict: WorktreeVerdict; why: string } {
  const { tree, facts, now } = input;
  if (facts?.state === 'in_use') return { verdict: 'in_use', why: 'A run is working here.' };
  if (facts?.state === 'parked') {
    return { verdict: 'in_use', why: 'Its run is parked and will come back to it.' };
  }
  if (tree.is_main) {
    return { verdict: 'in_use', why: 'This is the repository’s main folder.' };
  }
  if (facts?.kept) return { verdict: 'kept_for_later', why: 'You chose to keep this for later.' };
  if (tree.locked) {
    return { verdict: 'kept_for_later', why: 'It’s locked in git, so someone wants it kept.' };
  }
  if (tree.read !== 'ok') return { verdict: 'unknown', why: UNREAD[tree.read] };
  if (Date.parse(now) - Date.parse(input.checkedAt) > cleanupLimits.freshMs) {
    return { verdict: 'unknown', why: 'The last check is too old to rely on.' };
  }
  const { uncommitted_files: dirty, unpushed_commits: ahead, merged } = tree;
  if (dirty === null || ahead === null || merged === null) {
    return { verdict: 'unknown', why: UNREAD.timed_out };
  }
  if (dirty > 0 || ahead > 0) {
    const held = [dirty > 0 ? files(dirty) : null, ahead > 0 ? commits(ahead) : null]
      .filter(Boolean)
      .join(' and ');
    return {
      verdict: 'holds_work',
      why: facts?.handled
        ? `You marked this safe to discard, but it still has ${held}.`
        : `It has ${held}.`,
    };
  }
  if (facts && facts.unreleased.length > 0) {
    return { verdict: 'holds_work', why: 'Something its run started is still listed as running.' };
  }
  if (input.awaitsRestart) {
    return {
      verdict: 'holds_work',
      why: 'Its run ended unexpectedly, and the work hasn’t been picked up again.',
    };
  }
  if (!facts) {
    const quiet =
      tree.last_git_at !== null &&
      Date.parse(now) - Date.parse(tree.last_git_at) >= cleanupLimits.untrackedQuietMs;
    if (!quiet) {
      return {
        verdict: 'unknown',
        why: 'It changed in the last day and Docket has no run for it, so something may be using it.',
      };
    }
  }
  return {
    verdict: 'safe_to_remove',
    why: merged
      ? 'Clean, merged to main, and nothing is running in it.'
      : 'Clean, its commits are on a remote, and nothing is running in it.',
  };
}
