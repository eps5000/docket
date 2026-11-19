/**
 * The Jira Cloud REST v3 client for the import (BUILD_SPEC §9; FR-090,
 * FR-092, FR-106).
 *
 * - **Egress:** every request goes to the site the owner entered, or to
 *   Atlassian's gateway (`https://api.atlassian.com/ex/jira/<cloudId>`) when
 *   the token is a scoped one (B32), over HTTPS, and nowhere else: URLs are
 *   built from the session's base (chosen once, at sign-in) and checked
 *   against it, and redirects are never followed (Jira redirects
 *   attachment downloads to its media host; the client asks for
 *   `redirect=false` instead). The no-egress check in CI (T145) allows only
 *   the Jira fixture and its stand-in gateway, which this satisfies.
 * - **The token** lives in a private field of this object, for the import
 *   session only. `forget()` drops it; nothing here writes it anywhere, and
 *   errors never quote headers, bodies or credentials.
 * - **Rate limits:** `429` and `503` are retried after `Retry-After`
 *   (seconds or an HTTP date), else with exponential backoff, up to 5
 *   times; each wait is capped at 60 s.
 * - `fetch` and `sleep` are injectable: tests never reach a network.
 */
import { ATLASSIAN_GATEWAY_ORIGIN, JIRA_SITE_EXAMPLE, normaliseJiraSite } from '@docket/shared';
import { searchFields } from './mapper.js';
import type { JiraComment, JiraField, JiraIssue, JiraSnapshot } from './types.js';

export type JiraErrorKind =
  'auth' | 'not_found' | 'network' | 'rate_limited' | 'http' | 'protocol' | 'canceled' | 'expired';

/** A failure with a message safe to show the owner and store: never a credential. */
export class JiraError extends Error {
  readonly kind: JiraErrorKind;
  readonly status: number | null;
  constructor(kind: JiraErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = 'JiraError';
    this.kind = kind;
    this.status = status;
  }
}

/** A 401 later in the session (the token was revoked mid-import, say). */
export const SIGN_IN_FAILED = "Couldn't sign in to Jira. Check the email and API token.";
export const notFoundMessage = (key: string) =>
  `Project ${key} not found or not visible to this account.`;

// ---- Sign-in messages (B32; BUILD_SPEC §9 "Signing in") ----
export const SITE_NOT_FOUND = `Site not found: check the URL (${JIRA_SITE_EXAMPLE}).`;
export const ORG_KEY_MESSAGE =
  "That looks like an organization API key from admin.atlassian.com. Those can't read Jira. Create a personal API token at id.atlassian.com instead.";
export const wrongCredentialsMessage = (email: string) =>
  `Wrong email or API token. The token must belong to ${email}'s Atlassian account.`;
export const NO_ACCESS_MESSAGE =
  "Signed in, but this account can't browse that project (or the token's scopes don't include reading Jira work items).";
/** The classic scopes a scoped token needs for the import's reads. */
export const SCOPES_NEEDED = ['read:jira-work', 'read:jira-user'] as const;
export const SCOPED_NO_ACCESS_MESSAGE = `${NO_ACCESS_MESSAGE} A scoped token needs the ${SCOPES_NEEDED.join(' and ')} scopes.`;

/**
 * Does this look like an organization API key (admin.atlassian.com)? Only
 * what can be checked without guessing:
 * - a `Bearer …` value: organization keys are sent as Bearer tokens, so a
 *   pasted header (or a key copied with its scheme) is one;
 * - the `ATCTT` prefix: Atlassian's access and admin keys start with it,
 *   while personal API tokens (scoped or not) start with `ATATT`.
 * Anything else that fails both sign-ins is reported as a wrong email or token.
 */
export function looksLikeOrgKey(token: string): boolean {
  const t = token.trim();
  return /^bearer\s/i.test(t) || t.startsWith('ATCTT');
}

