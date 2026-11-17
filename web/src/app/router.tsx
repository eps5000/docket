/**
 * The route table (UI_SPEC §2 "Routes"). Every screen is routed; slices fill
 * them in. `/unlock` and the dev-only `/dev/kit` live outside the shell.
 */
import { lazy, Suspense } from 'react';
import { createBrowserRouter, type RouteObject } from 'react-router';
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
  { path: 'settings/agent-setup', element: <Settings /> },
  { path: 'help', element: <HelpIndex /> },
  { path: 'help/:slug', element: <HelpArticlePage /> },
  { path: '*', element: <NotFound /> },
];

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
