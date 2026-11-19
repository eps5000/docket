import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../../app/queryClient';
import { useShell } from '../../app/ShellState';
import { useBootstrap } from '../../app/useBootstrap';
import { queryKeys } from '../../lib/api';
import { JiraImportDialog } from './JiraImport';
import { NewProjectDialog } from './NewProject';

/**
 * The project dialogs, for the whole shell (B32): *New project* and *Import
 * from Jira*, opened with `setProjectDialog` from the Welcome page, the
 * header's *+ New* menu, the project switcher and Settings → Projects.
 *
 * The import offers only empty projects as targets, so it reads the item
 * counts from the Settings query (shared with the Settings screen's cache).
 */
export function ProjectDialogsHost() {
  const { projectDialog, setProjectDialog } = useShell();
  const boot = useBootstrap();
  const settings = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: () => apiClient['settings.get']({}),
    enabled: projectDialog?.kind === 'jira',
  });
  if (!projectDialog) return null;
  const close = () => setProjectDialog(null);
  if (projectDialog.kind === 'new') {
    return (
      <NewProjectDialog
        existingKeys={(boot.data?.projects ?? []).map((p) => p.key)}
        onClose={close}
        onImport={(key) => setProjectDialog({ kind: 'jira', target: key })}
      />
    );
  }
  // The targets come from the counts: open once they're in (or failed: then new projects
  // only). A just-created target may be missing from a cached copy: wait for the refetch.
  // Never unmount once open (a refetch mid-import mustn't close the dialog).
  const target = projectDialog.target;
  const hasTarget = !target || (settings.data?.projects ?? []).some((p) => p.key === target);
  if (settings.isPending || (!hasTarget && settings.isFetching)) return null;
  return (
    <JiraImportDialog
      initialTarget={projectDialog.target}
      onClose={close}
      projects={(settings.data?.projects ?? []).map((p) => ({
        key: p.key,
        name: p.name,
        items: p.counts.items,
      }))}
    />
  );
}
