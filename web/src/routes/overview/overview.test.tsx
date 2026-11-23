// @vitest-environment jsdom
/**
 * Overview (owner decision 43): every owner action that worked on Needs you
 * still works here, the badge equals the actions shown, each number links to
 * its list, the window is remembered safely, and agent problems stay on one line.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  needsYouCount,
  type NeedsYouResponse,
  type OverviewResponse,
  type Problem,
} from '@docket/shared';
import { createAppQueryClient } from '../../app/queryClient';
import { appRoutes } from '../../app/router';
import { ShellStateProvider } from '../../app/ShellState';
import { STORAGE_KEYS } from '../../lib/persistence';
import { toasts } from '../../lib/undo';
import { axisTicks, bucketTicketsText, completedSummary, placeTip } from './CompletedChart';
import { AGENTS_NOTE, deltaText } from './OverviewStats';
import { ownerActionParts, readOverviewWindow } from './overviewWindow';
import { workloadText } from './WorkloadCard';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const AT = '2026-11-20T10:00:00.000Z';
const ref = (id: string) => ({ id, title: `Title ${id}`, status: 'progress' });
const explanation = { what: 'What is wrong.', fix: 'The fix.', who: 'owner', who_text: 'You' };

const problem = (id: string, who: 'owner' | 'agent' = 'owner'): Problem =>
  ({
    kind: 'parked_too_long',
    id,
    item_id: 'RCP-9',
    title: 'Parked work',
    reason: 'Parked',
    related: [],
    link_id: null,
    run_id: 'run_1',
    resource_ids: [],
    explanation: { ...explanation, who, who_text: who },
    reached_you: who === 'owner' ? 'No lead' : null,
  }) as Problem;

/** One of every card the owner can act on. */
const busy = (): NeedsYouResponse =>
  ({
    for_you_now: [
      {
        kind: 'packet',
        item_id: 'RCP-1',
        title: 'A packet',
        project: 'RCP',
        packet_id: 'pkt_1',
        round: 1,
        to_verify: 2,
        estimate: '10 min',
        stale: false,
        built_from_commit: 'abc1234',
        submitted_at: AT,
      },
      {
        kind: 'question',
        item_id: 'RCP-2',
        title: 'A question',
        project: 'RCP',
        question_id: 'qst_1',
        asked_by: 'codex',
        text: 'Which way?',
        asked_at: AT,
      },
    ],
    problems: [problem('parked_too_long:RCP-9')],
    agent_problems: [problem('parked_too_long:RCP-10', 'agent')],
    acknowledged: [],
    deferred: [
      {
        hr_item_id: 'hri_1',
        item_id: 'RCP-3',
        title: 'Deferred',
        text: 'Check it',
        follow_up: null,
      },
    ],
    planning_queue: [
      {
        id: 'RCP-5',
        project: 'RCP',
        type: 'Task',
        title: 'Planned',
        status: 'planning',
        priority: 2,
        epic: null,
        epic_title: null,
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
        version: 3,
        updated_at: AT,
      },
    ],
    agent_counts: { live: 3 },
    agents_now: { working: 4, waiting: 3 },
    agent_file_proposals: 1,
    onboarding_reviews: [
      {
        id: 'onb_1',
        project: 'RCP',
        project_name: 'Recipe App',
        started_by: 'claude',
        run_id: null,
        state: 'ready_for_review',
        summary: 'Set up.',
        questions: [],
        changes: { created: 2, enriched: 1, documents: 0, decisions: 0, proposals: 0 },
        workflow_proposal_id: null,
        started_at: AT,
        finished_at: AT,
        reviewed_at: null,
      },
    ],
    overlaps: [
      {
        id: 'pov_1',
        project: 'RCP',
        items: [ref('RCP-20'), ref('RCP-21')],
        parts: ['model:Token'],
        state: 'open',
        note: null,
        link_id: null,
        raised_at: AT,
        decided_by: null,
        decided_at: null,
        version: 1,
      },
    ],
    undeclared_holds: [
      {
        id: 'udh_1',
        item: ref('RCP-22'),
        packet_id: 'pkt_2',
        via: 'submit_packet',
        parts: ['model:Token'],
        files: ['src/token.ts'],
        state: 'open',
        note: null,
        created_at: AT,
        decided_by: null,
        decided_at: null,
        version: 1,
      },
    ],
    design_reviews: [
      {
        id: 'drv_1',
        project: 'RCP',
        item: ref('RCP-23'),
        entries: [{ part: 'model:Token', change: 'modify', note: 'New field' }],
        state: 'open',
        note: null,
        requested_by: 'claude',
        created_at: AT,
        decided_by: null,
        decided_at: null,
        version: 1,
        explanation,
      },
    ],
    resolutions: [
      {
        id: 'prs_1',
        item_id: 'RCP-24',
        problem_id: null,
        problem_kind: 'radar_conflict',
        kind: 'split',
        plan_md: '1. Split it.',
        reason: 'Too big.',
        proposed_by: 'claude',
        state: 'open',
        note: null,
        decided_by: null,
        decided_at: null,
        created_at: AT,
        version: 1,
      },
    ],
    project_decisions: [
      {
        id: 'dcn_1',
        project: 'RCP',
        scope: { kind: 'project', id: null },
        title: 'A project decision',
        decision_md: 'Decided.',
        rationale_md: null,
        authority: 'agent',
        author: 'claude',
        status: 'active',
        supersedes_id: null,
        superseded_by_id: null,
        created_at: AT,
        confirmed_at: null,
        version: 1,
      },
    ],
    project_decision_groups: [
      {
        project: 'RCP',
        decisions: [{ id: 'dcn_2', title: 'An older decision', author: 'claude' }],
      },
    ],
  }) as unknown as NeedsYouResponse;

