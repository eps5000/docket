/**
 * The Jira site address, as the owner types it (B32; BUILD_SPEC §9 "Signing
 * in"). The Import dialog normalises it as the owner leaves the field, and
 * the server normalises it again before it reads anything:
 *
 * - `https://` is added when no scheme is given (`acme.atlassian.net`);
 * - the path, query and fragment are dropped (`/jira/software/projects/ABC`,
 *   `/browse/ABC-1`, trailing slashes), leaving the origin.
 *
 * Anything that still isn't a plain `https://host` (an `http://` address, a
 * user name in the URL, no dot in the host) is returned as typed with the
 * scheme added, for the server to refuse with a message.
 */
export const JIRA_SITE_EXAMPLE = 'https://yoursite.atlassian.net';

/** The gateway that scoped API tokens must go through (`/ex/jira/<cloudId>/rest/api/3/…`). */
export const ATLASSIAN_GATEWAY_ORIGIN = 'https://api.atlassian.com';

export function normaliseJiraSite(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  // No URL parser here (shared has no DOM or Node types): the scheme and the authority.
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec(withScheme);
  if (!m || m[1]!.toLowerCase() !== 'https') return withScheme;
  const authority = m[2]!.toLowerCase();
  const hm = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::(\d{1,5}))?$/.exec(authority);
  if (!hm) return withScheme;
  const port = hm[2] && hm[2] !== '443' ? `:${Number(hm[2])}` : '';
  return `https://${hm[1]}${port}`;
}
