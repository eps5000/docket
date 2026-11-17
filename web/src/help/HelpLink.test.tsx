// @vitest-environment jsdom
/**
 * The contextual "?" and its side panel (UI_SPEC §6.7c, §11), and the Help
 * pages: a labelled dialog, Esc closes it and focus returns to the "?";
 * links to other articles open in the panel; *Open in Help* goes to the page.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { ShellStateProvider } from '../app/ShellState';
import { HelpArticlePage, HelpIndex } from '../routes/help/HelpPages';
import { helpSlugOf, HelpLink } from './HelpLink';

afterEach(cleanup);

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      {
        path: '/agents',
        element: (
          <div>
            <h2>Workspaces</h2>
            <HelpLink anchor="agents.workspaces" />
          </div>
        ),
      },
      { path: '/help', element: <HelpIndex /> },
      { path: '/help/:slug', element: <HelpArticlePage /> },
    ],
    { initialEntries: [path] },
  );
  render(
    <ShellStateProvider>
      <RouterProvider router={router} />
    </ShellStateProvider>,
  );
  return router;
}

describe('HelpLink', () => {
  it('opens the article in a labelled side panel; Esc closes it and focus returns', async () => {
    const user = userEvent.setup();
    renderAt('/agents');
    const q = screen.getByRole('button', { name: 'Help: Workspace states and safe pruning' });
    await user.click(q);
    const panel = screen.getByRole('dialog', { name: 'Workspace states and safe pruning' });
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(panel.contains(document.activeElement)).toBe(true);
    expect(within(panel).getByText(/Idle is not finished/)).toBeTruthy();
    expect(within(panel).getByRole('link', { name: 'Open in Help' }).getAttribute('href')).toBe(
      '/help/workspaces-and-pruning',
    );
    // The page underneath stays.
    expect(screen.getByRole('heading', { name: 'Workspaces', level: 2 })).toBeTruthy();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(q));
  });

  it('follows a link to another article inside the panel', async () => {
    const user = userEvent.setup();
    renderAt('/agents');
    await user.click(screen.getByRole('button', { name: /^Help: Workspace states/ }));
    const panel = screen.getByRole('dialog');
    // In the text: "see [Recovering after a crash](/help/crash-recovery)".
    const inText = within(panel)
      .getAllByRole('link', { name: 'Recovering after a crash' })
      .find((a) => a.closest('[data-markdown]'));
    expect(inText?.getAttribute('target')).toBeNull();
    await user.click(inText!);
    expect(screen.getByRole('dialog', { name: 'Recovering after a crash' })).toBeTruthy();
    // And through Related.
    const related = within(screen.getByRole('dialog')).getByRole('region', { name: 'Related' });
    await user.click(within(related).getByRole('link', { name: /^Workspace states/ }));
    expect(screen.getByRole('dialog', { name: 'Workspace states and safe pruning' })).toBeTruthy();
  });

  it('Open in Help goes to the article page and closes the panel', async () => {
    const user = userEvent.setup();
    const router = renderAt('/agents');
    await user.click(screen.getByRole('button', { name: /^Help: Workspace states/ }));
    await user.click(screen.getByRole('link', { name: 'Open in Help' }));
    expect(router.state.location.pathname).toBe('/help/workspaces-and-pruning');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      screen.getByRole('heading', { name: 'Workspace states and safe pruning', level: 1 }),
    ).toBeTruthy();
  });

  it('reads help slugs from links', () => {
    expect(helpSlugOf('/help/run-states')).toBe('run-states');
    expect(helpSlugOf('/help/run-states#leases')).toBe('run-states');
    expect(helpSlugOf('/agents')).toBeNull();
    expect(helpSlugOf('https://example.com/help/x')).toBeNull();
  });
});

describe('Help pages', () => {
  it('lists every article by group, and searching keeps the URL', async () => {
    const user = userEvent.setup();
    const router = renderAt('/help');
    expect(screen.getByRole('heading', { name: 'Help', level: 1 })).toBeTruthy();
    for (const g of [
      'Getting started',
      'Working with agents',
      'Recovery',
      'Planning',
      'Operations',
    ])
      expect(screen.getByRole('heading', { name: g, level: 2 })).toBeTruthy();

    await user.type(screen.getByRole('searchbox', { name: 'Search help' }), 'parked');
    expect(router.state.location.search).toBe('?q=parked');
    expect(
      screen.getByRole('link', { name: 'Run states: live, parked, stale and more' }),
    ).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Jira import' })).toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/match “parked”/);
  });

  it('says so when nothing matches', async () => {
    renderAt('/help?q=zebra');
    expect(screen.getByRole('status').textContent).toBe(
      'No articles match “zebra”. Try another word.',
    );
  });

  it('renders an article with Related links, and an unknown slug says so', async () => {
    renderAt('/help/run-states');
    expect(screen.getByRole('heading', { name: /^Run states/, level: 1 })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Related' })).toBeTruthy();
    cleanup();
    renderAt('/help/nope');
    expect(screen.getByRole('heading', { name: 'No such help article' })).toBeTruthy();
  });
});