const quiet = (over: Partial<NeedsYouResponse> = {}): NeedsYouResponse => ({
  for_you_now: [],
  problems: [],
  deferred: [],
  planning_queue: [],
  agent_counts: {},
  ...over,
});

const metrics = (over: Partial<OverviewResponse> = {}): OverviewResponse => ({
  window: '7d',
  from: '2026-11-13T10:00:00.000Z',
  to: AT,
  prior_from: '2026-11-06T10:00:00.000Z',
  completed: {
    count: 18,
    prior: 12,
    granularity: 'day',
    buckets: [
      { key: '2026-11-18', label: 'Nov 18', count: 0, tickets: [] },
      {
        key: '2026-11-19',
        label: 'Nov 19',
        count: 6,
        tickets: [
          { id: 'RCP-31', title: 'Pantry screen' },
          { id: 'RCP-32', title: 'Shopping list' },
        ].concat(
          ['RCP-33', 'RCP-34', 'RCP-35', 'RCP-36'].map((id) => ({ id, title: `Title ${id}` })),
        ),
      },
      {
        key: '2026-11-20',
        label: 'Nov 20',
        count: 12,
        tickets: ['RCP-41', 'RCP-42', 'RCP-43', 'RCP-44', 'RCP-45', 'RCP-46'].map((id) => ({
          id,
          title: `Title ${id}`,
        })),
      },
    ],
  },
  in_flight: { count: 23, progress: 15, review: 8 },
  blocked: 5,
  ready: { startable: 2, waiting: 3 },
  workload: [
    {
      epic_id: 'RCP-40',
      title: 'Visual',
      project: 'RCP',
      total: 9,
      counts: { review: 1, progress: 3, ready: 3, blocked: 2, planning: 0, inbox: 0 },
    },
    {
      epic_id: null,
      title: null,
      project: null,
      total: 2,
      counts: { review: 0, progress: 1, ready: 1, blocked: 0, planning: 0, inbox: 0 },
    },
  ],
  last_backup_at: '2026-11-20T07:00:00.000Z',
  ...over,
});

