/**
 * Toasts, Undo and conflict handling for owner mutations (tasks.md T060;
 * UI_SPEC §4 Toast, §7; BUILD_SPEC §5.11).
 *
 * - `toasts`: a tiny store the shell renders in its `ToastRegion`
 *   (`role=status`). Info toasts last 3.2 s; toasts with Undo last 6 s (the
 *   kit's Toast owns the timing).
 * - The app's API client reports every owner mutation's `mutation_id`
 *   (`onMutation` → `recordMutation`). `toastSuccess(message, mutation_id)`
 *   then offers *Undo* when that route is undoable, and *Undo* calls
 *   `POST /api/mutations/:id/undo` with the captured `mutation_id`.
 * - A `409` (`ConflictError`) on a mutation refetches the affected queries and
 *   toasts "Changed by codex just now. Showing the latest."; a `409` on an
 *   undo (too late, already undone, changed since) toasts the server's reason.
 *
 * Slices call `runOwnerMutation` (or `toastSuccess` and `handleMutationError`
 * directly) and never build their own toasts.
 */
import type { QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import type { ToastData } from '../components/kit';
import { isConflict, queryKeys, type ApiClient, type MutationRecord, type QueryKey } from './api';

// ---- The toast store ----

type Listener = () => void;
let toastList: readonly ToastData[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l();
}

export const toasts = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  snapshot(): readonly ToastData[] {
    return toastList;
  },
  /** Show a toast; returns its id. At most 3 stay on screen. */
  show(message: string, opts: { onUndo?: () => void } = {}): number {
    const id = nextId++;
    const toast: ToastData = opts.onUndo ? { id, message, onUndo: opts.onUndo } : { id, message };
    toastList = [...toastList, toast].slice(-3);
    emit();
    return id;
  },
  dismiss(id: number): void {
    const next = toastList.filter((t) => t.id !== id);
    if (next.length === toastList.length) return;
    toastList = next;
    emit();
  },
  /** Tests only. */
  reset(): void {
    toastList = [];
    emit();
  },
};

export function useToasts(): readonly ToastData[] {
  return useSyncExternalStore(toasts.subscribe, toasts.snapshot, toasts.snapshot);
}

/** An info toast (3.2 s). */
export function showToast(message: string): number {
  return toasts.show(message);
}

// ---- Copy (UI_SPEC §7) ----

/** "Changed by codex just now. Showing the latest." */
export function conflictMessage(actor?: string | null): string {
  return `Changed by ${actor && actor.trim() ? actor : 'an agent'} just now. Showing the latest.`;
}

export const UNDONE_MESSAGE = 'Undone.';

// ---- Wiring ----

interface UndoDeps {
  client: Pick<ApiClient, 'mutations.undo'>;
  queryClient: Pick<QueryClient, 'invalidateQueries'>;
}

let deps: UndoDeps | null = null;
const recorded = new Map<string, MutationRecord>();

/** Called once by the app with its API client and query client. */
export function configureUndo(next: UndoDeps | null): void {
  deps = next;
  recorded.clear();
}

/** The API client's `onMutation` hook: remember each owner mutation for its Undo toast. */
export function recordMutation(m: MutationRecord): void {
  recorded.set(m.mutation_id, m);
  // Keep the map small: undo is only accepted for 60 s anyway.
  if (recorded.size > 50) recorded.delete(recorded.keys().next().value as string);
}

/** Undo a mutation through `POST /api/mutations/:id/undo`, then refetch everything. */
export async function undoMutation(mutationId: string): Promise<boolean> {
  if (!deps) throw new Error('configureUndo() has not been called');
  try {
    await deps.client['mutations.undo']({ params: { id: mutationId } });
    recorded.delete(mutationId);
    await deps.queryClient.invalidateQueries({ queryKey: queryKeys.all });
    toasts.show(UNDONE_MESSAGE);
    return true;
  } catch (err) {
    // 409: too late, already undone, or changed since. The server's message says which.
    if (isConflict(err)) {
      await deps.queryClient.invalidateQueries({ queryKey: queryKeys.all });
      toasts.show(err.message);
      return false;
    }
    toasts.show(err instanceof Error && err.message ? err.message : 'Undo failed. Try again.');
    return false;
  }
}

/**
 * The success toast for an owner mutation: a past-tense summary, plus *Undo*
 * (6 s) when the route is undoable (UI_SPEC §7).
 */
export function toastSuccess(message: string, mutationId?: string): number {
  const m = mutationId ? recorded.get(mutationId) : undefined;
  if (m && m.undoable) {
    return toasts.show(message, { onUndo: () => void undoMutation(m.mutation_id) });
  }
  return toasts.show(message);
}

/**
 * Handle a failed owner mutation. A `409` refetches `refetch` (default: every
 * query) and toasts the conflict message; returns true when it handled the
 * error. Other errors are left to the caller (inline callout or field error).
 */
export async function handleMutationError(
  err: unknown,
  opts: { actor?: string | null; refetch?: QueryKey[] } = {},
): Promise<boolean> {
  if (!isConflict(err)) return false;
  if (deps) {
    const keys = opts.refetch ?? [queryKeys.all];
    await Promise.all(keys.map((queryKey) => deps!.queryClient.invalidateQueries({ queryKey })));
  }
  toasts.show(conflictMessage(opts.actor));
  return true;
}

/**
 * Run an owner mutation with the standard toasts: success (with Undo when
 * undoable) or the conflict toast. Returns the result, or null when it
 * failed with a conflict. Other errors are rethrown.
 */
export async function runOwnerMutation<T extends { mutation_id: string }>(
  fn: () => Promise<T>,
  opts: {
    success: string | ((result: T) => string);
    actor?: string | null;
    refetch?: QueryKey[];
    /** Roll back an optimistic update. */
    rollback?: () => void;
  },
): Promise<T | null> {
  try {
    const result = await fn();
    toastSuccess(
      typeof opts.success === 'function' ? opts.success(result) : opts.success,
      result.mutation_id,
    );
    return result;
  } catch (err) {
    opts.rollback?.();
    if (await handleMutationError(err, opts)) return null;
    throw err;
  }
}
