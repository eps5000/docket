// @vitest-environment jsdom
/**
 * B81 (owner decision 64): the epic card's open-bug line, the epic page's
 * finish line (or "No finish line") with each open bug as a link, marking and
 * clearing the finish line, the finish line's own hold, the bug's note, and a
 * reason required to cancel a bug in an epic.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EpicCard as EpicCardData, FinishLine, ItemDetailResponse } from '@docket/shared';
import type * as QueryClientModule from '../../app/queryClient';
import { EpicCard, EpicReleaseLine, epicReleaseText } from '../../components/kit';
import { CancelMenu } from './CancelItem';
import { FinishLineControl } from './FinishLineControl';
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

const child = (id: string, type: string, status = 'ready') => ({
  id,
  type,
  status,
  title: `Synthetic ${type.toLowerCase()} ${id}`,
});

const epicDetail = (line: FinishLine, over: Partial<ItemDetailResponse> = {}) =>
  ({
    item: {
      id: 'TST-1',
      type: 'Epic',
      status: 'progress',
      title: 'Synthetic epic',
      version: 4,
      epic: null,
      labels: [],
      priority: 2,
      human_review: { declared: 0, ready: 0, approved: 0, deferred: 0 },
      lead: null,
    },
    children: [
      child('TST-10', 'Story'),
      child('TST-11', 'Task'),
      child('TST-12', 'Task', 'canceled'),
      child('TST-20', 'Bug'),
    ],
    finish_line: line,
    ...over,
  }) as unknown as ItemDetailResponse;

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

  it('says the finish line is waiting on bugs, in words, inside the one link', () => {
    wrap(<EpicCard epic={card({ finish_line: 'TST-11', open_bugs: 2 })} />);
    expect(screen.getByText(/Finish line waiting on 2 bugs/)).toBeTruthy();
    expect(screen.getByRole('link').textContent).not.toContain('TST-11');
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('says "No finish line" with the count when none is set, and nothing when no bug is open', () => {
    const { container, unmount } = wrap(
      <EpicCard epic={card({ finish_line: null, open_bugs: 1 })} />,
    );
    expect(screen.getByText(/No finish line · 1 bug open/)).toBeTruthy();
    unmount();
    const quiet = wrap(<EpicCard epic={card({ finish_line: 'TST-11', open_bugs: 0 })} />);
    expect(quiet.container.querySelector('[data-epic-release]')).toBeNull();
    expect(container).toBeTruthy();
  });

  it('epicReleaseText covers each case', () => {
    expect(epicReleaseText({ finish_line: 'TST-11', open_bugs: 1 })).toBe(
      'Finish line TST-11 · Waiting on 1 bug',
    );
    expect(epicReleaseText({ finish_line: 'TST-11', open_bugs: 0 })).toBe('Finish line TST-11');
    expect(epicReleaseText({ finish_line: null, open_bugs: 0 })).toBe('No finish line');
  });
});

describe('the epic page (decision 64)', () => {
  it('links the finish line and each open bug with its status', () => {
    wrap(
      <EpicReleaseLine line={{ id: 'TST-11', how: 'detected', candidates: [], open_bugs: BUGS }} />,
    );
    expect(screen.getByRole('link', { name: 'TST-11' }).getAttribute('href')).toBe('/items/TST-11');
    expect(screen.getByText(/Waiting on 2 bugs/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'TST-20' })).toBeTruthy();
    expect(screen.getByText(/\(In progress\)/)).toBeTruthy();
  });

  it('says "No finish line" and offers the candidates to mark; marking patches the epic', async () => {
    api.patch.mockResolvedValue({ mutation_id: 'mut_1', item: {} });
    const data = epicDetail({
      id: null,
      how: null,
      candidates: ['TST-10', 'TST-11'],
      open_bugs: BUGS.slice(0, 1),
    });
    wrap(
      <>
        <EpicReleaseLine line={data.finish_line!} />
        <FinishLineControl data={data} />
      </>,
    );
    expect(screen.getByText('No finish line')).toBeTruthy();
    const select = screen.getByLabelText(
      '2 tickets could be the release. Mark one:',
    ) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['', 'TST-10', 'TST-11']);
    const mark = screen.getByRole('button', { name: 'Mark as finish line' }) as HTMLButtonElement;
    expect(mark.disabled).toBe(true);
    fireEvent.change(select, { target: { value: 'TST-11' } });
    await act(async () => {
      fireEvent.click(mark);
    });
    expect(api.patch).toHaveBeenCalledWith({
      params: { id: 'TST-1' },
      body: { expected_version: 4, finish_line: 'TST-11' },
    });
  });

  it('with no candidates offers every ticket that is not a bug or canceled', () => {
    wrap(
      <FinishLineControl
        data={epicDetail({ id: null, how: null, candidates: [], open_bugs: [] })}
      />,
    );
    const select = screen.getByLabelText('Mark the release ticket:') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['', 'TST-10', 'TST-11']);
  });

  it('a marked finish line can be cleared; a detected one offers nothing', async () => {
    api.patch.mockResolvedValue({ mutation_id: 'mut_2', item: {} });
    const marked = wrap(
      <FinishLineControl
        data={epicDetail({ id: 'TST-10', how: 'explicit', candidates: [], open_bugs: [] })}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Clear finish line mark' }));
    });
    expect(api.patch).toHaveBeenCalledWith({
      params: { id: 'TST-1' },
      body: { expected_version: 4, finish_line: null },
    });
    marked.unmount();
    const found = wrap(
      <FinishLineControl
        data={epicDetail({ id: 'TST-11', how: 'detected', candidates: [], open_bugs: [] })}
      />,
    );
    expect(found.container.querySelector('[data-finish-control]')).toBeNull();
  });
});

const ticket = (over: Record<string, unknown>, rest: Partial<ItemDetailResponse> = {}) =>
  ({
    item: {
      id: 'TST-11',
      type: 'Task',
      status: 'progress',
      title: 'Synthetic release ticket',
      version: 2,
      epic: 'TST-1',
      epic_title: 'Synthetic epic',
      labels: [],
      priority: 2,
      blocked: false,
      blocked_by: [],
      human_review: { declared: 0, ready: 0, approved: 0, deferred: 0 },
      lead: null,
      ...over,
    },
    children: [],
    ...rest,
  }) as unknown as ItemDetailResponse;

describe('the ticket page (decision 64)', () => {
  it('the finish line says what holds it, with each bug as a link and the ways forward', () => {
    wrap(
      <ItemHeader
        id="TST-11"
        data={ticket({}, { release_hold: { epic: 'TST-1', open_bugs: BUGS } })}
      />,
    );
    const hold = document.querySelector('[data-release-hold]') as HTMLElement;
    expect(hold.textContent).toContain('Waiting on 2 bugs');
    expect(hold.textContent).toContain('can’t move to Review or Done');
    expect(hold.textContent).toContain(
      'fix it, move it to another epic as a follow-up, or cancel it with a reason',
    );
    expect(within(hold).getByRole('link', { name: 'TST-20' })).toBeTruthy();
  });

  it('an open bug in an epic says it holds the release; a bug with no epic does not', () => {
    const { unmount } = wrap(
      <ItemHeader id="TST-20" data={ticket({ id: 'TST-20', type: 'Bug' })} />,
    );
    expect(document.querySelector('[data-bug-holds="TST-1"]')!.textContent).toContain(
      'this bug holds TST-1’s release',
    );
    unmount();
    wrap(<ItemHeader id="TST-20" data={ticket({ id: 'TST-20', type: 'Bug', epic: null })} />);
    expect(document.querySelector('[data-bug-holds]')).toBeNull();
  });

  it('canceling a bug in an epic needs a reason, and sends it', async () => {
    api.cancel.mockResolvedValue({ mutation_id: 'mut_3', item: {} });
    wrap(<CancelMenu data={ticket({ id: 'TST-20', type: 'Bug', status: 'ready' })} />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Cancel item…' }));
    const box = document.querySelector('[data-cancel-confirm]') as HTMLElement;
    expect(within(box).getByText('Reason (required)')).toBeTruthy();
    expect(box.querySelector('[data-bug-reason]')!.textContent).toContain('holds TST-1’s release');
    const go = within(box).getByRole('button', { name: 'Cancel item' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(within(box).getByRole('textbox'), {
      target: { value: 'Only on a retired synthetic device' },
    });
    expect(go.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(go);
    });
    expect(api.cancel).toHaveBeenCalledWith({
      params: { id: 'TST-20' },
      body: { expected_version: 2, reason: 'Only on a retired synthetic device' },
    });
  });

  it('other items still cancel with an optional reason', () => {
    wrap(<CancelMenu data={ticket({ status: 'ready' })} />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Cancel item…' }));
    const box = document.querySelector('[data-cancel-confirm]') as HTMLElement;
    expect(within(box).getByText('Optional reason')).toBeTruthy();
    expect(
      (within(box).getByRole('button', { name: 'Cancel item' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
