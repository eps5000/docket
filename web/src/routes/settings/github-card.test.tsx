// @vitest-environment jsdom
/**
 * Settings → Connections → GitHub and the ticket's panel (owner decision 49):
 * every status in words, the connect steps, stale labels, Related kept apart,
 * and where Merged came from.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GITHUB_STATES,
  type GithubSettingsResponse,
  type ItemDetailResponse,
  type ItemGithubResponse,
  type ItemPr,
  type OverviewResponse,
} from '@docket/shared';
import { apiClient } from '../../app/queryClient';
import { mergedNote } from '../overview/FlowChart';
import { GitHubSection } from '../items/details/GitHubSection';
import { GITHUB_STATUS, GitHubCard } from './GitHubCard';

const settings = (over: Partial<GithubSettingsResponse> = {}): GithubSettingsResponse => ({
  enabled: true,
  state: 'connected',
  stale: false,
  last_sync_at: new Date(Date.now() - 4 * 60_000).toISOString(),
  last_error: null,
  repos: [{ repo: 'acme/web-app', projects: ['RCP'], last_sync_at: null, error: null }],
  projects: [
    {
      key: 'RCP',
      name: 'Recipe App',
      github_repo: 'acme/web-app',
      branch_rule: 'warn',
      branch_exempt: ['mergify/*', 'main', '*docket-agent-files*'],
    },
  ],
  default_exempt: ['mergify/*', 'main', '*docket-agent-files*'],
  ...over,
});

const pr = (number: number, over: Partial<ItemPr> = {}): ItemPr => ({
  repo: 'acme/web-app',
  number,
  title: `Change ${number}`,
  url: `https://github.com/acme/web-app/pull/${number}`,
  branch: `dev/RCP-1-change-${number}`,
  branch_url: `https://github.com/acme/web-app/tree/dev/RCP-1-change-${number}`,
  state: 'open',
  draft: false,
  ci: 'passed',
  checks_url: `https://github.com/acme/web-app/pull/${number}/checks`,
  merged_at: null,
  run_id: null,
  ...over,
});

const item = (over: Partial<ItemGithubResponse> = {}): ItemGithubResponse => ({
  enabled: true,
  state: 'connected',
  stale: false,
  last_sync_at: new Date(Date.now() - 60_000).toISOString(),
  primary: [],
  related: [],
  naming: null,
  ...over,
});

const wrap = (node: ReactNode) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );

const showCard = (data: GithubSettingsResponse, protectedMode = false) => {
  vi.spyOn(apiClient, 'github.get').mockResolvedValue(data);
  return wrap(<GitHubCard protectedMode={protectedMode} />);
};
const detail = { item: { id: 'RCP-1' } } as ItemDetailResponse;
const showPanel = (data: ItemGithubResponse) => {
  vi.spyOn(apiClient, 'items.github').mockResolvedValue(data);
  return wrap(<GitHubSection data={detail} />);
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the GitHub card', () => {
  it.each(GITHUB_STATES)('says %s in words', async (state) => {
    showCard(settings({ state, enabled: state !== 'off' }));
    expect((await screen.findAllByText(GITHUB_STATUS[state].label)).length).toBeGreaterThan(0);
    expect(screen.getByText(GITHUB_STATUS[state].help)).toBeTruthy();
  });

  it('is plain about the token', async () => {
    showCard(settings({ state: 'off', enabled: false }));
    expect(await screen.findByText(/stores no GitHub token and\s+never writes/)).toBeTruthy();
    expect((await screen.findByRole<HTMLInputElement>('checkbox')).checked).toBe(false);
    expect(screen.queryByText('Connect it')).toBeNull();
  });

  it('shows the steps until it is connected', async () => {
    showCard(settings({ state: 'helper_not_running', last_sync_at: null }));
    expect(await screen.findByText('Connect it')).toBeTruthy();
    expect(screen.getByText('gh auth login')).toBeTruthy();
    expect(screen.getByText(/manage\.ps1 -Action Install/)).toBeTruthy();
  });

  it('says protected mode stops the helper', async () => {
    showCard(settings({ state: 'helper_not_running' }), true);
    expect(await screen.findByText(/Protected mode is on/)).toBeTruthy();
  });

  it('labels stale data', async () => {
    showCard(settings({ state: 'helper_not_running', stale: true }));
    expect(await screen.findByText('Out of date')).toBeTruthy();
  });

  it('turns on from the checkbox', async () => {
    const set = vi
      .spyOn(apiClient, 'github.set')
      .mockResolvedValue({ mutation_id: 'mut_1', ...settings() });
    showCard(settings({ state: 'off', enabled: false }));
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Connect to GitHub' }));
    expect(set).toHaveBeenCalledWith({ body: { enabled: true } });
  });

  it('refuses a repository that is not owner/name, and says why', async () => {
    const save = vi.spyOn(apiClient, 'github.setProject');
    showCard(settings());
    const input = await screen.findByRole('textbox', {
      name: 'GitHub repository for Recipe App',
    });
    await userEvent.clear(input);
    await userEvent.type(input, 'not a repo');
    await userEvent.click(screen.getByRole('button', { name: 'Save Recipe App' }));
    expect(screen.getByRole('alert').textContent).toContain('owner/name');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(save).not.toHaveBeenCalled();
  });

  it('saves a project’s rule', async () => {
    const save = vi
      .spyOn(apiClient, 'github.setProject')
      .mockResolvedValue({ mutation_id: 'mut_2', ...settings() });
    showCard(settings());
    await userEvent.selectOptions(
      await screen.findByRole('combobox', { name: 'Branch naming for Recipe App' }),
      'off',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save Recipe App' }));
    expect(save).toHaveBeenCalledWith({
      params: { key: 'RCP' },
      body: {
        github_repo: 'acme/web-app',
        branch_rule: 'off',
        branch_exempt: ['mergify/*', 'main', '*docket-agent-files*'],
      },
    });
  });
});

describe('the ticket’s GitHub panel', () => {
  it('is hidden when off with nothing to show', async () => {
    const spy = vi
      .spyOn(apiClient, 'items.github')
      .mockResolvedValue(item({ enabled: false, state: 'off', last_sync_at: null }));
    const { container } = wrap(<GitHubSection data={detail} />);
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.querySelector('[data-section="github"]')).toBeNull();
  });

  it('shows state, CI and links, with words as well as colour', async () => {
    showPanel(
      item({
        primary: [pr(12, { state: 'merged', ci: 'failed', merged_at: '2026-11-20T10:00:00Z' })],
      }),
    );
    const list = await screen.findByRole('list', { name: 'Pull requests for this ticket' });
    expect(within(list).getByText('✓ Merged')).toBeTruthy();
    expect(within(list).getByText('CI failed')).toBeTruthy();
    const link = within(list).getByRole('link', { name: /#12 Change 12/ });
    expect(link.getAttribute('href')).toBe('https://github.com/acme/web-app/pull/12');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.textContent).toContain('opens GitHub');
  });

  it('keeps Related apart', async () => {
    showPanel(item({ primary: [pr(1)], related: [pr(2)] }));
    const related = await screen.findByRole('list', { name: 'Related pull requests' });
    expect(within(related).getByText(/#2 Change 2/)).toBeTruthy();
    const main = screen.getByRole('list', { name: 'Pull requests for this ticket' });
    expect(within(main).queryByText(/#2 Change 2/)).toBeNull();
  });

  it('labels stale data', async () => {
    showPanel(item({ primary: [pr(1)], stale: true }));
    expect(await screen.findByText('Out of date')).toBeTruthy();
  });

  it('shows a branch that lacks the key, with the fix', async () => {
    showPanel(item({ naming: { suggested: '<owner>/RCP-1-fix-login', unnamed: ['dev/other'] } }));
    expect(await screen.findByText('dev/other')).toBeTruthy();
    expect(screen.getByText('<owner>/RCP-1-fix-login')).toBeTruthy();
  });
});

describe('where Merged came from', () => {
  const flow = (over: Partial<OverviewResponse['flow']>) =>
    ({
      granularity: 'day',
      buckets: [],
      finished: 3,
      merged: 2,
      parked: 0,
      finished_without_merge: 0,
      note: null,
      ...over,
    }) as OverviewResponse['flow'];
  const ago = new Date(Date.now() - 4 * 60_000).toISOString();

  it('names GitHub when connected', () => {
    expect(mergedNote(flow({ merged_source: 'github', merged_synced_at: ago }))).toMatch(
      /^Merged counts PRs from GitHub, last synced/,
    );
  });

  it('warns when the sync is old', () => {
    expect(mergedNote(flow({ merged_source: 'github_stale', merged_synced_at: ago }))).toContain(
      'recent merges may be missing',
    );
  });

  it('keeps the recorded wording otherwise', () => {
    expect(mergedNote(flow({ merged_source: 'recorded' }))).toBe(
      'Merged counts only PRs an agent recorded in Docket.',
    );
    expect(mergedNote(flow({}))).toBe('Merged counts only PRs an agent recorded in Docket.');
  });
});
