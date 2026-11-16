import { useQuery } from '@tanstack/react-query';
import { useBreadcrumb } from '../../app/ShellState';
import { apiClient } from '../../app/queryClient';
import { queryKeys } from '../../lib/api';
import { ConnectionsSection } from './ConnectionsSection';
import { ProjectsSection } from './ProjectsSection';
import { ThisBrowserCard } from './ThisBrowserCard';
import '../screens.css';

/**
 * Settings (`/settings`, UI_SPEC §6.7): Projects, Connections and This
 * browser. Service-wide: the project scope doesn't apply. US10 fills it.
 */
export function Settings() {
  useBreadcrumb({ crumbs: [{ kind: 'current', text: 'Settings' }], serviceWide: true });
  const query = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: () => apiClient['settings.get']({}),
  });
  return (
    <div className="settings">
      <h1>Settings</h1>
      <ProjectsSection query={query} />
      <ConnectionsSection query={query} />
      <ThisBrowserCard />
    </div>
  );
}
