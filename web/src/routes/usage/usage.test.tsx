// @vitest-environment jsdom
/**
 * Token use in the UI (owner decision 48; B63): the number formats, tokens kept
 * apart, the estimate always labelled, "Cost not available", nothing at all with
 * the source off, and the Settings note visible before it's turned on.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ItemDetailResponse,
  SettingsResponse,
  UsageBucket,
  UsageCost,
  UsageItemResponse,
  UsageSettingsResponse,
  UsageSummaryResponse,
  UsageTokens,
} from '@docket/shared';
import { createAppQueryClient } from '../../app/queryClient';
import { UsageSection } from '../items/details/UsageSection';
import { UsageCard } from '../overview/UsageCard';
import { UsageSourceCard, usageStatusText } from '../settings/UsageSourceCard';
import { CostLine, TokenKinds, TokenTable } from './UsageParts';
import {
  formatTokens,
  formatUsd,
  shareText,
  unpricedText,
  USAGE_SOURCE_NOTE,
  USAGE_SOURCE_TITLE,
} from './usageText';

const AT = '2026-11-23T10:00:00.000Z';
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const tokens = (over: Partial<UsageTokens> = {}): UsageTokens => ({
  fresh_input: 12_000,
  cached_input: 4_500_000,
  cache_write: 80_000,
  output: 30_000,
  ...over,
});
const priced = (usd = 3.42): UsageCost => ({ usd, unpriced_tokens: 0, unpriced_models: [] });
const bucket = (over: Partial<UsageBucket> = {}): UsageBucket => ({
  tokens: tokens(),
  cost: priced(),
  turns: 40,
  sessions: 3,
  ...over,
});
const none = bucket({
  tokens: tokens({ fresh_input: 0, cached_input: 0, cache_write: 0, output: 0 }),
  cost: { usd: null, unpriced_tokens: 0, unpriced_models: [] },
  turns: 0,
  sessions: 0,
});

const summary = (over: Partial<UsageSummaryResponse> = {}): UsageSummaryResponse => ({
  enabled: true,
  prices_as_of: '2026-11-23',
  last_turn_at: AT,
  from: '2026-11-16T10:00:00.000Z',
  to: AT,
  total: bucket(),
  linked: bucket(),
  overhead: bucket({
    tokens: tokens({ fresh_input: 1000, cached_input: 0, cache_write: 0, output: 0 }),
  }),
  unlinked: bucket({
    tokens: tokens({ fresh_input: 2000, cached_input: 0, cache_write: 0, output: 0 }),
  }),
  linked_pct: 72,
  models: [],
  top_tickets: { count: 0, rows: [] },
  ...over,
});

const itemUsage = (over: Partial<UsageItemResponse> = {}): UsageItemResponse => ({
  enabled: true,
  prices_as_of: '2026-11-23',
  last_turn_at: AT,
  item_id: 'RCP-1',
  rollup: false,
  total: bucket(),
  models: [{ model: 'claude-opus-5-5', tokens: tokens(), cost: priced(), turns: 40 }],
  sessions: {
    count: 1,
    rows: [
      {
        session_id: 'sess-1',
        client: 'codex',
        first_at: AT,
        last_at: AT,
        turns: 40,
        models: ['gpt-5.5'],
        tokens: tokens(),
        cost: priced(),
      },
    ],
  },
  children: [],
  ...over,
});

const settings = (over: Partial<UsageSettingsResponse> = {}): UsageSettingsResponse => ({
  enabled: false,
  coordinator_folders: [],
  helper: 'off',
  last_read_at: null,
  turns_stored: 0,
  ...over,
});

const detail = { item: { id: 'RCP-1' } } as unknown as ItemDetailResponse;
const PROJECTS = [{ key: 'RCP', name: 'Recipe App' }] as unknown as SettingsResponse['projects'];

function withApp(ui: ReactNode, body: unknown) {
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

describe('formats', () => {
  it('shortens token counts without rounding up to the wrong unit', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_345)).toBe('12.3K');
    expect(formatTokens(999_499)).toBe('999K');
    expect(formatTokens(999_500)).toBe('1M');
    expect(formatTokens(4_500_000)).toBe('4.5M');
    expect(formatTokens(1_200_000_000)).toBe('1.2B');
  });

  it('writes dollars plainly', () => {
    expect(formatUsd(0)).toBe('$0');
    expect(formatUsd(0.004)).toBe('under $0.01');
    expect(formatUsd(3.42)).toBe('$3.42');
    expect(formatUsd(1204.4)).toBe('$1,204');
  });

  it('never shows a small share as 0%', () => {
    expect(shareText(1, 1000)).toBe('under 1%');
    expect(shareText(0, 1000)).toBe('0%');
    expect(shareText(5, 0)).toBe('0%');
    expect(shareText(970, 1000)).toBe('97%');
  });

  it('says what an estimate leaves out', () => {
    expect(unpricedText(priced())).toBeNull();
    expect(unpricedText({ usd: 1, unpriced_tokens: 1500, unpriced_models: [] })).toBe(
      '1.5K tokens have no sourced price, so they aren’t in this estimate.',
    );
    expect(unpricedText({ usd: null, unpriced_tokens: 9, unpriced_models: ['m-1'] })).toContain(
      '(m-1)',
    );
  });
});

describe('the parts', () => {
  it('shows all four kinds with their shares, never one total', () => {
    render(<TokenKinds tokens={tokens()} />);
    const reads = document.querySelector('[data-usage-kind="cached_input"]')!;
    expect(reads.textContent).toContain('Cache reads');
    expect(reads.textContent).toContain('4.5M');
    expect(reads.textContent).toContain('97%');
    expect(document.querySelectorAll('[data-usage-kind]')).toHaveLength(4);
    expect(document.body.textContent).not.toMatch(/total/i);
  });

  it('labels dollars as an estimate, and says a subscription may cost less', () => {
    render(<CostLine cost={priced()} asOf="2026-11-23" />);
    const text = document.body.textContent ?? '';
    expect(text).toContain('$3.42 API-equivalent estimate.');
    expect(text).toContain('Tokens are measured.');
    expect(text).toContain('from 2026-11-23');
    expect(text).toContain('A subscription plan may cost less.');
  });

  it('shows "Cost not available" and no dollar figure without a price', () => {
    render(
      <CostLine
        cost={{ usd: null, unpriced_tokens: 500, unpriced_models: ['made-up'] }}
        asOf="2026-11-23"
      />,
    );
    const line = document.querySelector('[data-usage-cost] p')!.textContent ?? '';
    expect(line).toContain('Cost not available.');
    expect(line).toContain('made-up');
    expect(line).not.toContain('$');
  });

  it('marks a row with no price in the table', () => {
    render(
      <TokenTable
        caption="By model"
        first="Model"
        rows={[
          {
            key: 'x',
            label: 'made-up',
            tokens: tokens(),
            cost: { usd: null, unpriced_tokens: 5, unpriced_models: ['made-up'] },
          },
        ]}
      />,
    );
    const row = screen.getByRole('row', { name: /made-up/ });
    expect(within(row).getByText('Not available')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'By model' }).getAttribute('tabindex')).toBe('0');
  });
});

describe('with the source off', () => {
  it('shows no Overview card', async () => {
    const fetchMock = withApp(
      <UsageCard scope="all" window="7d" />,
      summary({ enabled: false, total: none }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(document.querySelector('[data-card="token-use"]')).toBeNull();
  });

  it('shows no section on a ticket', async () => {
    const fetchMock = withApp(
      <UsageSection data={detail} />,
      itemUsage({ enabled: false, total: none }),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(document.querySelector('[data-section="token-use"]')).toBeNull();
  });
});

describe('with the source on', () => {
  it('shows the window on Overview with linked, overhead and not linked', async () => {
    withApp(<UsageCard scope="all" window="7d" />, summary());
    const split = await waitFor(() => {
      const el = document.querySelector('[data-usage-split]');
      if (!el) throw new Error('not yet');
      return el;
    });
    expect(split.textContent).toContain('72% linked to tickets');
    expect(split.textContent).toContain('1K project overhead');
    expect(split.textContent).toContain('2K not linked to a ticket');
    expect(document.body.textContent).toContain('API-equivalent estimate');
  });

  it('says so when the window is empty', async () => {
    withApp(<UsageCard scope="all" window="7d" />, summary({ total: none, linked_pct: null }));
    expect(await screen.findByText('No token use recorded in this window.')).toBeTruthy();
  });

  it('shows a ticket by kind, model and session', async () => {
    withApp(<UsageSection data={detail} />, itemUsage());
    expect(await screen.findByRole('region', { name: 'Token use by model' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Token use by session' })).toBeTruthy();
    expect(screen.getByRole('row', { name: /claude-opus-5-5/ })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Token use by ticket' })).toBeNull();
  });

  it('adds an epic’s tickets up and links them', async () => {
    withApp(
      <UsageSection data={detail} />,
      itemUsage({
        rollup: true,
        children: [
          {
            id: 'RCP-2',
            title: 'A child ticket',
            project: 'RCP',
            status: 'done',
            tokens: tokens(),
            cost: priced(),
          },
        ],
      }),
    );
    const table = await screen.findByRole('region', { name: 'Token use by ticket' });
    expect(within(table).getByRole('link', { name: /RCP-2/ }).getAttribute('href')).toBe(
      '/items/RCP-2',
    );
    expect(screen.getByText('This epic and its tickets, added up.')).toBeTruthy();
  });

  it('says plainly when a ticket has none', async () => {
    withApp(<UsageSection data={detail} />, itemUsage({ total: none, models: [] }));
    expect(await screen.findByText('No token use is linked to this ticket yet.')).toBeTruthy();
  });
});

describe('Settings', () => {
  it('shows the title and the whole note before it is turned on', async () => {
    withApp(<UsageSourceCard projects={PROJECTS} />, settings());
    const toggle = await screen.findByRole('switch', { name: USAGE_SOURCE_TITLE });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    expect(document.querySelector('[data-usage-note]')!.textContent).toBe(USAGE_SOURCE_NOTE);
    expect(USAGE_SOURCE_NOTE).toContain('include your conversations with those agents');
    expect(document.body.textContent).toContain('Counts already collected stay in Docket');
    expect(document.querySelector('[data-usage-status]')!.textContent).toBe('Off');
    expect(screen.queryByText('Coordinator folders')).toBeNull();
  });

  it('words each status', () => {
    expect(usageStatusText({ helper: 'off', last_read_at: null })).toBe('Off');
    expect(usageStatusText({ helper: 'not_running', last_read_at: null })).toBe(
      'On, but the helper isn’t running.',
    );
    expect(usageStatusText({ helper: 'not_running', last_read_at: AT })).toMatch(
      /^On, but the helper isn’t running\. Last read /,
    );
    expect(usageStatusText({ helper: 'running', last_read_at: AT })).toMatch(/^On\. Last read /);
  });

  it('turns it on through the API and keeps focus on the switch', async () => {
    const user = userEvent.setup();
    const fetchMock = withApp(<UsageSourceCard projects={PROJECTS} />, settings());
    const toggle = await screen.findByRole('switch', { name: USAGE_SOURCE_TITLE });
    await user.click(toggle);
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
      expect(put).toBeTruthy();
      expect(JSON.parse(String(put![1]!.body))).toEqual({ enabled: true });
    });
    expect(document.activeElement).toBe(toggle);
  });

  it('adds a coordinator folder once on', async () => {
    const user = userEvent.setup();
    const fetchMock = withApp(
      <UsageSourceCard projects={PROJECTS} />,
      settings({ enabled: true, helper: 'not_running' }),
    );
    await user.type(await screen.findByLabelText('Folder'), 'C:\\work\\coordinator');
    await user.click(screen.getByRole('button', { name: 'Add folder' }));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
      expect(JSON.parse(String(put![1]!.body))).toEqual({
        enabled: true,
        coordinator_folders: [{ project: 'RCP', path: 'C:\\work\\coordinator' }],
      });
    });
  });
});
