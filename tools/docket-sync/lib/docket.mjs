/**
 * The collector's calls to Docket's local API:
 *
 * - `GET /api/sync/<name>`: this source's settings and status. A 404 means this
 *   Docket doesn't know the source yet, and the runner skips it.
 * - `POST /api/sync/<name>`: one batch of records and how the run went.
 *
 * `reader()` is what a source receives as `ctx.docket`: reads under `/api/` only.
 */
const READ_TIMEOUT_MS = 15_000;
const POST_TIMEOUT_MS = 30_000;

export class DocketError extends Error {
  constructor(code, status = null, retryAfterMs = null) {
    super(code);
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

const retryAfter = (response) => {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
};

const failure = (response) => {
  const code =
    response.status === 401 || response.status === 403
      ? 'needs_local_trust'
      : response.status === 400 || response.status === 413
        ? 'rejected'
        : 'docket_error';
  return new DocketError(code, response.status, retryAfter(response));
};

export function createDocket({ baseUrl, fetchImpl = fetch }) {
  const root = baseUrl.replace(/\/+$/, '');

  const call = async (path, { signal, timeoutMs, ...init }) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await fetchImpl(`${root}${path}`, { ...init, signal: combined, redirect: 'error' });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new DocketError('unreachable');
    }
  };

  const readJson = async (response) => {
    try {
      return await response.json();
    } catch {
      throw new DocketError('bad_response', response.status);
    }
  };

  const get = async (path, { signal } = {}) => {
    if (!path.startsWith('/api/')) throw new DocketError('bad_path');
    const response = await call(path, {
      signal,
      timeoutMs: READ_TIMEOUT_MS,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw failure(response);
    return readJson(response);
  };

  return {
    /** The source's `{ settings, status }`, or null when this Docket doesn't know it. */
    async readSource(name, { signal } = {}) {
      const response = await call(`/api/sync/${encodeURIComponent(name)}`, {
        signal,
        timeoutMs: READ_TIMEOUT_MS,
        headers: { accept: 'application/json' },
      });
      if (response.status === 404) return null;
      if (!response.ok) throw failure(response);
      return readJson(response);
    },

    async post(name, body, { signal } = {}) {
      const response = await call(`/api/sync/${encodeURIComponent(name)}`, {
        signal,
        timeoutMs: POST_TIMEOUT_MS,
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw failure(response);
      return readJson(response);
    },

    reader: () => ({ get }),
  };
}
