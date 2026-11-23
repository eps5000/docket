/**
 * The branch naming rule (owner decision 49; BUILD_SPEC §5.34): a branch is
 * `<owner>/GF-243-short-description`, with one ticket key, and its worktree
 * folder has the same name. Pure functions, so every case is tested alone.
 *
 * A key is a whole token, so GF-243 never matches GF-2430 or XGF-243. Case is
 * ignored, because real branches are often lower-case. The first path segment
 * is the owner and is never read as a key.
 */

const KEY_TOKEN = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]*)-(\d+)(?![A-Za-z0-9])/g;
const SLUG_WORDS = 5;
const SLUG_MAX = 40;

/** The part of a branch that can name a ticket: all of it but the `<owner>/` segment. */
const afterOwner = (branch: string) => {
  const slash = branch.indexOf('/');
  return slash === -1 ? branch : branch.slice(slash + 1);
};

/** Every key-shaped token in a branch, upper-cased, once each, in order. */
export function keysInBranch(branch: string): string[] {
  const keys = new Set<string>();
  for (const m of afterOwner(branch).matchAll(KEY_TOKEN)) {
    keys.add(`${m[1]!.toUpperCase()}-${m[2]!}`);
  }
  return [...keys];
}

/** Whether `branch` names any of `keys` (an item ID, or its imported Jira key). */
export function branchNamesKey(branch: string, keys: readonly (string | null)[]): boolean {
  const named = new Set(keysInBranch(branch));
  return keys.some((key) => !!key && named.has(key.toUpperCase()));
}

/** A pattern where `*` is any text, anchored at both ends. */
function globToRegex(pattern: string): RegExp {
  const body = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\/-]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}$`, 'i');
}

export function isExemptBranch(branch: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globToRegex(pattern).test(branch));
}

/** `GF-243-fix-the-login-page`: the key, then a short slug of the title. */
export function suggestedName(id: string, title: string): string {
  const words = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, SLUG_WORDS);
  let slug = '';
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > SLUG_MAX) break;
    slug = next;
  }
  return slug ? `${id}-${slug}` : id;
}

/** The branch to suggest: the owner is the agent's own git user. */
export const suggestedBranch = (id: string, title: string) => `<owner>/${suggestedName(id, title)}`;
