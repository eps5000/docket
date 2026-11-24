/**
 * The route table (UI_SPEC §2 "Routes"). Every screen is routed; slices fill
 * them in. `/unlock` and the dev-only `/dev/kit` live outside the shell.
 */
import { lazy, Suspense } from 'react';
import {
  createBrowserRouter,
  Navigate,
  useLocation,
  useSearchParams,
  type RouteObject,
} from 'react-router';
import { PROJECT_KEY_RE } from '@docket/shared';
import { AgentFiles } from '../routes/agent-files/AgentFiles';
import { Agents } from '../routes/agents/Agents';
import { HelpArticlePage, HelpIndex } from '../routes/help/HelpPages';
import { ItemPage } from '../routes/items/ItemPage';
import { ProjectDecisionsPage } from '../routes/decisions/ProjectDecisionsPage';
import { LabelPage } from '../routes/labels/LabelPage';
import { NotFound } from '../routes/NotFound';
import { Overview } from '../routes/overview/Overview';
import { OverviewListPage } from '../routes/overview/OverviewListPage';
import { Brief } from '../routes/brief/Brief';
import { PacketScreen } from '../routes/review/PacketScreen';
import { Settings } from '../routes/settings/Settings';
import { SharedPartsPage } from '../routes/settings/SharedPartsPage';
import { Unlock } from '../routes/unlock/Unlock';
import { PickEpicPage } from '../routes/work/PickEpicPage';
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
  { index: true, element: <Overview /> },
  { path: 'overview', element: <Navigate replace to="/" /> },
  { path: 'overview/:metric', element: <OverviewListPage /> },
  { path: 'brief', element: <Brief /> },
  // Decision 43: Needs you is a section of Overview now; old links land on it.
  { path: 'needs-you', element: <LegacyNeedsYou /> },
  { path: 'work', element: <Work /> },
  { path: 'items/:id', element: <ItemPage /> },
  { path: 'review/:id', element: <PacketScreen /> },
  { path: 'labels/:project/:name', element: <LabelPage /> },
  // Decision 38: a project's Decisions page.
  { path: 'projects/:key/decisions', element: <ProjectDecisionsPage /> },
  { path: 'projects/:key/next-epic', element: <PickEpicPage /> },
  { path: 'agents', element: <Agents /> },
  { path: 'settings', element: <Settings /> },
  // Decision 36: Settings → Projects → <project> → Shared parts.
  { path: 'settings/projects/:key/shared-parts', element: <SharedPartsPage /> },
  { path: 'agent-files', element: <AgentFiles /> },
  { path: 'settings/agent-setup', element: <LegacyAgentSetup /> },
  { path: 'help', element: <HelpIndex /> },
  { path: 'help/:slug', element: <HelpArticlePage /> },
  { path: '*', element: <NotFound /> },
];

/** `/needs-you` → Overview, at the Needs you section, keeping any query. */
function LegacyNeedsYou() {
  const { search, hash } = useLocation();
  return <Navigate replace to={{ pathname: '/', search, hash: hash || '#needs-you' }} />;
}

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
