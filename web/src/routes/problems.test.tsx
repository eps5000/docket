// @vitest-environment jsdom
/**
 * Decision 37 (B42): the Problems rows say what's wrong, what fixes it and
 * who acts, with the agent actions; "Agents are handling N problems" opens
 * the rows agents are handling; the item's problem banner, with its warning
 * icon, the acknowledgement and a proposed resolution, and `?problem=`
 * focusing it.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import type { ItemDetailResponse, Problem, ResolutionRow } from '@docket/shared';
import { ProblemsCard } from './needs-you/ProblemsCard';
import { ProblemBanners } from './items/ProblemBanners';

function wrap(children: ReactNode, url = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>{children}</MemoryRouter>
    </QueryClientProvider>,
  );
}
afterEach(cleanup);

const radar = (over: Partial<Problem> = {}): Problem => ({
  kind: 'radar_conflict',
  id: 'rdf_1',
  item_id: 'GF-228',
  title: 'Shell redesign',
  reason: 'Heading for a conflict with main: 53 files · a, b, c, … (stale-228 vs main)',
  related: [],
  link_id: null,
  run_id: null,
  resource_ids: [],
  explanation: {
    what: "GF-228's branch stale-228 is out of date with main: 53 files conflict, including a, b and c.",
    fix: "Rebase it onto main, or split it into short story PRs. If it's an old draft, remove it from GF-228's branches.",
    who: 'agent',
    who_text: 'An agent (GF-228 has no lead yet)',
  },
  reached_you: 'Nobody is working on GF-228',
  branches: [{ item_id: 'GF-228', branch: 'stale-228' }],
  acknowledged: null,
  resolution: null,
  ...over,
});

const resolution = (over: Partial<ResolutionRow> = {}): ResolutionRow => ({
  id: 'prs_1',
  item_id: 'GF-228',
  problem_id: 'rdf_1',
  problem_kind: 'radar_conflict',
  kind: 'split',
  plan_md: '1. Land the shell tokens.\n2. Rebase the rest.',
  reason: 'The branch is 53 files behind main.',
  proposed_by: 'claude · orca-w3',
  state: 'open',
  note: null,
  decided_by: null,
  decided_at: null,
  created_at: '2026-11-20T10:00:00.000Z',
  version: 1,
  ...over,
});

describe('the Problems rows (decision 37)', () => {
  it('say what is wrong, what fixes it, who acts and why it reached you, with the agent actions', () => {
    wrap(<ProblemsCard problems={[radar()]} />);
    const row = document.querySelector('[data-problem="radar_conflict"]') as HTMLElement;
    const lines = within(row);
    expect(lines.getByText('What’s wrong')).toBeTruthy();
    expect(lines.getByText(radar().explanation!.what)).toBeTruthy();
    expect(lines.getByText(radar().explanation!.fix)).toBeTruthy();
    expect(lines.getByText('An agent (GF-228 has no lead yet)')).toBeTruthy();
    expect(lines.getByText('Nobody is working on GF-228')).toBeTruthy();
    expect(lines.getByRole('button', { name: 'Remind the agent' })).toBeTruthy();
    expect(lines.getByRole('link', { name: 'Open the item' }).getAttribute('href')).toBe(
      '/items/GF-228?tab=details&problem=rdf_1',
    );
    expect(lines.getByRole('button', { name: 'Not an active branch: stale-228' })).toBeTruthy();
    expect(lines.getByRole('button', { name: 'Acknowledge' })).toBeTruthy();
    expect(lines.getByRole('button', { name: /^Help: Problems and what to do/ })).toBeTruthy();
  });

  it('an owner problem keeps its own action, and Open lands on the banner', () => {
    wrap(
      <ProblemsCard
        problems={[
          radar({
            kind: 'unpushed_work',
            id: 'unpushed_work:run_25',
            run_id: 'run_25',
            branches: [],
            reached_you: null,
            explanation: {
              what: 'x',
              fix: 'y',
              who: 'owner',
              who_text: 'You, or your coordinator (agents can’t restart themselves)',
            },
          }),
        ]}
      />,
    );
    const row = document.querySelector('[data-problem="unpushed_work"]') as HTMLElement;
    // Decision 41: outcomes that say what happens, in place of *Handled*.
    expect(within(row).getByRole('button', { name: 'Keep for later' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Safe to discard' })).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'Handled' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Acknowledge' })).toBeNull();
    expect(within(row).getByRole('link', { name: 'Open' }).getAttribute('href')).toBe(
      '/items/GF-228?tab=activity&problem=unpushed_work%3Arun_25',
    );
    expect(within(row).queryByRole('button', { name: 'Remind the agent' })).toBeNull();
  });

  it('Keep for later and Safe to discard say what they do before you confirm (decision 41)', async () => {
    const user = userEvent.setup();
    wrap(
      <ProblemsCard
        problems={[
          radar({
            kind: 'unpushed_work',
            id: 'unpushed_work:run_25',
            run_id: 'run_25',
            branches: [],
          }),
        ]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Safe to discard' }));
    const discard = screen.getByRole('dialog', { name: 'Mark this work safe to discard?' });
    expect(discard.textContent).toContain('can then count as Safe to prune');
    expect(discard.textContent).toContain('It doesn’t commit, push, save or delete anything.');
    await user.click(within(discard).getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Keep for later' }));
    const keep = screen.getByRole('dialog', { name: 'Keep this work for later?' });
    expect(keep.textContent).toContain('The worktree stays At risk');
    expect(keep.textContent).toContain('It doesn’t commit, push, save or delete anything.');
  });

  it('"N more" opens the rest, so every counted problem can be reached (decision 41)', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 7 }, (_, i) => radar({ id: `rdf_${i}` }));
    wrap(<ProblemsCard problems={many} />);
    expect(document.querySelectorAll('[data-problem]')).toHaveLength(5);
    await user.click(screen.getByRole('button', { name: '2 more' }));
    expect(document.querySelectorAll('[data-problem]')).toHaveLength(7);
  });

  it('"Agents are handling N problems" opens the rows agents are handling', async () => {
    wrap(
      <ProblemsCard
        problems={[]}
        agentProblems={[radar({ reached_you: null })]}
        acknowledged={[
          radar({ id: 'rdf_2', acknowledged: { by: 'owner', at: new Date().toISOString() } }),
        ]}
      />,
    );
    const line = screen.getByRole('button', { name: 'Agents are handling 1 problem' });
    expect(line.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-more-problems="agents"] [data-problem]')).toBeNull();
    await userEvent.click(line);
    expect(line.getAttribute('aria-expanded')).toBe('true');
    expect(
      document.querySelector('[data-more-problems="agents"] [data-problem-id="rdf_1"]'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'You acknowledged 1 problem' })).toBeTruthy();
  });
});

describe('the item’s problem banner (decision 37)', () => {
  const detail = (problems: Problem[], resolutions: ResolutionRow[] = []) =>
    ({
      item: { id: 'GF-228', status: 'progress' },
      problems,
      resolutions,
    }) as unknown as ItemDetailResponse;

  it('shows the warning icon, the three lines, the acknowledgement and a proposed resolution', () => {
    const at = new Date(Date.now() - 5 * 60_000).toISOString();
    wrap(
      <ProblemBanners
        data={detail([
          radar({ acknowledged: { by: 'owner', at }, resolution: resolution() }),
          radar({ id: 'rdf_2', related: ['GF-240'], reached_you: null }),
        ])}
      />,
    );
    const region = screen.getByRole('region', { name: 'Problems with GF-228' });
    expect(within(region).getByText('2 open problems')).toBeTruthy();
    const first = region.querySelector('[data-problem-id="rdf_1"]') as HTMLElement;
    expect(within(first).getByRole('img', { name: 'Problem (acknowledged)' })).toBeTruthy();
    expect(within(first).getByText('Out of date with main')).toBeTruthy();
    expect(first.querySelector('.prob-ack dd')?.textContent).toBe('Acknowledged by you 5m ago');
    // Already acknowledged: the banner's own actions don't offer it again.
    const acts = first.querySelector('.prob-acts') as HTMLElement;
    expect(within(acts).queryByRole('button', { name: 'Acknowledge' })).toBeNull();
    expect(within(first).getByText('Proposed: Split the work')).toBeTruthy();
    expect(within(first).getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(within(first).getByRole('button', { name: 'Go a different way' })).toBeTruthy();
    // No "Open the item" on the item's own page.
    expect(within(first).queryByRole('link', { name: 'Open the item' })).toBeNull();
    const second = region.querySelector('[data-problem-id="rdf_2"]') as HTMLElement;
    expect(within(second).getByText('Heading for a merge conflict')).toBeTruthy();
    expect(within(second).getByRole('img', { name: 'Problem' })).toBeTruthy();
  });

  it('Go a different way needs a note', async () => {
    wrap(<ProblemBanners data={detail([], [resolution({ problem_id: null })])} />);
    await userEvent.click(screen.getByRole('button', { name: 'Go a different way' }));
    const note = screen.getByLabelText('Which way instead (required)');
    expect(document.activeElement).toBe(note);
    await userEvent.click(screen.getByRole('button', { name: 'Send: go a different way' }));
    expect(screen.getByRole('alert').textContent).toBe('Say which way to go instead.');
  });

  it('?problem= focuses that problem', () => {
    wrap(
      <ProblemBanners data={detail([radar(), radar({ id: 'rdf_2', related: ['GF-240'] })])} />,
      '/items/GF-228?problem=rdf_2',
    );
    expect(document.activeElement?.getAttribute('data-problem-id')).toBe('rdf_2');
  });

  it('renders nothing without problems', () => {
    wrap(<ProblemBanners data={detail([])} />);
    expect(screen.queryByRole('region')).toBeNull();
  });
});
