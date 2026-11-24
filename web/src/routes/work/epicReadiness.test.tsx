// @vitest-environment jsdom
/**
 * B74 (owner decision 58): Pick next epic's Not ready to start group, the epic
 * card's quiet line, the epic page's links, and the ticket's Known gaps.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  EpicCard as EpicCardData,
  EpicPick,
  ItemDetailResponse,
  PickEpicResponse,
} from '@docket/shared';
import type * as QueryClientModule from '../../app/queryClient';
import type * as ShellStateModule from '../../app/ShellState';
import { EpicCard, EpicReadinessLine } from '../../components/kit';
import { KnownGapsSection } from '../items/details/KnownGapsSection';
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

const UNSHAPED = [
  { id: 'TST-3', title: 'Shape the import screen', status: 'planning' as const },
  { id: 'TST-5', title: 'An idea for later', status: 'inbox' as const },
];

const pick = (id: string, over: Partial<EpicPick> = {}): EpicPick => ({
  id,
  title: `Epic ${id}`,
  status: 'ready',
  priority: 2,
  open: 4,
  self_contained: 4,
  can_start: { count: 1, first: [] },
  waits_on: [],
  waiting: { queued: 0, blocked: 0 },
  unblocks_elsewhere: 0,
  not_shaped: 0,
  worked_by: [],
  fit: 'available',
  park_reason: null,
  ...over,
});

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

describe('Pick next epic (decision 58)', () => {
  it('puts an epic with unshaped tickets under Not ready to start, with links, never Best next', async () => {
    const { container } = show({
      project: 'TST',
      paused: false,
      best: { id: 'E-1', reason: 'Nothing outside this epic blocks it.' },
      epics: [
        pick('E-1'),
        pick('E-2', {
          fit: 'not_ready',
          not_shaped: 2,
          readiness: { state: 'not_ready', unshaped: UNSHAPED },
        }),
      ],
    });
    await screen.findByText('Best next');
    const group = container.querySelector('[data-pick-group="not_ready"]')!;
    expect(within(group as HTMLElement).getByText('Not ready to start · 1')).toBeTruthy();
    const row = group.querySelector('[data-pick-row="E-2"]') as HTMLElement;
    expect(row.hasAttribute('data-best-next')).toBe(false);
    expect(within(row).getByText(/Not ready to start: 2 unshaped tickets/)).toBeTruthy();
    expect(within(row).getByRole('link', { name: 'TST-3' }).getAttribute('href')).toBe(
      '/items/TST-3',
    );
    expect(within(row).getByRole('link', { name: 'TST-5' })).toBeTruthy();
  });

  it('says Started with N unshaped tickets on an epic already in progress', async () => {
    show({
      project: 'TST',
      paused: false,
      best: null,
      epics: [
        pick('E-3', {
          status: 'progress',
          fit: 'being_worked',
          worked_by: [{ who: 'producer-a', role: 'producer', items: ['E-3'] }],
          readiness: { state: 'started_unshaped', unshaped: UNSHAPED.slice(0, 1) },
        }),
      ],
    });
    expect(await screen.findByText(/Started with 1 unshaped ticket/)).toBeTruthy();
  });
});

const card = (over: Partial<EpicCardData> = {}): EpicCardData =>
  ({
    id: 'TST-1',
    title: 'Synthetic epic',
    type: 'Epic',
    status: 'ready',
    children: { total: 3, done: 0, by_status: { ready: 1 }, for_you: 0, queued: 0, blocked: 0 },
    ...over,
  }) as EpicCardData;

describe('the epic card and page (decision 58)', () => {
  it('the card says Not ready to start in words, one link with the tickets as its tooltip', () => {
    render(
      <MemoryRouter>
        <EpicCard epic={card({ readiness: { state: 'not_ready', unshaped: UNSHAPED } })} />
      </MemoryRouter>,
    );
    const note = screen.getByText(/Not ready to start: 2 unshaped tickets/);
    expect(note.closest('[data-epic-readiness]')!.getAttribute('title')).toContain('TST-3');
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('a card with every ticket Ready shows no readiness line', () => {
    const { container } = render(
      <MemoryRouter>
        <EpicCard epic={card()} />
      </MemoryRouter>,
    );
    expect(container.querySelector('[data-epic-readiness]')).toBeNull();
  });

  it('the epic page links each unshaped ticket with its status', () => {
    render(
      <MemoryRouter>
        <EpicReadinessLine readiness={{ state: 'not_ready', unshaped: UNSHAPED }} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'TST-3' })).toBeTruthy();
    expect(screen.getByText(/\(Planning\)/)).toBeTruthy();
    expect(screen.getByText(/\(Inbox\)/)).toBeTruthy();
  });
});

const detail = (item: Partial<ItemDetailResponse['item']>) =>
  ({ item: { id: 'TST-3', status: 'planning', ...item } }) as unknown as ItemDetailResponse;

describe('Known gaps on the item page (decision 58)', () => {
  const gaps = [
    { n: 1, gap: 'Which retry limit to use', settled: null },
    { n: 2, gap: 'Wording of the empty state', settled: 'Reused the list wording' },
  ];

  it('a Planning ticket asks for your approval, and names the header action', () => {
    render(<KnownGapsSection data={detail({ known_gaps: { gaps, open: 1, approved: null } })} />);
    expect(screen.getByRole('region', { name: 'Known gaps' })).toBeTruthy();
    expect(screen.getByText('· 1 open · needs your approval to move to Ready')).toBeTruthy();
    expect(screen.getByText(/Approve gaps and move to Ready/)).toBeTruthy();
    expect(screen.getByText('Open')).toBeTruthy();
    expect(screen.getByText('Reused the list wording')).toBeTruthy();
  });

  it('past Planning it is Known gaps to shape, with your approval', () => {
    render(
      <KnownGapsSection
        data={detail({
          status: 'progress',
          known_gaps: {
            gaps,
            open: 1,
            approved: { decision_id: 'dec_1', at: '2026-11-24T08:00:00.000Z' },
          },
        })}
      />,
    );
    expect(screen.getByRole('region', { name: 'Known gaps to shape' })).toBeTruthy();
    expect(screen.getByText(/approved by you/)).toBeTruthy();
    expect(screen.queryByText(/Approve gaps and move to Ready/)).toBeNull();
  });

  it('is hidden when the ticket names no gaps', () => {
    const { container } = render(<KnownGapsSection data={detail({})} />);
    expect(container.innerHTML).toBe('');
  });
});
