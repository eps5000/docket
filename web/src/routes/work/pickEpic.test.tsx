// @vitest-environment jsdom
/**
 * B70 (owner decision 54): the sort, the table's groups and Best next, the
 * empty states, and the epic indicator in words.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EpicPick, EpicWait, PickEpicResponse } from '@docket/shared';
import type * as QueryClientModule from '../../app/queryClient';
import type * as ShellStateModule from '../../app/ShellState';
import { EpicDepsLine, EpicDepsNote, epicDepsNames, epicDepsText } from '../../components/kit';
import { nextSort, sortPicks } from './pickEpicSort';
import { PickEpicPage } from './PickEpicPage';

const api = vi.hoisted(() => ({ pick: vi.fn() }));
vi.mock('../../app/queryClient', async (original) => ({
  ...(await original<typeof QueryClientModule>()),
  apiClient: { 'projects.pickEpic': api.pick },
}));
vi.mock('../../app/useBootstrap', () => ({
  useBootstrap: () => ({ data: { projects: [{ key: 'TST', name: 'Test project' }] } }),
}));
vi.mock('../../app/ShellState', async (original) => ({
  ...(await original<typeof ShellStateModule>()),
  useBreadcrumb: () => undefined,
}));

afterEach(cleanup);

const pick = (id: string, over: Partial<EpicPick> = {}): EpicPick => ({
  id,
  title: `Epic ${id}`,
  status: 'progress',
  priority: 2,
  open: 4,
  self_contained: 4,
  can_start: { count: 1, first: [{ id: `${id}-T`, title: 'A ticket' }] },
  waits_on: [],
  unblocks_elsewhere: 0,
  not_shaped: 0,
  worked_by: [],
  fit: 'available',
  park_reason: null,
  ...over,
});

const FULL: PickEpicResponse = {
  project: 'TST',
  paused: false,
  best: { id: 'E-1', reason: 'Nothing outside this epic blocks it.' },
  epics: [
    pick('E-1', { unblocks_elsewhere: 5 }),
    pick('E-2', { unblocks_elsewhere: 9, self_contained: 3 }),
    pick('E-3', { fit: 'being_worked', worked_by: [{ who: 'agent-a', role: 'lead', items: [] }] }),
    pick('E-4', {
      fit: 'likely_parks',
      park_reason: 'Nothing can start: 2 of 4 tickets wait on work outside this epic.',
      can_start: { count: 0, first: [] },
      self_contained: 2,
      waits_on: [
        { epic: 'E-1', title: 'Epic E-1', tickets: 2 },
        { epic: null, title: null, tickets: 1 },
      ],
    }),
  ],
};

function show(data: PickEpicResponse) {
  api.pick.mockResolvedValue(data);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/projects/TST/next-epic']}>
        <Routes>
          <Route path="/projects/:key/next-epic" element={<PickEpicPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const ids = (group: Element) =>
  [...group.querySelectorAll('[data-pick-row]')].map((r) => r.getAttribute('data-pick-row'));

describe('sorting', () => {
  it('sorts, reverses, then returns to the best-fit order', () => {
    let s = nextSort(null, 'unblocks');
    expect(s).toEqual({ key: 'unblocks', dir: 'desc' });
    s = nextSort(s, 'unblocks');
    expect(s).toEqual({ key: 'unblocks', dir: 'asc' });
    expect(nextSort(s, 'unblocks')).toBeNull();
    expect(nextSort(s, 'title')).toEqual({ key: 'title', dir: 'asc' });
  });

  it('keeps best-fit order on ties and with no sort', () => {
    const rows = [pick('A'), pick('B', { unblocks_elsewhere: 2 }), pick('C')];
    expect(sortPicks(rows, null).map((r) => r.id)).toEqual(['A', 'B', 'C']);
    expect(sortPicks(rows, { key: 'unblocks', dir: 'desc' }).map((r) => r.id)).toEqual([
      'B',
      'A',
      'C',
    ]);
    expect(sortPicks(rows, { key: 'unblocks', dir: 'asc' }).map((r) => r.id)).toEqual([
      'A',
      'C',
      'B',
    ]);
  });
});

describe('the table', () => {
  it('marks Best next with its reason and separates the groups', async () => {
    const { container } = show(FULL);
    const best = (await screen.findByText('Best next')).closest('tr')!;
    expect(best.getAttribute('data-pick-row')).toBe('E-1');
    expect(within(best).getByText('Nothing outside this epic blocks it.')).toBeTruthy();
    expect(
      [...container.querySelectorAll('tbody')].map((g) => g.getAttribute('data-pick-group')),
    ).toEqual(['available', 'being_worked', 'likely_parks']);
    expect(screen.getByText('Likely to park · 1')).toBeTruthy();
    expect(screen.getByText(/2 of 4 tickets wait on work outside/)).toBeTruthy();
    expect(screen.getAllByText('Based on dependencies recorded in Docket.')).toHaveLength(1);
  });

  it('links each row to its epic, its critical path and what it waits on', async () => {
    const { container } = show(FULL);
    await screen.findByText('Best next');
    const row = container.querySelector('[data-pick-row="E-4"]') as HTMLElement;
    expect(within(row).getByRole('link', { name: 'Epic E-4' }).getAttribute('href')).toBe(
      '/items/E-4',
    );
    expect(
      within(row).getByRole('link', { name: 'Critical path for Epic E-4' }).getAttribute('href'),
    ).toBe('/items/E-4?tab=map&goal=E-4');
    expect(within(row).getByRole('link', { name: 'Epic E-1' }).getAttribute('href')).toBe(
      '/items/E-1',
    );
    expect(within(row).getByText('No epic')).toBeTruthy();
  });

  it('sorts inside each group from the column header, and says so', async () => {
    const user = userEvent.setup();
    const { container } = show(FULL);
    await screen.findByText('Best next');
    const group = container.querySelector('[data-pick-group="available"]')!;
    expect(ids(group)).toEqual(['E-1', 'E-2']);
    await user.click(screen.getByRole('button', { name: 'Unblocks elsewhere' }));
    expect(ids(group)).toEqual(['E-2', 'E-1']);
    expect(
      screen.getByRole('columnheader', { name: /Unblocks elsewhere/ }).getAttribute('aria-sort'),
    ).toBe('descending');
    expect(
      container.querySelectorAll('[data-pick-group="likely_parks"] [data-pick-row]'),
    ).toHaveLength(1);
  });

  it('says "once resumed" in a paused project, and doesn’t show zero', async () => {
    show({ ...FULL, paused: true });
    expect(await screen.findByRole('button', { name: 'Can start once resumed' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Can start now' })).toBeNull();
    expect(screen.getByText(/could start once you resume it/)).toBeTruthy();
  });

  it('says so when no epic qualifies', async () => {
    show({ ...FULL, best: null, epics: [FULL.epics[3]!] });
    expect(await screen.findByText(/No epic is free to hand off/)).toBeTruthy();
    expect(screen.queryByText('Best next')).toBeNull();
  });

  it('has an empty state', async () => {
    show({ ...FULL, best: null, epics: [] });
    expect(await screen.findByText(/No open epic has open tickets yet/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('the indicator', () => {
  const two: EpicWait[] = [
    { epic: 'E-1', title: 'Foundations', tickets: 3 },
    { epic: 'E-2', title: 'Billing', tickets: 1 },
  ];
  const loose: EpicWait = { epic: null, title: null, tickets: 2 };

  it.each([
    [[], 'No outside dependencies'],
    [two.slice(0, 1), 'Waits on 1 epic'],
    [two, 'Waits on 2 epics'],
    [[loose], 'Waits on 2 tickets with no epic'],
    [[...two, loose], 'Waits on 2 epics and 2 tickets with no epic'],
  ])('%j reads "%s"', (waits, text) => {
    expect(epicDepsText(waits)).toBe(text);
  });

  it('keeps the names available on the card, in words', () => {
    const { container } = render(<EpicDepsNote waits={[...two, loose]} />);
    const note = container.querySelector('[data-epic-deps="waits"]')!;
    const names = epicDepsNames([...two, loose]);
    expect(names).toBe('Foundations (3 tickets), Billing (1 ticket), no epic (2 tickets)');
    expect(note.getAttribute('title')).toBe(names);
    expect(note.querySelector('.sr')!.textContent).toContain(names);
  });

  it('links each epic on the epic page', () => {
    render(
      <MemoryRouter>
        <EpicDepsLine waits={two} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Foundations' }).getAttribute('href')).toBe(
      '/items/E-1',
    );
    expect(screen.getByRole('link', { name: 'Billing' }).getAttribute('href')).toBe('/items/E-2');
  });
});
