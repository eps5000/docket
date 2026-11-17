import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router';
import { ViewTabs } from '../../components/kit';
import { useBreadcrumb } from '../../app/ShellState';
import { apiClient } from '../../app/queryClient';
import { queryKeys } from '../../lib/api';
import { paths } from '../../lib/paths';
import { AgentSetup } from './AgentSetup';
import { ConnectionsSection } from './ConnectionsSection';
import { ProjectsSection } from './ProjectsSection';
import { ThisBrowserCard } from './ThisBrowserCard';
import '../screens.css';

type SettingsTab = 'general' | 'agent-setup';

const TABS = [
  { key: 'general', label: 'General' },
  { key: 'agent-setup', label: 'Agent setup' },
] as const;

/**
 * Settings (`/settings`, UI_SPEC §6.7): Projects, Connections and This
 * browser. Service-wide: the project scope doesn't apply. US10 fills it.
 * The *Agent setup* tab (`/settings/agent-setup`, §6.7b; US13) is its own
 * route, so a file's view can be linked.
 */
export function Settings() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const tab: SettingsTab = pathname.startsWith('/settings/agent-setup') ? 'agent-setup' : 'general';
  useBreadcrumb({
    crumbs:
      tab === 'general'
        ? [{ kind: 'current', text: 'Settings' }]
        : [
            { kind: 'link', text: 'Settings', to: paths.settings() },
            { kind: 'current', text: 'Agent setup' },
          ],
    serviceWide: true,
  });
  const query = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: () => apiClient['settings.get']({}),
  });
  return (
    <div className="settings">
      <h1>Settings</h1>
      <ViewTabs
        label="Settings sections"
        tabs={TABS}
        active={tab}
        onChange={(k) => void navigate(k === 'general' ? paths.settings() : paths.agentSetup())}
      >
        {tab === 'general' ? (
          <>
            <ProjectsSection query={query} />
            <ConnectionsSection query={query} />
            <ThisBrowserCard />
          </>
        ) : (
          <AgentSetup projects={query.data?.projects ?? []} />
        )}
      </ViewTabs>
    </div>
  );
}
