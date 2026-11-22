// @vitest-environment jsdom
/**
 * The shell against a fake server: every data route answers 501 (as today),
 * or 401 when locked.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../lib/persistence';
import { toasts } from '../lib/undo';
import { createAppQueryClient } from './queryClient';
import { appRoutes } from './router';
import { ShellStateProvider } from './ShellState';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let locked = false;
const calls: string[] = [];
/** When set, `GET /api/bootstrap` answers with these projects (B32's first run). */
let bootProjects: unknown[] | null = null;
/** When set, `GET /api/needs-you` answers with this (decision 41's badge). */
let needsYou: unknown = null;
const bootstrap = () => ({
  server_version: '0.0.0',
  server_time: '2026-11-18T10:00:00.000Z',
  projects: bootProjects,
  labels: [],
  counts: { for_you: 0, problems: 0, planning: 0, runs: {} },
  settings: { live_window_s: 180, stale_after_s: 900, lease_s: 1800, undo_window_s: 30 },
  health: { status: 'ready', checks: {} },
});

beforeEach(() => {
  locked = false;
  bootProjects = null;
  needsYou = null;
  calls.length = 0;
  sessionStorage.clear();
  localStorage.clear();
  toasts.reset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/api/session/unlock') return json(200, { unlocked: true });
      if (locked) return json(401, { error: { code: 'forbidden', message: 'Docket is locked.' } });
      const route = path.split('?')[0];
      if (route === '/api/bootstrap' && bootProjects) return json(200, bootstrap());
      if (route === '/api/needs-you' && needsYou) return json(200, needsYou);
      return json(501, {
        error: {
          code: 'unavailable',
          message: `Not implemented yet: ${init?.method ?? 'GET'} ${route}`,
        },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete document.body.dataset.theme;
});

function renderAt(path: string) {
  const router = createMemoryRouter(appRoutes(), { initialEntries: [path] });
  const queryClient = createAppQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <ShellStateProvider>
        <RouterProvider router={router} />
      </ShellStateProvider>
    </QueryClientProvider>,
  );
  return router;
}

describe('the Needs you count (owner decision 41)', () => {
  const project = {
    key: 'GF',
    name: 'Gameflow',
    short_name: 'Gameflow',
    color: '#336699',
    default_satisfied_when: 'done',
    version: 1,
    created_by: null,
  };
  const problem = (id: string, who: 'owner' | 'agent') => ({
    kind: 'parked_too_long',
    id,
    item_id: 'GF-1',
    title: 'One',
    reason: 'Parked',
    related: [],
    link_id: null,
    run_id: 'run_1',
    resource_ids: [],
    explanation: { what: 'w', fix: 'f', who, who_text: who },
    reached_you: who === 'owner' ? 'No coordinator or lead is on GF-1' : null,
  });
  const view = (over: Record<string, unknown>) => ({
    for_you_now: [],
    problems: [],
    deferred: [],
    planning_queue: [],
    agent_counts: {},
    ...over,
  });
  const nav = () => screen.getByRole('link', { name: /^Needs you/ });

  it('the badge, the tab title and the page agree; problems agents handle are not counted', async () => {
    bootProjects = [project];
    needsYou = view({
      problems: [problem('p1', 'owner'), problem('p2', 'owner')],
      agent_problems: [problem('p3', 'agent')],
    });
    renderAt('/');
    await waitFor(() => expect(nav().querySelector('.badge')?.textContent).toContain('2'));
    expect(document.title).toBe('(2) Docket');
    expect(
      document.querySelector('[data-needs-you-count]')?.getAttribute('data-needs-you-count'),
    ).toBe('2');
  });

  it('shows no badge at 0, even with problems agents are handling', async () => {
    bootProjects = [project];
    needsYou = view({ agent_problems: [problem('p3', 'agent')] });
    renderAt('/');
    await screen.findByRole('button', { name: 'Agents are handling 1 problem' });
    expect(nav().querySelector('.badge')).toBeNull();
    expect(document.title).toBe('Docket');
    expect(document.querySelector('[data-needs-you-count]')).toBeNull();
  });
});

describe('app shell', () => {
  it('renders the sidebar, header and a clean "not built yet" state for 501', async () => {
    renderAt('/');
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeTruthy();
    for (const name of ['Needs you', 'Work', 'Agents', 'Settings']) {
      expect(screen.getByRole('link', { name: new RegExp(`^${name}`) })).toBeTruthy();
    }
    expect(screen.getByRole('heading', { level: 1, name: 'Needs you' })).toBeTruthy();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Not built yet.');
    expect(alert.textContent).toContain('unavailable');
    expect(alert.textContent).toContain('Not implemented yet: GET /api/needs-you');
    expect(screen.getByRole('link', { name: 'Needs you' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' }).textContent).toBe(
      'All projects / Needs you',
    );
  });

  it('sends a locked browser to /unlock and back after unlocking', async () => {
    locked = true;
    const user = userEvent.setup();
    const router = renderAt('/agents');
    // Wait for what the owner sees, not for the router: React Router 7's
    // RouterProvider applies each navigation in React.startTransition, so
    // `router.state.location` changes before React commits the new page. A
    // DOM query right after waiting on the router raced that commit and
    // failed under CI load (PR #22). The router state is settled once the
    // page is on screen, so check it after.
    expect(await screen.findByRole('heading', { name: 'Unlock Docket' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/unlock');
    expect(router.state.location.search).toBe('?next=%2Fagents');
    locked = false;
    await user.type(screen.getByLabelText('Owner key'), 'ABCD');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Agents' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/agents');
    expect(calls).toContain('POST /api/session/unlock');
  });

  it('opens the palette with Ctrl K and /, and navigates with Go to', async () => {
    const user = userEvent.setup();
    const router = renderAt('/');
    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog', { name: 'Search or jump to' });
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Search' }));
    await user.keyboard('agents');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents'));
    expect(dialog.isConnected).toBe(false);
    await user.keyboard('/');
    expect(await screen.findByRole('dialog', { name: 'Search or jump to' })).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('cycles the theme System → Light → Dark and keeps it in localStorage', async () => {
    const user = userEvent.setup();
    renderAt('/');
    await user.click(screen.getByRole('button', { name: 'Theme: system. Switch theme' }));
    expect(document.body.dataset.theme).toBe('light');
    await user.click(screen.getByRole('button', { name: 'Theme: light. Switch theme' }));
    expect(document.body.dataset.theme).toBe('dark');
    expect(localStorage.getItem(STORAGE_KEYS.theme)).toBe('dark');
    await user.click(screen.getByRole('button', { name: 'Theme: dark. Switch theme' }));
    expect(document.body.dataset.theme).toBeUndefined();
    expect(localStorage.getItem(STORAGE_KEYS.theme)).toBeNull();
  });

  it('opens an item tab per visited item and remembers its view tab', async () => {
    const user = userEvent.setup();
    const router = renderAt('/items/RCP-14');
    const strip = await screen.findByRole('navigation', { name: 'Open items' });
    expect(strip.textContent).toContain('RCP-14');
    await user.click(screen.getByRole('tab', { name: 'Activity' }));
    expect(router.state.location.search).toBe('?tab=activity');
    await act(() => router.navigate('/items/RCP-12'));
    await act(() => router.navigate('/work'));
    expect(screen.getByRole('link', { name: 'RCP-14' }).getAttribute('href')).toBe(
      '/items/RCP-14?tab=activity',
    );
    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEYS.openTabs)!).tabs).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Close RCP-12' }));
    expect(screen.queryByRole('link', { name: 'RCP-12' })).toBeNull();
  });

  it('Quick capture: an empty title toasts "Give it a title" and focuses the title', async () => {
    const user = userEvent.setup();
    renderAt('/');
    await user.click(screen.getByRole('button', { name: '+ New item' }));
    const title = screen.getByLabelText(/^Title/);
    expect(document.activeElement).toBe(title);
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(toasts.snapshot().map((t) => t.message)).toContain('Give it a title');
    expect(document.activeElement).toBe(title);
  });

  it('first run (B32): no projects → the Welcome page, + New project, pointers on Work', async () => {
    bootProjects = [];
    const user = userEvent.setup();
    const router = renderAt('/');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Welcome to Docket' }),
    ).toBeTruthy();
    expect(screen.getByText('The shared record your AI agents work from.')).toBeTruthy();
    for (const name of ['Create a project', 'Import from Jira', 'Onboard a repo with an agent'])
      expect(screen.getByRole('heading', { level: 2, name })).toBeTruthy();
    expect(
      screen.getByText('Onboard this repo into Docket as project <KEY>, using onboard_project.'),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Connect an agent' }).getAttribute('href')).toBe(
      '/help/connect-an-agent',
    );
    expect(screen.getByRole('button', { name: 'Help: Your first look around' })).toBeTruthy();
    // The header button says what it creates: with no projects, a project.
    expect(screen.queryByRole('button', { name: '+ New item' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '+ New project' }));
    expect(screen.getByRole('dialog', { name: 'New project' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'New project' }));
    expect(screen.getByRole('dialog', { name: 'New project' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    // The switcher ends with + New project.
    await user.click(screen.getByRole('button', { name: /^Project/ }));
    const menu = screen.getByRole('menu', { name: 'Choose project' });
    const items = menu.querySelectorAll('[role="menuitemradio"], [role="menuitem"]');
    expect(items[items.length - 1]!.textContent).toBe('New project');
    expect(menu.querySelector('[role="separator"]')).toBeTruthy();
    await user.keyboard('{Escape}');
    // Work shows a pointer back to the Welcome page.
    await act(() => router.navigate('/work'));
    expect(await screen.findByText(/No projects yet\./)).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Start on the Welcome page' }).getAttribute('href'),
    ).toBe('/');
  });

  it('with projects (B32): + New item stays one click, its caret offers item or project', async () => {
    bootProjects = [
      {
        key: 'RCP',
        name: 'Recipes',
        short_name: 'Recipes',
        color: '#3b5bdb',
        default_satisfied_when: 'done',
        version: 1,
      },
    ];
    const user = userEvent.setup();
    renderAt('/settings');
    const caret = await screen.findByRole('button', { name: 'More to create' });
    expect(screen.getByRole('button', { name: '+ New item' }).getAttribute('title')).toBe(
      'New item: capture it in Inbox',
    );
    await user.click(caret);
    const menu = screen.getByRole('menu', { name: 'Create' });
    expect(
      Array.from(menu.querySelectorAll('[role="menuitem"]')).map((b) => b.firstChild?.textContent),
    ).toEqual(['New item', 'New project']);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(screen.getByRole('dialog', { name: 'New project' })).toBeTruthy();
  });

  it('keeps scope in sessionStorage and resets to All projects in a new session', () => {
    sessionStorage.setItem(STORAGE_KEYS.scope, 'RCP');
    renderAt('/');
    expect(screen.getByRole('button', { name: 'Project RCP' })).toBeTruthy();
    cleanup();
    sessionStorage.clear();
    renderAt('/');
    expect(screen.getByRole('button', { name: 'Project All projects' })).toBeTruthy();
  });
});
