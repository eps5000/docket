/**
 * The two read-only Docket calls the relay makes.
 *
 * - `GET /agent/changes/wait`: the long-poll. It asks for every type and
 *   filters here, because the server refuses a type it doesn't know yet.
 * - `GET /api/items/:id`: the owner's item read, which local trust serves
 *   without a session. Unlike MCP `get_item` it records no delivery, so the
 *   agent's answer stays unread until the agent reads it. Only the run and
 *   actor fields are kept; the rest of the response is dropped here.
 */

const PAGE = 200;

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
    response.status === 401 || response.status === 403 ? 'needs_local_trust' : 'docket_error';
  return new DocketError(code, response.status, retryAfter(response));
};

export function createDocket({ baseUrl, fetchImpl = fetch }) {
  const root = baseUrl.replace(/\/+$/, '');

  const get = async (path, { signal, timeoutMs }) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await fetchImpl(`${root}${path}`, {
        signal: combined,
        redirect: 'error',
        headers: { accept: 'application/json' },
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new DocketError('unreachable');
    }
  };

  const readPage = async (response) => {
    if (response.status === 204) return null;
    if (!response.ok) throw failure(response);
    let page;
    try {
      page = await response.json();
    } catch {
      throw new DocketError('bad_response', response.status);
    }
    if (!/^\d{1,15}$/.test(String(page?.next_cursor ?? '')) || !Array.isArray(page.events)) {
      throw new DocketError('bad_response', response.status);
    }
    return { next_cursor: String(page.next_cursor), events: page.events };
  };

  return {
    /** The end of the feed, without waiting. */
    async currentCursor({ signal } = {}) {
      const response = await get('/agent/changes/wait?timeout_s=0&limit=1', {
        signal,
        timeoutMs: 15_000,
      });
      const page = await readPage(response);
      if (!page) throw new DocketError('bad_response');
      return page.next_cursor;
    },

    /** Waits for events after `cursor`. Null when the wait was cut off. */
    async wait({ cursor, timeoutS, signal }) {
      const query = new URLSearchParams({
        cursor,
        timeout_s: String(timeoutS),
        limit: String(PAGE),
      });
      const response = await get(`/agent/changes/wait?${query}`, {
        signal,
        timeoutMs: (timeoutS + 15) * 1000,
      });
      return readPage(response);
    },

    /** `{ runs, activity }` (cursor to actor kind), or null when the item is gone. */
    async readItem(id, { signal } = {}) {
      const response = await get(`/api/items/${encodeURIComponent(id)}`, {
        signal,
        timeoutMs: 15_000,
      });
      if (response.status === 404) return null;
      if (!response.ok) throw failure(response);
      let detail;
      try {
        detail = await response.json();
      } catch {
        throw new DocketError('bad_response', response.status);
      }
      const runs = Array.isArray(detail?.item?.runs) ? detail.item.runs : [];
      const activity = new Map();
      for (const row of Array.isArray(detail?.activity) ? detail.activity : []) {
        if (row?.cursor != null) activity.set(String(row.cursor), row.actor_kind);
      }
      return {
        runs: runs.map((run) => ({
          run_id: run?.run_id,
          is_lead: run?.is_lead,
          run_state: run?.run_state,
          orchestrator: run?.orchestrator
            ? { dispatch_id: run.orchestrator.dispatch_id, run_id: run.orchestrator.run_id }
            : null,
        })),
        activity,
      };
    },
  };
}