/** How the session reaches Jira: the site itself, or the gateway (scoped tokens). */
export type JiraRoute = 'site' | 'gateway';

const CLOUD_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const defaultSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new JiraError('canceled', 'The import was canceled.'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new JiraError('canceled', 'The import was canceled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export interface JiraClientOptions {
  site: string;
  email: string;
  token: string;
  /** Default: the global `fetch`, looked up at call time. */
  fetch?: FetchLike;
  sleep?: Sleep;
  /** Aborts every request (cancel). */
  signal?: AbortSignal;
  maxRetries?: number;
  maxWaitMs?: number;
}

/**
 * The site's origin, or a `JiraError`: HTTPS only, no credentials in the
 * URL. Normalised first (`normaliseJiraSite`): `https://` added when
 * missing, and any path (`/jira/…`, `/browse/…`, trailing slashes) dropped.
 */
export function siteOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(normaliseJiraSite(raw));
  } catch {
    throw new JiraError('protocol', `Enter the Jira site as ${JIRA_SITE_EXAMPLE}.`);
  }
  if (url.protocol !== 'https:') {
    throw new JiraError('protocol', 'The Jira site must use https://.');
  }
  if (url.username || url.password) {
    throw new JiraError('protocol', 'Enter the Jira site without a user name or password.');
  }
  if (!url.hostname.includes('.')) {
    throw new JiraError('protocol', `Enter the Jira site as ${JIRA_SITE_EXAMPLE}.`);
  }
  return url.origin;
}

/** `Retry-After` in milliseconds: seconds or an HTTP date; null when absent or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/**
 * Is this 401 the gateway's "Unauthorized; scope does not match" (a scoped
 * token without the scope a call needs)? Reads at most a few KB of the
 * body and keeps none of it.
 */
async function scopeMismatch(res: Response): Promise<boolean> {
  try {
    const text = (await res.text()).slice(0, 4096);
    return /scope does not match/i.test(text);
  } catch {
    return false;
  }
}

const PAGE_SIZE = 100;

export class JiraClient {
  readonly site: string;
  readonly #email: string;
  #auth: string | null;
  /** Looks like an organization API key (checked once, then only this flag is kept). */
  readonly #orgKeyShape: boolean;
  /** Where every REST call goes: the site's origin, or the gateway's `/ex/jira/<cloudId>`. */
  #base: string;
  #route: JiraRoute = 'site';
  readonly #fetch: FetchLike | undefined;
  readonly #sleep: Sleep;
  readonly #signal: AbortSignal | undefined;
  readonly #maxRetries: number;
  readonly #maxWaitMs: number;

  constructor(opts: JiraClientOptions) {
    this.site = siteOrigin(opts.site);
    this.#base = this.site;
    this.#email = opts.email.trim();
    const token = opts.token.trim();
    this.#orgKeyShape = looksLikeOrgKey(token);
    this.#auth = `Basic ${Buffer.from(`${this.#email}:${token}`, 'utf8').toString('base64')}`;
    this.#fetch = opts.fetch;
    this.#sleep = opts.sleep ?? defaultSleep;
    this.#signal = opts.signal;
    this.#maxRetries = opts.maxRetries ?? 5;
    this.#maxWaitMs = opts.maxWaitMs ?? 60_000;
  }

  /** Drop the credentials. Every later request fails with `expired`. */
  forget(): void {
    this.#auth = null;
  }

  get forgotten(): boolean {
    return this.#auth === null;
  }

  /** `site` (classic personal token) or `gateway` (scoped token), chosen by `signIn`. */
  get route(): JiraRoute {
    return this.#route;
  }

  /** The base every REST path is appended to. */
  get base(): string {
    return this.#base;
  }

