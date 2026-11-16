/**
 * The app's TanStack Query client and API client.
 * - No retries for answers that won't change by retrying: 4xx, and 501 from
 *   a route no slice has built yet. Network errors and other 5xx retry twice.
 * - Any `401` (the owner session is missing or ended) sends the browser to
 *   /unlock and back afterwards (UI_SPEC §6.8).
 * - Owner mutations report their `mutation_id` to the undo plumbing.
 */
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiError, createApiClient, type ApiClient } from '../lib/api';
import { configureUndo, recordMutation } from '../lib/undo';

export function isLocked(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

export function shouldRetry(failureCount: number, err: unknown): boolean {
  if (err instanceof ApiError && (err.status < 500 || err.status === 501)) return false;
  return failureCount < 2;
}

let onLocked: () => void = () => {};

/** The shell registers what to do on a 401 (navigate to /unlock?next=…). */
export function setOnLocked(fn: () => void): void {
  onLocked = fn;
}

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (err) => {
        if (isLocked(err)) onLocked();
      },
    }),
    mutationCache: new MutationCache({
      onError: (err) => {
        if (isLocked(err)) onLocked();
      },
    }),
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        staleTime: 10_000,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
}

export const queryClient = createAppQueryClient();

/** Same origin; every owner mutation is recorded for its Undo toast. */
export const apiClient: ApiClient = createApiClient({ onMutation: recordMutation });

configureUndo({ client: apiClient, queryClient });
