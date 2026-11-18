import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link, useLocation } from 'react-router';
import { useBreadcrumb } from '../../app/ShellState';
import { apiClient } from '../../app/queryClient';
import { queryKeys } from '../../lib/api';
import { paths } from '../../lib/paths';
import { ConnectionsSection } from './ConnectionsSection';
import { ProjectsSection } from './ProjectsSection';
import { PushFolderCard } from './PushFolderCard';
import { ThisBrowserCard } from './ThisBrowserCard';
import '../screens.css';
import '../agent-files/agent-files.css';

/**
 * Settings (`/settings`, UI_SPEC §6.7): Projects, Connections, the push
 * folder and This browser. Service-wide: the project scope doesn't apply.
 * Agent files moved to its own page (`/agent-files`, B25); the push folder
 * card stays here because it's service setup (`/settings#push-folder`).
 */
export function Settings() {
  const { hash } = useLocation();
  useBreadcrumb({ crumbs: [{ kind: 'current', text: 'Settings' }], serviceWide: true });
  const query = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: () => apiClient['settings.get']({}),
  });
  useEffect(() => {
    if (hash === '#push-folder') document.getElementById('push-folder')?.scrollIntoView?.();
  }, [hash]);
  return (
    <div className="settings">
      <h1>Settings</h1>
      <ProjectsSection query={query} />
      <ConnectionsSection query={query} />
      <section id="push-folder" aria-labelledby="set-push" className="settings-sec">
        <h2 id="set-push">One-click install</h2>
        <p className="src aflede">
          Lets <Link to={paths.agentFiles()}>Agent files</Link> write the skills and the AGENTS.md
          block straight into your repos. Without it, Install gives you a command to paste.
        </p>
        <PushFolderCard />
      </section>
      <ThisBrowserCard />
    </div>
  );
}
