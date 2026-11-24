// @vitest-environment jsdom
/**
 * Decision 62 (B79): the idle ticket's problem row and its *Decide…* dialog,
 * the epic card's and epic page's "Added since it started" lines, and the
 * map card's "added mid-flight" mark. Synthetic data only.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EpicMidflight, Problem } from '@docket/shared';
import { createAppQueryClient } from '../app/queryClient';
import { EpicMidflightLine, EpicMidflightNote } from '../components/kit';
import { MapCard } from '../components/ProgressMap/MapCard';
import type { MapItem } from '../components/ProgressMap/layout';
import { ProblemsCard } from './needs-you/ProblemsCard';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

function wrap(ui: ReactNode, body: unknown = {}) {
  const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(json(body)),
  );
  vi.stubGlobal('fetch', fetchMock);
  render(
    <QueryClientProvider client={createAppQueryClient()}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
  return fetchMock;
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const idle: Problem = {
  kind: 'idle_ticket',
  id: 'idle_ticket:TST-7',
  item_id: 'TST-7',
  title: 'Synthetic export task',
  reason: 'TST-7 is In progress but nobody has worked on it since Nov 20',
  related: [],
  link_id: null,
  run_id: null,
  resource_ids: [],
  explanation: {
    what: 'TST-7 is In progress but nobody has worked on it since Nov 20: no agent, no run and no activity.',
    fix: 'Move it to Planning, Ready or Inbox, cancel it, or clear its branches. If someone will pick it up again, acknowledge this.',
    who: 'owner',
    who_text: 'You (nobody is working on it)',
  },
  reached_you: null,
  acknowledged: null,
  resolution: null,
};

describe('an idle ticket (decision 62)', () => {
  it('has one row with Decide…, which offers the five ways forward and sends the one chosen', async () => {
    const fetchMock = wrap(<ProblemsCard problems={[idle]} />, {
      mutation_id: 'mut_1',
      item: {},
    });
    const row = document.querySelector('[data-problem="idle_ticket"]') as HTMLElement;
    expect(within(row).getByText('TST-7')).toBeTruthy();
    expect(within(row).getByText(idle.explanation!.what)).toBeTruthy();
    await userEvent.click(within(row).getByRole('button', { name: 'Decide…' }));
    const dialog = screen.getByRole('dialog', { name: 'What happens to TST-7?' });
    const choices = within(dialog).getAllByRole('radio');
    expect(choices.map((c) => (c as HTMLInputElement).value)).toEqual([
      'ready',
      'planning',
      'inbox',
      'cancel',
      'clear_branches',
    ]);
    await userEvent.click(within(dialog).getByRole('radio', { name: /Move it to Planning/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move it to Planning' }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(post).toBeTruthy();
      expect(String(post![0])).toContain('/api/items/TST-7/idle');
      expect(JSON.parse(String(post![1]!.body))).toEqual({ action: 'planning' });
    });
  });
});

const midflight: EpicMidflight = {
  started_at: '2026-11-20T08:00:00.000Z',
  added: [
    {
      id: 'TST-9',
      title: 'Synthetic crash on save',
      type: 'Bug',
      status: 'inbox',
      added_at: '2026-11-21T08:00:00.000Z',
      untriaged: true,
    },
    {
      id: 'TST-10',
      title: 'Synthetic retry story',
      type: 'Story',
      status: 'ready',
      added_at: '2026-11-22T08:00:00.000Z',
      untriaged: false,
    },
  ],
  untriaged: 1,
};

describe('tickets added after the epic started (decision 62)', () => {
  it('the epic card says how many, with the tickets in its tooltip', () => {
    wrap(<EpicMidflightNote midflight={midflight} />);
    const note = document.querySelector('[data-epic-midflight]') as HTMLElement;
    expect(note.textContent).toContain('Added since it started: 2 tickets · 1 untriaged');
    expect(note.getAttribute('title')).toBe(
      'TST-9 Synthetic crash on save (untriaged)\nTST-10 Synthetic retry story',
    );
  });

  it('the epic page links each ticket, saying untriaged or its status', () => {
    wrap(<EpicMidflightLine midflight={midflight} />);
    const line = document.querySelector('[data-epic-midflight]') as HTMLElement;
    expect(within(line).getByRole('link', { name: 'TST-9' }).getAttribute('href')).toBe(
      '/items/TST-9',
    );
    expect(line.textContent).toContain('TST-9 (untriaged)');
    expect(line.textContent).toContain('TST-10 (Ready)');
  });

  it('the map card marks a ticket added mid-flight, in words', () => {
    const item = {
      id: 'TST-9',
      type: 'Bug',
      title: 'Synthetic crash on save',
      status: 'inbox',
      blocked: false,
      blocked_by: [],
      lead: null,
      human_review: { declared: 0, ready: 0 },
      added_midflight: true,
    } as unknown as MapItem;
    wrap(<MapCard item={item} />);
    const card = screen.getByRole('button', { name: /TST-9/ });
    expect(within(card).getByText('· added mid-flight').getAttribute('title')).toBe(
      'Added after the epic started',
    );
  });
});