  /**
   * The URL for a REST path: the base plus the path. A full URL is allowed
   * only when it already sits under the base (an attachment's `content`
   * link, say); anything else is refused, so nothing leaves the site or the
   * gateway.
   */
  #url(path: string, base: string): URL {
    let url: URL;
    try {
      url = /^[a-z]+:\/\//i.test(path) ? new URL(path) : new URL(`${base}${path}`);
    } catch {
      throw new JiraError('protocol', 'Refused a request outside the Jira site.');
    }
    const root = new URL(base);
    const under =
      url.origin === root.origin &&
      (root.pathname === '/' || url.pathname.startsWith(`${root.pathname}/`));
    if (!under || (url.origin !== this.site && url.origin !== ATLASSIAN_GATEWAY_ORIGIN)) {
      throw new JiraError('protocol', 'Refused a request outside the Jira site.');
    }
    return url;
  }

  /**
   * One request to the site (or the gateway), with retries for `429`/`503`.
   * Never follows a redirect. A `401` throws, unless `allow401` (the
   * sign-in probe reads it). `auth: false` sends no credentials (the
   * site's public `/_edge/tenant_info`).
   */
  async request(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      accept?: string;
      base?: string;
      auth?: boolean;
      allow401?: boolean;
    } = {},
  ): Promise<Response> {
    const url = this.#url(path, init.base ?? this.#base);
    for (let attempt = 0; ; attempt++) {
      if (this.#signal?.aborted) throw new JiraError('canceled', 'The import was canceled.');
      const auth = this.#auth;
      if (auth === null) {
        throw new JiraError('expired', 'The import session expired. Run the dry run again.');
      }
      let res: Response;
      try {
        const doFetch = this.#fetch ?? globalThis.fetch;
        res = await doFetch(url, {
          method: init.method ?? 'GET',
          redirect: 'manual',
          signal: this.#signal,
          headers: {
            ...(init.auth === false ? {} : { authorization: auth }),
            accept: init.accept ?? 'application/json',
            ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        });
      } catch {
        if (this.#signal?.aborted) throw new JiraError('canceled', 'The import was canceled.');
        throw new JiraError('network', `Couldn't reach ${this.site}. Check the Jira site address.`);
      }
      if ((res.status === 429 || res.status === 503) && attempt < this.#maxRetries) {
        await res.body?.cancel().catch(() => {});
        const wait = retryAfterMs(res.headers.get('retry-after')) ?? 1000 * 2 ** attempt;
        await this.#sleep(Math.min(wait, this.#maxWaitMs), this.#signal);
        continue;
      }
      if (res.status === 429) {
        throw new JiraError(
          'rate_limited',
          'Jira is rate limiting this account. Try again in a few minutes.',
          429,
        );
      }
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => {});
        throw new JiraError(
          'protocol',
          `Jira answered ${res.status} (a redirect); the importer doesn't follow redirects.`,
          res.status,
        );
      }
      if (res.status === 401 && !init.allow401) {
        const scope = await scopeMismatch(res);
        throw new JiraError('auth', scope ? this.noAccessMessage() : SIGN_IN_FAILED, 401);
      }
      return res;
    }
  }

  /** The 403 message, naming the scopes when the session uses a scoped token. */
  noAccessMessage(): string {
    return this.#route === 'gateway' ? SCOPED_NO_ACCESS_MESSAGE : NO_ACCESS_MESSAGE;
  }

  /**
   * The sign-in probe (BUILD_SPEC §9 "Signing in"), in this order:
   * 1. `GET <site>/_edge/tenant_info` (no credentials) for the cloudId:
   *    unreachable, not JSON or no cloudId → "Site not found";
   * 2. `GET <site>/rest/api/3/myself` with Basic auth: 200 → a classic
   *    personal token, and the session stays on the site;
   * 3. on a 401, the same request through the gateway
   *    (`https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/myself`):
   *    200 → a scoped token, and every later call uses the gateway;
   * 4. a 401 on both → an organization API key (by its shape) or a wrong
   *    email or token; a 403 → signed in, but no access.
   */
  async signIn(): Promise<void> {
    const cloudId = await this.#tenant();
    const site = await this.request('/rest/api/3/myself', { base: this.site, allow401: true });
    await site.body?.cancel().catch(() => {});
    if (site.ok) return;
    if (site.status === 403) throw new JiraError('auth', NO_ACCESS_MESSAGE, 403);
    if (site.status === 404) {
      throw new JiraError(
        'not_found',
        `${this.site} doesn't look like a Jira Cloud site. Check the address.`,
        404,
      );
    }
    if (site.status !== 401) {
      throw new JiraError('http', `Jira answered ${site.status}. Try again later.`, site.status);
    }
    const gatewayBase = `${ATLASSIAN_GATEWAY_ORIGIN}/ex/jira/${cloudId}`;
    const gw = await this.request('/rest/api/3/myself', { base: gatewayBase, allow401: true });
    if (gw.ok || gw.status === 403 || (gw.status === 401 && (await scopeMismatch(gw)))) {
      await gw.body?.cancel().catch(() => {});
      // A scoped token: everything else in this session goes through the gateway.
      this.#base = gatewayBase;
      this.#route = 'gateway';
      if (gw.ok) return;
      throw new JiraError('auth', SCOPED_NO_ACCESS_MESSAGE, gw.status);
    }
    await gw.body?.cancel().catch(() => {});
    if (gw.status === 401) {
      throw new JiraError(
        'auth',
        this.#orgKeyShape ? ORG_KEY_MESSAGE : wrongCredentialsMessage(this.#email),
        401,
      );
    }
    throw new JiraError('http', `Jira answered ${gw.status}. Try again later.`, gw.status);
  }

  /** The site's cloudId, from its public tenant info; "Site not found" otherwise. */
  async #tenant(): Promise<string> {
    let res: Response;
    try {
      res = await this.request('/_edge/tenant_info', { base: this.site, auth: false });
    } catch (err) {
      if (err instanceof JiraError && (err.kind === 'network' || err.kind === 'protocol')) {
        throw new JiraError('not_found', SITE_NOT_FOUND);
      }
      throw err;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new JiraError('not_found', SITE_NOT_FOUND, res.status);
    }
    let cloudId: unknown;
    try {
      cloudId = ((await res.json()) as { cloudId?: unknown } | null)?.cloudId;
    } catch {
      throw new JiraError('not_found', SITE_NOT_FOUND);
    }
    if (typeof cloudId !== 'string' || !CLOUD_ID_RE.test(cloudId)) {
      throw new JiraError('not_found', SITE_NOT_FOUND);
    }
    return cloudId;
  }

  async json<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await this.request(path, init);
    if (res.status === 403) {
      await res.body?.cancel().catch(() => {});
      throw new JiraError('auth', this.noAccessMessage(), 403);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new JiraError('http', `Jira answered ${res.status}. Try again later.`, res.status);
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new JiraError(
        'protocol',
        'Jira sent a response that is not JSON. Check the site address.',
      );
    }
  }

  /** Who the credentials belong to: the sign-in check (`signIn`, kept by its old name). */
  myself(): Promise<void> {
    return this.signIn();
  }

  async project(key: string): Promise<{ key: string; name: string }> {
    const res = await this.request(`/rest/api/3/project/${encodeURIComponent(key)}`);
    if (res.status === 403) {
      await res.body?.cancel().catch(() => {});
      throw new JiraError('auth', this.noAccessMessage(), 403);
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      throw new JiraError('not_found', notFoundMessage(key), res.status);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new JiraError('http', `Jira answered ${res.status}. Try again later.`, res.status);
    }
    const body = (await res.json()) as { key?: string; name?: string };
    return { key: body.key ?? key, name: body.name ?? key };
  }

  fields(): Promise<JiraField[]> {
    return this.json<JiraField[]>('/rest/api/3/field');
  }

  /** The approximate number of issues, for "Reading 140 of 512 issues…"; null if unavailable. */
  async approximateCount(jql: string): Promise<number | null> {
    try {
      const body = await this.json<{ count?: number }>('/rest/api/3/search/approximate-count', {
        method: 'POST',
        body: { jql },
      });
      return typeof body.count === 'number' ? body.count : null;
    } catch (err) {
      if (
        err instanceof JiraError &&
        (err.kind === 'canceled' || err.kind === 'auth' || err.kind === 'expired')
      ) {
        throw err;
      }
      return null;
    }
  }

  /** Every issue matching `jql` (enhanced search, `nextPageToken` pagination). */
  async search(
    jql: string,
    fields: string[],
    onPage: (read: number) => void = () => {},
  ): Promise<JiraIssue[]> {
    const issues: JiraIssue[] = [];
    let token: string | undefined;
    for (;;) {
      const page = await this.json<{
        issues?: JiraIssue[];
        nextPageToken?: string;
        isLast?: boolean;
      }>('/rest/api/3/search/jql', {
        method: 'POST',
        body: { jql, fields, maxResults: PAGE_SIZE, ...(token ? { nextPageToken: token } : {}) },
      });
      issues.push(...(page.issues ?? []));
      onPage(issues.length);
      if (page.isLast || !page.nextPageToken || (page.issues ?? []).length === 0) break;
      token = page.nextPageToken;
    }
    return issues;
  }

  /** Every comment on an issue, oldest first. */
  async comments(key: string): Promise<JiraComment[]> {
    const out: JiraComment[] = [];
    for (let startAt = 0; ;) {
      const page = await this.json<{ comments?: JiraComment[]; total?: number }>(
        `/rest/api/3/issue/${encodeURIComponent(key)}/comment?startAt=${startAt}&maxResults=${PAGE_SIZE}&orderBy=created`,
      );
      const list = page.comments ?? [];
      out.push(...list);
      startAt += list.length;
      if (list.length === 0 || startAt >= (page.total ?? 0)) break;
    }
    return out;
  }

  /** An attachment's bytes, streamed from the site itself (`redirect=false`). */
  async attachment(id: string): Promise<Response> {
    const res = await this.request(
      `/rest/api/3/attachment/content/${encodeURIComponent(id)}?redirect=false`,
      { accept: '*/*' },
    );
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new JiraError('http', `Jira answered ${res.status}`, res.status);
    }
    return res;
  }
}

