// @vitest-environment jsdom
/**
 * Decision 60 (B77): the Dependencies tab still lists every dependency, and
 * one the epic map hides as implied gets a quiet "Also implied through …".
 * Synthetic tickets only.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ItemDetailResponse, ItemSummary, LinkEdge, LinkRef } from '@docket/shared';
import { DependenciesTab } from './DependenciesTab';

const api = vi.hoisted(() => ({ 'items.get': vi.fn() }));
vi.mock('../../app/queryClient', () => ({ apiClient: api }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

const summary = (id: string, over: Partial<ItemSummary> = {}): ItemSummary => ({
  id,
  project: 'T',
  type: 'Task',
  title: `Ticket ${id}`,
  status: 'ready',
  priority: 2,
  epic: 'T-100',
  epic_title: 'Synthetic epic',
  labels: [],
  blocked: false,
  blocked_by: [],
  unblocks: 0,
  lead: null,
  human_review: { declared: 0, ready: 0, approved: 0, deferred: 0 },
  planned_start: null,
  planned_end: null,
  effort: null,
  archived: false,
  jira_key: null,
  version: 1,
  updated_at: '2026-11-24T00:00:00.000Z',
  ...over,
});
const edge = (from: string, to: string): LinkEdge => ({
  link_id: `${from}>${to}`,
  from,
  to,
  type: 'blocks',
  satisfied_when: 'done',
  cleared: false,
});
const ref = (id: string, link_id: string): LinkRef => ({
  link_id,
  id,
  title: `Ticket ${id}`,
  status: 'ready',
  project: 'T',
  cleared: false,
});

// T-1 → T-2 → T-3, and T-1 → T-3, which the chain already shows.
const links = [edge('T-1', 'T-2'), edge('T-2', 'T-3'), edge('T-1', 'T-3')];
const epic = {
  item: { ...summary('T-100', { type: 'Epic', epic: null, epic_title: null }) },
  children: ['T-1', 'T-2', 'T-3'].map((id) => ({ ...summary(id), for_you: false })),
  links,
  outside: [],
} as unknown as ItemDetailResponse;
const ticket = (epicId: string | null = 'T-100') =>
  ({
    item: {
      ...summary('T-3', { blocked: true, blocked_by: ['T-1', 'T-2'], epic: epicId }),
      links: { blocked_by: [ref('T-1', 'T-1>T-3'), ref('T-2', 'T-2>T-3')], blocks: [], relates: [] },
      checklist: { human_review: [] },
    },
    children: [],
    links: links.filter((l) => l.to === 'T-3'),
    outside: [summary('T-1'), summary('T-2')],
  }) as unknown as ItemDetailResponse;

function view(data: ItemDetailResponse) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <div className="tl">
          <DependenciesTab data={data} />
        </div>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Dependencies tab: implied links (decision 60)', () => {
  it('lists every dependency and notes the one the epic map hides', async () => {
    api['items.get'].mockResolvedValue(epic);
    const { container } = view(ticket());
    expect(await screen.findByText('Also implied through T-2')).toBeTruthy();
    expect(api['items.get']).toHaveBeenCalledWith({ params: { id: 'T-100' } });
    expect(screen.getByText('Waits on 2 · unblocks 0')).toBeTruthy();
    // The note sits with T-1's card; T-2's direct link has none.
    const noted = [...container.querySelectorAll('[data-implied]')].map((n) =>
      n.getAttribute('data-implied'),
    );
    expect(noted).toEqual(['T-1']);
    expect(container.querySelector('[data-implied="T-1"] [data-pid="T-1"]')).toBeTruthy();
    expect(container.querySelector('[data-pid="T-2"]')).toBeTruthy();
  });

  it('adds no note, and doesn’t ask for the epic, when this viewer shows implied links', () => {
    localStorage.setItem('docket.mapHideImplied', 'off');
    view(ticket());
    expect(api['items.get']).not.toHaveBeenCalled();
    expect(screen.queryByText(/Also implied/)).toBeNull();
  });

  it('adds no note to a ticket without an epic', () => {
    view(ticket(null));
    expect(api['items.get']).not.toHaveBeenCalled();
    expect(screen.queryByText(/Also implied/)).toBeNull();
  });
});
