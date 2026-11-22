// @vitest-environment jsdom
/**
 * Decision 38 (B44): a ticket or epic lists its own scopes' decisions and
 * one "N project decisions also apply · View" line instead of the project
 * ones; the project Decisions page with *All* / *Needs your review*, its
 * actions and their Undo, and `?decision=`; the Needs you cards (one per new
 * agent project decision, one grouped card for older ones) and the
 * switcher's *Project decisions*.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { createMemoryRouter, MemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionRecord } from '@docket/shared';
import { createAppQueryClient } from '../../app/queryClient';
import { appRoutes } from '../../app/router';
import { ShellStateProvider } from '../../app/ShellState';
import { STORAGE_KEYS } from '../../lib/persistence';
import { toasts } from '../../lib/undo';
import { DecisionsPanel } from '../shared/DecisionsPanel';
import { ProjectDecisionCards } from '../needs-you/ProjectDecisionCards';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const rec = (id: string, over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  id,
  project: 'RCP',
  scope: { kind: 'project', id: null },
  title: `Title ${id}`,
  decision_md: `Text of ${id}.`,
  rationale_md: null,
  authority: 'agent',
  author: 'claude',
  status: 'active',
  supersedes_id: null,
  superseded_by_id: null,
  created_at: '2026-11-20T10:00:00.000Z',
  confirmed_at: null,
  version: 1,
  ...over,
});

let pageRecords: DecisionRecord[] = [];
const calls: { method: string; path: string; body: unknown }[] = [];

beforeEach(() => {
  toasts.reset();
  calls.length = 0;
  sessionStorage.clear();
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      const method = init?.method ?? 'GET';
      calls.push({
        method,
        path,
        body: init?.body ? (JSON.parse(String(init.body)) as unknown) : null,
      });
      const route = path.split('?')[0];
      if (route === '/api/bootstrap') {
        return json(200, {
          server_version: '0.0.0',
          server_time: '2026-11-20T10:00:00.000Z',
          projects: [
            {
              key: 'RCP',
              name: 'Sample · Recipe App',
              short_name: 'Recipes',
              color: '#3b5bdb',
              default_satisfied_when: 'done',
              version: 1,
            },
          ],
          labels: [],
          counts: { for_you: 0, problems: 0, planning: 0, runs: {} },
          settings: { live_window_s: 180, stale_after_s: 900, lease_s: 1800, undo_window_s: 30 },
          health: { status: 'ready', checks: {} },
        });
      }
      if (route === '/api/decisions' && method === 'GET') {
        return json(200, { items: pageRecords, next_cursor: null });
      }
      const confirm = /^\/api\/decisions\/([^/]+)\/confirm$/.exec(route ?? '');
      if (confirm) {
        return json(200, {
          mutation_id: 'mut_1',
          decision: rec(confirm[1]!, { authority: 'owner' }),
        });
      }
      if (route === '/api/decisions/acknowledge') {
        return json(200, { mutation_id: 'mut_2', decisions: [] });
      }
      if (route?.startsWith('/api/mutations/')) return json(200, { undone: true });
      return json(501, { error: { code: 'unavailable', message: `No fake for ${route}` } });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function wrap(children: ReactNode) {
  const client = createAppQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderAt(path: string) {
  const router = createMemoryRouter(appRoutes(), { initialEntries: [path] });
  render(
    <QueryClientProvider client={createAppQueryClient()}>
      <ShellStateProvider>
        <RouterProvider router={router} />
      </ShellStateProvider>
    </QueryClientProvider>,
  );
  return router;
}

const rowTitles = (root: HTMLElement) =>
  Array.from(root.querySelectorAll('.decrow .dt')).map((e) => e.textContent);

describe('ticket and epic Decisions: own scopes, project ones as one line', () => {
  const ticket = {
    kind: 'ticket' as const,
    project: 'RCP',
    id: 'RCP-12',
    epic: { id: 'RCP-1', title: 'Meal planning MVP' },
  };
  const records = [
    rec('dec_p1', { title: 'Prototypes for owner review' }),
    rec('dec_p2', { title: 'Open with no commands', authority: 'owner', author: 'owner' }),
    rec('dec_p3', { title: 'Old project rule', status: 'withdrawn' }),
    rec('dec_e', { title: 'Units are metric', scope: { kind: 'epic', id: 'RCP-1' } }),
    rec('dec_l', { title: 'Tokens v2', scope: { kind: 'label', id: 'ui-refresh' } }),
    rec('dec_i', { title: 'Drop targets 44 px', scope: { kind: 'item', id: 'RCP-12' } }),
    rec('dec_i2', {
      title: 'Old item rule',
      scope: { kind: 'item', id: 'RCP-12' },
      status: 'superseded',
    }),
  ];

  it('lists the item, epic and label decisions with chips, and counts the active project ones', async () => {
    const user = userEvent.setup();
    wrap(<DecisionsPanel place={ticket} records={records} hideWhenEmpty />);
    const sec = document.querySelector('section[data-section="decisions"]') as HTMLElement;
    expect(rowTitles(sec)).toEqual(['Units are metric', 'Tokens v2', 'Drop targets 44 px']);
    expect(sec.textContent).toContain('◆ Meal planning MVP');
    expect(sec.textContent).toContain('#ui-refresh');
    expect(sec.textContent).toContain('This item');
    expect(sec.textContent).not.toContain('Prototypes for owner review');
    expect(within(sec).queryByText('Project')).toBeNull();
    // The header counts what's listed.
    expect(sec.querySelector('.sechead')!.textContent).toContain('3 in scope · 3 by agents');
    // Two active project decisions (the withdrawn one doesn't count).
    const line = sec.querySelector('[data-also-apply]') as HTMLElement;
    expect(line.textContent).toBe('2 project decisions also apply · View');
    const view = within(line).getByRole('link', { name: 'View RCP project decisions' });
    expect(view.getAttribute('href')).toBe('/projects/RCP/decisions');
    // The toggle covers only what's listed: one superseded item record.
    await user.click(
      within(sec).getByRole('button', { name: 'Show withdrawn and superseded (1)' }),
    );
    expect(rowTitles(sec)).toEqual([
      'Units are metric',
      'Tokens v2',
      'Drop targets 44 px',
      'Old item rule',
    ]);
  });

  it('with only project decisions, a ticket shows the line alone; with none, nothing', () => {
    const { unmount } = wrap(
      <DecisionsPanel place={ticket} records={[records[0]!]} hideWhenEmpty />,
    );
    const sec = document.querySelector('section[data-section="decisions"]') as HTMLElement;
    expect(sec.querySelector('[data-also-apply]')!.textContent).toBe(
      '1 project decision also applies · View',
    );
    expect(sec.querySelector('.empty')).toBeNull();
    expect(rowTitles(sec)).toEqual([]);
    unmount();
    wrap(<DecisionsPanel place={ticket} records={[records[2]!]} hideWhenEmpty />);
    expect(document.querySelector('section[data-section="decisions"]')).toBeNull();
  });

  it('an epic lists its own and its labels’, with "This epic" and "#label" chips', () => {
    wrap(
      <DecisionsPanel
        place={{ kind: 'epic', project: 'RCP', id: 'RCP-1', title: 'Meal planning MVP' }}
        records={records.filter((r) => r.scope.kind !== 'item')}
      />,
    );
    const sec = document.querySelector('section[data-section="decisions"]') as HTMLElement;
    expect(rowTitles(sec)).toEqual(['Units are metric', 'Tokens v2']);
    const chips = Array.from(sec.querySelectorAll('.decrow .chip')).map((c) => c.textContent);
    expect(chips).toEqual(['This epic', '#ui-refresh']);
    expect(sec.querySelector('[data-also-apply]')!.textContent).toBe(
      '2 project decisions also apply · View',
    );
  });

  it('a label or project section lists what it is given, with no line', () => {
    wrap(
      <DecisionsPanel
        place={{ kind: 'project', project: 'RCP', name: 'Recipes' }}
        records={records.filter((r) => r.scope.kind === 'project')}
      />,
    );
    const sec = document.querySelector('section[data-section="decisions"]') as HTMLElement;
    expect(rowTitles(sec)).toEqual(['Prototypes for owner review', 'Open with no commands']);
    expect(sec.querySelector('[data-also-apply]')).toBeNull();
  });
});

describe('the project Decisions page', () => {
  beforeEach(() => {
    pageRecords = [
      rec('dec_o', { title: 'Follow the constitution', authority: 'owner', author: 'owner' }),
      rec('dec_a', { title: 'Prototypes for owner review' }),
      rec('dec_w', { title: 'Withdrawn one', status: 'withdrawn' }),
    ];
  });

  it('lists every project decision; Needs your review shows agents’ unconfirmed ones', async () => {
    const user = userEvent.setup();
    const router = renderAt('/projects/RCP/decisions');
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Project decisions · Sample · Recipe App',
      }),
    ).toBeTruthy();
    // waitFor only retries on a throw, so a section not rendered yet must fail the check.
    const sec = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('section[data-section="decisions"]');
      expect(el).not.toBeNull();
      return el!;
    });
    await waitFor(() =>
      expect(rowTitles(sec)).toEqual(['Follow the constitution', 'Prototypes for owner review']),
    );
    expect(calls.find((c) => c.path.startsWith('/api/decisions?'))!.path).toContain(
      'scope_kind=project',
    );
    const review = screen.getByRole('button', { name: 'Needs your review (1)' });
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true');
    await user.click(review);
    expect(review.getAttribute('aria-pressed')).toBe('true');
    expect(router.state.location.search).toBe('?filter=review');
    const after = document.querySelector('section[data-section="decisions"]') as HTMLElement;
    expect(rowTitles(after)).toEqual(['Prototypes for owner review']);
    expect(within(after).queryByRole('button', { name: /Show withdrawn/ })).toBeNull();
    // + Record a decision is scoped to the project.
    await user.click(within(after).getByRole('button', { name: '+ Record a decision' }));
    expect(after.querySelector('[data-scope]')!.textContent).toBe('Project');
  });

  it('Confirm posts with the version and offers Undo', async () => {
    const user = userEvent.setup();
    renderAt('/projects/RCP/decisions?filter=review');
    const row = await waitFor(() => {
      const el = document.querySelector('[data-decision="dec_a"]') as HTMLElement | null;
      expect(el).toBeTruthy();
      return el!;
    });
    await user.click(within(row).getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(calls.some((c) => c.path === '/api/decisions/dec_a/confirm')).toBe(true),
    );
    expect(calls.find((c) => c.path === '/api/decisions/dec_a/confirm')!.body).toEqual({
      expected_version: 1,
    });
    const toast = await waitFor(() => {
      const t = toasts.snapshot().find((x) => x.message.startsWith('Confirmed'));
      expect(t?.onUndo).toBeTruthy();
      return t!;
    });
    expect(toast.message).toBe(
      'Confirmed “Prototypes for owner review”. It is now an owner decision.',
    );
    act(() => toast.onUndo!());
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path === '/api/mutations/mut_1/undo')).toBe(
        true,
      ),
    );
  });

  it('?decision= focuses that record', async () => {
    renderAt('/projects/RCP/decisions?decision=dec_a');
    await waitFor(() => {
      const el = document.querySelector('[data-decision="dec_a"]');
      expect(document.activeElement).toBe(el);
      expect(el!.classList.contains('focused')).toBe(true);
    });
  });

  it('?decision= keeps focus when the records are already cached (the shell moves it first)', async () => {
    const router = renderAt('/projects/RCP/decisions');
    await waitFor(() => expect(document.querySelector('[data-decision="dec_a"]')).toBeTruthy());
    await act(() => router.navigate('/settings'));
    await act(() => router.navigate('/projects/RCP/decisions?decision=dec_a'));
    await waitFor(() =>
      expect(document.activeElement).toBe(document.querySelector('[data-decision="dec_a"]')),
    );
  });

  it('?decision= on a withdrawn record shows the inactive ones, so the link lands', async () => {
    renderAt('/projects/RCP/decisions?decision=dec_w');
    await waitFor(() =>
      expect(document.activeElement).toBe(document.querySelector('[data-decision="dec_w"]')),
    );
    expect(screen.getByRole('button', { name: /^Hide withdrawn and superseded/ })).toBeTruthy();
  });

  it('stays open when Decisions was collapsed on a ticket, and shows which filter is on', async () => {
    localStorage.setItem(STORAGE_KEYS.collapsed, JSON.stringify({ decisions: true }));
    renderAt('/projects/RCP/decisions?decision=dec_a');
    await waitFor(() =>
      expect(document.activeElement).toBe(document.querySelector('[data-decision="dec_a"]')),
    );
    const sec = document.querySelector('section[data-section="decisions"]') as HTMLElement;
    expect(sec.querySelector('button.sectog')).toBeNull();
    expect(within(sec).getByRole('heading', { name: 'Decisions' })).toBeTruthy();
    const group = screen.getByRole('group', { name: 'Show decisions' });
    expect(group.classList.contains('seg')).toBe(true);
  });

  it('an unknown project says so', async () => {
    renderAt('/projects/NOPE/decisions');
    expect(await screen.findByText(/There’s no project NOPE\./)).toBeTruthy();
  });

  it('the switcher offers Project decisions once a project is chosen', async () => {
    const user = userEvent.setup();
    const router = renderAt('/settings');
    // All projects: no Project decisions entry.
    await user.click(await screen.findByRole('button', { name: /^Project/ }));
    const menu = screen.getByRole('menu', { name: 'Choose project' });
    const entries = (m: HTMLElement) =>
      Array.from(m.querySelectorAll('[role="menuitem"]')).map((b) => b.textContent);
    expect(entries(menu)).toEqual(['New project']);
    await user.click(within(menu).getByRole('menuitemradio', { name: /Recipes/ }));
    await user.click(screen.getByRole('button', { name: /^Project/ }));
    const again = screen.getByRole('menu', { name: 'Choose project' });
    expect(entries(again)).toEqual(['Project decisions', 'New project']);
    await user.click(within(again).getByRole('menuitem', { name: 'Project decisions' }));
    expect(router.state.location.pathname).toBe('/projects/RCP/decisions');
  });
});

describe('Needs you: agents’ project-wide decisions', () => {
  it('a card per new decision: the text, the reason, Confirm, Withdraw…, Acknowledge and Open', async () => {
    const user = userEvent.setup();
    wrap(
      <ProjectDecisionCards
        cards={[
          rec('dec_n', {
            title: 'Prototypes for owner review',
            author: 'claude · orca-w3',
            decision_md: 'Build a prototype first.',
            rationale_md: 'The owner reviews UI early.',
          }),
        ]}
        groups={[]}
      />,
    );
    const card = document.querySelector('[data-project-decision-card="dec_n"]') as HTMLElement;
    const c = within(card);
    expect(
      c.getByRole('heading', {
        name: 'New project-wide decision by claude · orca-w3: Prototypes for owner review',
      }),
    ).toBeTruthy();
    expect(c.getByText('Build a prototype first.')).toBeTruthy();
    expect(card.querySelector('.pdec-why')!.textContent).toBe('Why: The owner reviews UI early.');
    expect(c.getByRole('link', { name: 'Open' }).getAttribute('href')).toBe(
      '/projects/RCP/decisions?decision=dec_n',
    );
    // Withdraw… asks for an optional reason inline.
    await user.click(c.getByRole('button', { name: 'Withdraw…' }));
    expect(document.activeElement).toBe(c.getByLabelText('Reason for withdrawing (optional)'));
    await user.click(c.getByRole('button', { name: 'Keep it' }));
    await user.click(c.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() =>
      expect(calls.find((x) => x.path === '/api/decisions/acknowledge')?.body).toEqual({
        decision_ids: ['dec_n'],
      }),
    );
    await waitFor(() =>
      expect(toasts.snapshot().map((t) => t.message)).toContain(
        'Acknowledged “Prototypes for owner review”. It stays an agent decision.',
      ),
    );
    expect(c.getByRole('button', { name: 'Confirm' })).toBeTruthy();
  });

  it('older ones share one card: the first 3 titles, Review and Acknowledge all', async () => {
    const user = userEvent.setup();
    const decisions = ['A', 'B', 'C', 'D'].map((t) => ({
      id: `dec_${t}`,
      title: `Rule ${t}`,
      author: 'codex',
    }));
    wrap(<ProjectDecisionCards cards={[]} groups={[{ project: 'RCP', decisions }]} />);
    const card = document.querySelector('[data-project-decision-group="RCP"]') as HTMLElement;
    const c = within(card);
    expect(
      c.getByRole('heading', { name: '4 project-wide decisions by agents to review' }),
    ).toBeTruthy();
    expect(Array.from(card.querySelectorAll('.pdec-list li')).map((l) => l.textContent)).toEqual([
      'Rule A · codex',
      'Rule B · codex',
      'Rule C · codex',
      'and 1 more',
    ]);
    expect(c.getByRole('link', { name: 'Review' }).getAttribute('href')).toBe(
      '/projects/RCP/decisions?filter=review',
    );
    await user.click(c.getByRole('button', { name: 'Acknowledge all' }));
    await waitFor(() =>
      expect(calls.find((x) => x.path === '/api/decisions/acknowledge')?.body).toEqual({
        decision_ids: ['dec_A', 'dec_B', 'dec_C', 'dec_D'],
      }),
    );
  });

  it('nothing to review renders nothing', () => {
    const { container } = wrap(<ProjectDecisionCards cards={[]} groups={[]} />);
    expect(container.querySelector('[data-card="project-decisions"]')).toBeNull();
  });
});