let needs: NeedsYouResponse;
let overview: OverviewResponse;
/** A different Needs you for one project, by scope key. */
let byScope: Record<string, NeedsYouResponse> = {};
const sent: { method: string; path: string }[] = [];
const asked: string[] = [];

beforeEach(() => {
  needs = busy();
  overview = metrics();
  byScope = {};
  sent.length = 0;
  asked.length = 0;
  sessionStorage.clear();
  localStorage.clear();
  toasts.reset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      const route = path.split('?')[0]!;
      const method = init?.method ?? 'GET';
      if (method !== 'GET') {
        sent.push({ method, path: route });
        return json(200, {});
      }
      if (route === '/api/bootstrap') {
        return json(200, {
          server_version: '0.0.0',
          server_time: AT,
          projects: [
            {
              key: 'RCP',
              name: 'Recipe App',
              short_name: 'Recipe App',
              color: '#336699',
              default_satisfied_when: 'done',
              version: 1,
              created_by: null,
            },
          ],
          labels: [],
          counts: { for_you: 0, problems: 0, planning: 0, runs: {} },
          settings: { live_window_s: 180, stale_after_s: 900, lease_s: 1800, undo_window_s: 30 },
          health: { status: 'ready', checks: {} },
        });
      }
      if (route === '/api/needs-you') {
        const scope = new URL(path, 'http://docket.test').searchParams.get('scope') ?? 'all';
        return json(200, byScope[scope] ?? needs);
      }
      if (route === '/api/agents') return json(200, { rows: [] });
      if (route === '/api/overview') {
        asked.push(path);
        return json(200, overview);
      }
      if (route === '/api/workspaces') return json(200, { rows: [] });
      return json(404, { error: { code: 'not_found', message: `No ${route}` } });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderAt(path = '/') {
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

const nav = () => screen.getByRole('link', { name: /^Overview/ });
const section = async () => {
  await screen.findByRole('heading', { level: 2, name: /^Needs you/ });
  return document.getElementById('needs-you') as HTMLElement;
};
const stat = (name: string) => document.querySelector(`[data-stat="${name}"]`) as HTMLElement;

describe('every owner action still works from Overview', () => {
  const inCard = (selector: string) => document.querySelector(selector) as HTMLElement;
  const actions: [string, string, string, RegExp][] = [
    [
      'onboarding: Mark reviewed',
      '[data-card="onboarding-reviews"], .needs-you',
      'Mark reviewed',
      /\/api\/onboarding\/onb_1\/reviewed$/,
    ],
    [
      'overlap: Run one after the other',
      '[data-card="shared-questions"]',
      'Run one after the other',
      /\/api\/overlaps\/pov_1\/decide$/,
    ],
    [
      'hold: Add to the declaration',
      '[data-card="shared-questions"]',
      'Add to the declaration',
      /\/api\/undeclared-holds\/udh_1\/decide$/,
    ],
    [
      'design review: Approve',
      '[data-card="shared-questions"]',
      'Approve the design change',
      /\/api\/design-reviews\/drv_1\/decide$/,
    ],
    [
      'proposal: Approve',
      '[data-resolution-card="prs_1"]',
      'Approve',
      /\/api\/resolutions\/prs_1\/decide$/,
    ],
    [
      'project decision group: Acknowledge all',
      '.needs-you',
      'Acknowledge all',
      /\/api\/decisions\/acknowledge$/,
    ],
    [
      'problem: Acknowledge',
      '[data-card="problems"]',
      'Acknowledge',
      /\/api\/problems\/acknowledge$/,
    ],
    [
      'planning: Move to Ready',
      '[data-card="planning-queue"]',
      'Move to Ready(RCP-5)',
      /\/api\/items\/RCP-5$/,
    ],
    [
      'deferred: Create test ticket',
      '[data-card="deferred"]',
      'Create test ticket',
      /\/api\/deferred\/hri_1\/follow-up$/,
    ],
  ];

  it.each(actions)('%s', async (_name, card, button, request) => {
    const user = userEvent.setup();
    renderAt();
    await section();
    await user.click(within(inCard(card)).getByRole('button', { name: button }));
    await waitFor(() => expect(sent.some((c) => request.test(c.path))).toBe(true));
  });

  it('a project decision card: Confirm, Withdraw and Acknowledge are there', async () => {
    renderAt();
    const needsYou = await section();
    const decision = needsYou.querySelector('[data-project-decision-card="dcn_1"]');
    const buttons = within(decision as HTMLElement);
    for (const name of ['Confirm', 'Withdraw…', 'Acknowledge']) {
      expect(buttons.getByRole('button', { name })).toBeTruthy();
    }
  });

  it('a packet opens its review, and a question takes an answer inline', async () => {
    const user = userEvent.setup();
    renderAt();
    const needsYou = await section();
    expect(within(needsYou).getByRole('link', { name: 'Open packet' }).getAttribute('href')).toBe(
      '/review/RCP-1',
    );
    await user.click(within(needsYou).getByRole('button', { name: 'Answer codex on RCP-2' }));
    expect(within(needsYou).getByLabelText('Your answer to codex')).toBeTruthy();
  });
});

describe('the badge', () => {
  it('equals the owner actions shown, and the parts add up to it', async () => {
    renderAt();
    await section();
    const n = needsYouCount(needs);
    expect(n).toBe(10);
    const parts = ownerActionParts(needs);
    expect(parts.reviews + parts.questions + parts.decisions + parts.problems).toBe(n);
    await waitFor(() => expect(nav().querySelector('.badge')?.textContent).toContain(String(n)));
    expect(document.title).toBe(`(${n}) Docket`);
    expect(
      document.querySelector('[data-needs-you-count]')?.getAttribute('data-needs-you-count'),
    ).toBe(String(n));
    expect(screen.getByRole('heading', { level: 2, name: `Needs you · ${n}` })).toBeTruthy();
    expect(within(stat('needs-you')).getByRole('link', { name: `${n} to act on` })).toBeTruthy();
  });

  it('disappears with "Nothing needs you"; agent problems stay on one collapsed line', async () => {
    needs = quiet({ agent_problems: [problem('parked_too_long:RCP-10', 'agent')] });
    renderAt();
    expect(await screen.findByText('Nothing needs you')).toBeTruthy();
    expect(nav().querySelector('.badge')).toBeNull();
    expect(document.title).toBe('Docket');
    const line = screen.getByRole('button', { name: 'Agents are handling 1 problem' });
    expect(line.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-more-problems="agents"] [data-problem]')).toBeNull();
    expect(document.querySelector('[data-card="problems"]')).toBeNull();
  });
});

describe('every number links to what is behind it', () => {
  it('the stat cards and the workload', async () => {
    renderAt();
    await section();
    await screen.findByRole('link', { name: '18 tickets' });
    const href = (root: HTMLElement, name: string | RegExp) =>
      within(root).getByRole('link', { name }).getAttribute('href');
    expect(href(stat('completed'), '18 tickets')).toBe('/overview/completed?window=7d');
    expect(href(stat('agents'), '4 being worked')).toBe('/overview/agents_working');
    expect(href(stat('agents'), '3 parked/waiting')).toBe('/overview/agents_waiting');
    expect(href(stat('in-flight'), '23 tickets')).toBe('/overview/in_flight');
    expect(href(stat('in-flight'), '5 blocked')).toBe('/work?quick=blocked');
    const work = document.querySelector('[data-card="workload"]') as HTMLElement;
    expect(href(work, '9 open in Visual')).toBe('/work?epic=RCP-40&quick=active');
    expect(href(work, '2 open in No epic')).toBe('/overview/no_epic');
  });

  it('counts agents as stories, and never shows raw run counts', async () => {
    renderAt();
    await section();
    await screen.findByRole('link', { name: '4 being worked' });
    expect(document.querySelector('[data-card="agents-strip"]')).toBeNull();
    expect(document.querySelector('.overview')?.textContent).not.toMatch(/× 3/);
  });

  it('names the card for what it counts, explains it, and estimates no sessions', async () => {
    renderAt();
    await section();
    await screen.findByRole('link', { name: '4 being worked' });
    const card = screen.getByRole('group', { name: 'Tickets with agents' });
    expect(card.getAttribute('data-stat')).toBe('agents');
    const note = document.getElementById(card.getAttribute('aria-describedby')!)!;
    expect(note.textContent).toContain(AGENTS_NOTE);
    expect(AGENTS_NOTE).toContain('Counts tickets in Docket, not agent sessions.');
    // No number of sessions anywhere on the card or in its note.
    expect(`${card.textContent} ${note.textContent}`).not.toMatch(/\d+\s+(agent )?sessions?/i);
  });

  it('an old /needs-you link lands on the section', async () => {
    const router = renderAt('/needs-you');
    await section();
    expect(router.state.location.pathname).toBe('/');
    expect(router.state.location.hash).toBe('#needs-you');
  });
});

describe('the Agents badge equals the card (decision 43)', () => {
  const agentsLink = () => screen.getByRole('link', { name: /^Agents/ });

  it.each([
    ['all', 'All projects', 4, 3],
    ['RCP', 'one project', 1, 2],
  ])('%s (%s)', async (scope, _name, working, waiting) => {
    byScope = { RCP: quiet({ agents_now: { working: 1, waiting: 2 } }) };
    sessionStorage.setItem(STORAGE_KEYS.scope, scope);
    renderAt();
    const card = await screen.findByRole('link', { name: `${working} being worked` });
    expect(card.closest('[data-stat="agents"]')).toBeTruthy();
    expect(
      within(stat('agents')).getByRole('link', { name: `${waiting} parked/waiting` }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(agentsLink().querySelector('.badge')?.textContent).toContain(String(working)),
    );
    // Parked isn't in the badge, and the badge uses the card's words.
    expect(agentsLink().textContent).toContain(
      working === 1 ? 'ticket being worked' : 'tickets being worked',
    );
    const title = agentsLink().querySelector('.badge')?.getAttribute('title');
    expect(title).toContain('Parked or waiting tickets aren’t counted');
    expect(title).toContain('not agent sessions');
  });

  it('shows no badge when every ticket is parked, though the card says who waits', async () => {
    needs = quiet({ agents_now: { working: 0, waiting: 2 }, agent_counts: { parked: 2 } });
    renderAt();
    await screen.findByRole('link', { name: '0 being worked' });
    expect(screen.getByRole('link', { name: '2 parked/waiting' })).toBeTruthy();
    expect(agentsLink().querySelector('.badge')).toBeNull();
  });

  it('the Agents page says its lists are runs, beside the same ticket count', async () => {
    renderAt('/agents');
    const line = await waitFor(() => {
      const el = document.querySelector('[data-agents-stories]');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(line.textContent).toContain('4 tickets being worked');
    expect(line.textContent).toContain('3 parked/waiting');
    expect(line.textContent).toContain('show individual runs');
    await waitFor(() => expect(agentsLink().querySelector('.badge')?.textContent).toContain('4'));
  });
});

describe('the time window', () => {
  it('defaults to 7 days, and remembers the last choice', async () => {
    const user = userEvent.setup();
    renderAt();
    const group = await screen.findByRole('group', { name: 'Time window' });
    expect(within(group).getByRole('button', { name: '7d' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    await user.click(within(group).getByRole('button', { name: '30d' }));
    await waitFor(() => expect(asked.some((p) => p.includes('window=30d'))).toBe(true));
    expect(localStorage.getItem(STORAGE_KEYS.overviewWindow)).toBe('30d');
    expect(readOverviewWindow()).toBe('30d');
  });

  it('ignores a bad stored value, and works when storage throws', async () => {
    localStorage.setItem(STORAGE_KEYS.overviewWindow, 'forever');
    expect(readOverviewWindow()).toBe('7d');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readOverviewWindow()).toBe('7d');
    const user = userEvent.setup();
    renderAt();
    const group = await screen.findByRole('group', { name: 'Time window' });
    await user.click(within(group).getByRole('button', { name: '24h' }));
    expect(within(group).getByRole('button', { name: '24h' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });
});

describe('the Completed chart (B56)', () => {
  const bar = (key: string) => document.querySelector(`[data-bar="${key}"]`) as HTMLButtonElement;
  const tip = () => document.querySelector('[data-chart-tip]') as HTMLElement | null;
  const chart = async () => {
    renderAt();
    await screen.findByRole('table', { name: /Tickets completed per day/ });
  };

  it.each([
    [0, [0, 1]],
    [1, [0, 1]],
    [2, [0, 1, 2]],
    [3, [0, 1, 2, 3]],
    [4, [0, 1, 2, 3, 4]],
    [5, [0, 2, 4, 6]],
    [9, [0, 5, 10]],
    [12, [0, 5, 10, 15]],
    [137, [0, 50, 100, 150]],
    [1000, [0, 500, 1000]],
    [12345, [0, 5000, 10000, 15000]],
  ])('axis ticks for a peak of %i', (max, ticks) => {
    expect(axisTicks(max)).toEqual(ticks);
  });

  it('axis ticks are always whole, reach the peak, and stay few', () => {
    for (let max = 0; max <= 2500; max++) {
      const ticks = axisTicks(max);
      expect(ticks.every(Number.isInteger)).toBe(true);
      expect(ticks[0]).toBe(0);
      expect(ticks.at(-1)!).toBeGreaterThanOrEqual(max);
      expect(ticks.length).toBeLessThanOrEqual(5);
    }
  });

  it('draws the axis, and scales the bars to its top tick', async () => {
    await chart();
    const labels = [...document.querySelectorAll('.ov-yaxis span')].map((s) => s.textContent);
    expect(labels).toEqual(['0', '5', '10', '15']);
    expect((bar('2026-11-20').querySelector('i') as HTMLElement).style.height).toBe('80%');
    expect(bar('2026-11-18').querySelector('i')).toBeNull();
  });

  it('hover shows the date, count and linked tickets, with "and N more"', async () => {
    const user = userEvent.setup();
    await chart();
    await user.hover(bar('2026-11-20'));
    const open = tip()!;
    expect(open.textContent).toContain('Nov 20');
    expect(open.textContent).toContain('12 tickets completed');
    const links = within(open).getAllByRole('link');
    expect(links).toHaveLength(6);
    expect(links[0]!.getAttribute('href')).toBe('/items/RCP-41');
    expect(links[0]!.textContent).toContain('Title RCP-41');
    expect(open.textContent).toContain('and 6 more');
    expect(bar('2026-11-20').getAttribute('aria-expanded')).toBe('true');
    expect(bar('2026-11-20').getAttribute('aria-controls')).toBe(open.id);
  });

  it('shows no "more" when every ticket fits, and says none for an empty bucket', async () => {
    const user = userEvent.setup();
    await chart();
    await user.hover(bar('2026-11-19'));
    expect(tip()!.textContent).not.toContain('more');
    await user.hover(bar('2026-11-18'));
    expect(tip()!.textContent).toContain('None completed');
    expect(within(tip()!).queryByRole('link')).toBeNull();
  });

  it('stays open while the pointer moves onto it, and closes after it leaves', async () => {
    const user = userEvent.setup();
    await chart();
    await user.hover(bar('2026-11-20'));
    await user.hover(tip()!);
    await new Promise((r) => setTimeout(r, 260));
    expect(tip()).toBeTruthy();
    await user.unhover(tip()!);
    await waitFor(() => expect(tip()).toBeNull());
  });

  it('the keyboard: one tab stop, arrows move, Tab reaches the links, Esc returns', async () => {
    const user = userEvent.setup();
    await chart();
    const stops = [...document.querySelectorAll('[data-bar]')].filter(
      (b) => (b as HTMLElement).tabIndex === 0,
    );
    // The newest bar with tickets is the way in.
    expect(stops).toEqual([bar('2026-11-20')]);
    bar('2026-11-20').focus();
    await waitFor(() => expect(tip()?.dataset.chartTip).toBe('2026-11-20'));
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(bar('2026-11-19'));
    await waitFor(() => expect(tip()?.dataset.chartTip).toBe('2026-11-19'));
    expect(bar('2026-11-19').tabIndex).toBe(0);
    expect(bar('2026-11-20').tabIndex).toBe(-1);
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(bar('2026-11-18'));
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(bar('2026-11-20'));

    await user.tab();
    expect(document.activeElement?.getAttribute('href')).toBe('/items/RCP-41');
    expect(tip()).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(tip()).toBeNull();
    expect(document.activeElement).toBe(bar('2026-11-20'));
  });

  it('closes when focus leaves the chart', async () => {
    const user = userEvent.setup();
    await chart();
    bar('2026-11-18').focus();
    await waitFor(() => expect(tip()).toBeTruthy());
    await user.tab();
    await waitFor(() => expect(tip()).toBeNull());
  });

  it('stays inside the window at every edge', () => {
    const view = { width: 1024, height: 768 };
    const size = { width: 300, height: 200 };
    const at = (left: number, top: number) => ({
      left,
      width: 12,
      top,
      bottom: top + 132,
    });
    expect(placeTip(at(500, 400), size, view)).toEqual({ left: 356, top: 194 });
    expect(placeTip(at(0, 400), size, view).left).toBe(8);
    expect(placeTip(at(1012, 400), size, view).left).toBe(716);
    // No room above: below it.
    expect(placeTip(at(500, 60), size, view).top).toBe(198);
    // No room either way: as high as fits.
    const short = placeTip(at(500, 60), size, { width: 1024, height: 300 });
    expect(short.top).toBe(92);
  });

  it('the text alternative names the tickets, the overflow and an empty bucket', async () => {
    await chart();
    const table = screen.getByRole('table', { name: /Tickets completed per day/ });
    const row = (name: string) => within(table).getByRole('rowheader', { name }).closest('tr')!;
    expect(row('Nov 18').textContent).toContain('None');
    expect(row('Nov 19').textContent).toContain('RCP-31 Pantry screen');
    expect(row('Nov 20').textContent).toContain('and 6 more');
    expect(
      bucketTicketsText({
        key: 'k',
        label: 'Nov 1',
        count: 3,
        tickets: [{ id: 'RCP-1', title: 'One' }],
      }),
    ).toBe('RCP-1 One; and 2 more');
  });
});

describe('text equivalents', () => {
  it('the comparison says its direction in words and signs', () => {
    expect(deltaText(18, 12, '7d')).toBe('+6 vs the previous 7 days');
    expect(deltaText(3, 5, '24h')).toBe('−2 vs the previous 24 hours');
    expect(deltaText(4, 4, '30d')).toBe('Same as the previous 30 days');
  });

  it('the charts have a sentence, a table and a labelled bar', async () => {
    expect(completedSummary(metrics().completed)).toBe(
      '18 tickets completed. Busiest: Nov 20, with 12.',
    );
    expect(completedSummary({ ...metrics().completed, count: 0, buckets: [] })).toBe(
      'No tickets completed in this window.',
    );
    expect(workloadText(metrics().workload[0]!)).toBe(
      'Visual: 1 Review, 3 In progress, 3 Ready, 2 Blocked',
    );
    renderAt();
    expect(await screen.findByRole('table', { name: /Tickets completed per day/ })).toBeTruthy();
    expect(
      screen.getByRole('img', { name: 'Visual: 1 Review, 3 In progress, 3 Ready, 2 Blocked' }),
    ).toBeTruthy();
  });

  it('shows no token use or estimated metric', async () => {
    renderAt();
    await screen.findByRole('link', { name: '18 tickets' });
    const stats = document.querySelector('.ov-stats')?.textContent ?? '';
    expect(stats).not.toMatch(/token|estimate/i);
  });
});