export interface ReadProgress {
  phase: 'reading' | 'mapping';
  done: number;
  total: number | null;
}

/**
 * The dry run's reads: sign in, find the project, the fields, every issue
 * (`project = X ORDER BY key`), and the comments the search didn't embed.
 */
export async function readJiraProject(
  client: JiraClient,
  projectKey: string,
  onProgress: (p: ReadProgress) => void = () => {},
): Promise<JiraSnapshot> {
  await client.signIn();
  const project = await client.project(projectKey);
  const fields = await client.fields();
  const jql = `project = "${project.key}" ORDER BY key ASC`;
  const total = await client.approximateCount(`project = "${project.key}"`);
  onProgress({ phase: 'reading', done: 0, total });
  const issues = await client.search(jql, searchFields(fields), (done) =>
    onProgress({ phase: 'reading', done, total: total === null ? null : Math.max(total, done) }),
  );
  onProgress({ phase: 'mapping', done: 0, total: issues.length });
  const comments: Record<string, JiraComment[]> = {};
  let checked = 0;
  for (const issue of issues) {
    const page = issue.fields.comment as { comments?: JiraComment[]; total?: number } | undefined;
    const embedded = page?.comments ?? [];
    if ((page?.total ?? embedded.length) > embedded.length)
      comments[issue.key] = await client.comments(issue.key);
    checked++;
    if (checked % 50 === 0) onProgress({ phase: 'mapping', done: checked, total: issues.length });
  }
  return { site: client.site, project, fields, issues, comments };
}
