// @vitest-environment jsdom
/**
 * B84 (owner decision 67): the epic card's open-bug line, the epic page's
 * Release with what it waits for and each open bug as a link, the Release's own
 * hold, a bug's note, a Release that can't be canceled on its own, and the
 * type control (change, confirm an inferred type, mark a rollout), with
 * synthetic text only.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EpicCard as EpicCardData, ItemDetailResponse } from '@docket/shared';
import type * as QueryClientModule from '../../app/queryClient';
import { EpicCard, EpicReleaseLine, TypeBadge, epicReleaseText } from '../../components/kit';
import { CancelMenu } from './CancelItem';
import { ItemHeader } from './ItemHeader';

const api = vi.hoisted(() => ({ patch: vi.fn(), cancel: vi.fn() }));
vi.mock('../../app/queryClient', async (original) => ({
  ...(await original<typeof QueryClientModule>()),
  apiClient: { 'items.patch': api.patch, 'items.cancel': api.cancel },
}));

afterEach(() => {
  cleanup();
  api.patch.mockReset();
  api.cancel.mockReset();
});

const wrap = (node: ReactNode) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <div className="tl">{node}</div>
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

const BUGS = [
  { id: 'TST-20', title: 'Synthetic crash on save', status: 'ready' as const },
  { id: 'TST-21', title: 'Synthetic wrong total', status: 'progress' as const },
];

describe('the epic card and Pick next epic text', () => {
  const card = (release?: EpicCardData['release']) =>
    ({
      id: 'TST-1',
      title: 'Synthetic epic',
      type: 'Epic',
      status: 'progress',
      children: { total: 3, done: 0, by_status: { ready: 3 }, for_you: 0, queued: 0, blocked: 0 },
      ...(release ? { release } : {}),
    }) as EpicCardData;

  it('says the Release is waiting on bugs, in words, inside the one link', () => {
    wrap(<EpicCard epic={card({ id: 'TST-30', left: 3, open_bugs: 2 })} />);
    expect(screen.getByText(/Release waiting on 2 bugs/)).toBeTruthy();
    expect(screen.getByRole('link').textContent).not.toContain('TST-30');
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('says nothing on the card when no bug is open', () => {
    const quiet = wrap(<EpicCard epic={card({ id: 'TST-30', left: 2, open_bugs: 0 })} />);
    expect(quiet.container.querySelector('[data-epic-release]')).toBeNull();
  });

  it('epicReleaseText covers each case', () => {
    expect(epicReleaseText({ id: 'TST-30', left: 3, open_bugs: 1 })).toBe(
      'Release TST-30 · waits for 2 tickets · Waiting on 1 bug',
    );
    expect(epicReleaseText({ id: 'TST-30', left: 0, open_bugs: 0 })).toBe(
      'Release TST-30 · nothing left before it',
    );
    expect(epicReleaseText({ id: null, left: 0, open_bugs: 0 })).toBe('No Release');
  });
});

describe('the epic page (decision 67)', () => {
  it('links the Release, the tickets it waits for, and each open bug with its status', () => {
    wrap(
      <EpicReleaseLine
        release={{
          id: 'TST-30',
          title: 'Release Synthetic epic',
          status: 'ready',
          left: ['TST-11', 'TST-20', 'TST-21'],
          open_bugs: BUGS,
        }}
      />,
    );
    expect(screen.getByRole('link', { name: 'TST-30' }).getAttribute('href')).toBe('/items/TST-30');
    expect(screen.getByText(/waits for 1 ticket/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'TST-11' })).toBeTruthy();
    expect(screen.getByText(/Waiting on 2 bugs/)).toBeTruthy();
    expect(screen.getByText(/\(In progress\)/)).toBeTruthy();
  });
});

const ticket = (over: Record<string, unknown>, rest: Partial<ItemDetailResponse> = {}) =>
  ({
    item: {
      id: 'TST-30',
      type: 'Release',
      status: 'ready',
      title: 'Release Synthetic epic',
      version: 2,
      epic: 'TST-1',
      epic_title: 'Synthetic epic',
      labels: [],
      priority: 2,
      blocked: false,
      blocked_by: [],
      human_review: { declared: 0, ready: 0, approved: 0, deferred: 0 },
      lead: null,
      runs: [],
      ...over,
    },
    children: [],
    ...rest,
  }) as unknown as ItemDetailResponse;

describe('the ticket page (decision 67)', () => {
  it('the Release says what it finishes after, with each ticket as a link', () => {
    wrap(
      <ItemHeader
        id="TST-30"
        data={ticket(
          {},
          {
            release_hold: {
              epic: 'TST-1',
              left: 3,
              waiting_on: ['TST-11', 'TST-20', 'TST-21'],
              open_bugs: BUGS,
            },
          },
        )}
      />,
    );
    const hold = document.querySelector('[data-release-hold]') as HTMLElement;
    expect(hold.textContent).toContain('The Release of TST-1: it finishes after 3 tickets');
    expect(hold.textContent).toContain('2 bugs open');
    expect(within(hold).getByRole('link', { name: 'TST-20' })).toBeTruthy();
  });

  it('an open bug in an epic says it holds the Release; a bug with no epic does not', () => {
    const { unmount } = wrap(
      <ItemHeader id="TST-20" data={ticket({ id: 'TST-20', type: 'Bug' })} />,
    );
    expect(document.querySelector('[data-bug-holds="TST-1"]')!.textContent).toContain(
      'this bug holds TST-1’s Release',
    );
    unmount();
    wrap(<ItemHeader id="TST-20" data={ticket({ id: 'TST-20', type: 'Bug', epic: null })} />);
    expect(document.querySelector('[data-bug-holds]')).toBeNull();
  });

  it("a Release can't be canceled on its own", () => {
    wrap(<CancelMenu data={ticket({})} />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.queryByRole('menuitem', { name: 'Cancel item…' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Cancel with its epic only' })).toBeTruthy();
  });

  it('canceling an epic does not wait for its Release', () => {
    wrap(
      <CancelMenu
        data={ticket(
          { id: 'TST-1', type: 'Epic', epic: null, status: 'progress' },
          {
            children: [
              { id: 'TST-30', type: 'Release', status: 'inbox', title: 'Release it' },
            ] as never,
          },
        )}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Cancel item…' }));
    const box = document.querySelector('[data-cancel-confirm]') as HTMLElement;
    expect(box.textContent).not.toContain('can’t be canceled yet');
  });
});

describe('the type control (decision 67)', () => {
  it('an inferred type says so in words, with a dashed icon', () => {
    const { container } = wrap(<TypeBadge type="Implementation" inferred original="Story" />);
    expect(container.textContent).toBe('Implementation (inferred from Story)');
    expect(container.querySelector('.type.inferred')).toBeTruthy();
  });

  it('changes the type, confirms an inferred one, and marks a rollout', async () => {
    api.patch.mockResolvedValue({ mutation_id: 'mut_1', item: {} });
    wrap(
      <ItemHeader
        id="TST-11"
        data={ticket({
          id: 'TST-11',
          type: 'Implementation',
          type_inferred: true,
          type_original: 'Task',
          title: 'Synthetic ticket',
        })}
      />,
    );
    expect(screen.getByText('Implementation (inferred from Task)')).toBeTruthy();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'Design' } });
    });
    expect(api.patch).toHaveBeenLastCalledWith({
      params: { id: 'TST-11' },
      body: { expected_version: 2, type: 'Design' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm type' }));
    });
    expect(api.patch).toHaveBeenLastCalledWith({
      params: { id: 'TST-11' },
      body: { expected_version: 2, type: 'Implementation' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Mark as rollout' }));
    });
    expect(api.patch).toHaveBeenLastCalledWith({
      params: { id: 'TST-11' },
      body: { expected_version: 2, rollout: true },
    });
  });

  it('a Release only shows its badge; a rollout shows its mark in words', () => {
    const release = wrap(<ItemHeader id="TST-30" data={ticket({})} />);
    expect(screen.queryByLabelText('Type')).toBeNull();
    release.unmount();
    wrap(
      <ItemHeader
        id="TST-12"
        data={ticket({ id: 'TST-12', type: 'Implementation', rollout: true })}
      />,
    );
    expect(document.querySelector('.rollout-mark')!.textContent).toContain('Rollout');
    expect(screen.getByRole('button', { name: 'Not a rollout' })).toBeTruthy();
  });
});
