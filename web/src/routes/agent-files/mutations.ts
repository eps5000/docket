import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { apiClient } from '../../app/queryClient';
import { queryKeys } from '../../lib/api';
import { runOwnerMutation, showToast } from '../../lib/undo';
import { possessive } from './model';

interface FileRef {
  key: string;
  name: string;
}

/**
 * *Use default* (UI_SPEC §6.7b): the project's copy stops applying, so the
 * project gets the default again. It is B23's revert of the project layer;
 * the copy's versions stay in History, and the toast has Undo.
 */
export function useSwitchToDefault() {
  const qc = useQueryClient();
  return useCallback(
    async (file: FileRef, project: string, projectName: string) => {
      const key = queryKeys.family('agentFiles');
      try {
        await runOwnerMutation(
          () =>
            apiClient['agentFiles.revert']({
              params: { key: file.key },
              body: { layer: 'project', project },
            }),
          {
            success: `${projectName} uses the default ${file.name} again. ${possessive(projectName)} copy stays in History.`,
            refetch: [key],
          },
        );
      } catch (err) {
        showToast(
          err instanceof Error ? err.message : 'Couldn’t switch to the default. Try again.',
        );
      }
      await qc.invalidateQueries({ queryKey: key });
    },
    [qc],
  );
}

/**
 * *Reset to Task Lite’s version* (All projects): the owner's edit of the
 * default stops applying (B23's revert of the service layer). Its versions
 * stay in History, and the toast has Undo.
 */
export function useResetDefault() {
  const qc = useQueryClient();
  return useCallback(
    async (file: FileRef) => {
      const key = queryKeys.family('agentFiles');
      try {
        await runOwnerMutation(
          () =>
            apiClient['agentFiles.revert']({
              params: { key: file.key },
              body: { layer: 'service' },
            }),
          {
            success: `The default ${file.name} is Task Lite’s version again. Your edit stays in History.`,
            refetch: [key],
          },
        );
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Couldn’t reset the file. Try again.');
      }
      await qc.invalidateQueries({ queryKey: key });
    },
    [qc],
  );
}
