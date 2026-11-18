/**
 * The route table (UI_SPEC §2 "Routes"). Every screen is routed; slices fill
 * them in. `/unlock` and the dev-only `/dev/kit` live outside the shell.
 */
import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate, useSearchParams, type RouteObject } from 'react-router';
import { PROJECT_KEY_RE } from '@tasklite/shared';
import { AgentFiles } from '../routes/agent-files/AgentFiles';
import { Agents } from '../routes/agents/Agents';
import { HelpArticlePage, HelpIndex } from '../routes/help/HelpPages';
import { ItemPage } from '../routes/items/ItemPage';
import { LabelPage } from '../routes/labels/LabelPage';
import { NeedsYou } from '../routes/needs-you/NeedsYou';
import { NotFound } from '../routes/NotFound';
import { PacketScreen } from '../routes/review/PacketScreen';
import { Settings } from '../routes/settings/Settings';
import { Unlock } from '../routes/unlock/Unlock';
import { Work } from '../routes/work/Work';
import { paths } from '../lib/paths';
import { AppShell } from './AppShell';

/**
 * The kit gallery ships only in dev builds and test builds (`vite --mode
 * test`), never in production: `import.meta.env` is replaced at build time,
 * so a production build drops the route and its chunk.
 */
export const DEV_KIT_ENABLED = import.meta.env.DEV || import.meta.env.MODE === 'test';

const KitGallery = DEV_KIT_ENABLED ? lazy(() => import('../routes/dev/kit')) : null;

export const shellRoutes: RouteObject[] = [
  { index: true, element: <NeedsYou /> },
  { path: 'work', element: <Work /> },
  { path: 'items/:id', element: <ItemPage /> },
  { path: 'review/:id', element: <PacketScreen /> },
  { path: 'labels/:project/:name', element: <LabelPage /> },
  { path: 'agents', element: <Agents /> },
  { path: 'settings', element: <Settings /> },
  { path: 'agent-files', element: <AgentFiles /> },
  { path: 'settings/agent-setup', element: <LegacyAgentSetup /> },
  { path: 'help', element: <HelpIndex /> },
  { path: 'help/:slug', element: <HelpArticlePage /> },
  { path: '*', element: <NotFound /> },
];

/**
 * The old Settings → Agent setup route (B21–B24) redirects to Agent files
 * (B25). Its `project` and `file` carry over; without a project it showed
 * the service-wide files, which are All projects' defaults now.
 */
function LegacyAgentSetup() {
  const [params] = useSearchParams();
  const project = params.get('project');
  const file = params.get('file');
  return (
    <Navigate
      replace
      to={paths.agentFiles({
        project: project && PROJECT_KEY_RE.test(project) ? project : 'all',
        file: file ?? undefined,
      })}
    />
  );
}

export function appRoutes(): RouteObject[] {
  const routes: RouteObject[] = [{ path: '/unlock', element: <Unlock /> }];
  if (KitGallery) {
    routes.push({
      path: '/dev/kit',
      element: (
        <Suspense fallback={null}>
          <KitGallery />
        </Suspense>
      ),
    });
  }
  routes.push({ path: '/', element: <AppShell />, children: shellRoutes });
  return routes;
}

export function createAppRouter() {
  return createBrowserRouter(appRoutes());
}
