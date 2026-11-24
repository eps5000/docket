// @vitest-environment jsdom
/**
 * The daily brief (owner decision 48): each section with and without data, the
 * owner-decision group only when the wait card reports one, a cost section only
 * when the token use source is on (B63),
 * and one line per owner action, so the brief and the badge can't disagree.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  needsYouCount,
  type BriefResponse,
  type NeedsYouResponse,
  type UsageSummaryResponse,
} from '@docket/shared';
import { createAppQueryClient } from '../../app/queryClient';
import { ShellStateProvider } from '../../app/ShellState';
import { Brief } from './Brief';
import { briefDayText, decisionChangeText, decisionLink, needsYouLines } from './briefLines';

const AT = '2026-11-23T10:00:00.000Z';
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const empty = (over: Partial<BriefResponse> = {}): BriefResponse => ({
  day: '2026-11-23',
  today: '2026-11-23',
  timezone: 'UTC',
  from: '2026-11-22T23:59:59.999Z',
  to: AT,
  finished: { count: 0, rows: [] },
  stuck: {
    parked: { count: 0, rows: [] },
    unowned_blockers: { count: 0, rows: [] },
    held: { count: 0, rows: [] },
    blocked: { count: 0, rows: [] },
    queued: 0,
  },
  decisions: { count: 0, rows: [] },
  ...over,
});

const full = (): BriefResponse =>
  empty({
    finished: {
      count: 10,
      rows: [{ id: 'RCP-1', title: 'Pantry screen', project: 'RCP', closed_at: AT }],
    },
    stuck: {
      parked: {
        count: 1,
        rows: [
          {
            id: 'RCP-2',
            title: 'Parked ticket',
            project: 'RCP',
            since: '2026-11-20T10:00:00.000Z',
            next: 'Next step on RCP-5: shape it or assign it',
          },
        ],
      },
      unowned_blockers: {
        count: 1,
        rows: [{ id: 'RCP-5', title: 'Blocker', project: 'RCP', status: 'planning', blocks: 3 }],
      },
      held: {
        count: 1,
        rows: [
          {
            id: 'RCP-6',
            title: 'Held ticket',
            project: 'RCP',
            since: AT,
            decision_id: 'dec_1',
            decision_title: 'Wait for the launch',
          },
        ],
      },
      blocked: {
        count: 1,
        rows: [
          {
            id: 'RCP-7',
            title: 'Blocked ticket',
            project: 'RCP',
            reason: 'canceled',
            why: 'RCP-8 was canceled, so it never clears',
          },
        ],
      },
      queued: 4,
    },
    decisions: {
      count: 2,
      rows: [
        {
          decision_id: 'dec_2',
          title: 'Use the short form',
          change: 'recorded',
          by: 'owner',
          at: AT,
          project: 'RCP',
          item_id: 'RCP-7',
        },
        {
          decision_id: 'dec_3',
          title: 'Project rule',
          change: 'replaced',
          by: 'agent',
          at: AT,
          project: 'RCP',
          item_id: null,
        },
      ],
    },
  });

const quiet: NeedsYouResponse = {
  for_you_now: [],
  problems: [],
  deferred: [],
  planning_queue: [],
  agent_counts: {},
};

const asking: NeedsYouResponse = {
  ...quiet,
  for_you_now: [
    {
      kind: 'question',
      item_id: 'RCP-8',
      title: 'A question',
      project: 'RCP',
      question_id: 'qst_1',
      asked_by: 'codex',
      text: 'Which way?',
      asked_at: AT,
    },
  ] as NeedsYouResponse['for_you_now'],
};

let requests: string[] = [];

function show(
  brief: BriefResponse,
  needs: NeedsYouResponse,
  entry = '/brief',
  usage: Partial<UsageSummaryResponse> = { enabled: false },
) {
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.includes('/api/usage')) return Promise.resolve(json(usage));
      return Promise.resolve(json(url.includes('/api/brief') ? brief : needs));
    }),
  );
  const router = createMemoryRouter([{ path: '/brief', element: <Brief /> }], {
    initialEntries: [entry],
  });
  render(
    <QueryClientProvider client={createAppQueryClient()}>
      <ShellStateProvider>
        <RouterProvider router={router} />
      </ShellStateProvider>
    </QueryClientProvider>,
  );
  return router;
}

const section = (id: string) =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>(`[data-brief-section="${id}"]`);
    if (!el) throw new Error(`No section ${id}`);
    return el;
  });

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the sections', () => {
  it('says plainly when there is nothing', async () => {
    show(empty(), quiet);
    expect((await section('finished')).textContent).toContain('No tickets finished on Nov 23.');
    expect((await section('stuck')).textContent).toContain('Nothing is stuck right now.');
    await waitFor(async () =>
      expect((await section('needs-you')).textContent).toContain('Nothing needs you.'),
    );
    expect((await section('decisions')).textContent).toContain('No decisions changed on Nov 23.');
  });

  it('links every line to its ticket, and counts past the rows it lists', async () => {
    show(full(), asking);
    const finished = await section('finished');
    expect(within(finished).getByRole('link', { name: /RCP-1/ }).getAttribute('href')).toBe(
      '/items/RCP-1',
    );
    expect(within(finished).getByRole('link', { name: 'and 9 more' })).toBeTruthy();
    const stuck = await section('stuck');
    for (const id of ['RCP-2', 'RCP-5', 'RCP-6']) {
      expect(
        within(stuck)
          .getByRole('link', { name: new RegExp(id) })
          .getAttribute('href'),
      ).toBe(`/items/${id}`);
    }
    await waitFor(async () =>
      expect(
        within(await section('needs-you'))
          .getByRole('link', { name: /RCP-8/ })
          .getAttribute('href'),
      ).toBe('/items/RCP-8'),
    );
  });

  it('lists runs held by an owner decision separately and calmly', async () => {
    show(full(), quiet);
    const stuck = await section('stuck');
    const held = stuck.querySelector<HTMLElement>('[data-brief-group="held"]')!;
    expect(held.textContent).toContain('Held by your decision · 1');
    expect(held.textContent).toContain('Nothing is wrong.');
    expect(held.textContent).toContain('Wait for the launch');
    expect(stuck.querySelector('[data-brief-group="parked"]')?.textContent).not.toContain('RCP-6');
  });

  it('leaves the held group out when no run has one', async () => {
    const brief = full();
    brief.stuck.held = { count: 0, rows: [] };
    show(brief, quiet);
    const stuck = await section('stuck');
    expect(stuck.querySelector('[data-brief-group="parked"]')).not.toBeNull();
    expect(stuck.querySelector('[data-brief-group="held"]')).toBeNull();
  });

  it('shows no cost section or estimate with the token use source off', async () => {
    show(full(), asking);
    await section('decisions');
    await waitFor(() => expect(requests.some((r) => r.includes('/api/usage'))).toBe(true));
    const page = document.querySelector('.brief')!.textContent!;
    expect(page).not.toMatch(/cost|estimate|token|\$/i);
    expect(document.querySelector('[data-brief-section="cost"]')).toBeNull();
  });

  it('shows what the day cost, labelled as an estimate, with the source on', async () => {
    const tokens = { fresh_input: 1200, cached_input: 340_000, cache_write: 5000, output: 800 };
    const cost = { usd: 2.5, unpriced_tokens: 0, unpriced_models: [] };
    const bucket = { tokens, cost, turns: 4, sessions: 1 };
    show(full(), asking, '/brief', {
      enabled: true,
      prices_as_of: '2026-11-23',
      total: bucket,
      linked: bucket,
      overhead: {
        ...bucket,
        tokens: { ...tokens, fresh_input: 0, cached_input: 0, cache_write: 0, output: 0 },
      },
      unlinked: {
        ...bucket,
        tokens: { ...tokens, fresh_input: 0, cached_input: 0, cache_write: 0, output: 0 },
      },
      linked_pct: 100,
      top_tickets: {
        count: 1,
        rows: [{ id: 'RCP-1', title: 'A ticket', project: 'RCP', status: 'done', tokens, cost }],
      },
    });
    const card = await section('cost');
    expect(card.textContent).toContain('$2.50 API-equivalent estimate.');
    expect(card.textContent).toContain('A subscription plan may cost less.');
    expect(card.textContent).toContain('100% linked to tickets');
    expect(within(card).getByRole('link', { name: /RCP-1/ }).getAttribute('href')).toBe(
      '/items/RCP-1',
    );
    await waitFor(() =>
      expect(requests.some((r) => r.includes('/api/usage') && r.includes('day=2026-11-23'))).toBe(
        true,
      ),
    );
  });

  it('says so when the source is on and the day has no token use', async () => {
    const none = { fresh_input: 0, cached_input: 0, cache_write: 0, output: 0 };
    show(empty(), quiet, '/brief', {
      enabled: true,
      prices_as_of: '2026-11-23',
      total: {
        tokens: none,
        cost: { usd: null, unpriced_tokens: 0, unpriced_models: [] },
        turns: 0,
        sessions: 0,
      },
    });
    expect((await section('cost')).textContent).toContain('No token use recorded on Nov 23.');
  });

  it('says a past day still shows what is stuck now', async () => {
    show(empty({ day: '2026-11-20' }), quiet, '/brief?day=2026-11-20');
    expect((await section('stuck')).textContent).toContain('Shown as it is now.');
    await waitFor(() => expect(requests.some((r) => r.includes('day=2026-11-20'))).toBe(true));
  });

  it('ignores a day that is not real rather than failing', async () => {
    show(empty(), quiet, '/brief?day=2026-02-31');
    await section('finished');
    expect(requests.filter((r) => r.includes('/api/brief')).join()).not.toContain('day=');
  });

  it('changes the day from the picker, and Today goes back', async () => {
    const user = userEvent.setup();
    const router = show(empty(), quiet, '/brief?day=2026-11-20');
    await section('finished');
    await user.click(screen.getByRole('button', { name: 'Today' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
  });
});

describe('the lines', () => {
  it('gives one line per owner action', () => {
    expect(needsYouLines(asking)).toHaveLength(needsYouCount(asking));
    expect(needsYouLines(quiet)).toHaveLength(0);
  });

  it('words a decision change for who made it', () => {
    expect(decisionChangeText({ change: 'recorded', by: 'owner' })).toBe('You recorded this');
    expect(decisionChangeText({ change: 'withdrawn', by: 'agent' })).toBe('An agent withdrew this');
  });

  it('links a project-wide decision to its Decisions page', () => {
    const [onTicket, wide] = full().decisions.rows;
    expect(decisionLink(onTicket!)).toBe('/items/RCP-7');
    expect(decisionLink(wide!)).toBe('/projects/RCP/decisions?decision=dec_3');
  });

  it('prints the chosen day without moving it through a timezone', () => {
    expect(briefDayText('2026-11-01')).toBe('Nov 1');
  });
});
