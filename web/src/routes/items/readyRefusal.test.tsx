// @vitest-environment jsdom
/**
 * B82 (owner decision 65): the owner's Move to Ready never dead-ends. A refused
 * move shows exactly what the ticket lacks and the ways forward, *Ask a planner
 * to shape this* sends your note, and a Needs shaping ticket says so.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ItemDetailResponse, NeedsShaping } from '@docket/shared';
import type * as QueryClientModule from '../../app/queryClient';
import { EpicReadinessLine } from '../../components/kit';
import { MapCard, type MapItem } from '../../components/ProgressMap';
import { ApiError } from '../../lib/api';
import { ItemHeader } from './ItemHeader';

const api = vi.hoisted(() => ({ patch: vi.fn(), shared: vi.fn() }));
vi.mock('../../app/queryClient', async (original) => ({
  ...(await original<typeof QueryClientModule>()),
  apiClient: { 'items.patch': api.patch, 'itemShared.put': api.shared },
}));

afterEach(() => {
  cleanup();
  api.patch.mockReset();
  api.shared.mockReset();
});

const ITEM = {
  id: 'TST-3',
  project: 'TST',
  type: 'Story',
  title: 'Synthetic story',
  status: 'planning',
  priority: 2,
  epic: null,
  epic_title: null,
  labels: [],
  blocked: false,
  blocked_by: [],
  links: { blocked_by: [], blocks: [], relates: [] },
  lead: null,
  archived: false,
  jira_key: null,
  version: 4,
};

const data = (item: Record<string, unknown> = {}) =>
  ({ item: { ...ITEM, ...item }, children: [] }) as unknown as ItemDetailResponse;

function show(d = data()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ItemHeader id="TST-3" data={d} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const refusal = (missing: string[]) =>
  new ApiError('items.patch', 409, {
    code: 'not_declared',
    message: "TST-3 can't move to Ready: its shared changes aren't declared.",
    details: { missing, ask_planner: true },
  });

describe('a refused Move to Ready (decision 65)', () => {
  it('lists exactly what is missing and offers a planner and "none"', async () => {
    api.patch.mockRejectedValueOnce(refusal(['outcome', 'acceptance', 'shared_changes']));
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Move to Ready' }));
    const panel = await screen.findByRole('group', { name: /TST-3 can’t move to Ready yet/ });
    expect(panel.querySelectorAll('[data-missing]')).toHaveLength(3);
    expect(screen.getByText('An outcome')).toBeTruthy();
    expect(screen.getByText('Acceptance criteria')).toBeTruthy();
    expect(screen.getByText(/Its shared changes declared/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ask a planner to shape this' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'It changes no shared part' })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(panel));
  });

  it('Ask a planner sends your note, and the panel closes', async () => {
    api.patch
      .mockRejectedValueOnce(refusal(['shared_changes']))
      .mockResolvedValueOnce({ mutation_id: 'mut_1', item: ITEM });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Move to Ready' }));
    fireEvent.change(await screen.findByLabelText('Note for the planner (optional)'), {
      target: { value: 'Check it against the synthetic export story' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ask a planner to shape this' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(2));
    expect(api.patch.mock.calls[1]![0]).toEqual({
      params: { id: 'TST-3' },
      body: {
        expected_version: 4,
        request_shaping: { note: 'Check it against the synthetic export story' },
      },
    });
    await waitFor(() => expect(document.querySelector('[data-ready-refusal]')).toBeNull());
  });

  it('declaring none goes through the Shared changes route, as before', async () => {
    api.patch.mockRejectedValueOnce(refusal(['shared_changes']));
    api.shared.mockResolvedValueOnce({ mutation_id: 'mut_2', registered: [] });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Move to Ready' }));
    fireEvent.click(await screen.findByRole('button', { name: 'It changes no shared part' }));
    await waitFor(() =>
      expect(api.shared).toHaveBeenCalledWith({ params: { id: 'TST-3' }, body: { none: true } }),
    );
  });

  it('a ticket with its declaration but no outcome offers no "none" button', async () => {
    api.patch.mockRejectedValueOnce(refusal(['outcome']));
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Move to Ready' }));
    await screen.findByText('An outcome');
    expect(screen.queryByRole('button', { name: 'It changes no shared part' })).toBeNull();
  });
});

describe('Needs shaping on the ticket (decision 65)', () => {
  const asked = (over: Partial<NeedsShaping> = {}): NeedsShaping => ({
    missing: ['outcome', 'shared_changes'],
    asked_by: 'agent',
    by: 'claude · producer',
    at: '2026-11-24T08:00:00.000Z',
    note: null,
    ...over,
  });

  it('says what it lacks in words', () => {
    show(data({ needs_shaping: asked() }));
    expect(
      screen.getByText('Needs shaping: no outcome and shared changes not declared'),
    ).toBeTruthy();
  });

  it('once you asked a planner, the refusal says so instead of asking again', async () => {
    api.patch.mockRejectedValueOnce(refusal(['outcome', 'shared_changes']));
    show(data({ needs_shaping: asked({ asked_by: 'owner', by: 'owner' }) }));
    expect(screen.getByText(/you asked a planner/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Move to Ready' }));
    expect(await screen.findByText(/You’ve asked a planner to shape it/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ask a planner to shape this' })).toBeNull();
  });
});

describe('Needs shaping on the epic and the map (decision 65)', () => {
  it('the epic line counts and marks the tickets waiting for a planner', () => {
    render(
      <MemoryRouter>
        <EpicReadinessLine
          readiness={{
            state: 'not_ready',
            unshaped: [
              { id: 'TST-3', title: 'Synthetic story', status: 'planning', needs_shaping: true },
              { id: 'TST-5', title: 'Synthetic idea', status: 'inbox' },
            ],
          }}
        />
      </MemoryRouter>,
    );
    expect(
      screen.getByText(/Not ready to start: 2 unshaped tickets · Needs shaping: 1/),
    ).toBeTruthy();
    expect(screen.getByText(/\(Planning, needs shaping\)/)).toBeTruthy();
    expect(screen.getByText(/\(Inbox\)/)).toBeTruthy();
  });

  it('a map card says needs shaping in words, in its name', () => {
    render(
      <MemoryRouter>
        <MapCard
          item={
            {
              ...ITEM,
              unblocks: 0,
              human_review: { declared: 0, ready: 0, approved: 0, deferred: 0 },
              planned_start: null,
              planned_end: null,
              effort: null,
              updated_at: '2026-11-24T08:00:00.000Z',
              needs_shaping: {
                missing: ['shared_changes'],
                asked_by: 'agent',
                by: 'claude · producer',
                at: '2026-11-24T08:00:00.000Z',
                note: null,
              },
            } as MapItem
          }
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: /needs shaping/ })).toBeTruthy();
  });
});
