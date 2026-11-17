/**
 * The Jira Cloud REST v3 client for the import (BUILD_SPEC §9; FR-090,
 * FR-092, FR-106).
 *
 * - **Egress:** every request goes to the site the owner entered, over
 *   HTTPS, and nowhere else: URLs are built from the site's origin and
 *   checked against it, and redirects are never followed (Jira redirects
 *   attachment downloads to its media host; the client asks for
 *   `redirect=false` instead). The no-egress check in CI (T145) allows only
 *   the Jira fixture, which this satisfies.
 * - **The token** lives in a private field of this object, for the import
 *   session only. `forget()` drops it; nothing here writes it anywhere, and
 *   errors never quote headers, bodies or credentials.
 * - **Rate limits:** `429` and `503` are retried after `Retry-After`
 *   (seconds or an HTTP date), else with exponential backoff, up to 5
 *   times; each wait is capped at 60 s.
 * - `fetch` and `sleep` are injectable: tests never reach a network.
 */
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

export const SIGN_IN_FAILED = "Couldn't sign in to Jira. Check the email and API token.";
export const notFoundMessage = (key: string) =>
  `Project ${key} not found or not visible to this account.`;

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

/** The site's origin, or a `JiraError`: HTTPS only, no credentials in the URL. */
export function siteOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new JiraError('protocol', 'Enter the Jira site as https://yoursite.atlassian.net.');
  }
  if (url.protocol !== 'https:') {
    throw new JiraError('protocol', 'The Jira site must use https://.');
  }
  if (url.username || url.password) {
    throw new JiraError('protocol', 'Enter the Jira site without a user name or password.');
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

const PAGE_SIZE = 100;

export class JiraClient {
  readonly site: string;
  #auth: string | null;
  readonly #fetch: FetchLike | undefined;
  readonly #sleep: Sleep;
  readonly #signal: AbortSignal | undefined;
  readonly #maxRetries: number;
  readonly #maxWaitMs: number;

  constructor(opts: JiraClientOptions) {
    this.site = siteOrigin(opts.site);
    this.#auth = `Basic ${Buffer.from(`${opts.email}:${opts.token}`, 'utf8').toString('base64')}`;
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

  /** One request to the site, with retries for `429`/`503`. Never follows a redirect. */
  async request(
    path: string,
    init: { method?: string; body?: unknown; accept?: string } = {},
  ): Promise<Response> {
    const url = new URL(path, this.site);
    if (url.origin !== this.site) {
      throw new JiraError('protocol', 'Refused a request outside the Jira site.');
    }
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
            authorization: auth,
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
      if (res.status === 401) {
        await res.body?.cancel().catch(() => {});
        throw new JiraError('auth', SIGN_IN_FAILED, 401);
      }
      return res;
    }
  }

  async json<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await this.request(path, init);
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

  /** Who the credentials belong to: the sign-in check. */
  async myself(): Promise<void> {
    const res = await this.request('/rest/api/3/myself');
    await res.body?.cancel().catch(() => {});
    if (res.status === 403) throw new JiraError('auth', SIGN_IN_FAILED, 403);
    if (res.status === 404) {
      throw new JiraError(
        'not_found',
        `${this.site} doesn't look like a Jira Cloud site. Check the address.`,
        404,
      );
    }
    if (!res.ok)
      throw new JiraError('http', `Jira answered ${res.status}. Try again later.`, res.status);
  }

  async project(key: string): Promise<{ key: string; name: string }> {
    const res = await this.request(`/rest/api/3/project/${encodeURIComponent(key)}`);
    if (res.status === 404 || res.status === 403) {
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
  await client.myself();
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
