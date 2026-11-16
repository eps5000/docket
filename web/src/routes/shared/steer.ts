import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { queryKeys } from '../../lib/api';
import { runOwnerMutation, showToast } from '../../lib/undo';

type Mutation = { mutation_id: string; warnings?: string[] };

/**
 * Steering an item (UI_SPEC §6.3, §6.1; US6): run one owner mutation with the
 * standard toasts (success with Undo, or the conflict toast), toast any
 * other error's message, then refetch the item, Needs you and the shell
 * counts. Resolves to the result, or null when it didn't go through.
 */
export function useSteer(itemId: string) {
  const queryClient = useQueryClient();
  return useCallback(
    async <T extends Mutation>(
      fn: () => Promise<T>,
      success: string | ((result: T) => string),
    ): Promise<T | null> => {
      try {
        return await runOwnerMutation(fn, { success, refetch: [queryKeys.item(itemId)] });
      } catch (err) {
        showToast(err instanceof Error && err.message ? err.message : 'Couldn’t save. Try again.');
        return null;
      } finally {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.item(itemId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.family('needsYou') }),
          queryClient.invalidateQueries({ queryKey: queryKeys.bootstrap() }),
        ]);
      }
    },
    [itemId, queryClient],
  );
}
