import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictError, createApiClient, queryKeys } from './api';
import {
  configureUndo,
  conflictMessage,
  handleMutationError,
  recordMutation,
  runOwnerMutation,
  toasts,
  toastSuccess,
  UNDONE_MESSAGE,
} from './undo';

type Call = { url: string; method: string; headers: Record<string, string> };

function harness(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    return answer(call);
  });
  const client = createApiClient({
    fetch: fetch as unknown as typeof globalThis.fetch,
    cookies: () => 'tl_csrf=tok',
    onMutation: recordMutation,
  });
  const invalidateQueries = vi.fn(async () => {});
  configureUndo({ client, queryClient: { invalidateQueries } });
  return { client, calls, invalidateQueries };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  toasts.reset();
  configureUndo(null);
});

describe('toast-with-undo plumbing', () => {
  it('offers Undo for an undoable owner mutation and calls the undo route with its mutation_id', async () => {
    const { client, calls, invalidateQueries } = harness((call) =>
      call.url.endsWith('/undo')
        ? json(200, { mutation_id: 'm-2', undone: 'Archived RCP-11' })
        : json(200, { mutation_id: 'm-1', item: {} }),
    );
    // archive is undoable (BUILD_SPEC §5.11).
    const res = (await client['items.archive']({ params: { id: 'RCP-11' } })) as {
      mutation_id: string;
    };
    toastSuccess('Archived RCP-11.', res.mutation_id);

    const [toast] = toasts.snapshot();
    expect(toast?.message).toBe('Archived RCP-11.');
    expect(toast?.onUndo).toBeTypeOf('function');

    toast!.onUndo!();
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toMatchObject({ url: '/api/mutations/m-1/undo', method: 'POST' });
    expect(calls[1]!.headers['X-Tasklite-CSRF']).toBe('tok');
    await vi.waitFor(() =>
      expect(toasts.snapshot().map((t) => t.message)).toContain(UNDONE_MESSAGE),
    );
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.all });
  });

  it('shows no Undo for a mutation it never saw', () => {
    harness(() => json(200, {}));
    toastSuccess('Saved.', 'm-unknown');
    expect(toasts.snapshot()[0]?.onUndo).toBeUndefined();
  });

  it('shows the server reason when the undo answers 409', async () => {
    const { client } = harness((call) =>
      call.url.endsWith('/undo')
        ? json(409, {
            error: {
              code: 'conflict',
              message:
                'Undo is only possible within 60 seconds of the change. Make the change again instead.',
            },
          })
        : json(200, { mutation_id: 'm-9' }),
    );
    const res = (await client['items.archive']({ params: { id: 'RCP-11' } })) as {
      mutation_id: string;
    };
    toastSuccess('Archived RCP-11.', res.mutation_id);
    toasts.snapshot()[0]!.onUndo!();
    await vi.waitFor(() =>
      expect(toasts.snapshot().map((t) => t.message)).toContain(
        'Undo is only possible within 60 seconds of the change. Make the change again instead.',
      ),
    );
  });

  it('turns a 409 on a mutation into the conflict toast and a refetch', async () => {
    const { invalidateQueries } = harness(() => json(200, {}));
    const err = new ConflictError('items.patch', { code: 'conflict', message: 'stale' });
    expect(
      await handleMutationError(err, { actor: 'codex', refetch: [queryKeys.item('RCP-12')] }),
    ).toBe(true);
    expect(toasts.snapshot().map((t) => t.message)).toEqual([
      'Changed by codex just now. Showing the latest.',
    ]);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['tl', 'item', 'RCP-12'] });
    expect(await handleMutationError(new Error('boom'))).toBe(false);
  });

  it('runOwnerMutation rolls back and returns null on conflict', async () => {
    harness(() => json(200, {}));
    const rollback = vi.fn();
    const out = await runOwnerMutation(
      async () => {
        throw new ConflictError('items.patch', { code: 'conflict', message: 'stale' });
      },
      { success: 'Saved.', rollback },
    );
    expect(out).toBeNull();
    expect(rollback).toHaveBeenCalled();
    expect(toasts.snapshot()[0]?.message).toBe(conflictMessage(undefined));
  });

  it('keeps at most three toasts', () => {
    for (let i = 0; i < 5; i++) toasts.show(`t${i}`);
    expect(toasts.snapshot().map((t) => t.message)).toEqual(['t2', 't3', 't4']);
  });
});

describe('write-check warnings in the success toast (MCP_SPEC §3.4)', () => {
  it('appends each warning as a ! line, and leaves a clean result alone', async () => {
    const { withWarnings } = await import('./undo');
    expect(withWarnings('Added to human review.', ["RCP-99 doesn't exist"])).toBe(
      "Added to human review. ! RCP-99 doesn't exist",
    );
    expect(withWarnings('Saved.', [])).toBe('Saved.');
    expect(withWarnings('Saved.')).toBe('Saved.');
  });
});
