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

beforeEach(() => {
  locked = false;
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
      if (locked)
        return json(401, { error: { code: 'forbidden', message: 'Task Lite is locked.' } });
      const route = path.split('?')[0];
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
    await waitFor(() => expect(router.state.location.pathname).toBe('/unlock'));
    expect(router.state.location.search).toBe('?next=%2Fagents');
    expect(screen.getByRole('heading', { name: 'Unlock Task Lite' })).toBeTruthy();
    locked = false;
    await user.type(screen.getByLabelText('Owner key'), 'ABCD');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents'));
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
    await user.click(screen.getByRole('button', { name: '+ New' }));
    const title = screen.getByLabelText(/^Title/);
    expect(document.activeElement).toBe(title);
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(toasts.snapshot().map((t) => t.message)).toContain('Give it a title');
    expect(document.activeElement).toBe(title);
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
