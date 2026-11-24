// @vitest-environment jsdom
/**
 * B60 (owner decision 48): the chain on the map stays complete and uncounted,
 * the text alternative matches it, and the worktree view groups, filters and
 * offers a command only for Safe to remove.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CriticalPathResponse,
  ItemSummary,
  LinkEdge,
  RepoWorktreeRow,
  WorktreeCleanupResponse,
} from '@docket/shared';
import { layoutMap } from '../components/ProgressMap/layout';
import { GROUP_LIMIT, WorktreeCleanup, filterWorktrees } from './agents/WorktreeCleanup';
import { GoalMap, NEXT_REASON, criticalOverlay } from './shared/GoalMap';

const api = vi.hoisted(() => ({
  'items.criticalPath': vi.fn(),
  'workspaces.cleanup': vi.fn(),
  'bootstrap.get': vi.fn(),
}));
vi.mock('../app/queryClient', () => ({ apiClient: api }));
vi.mock('../app/ShellState', () => ({ useShell: () => ({ scope: 'CP' }) }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const item = (id: string, over: Partial<ItemSummary> = {}): ItemSummary => ({
  id,
  project: 'CP',
  type: 'Task',
  title: `Ticket ${id}`,
  status: 'ready',
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
  version: 1,
  updated_at: '2026-11-01T00:00:00.000Z',
  ...over,
});
const link = (from: string, to: string): LinkEdge => ({
  link_id: `l-${from}-${to}`,
  from,
  to,
  type: 'blocks',
  satisfied_when: null,
  cleared: false,
});
const path: CriticalPathResponse = {
  goal: { id: 'CP-3', title: 'Ticket CP-3', kind: 'ticket' },
  state: 'blocked',
  chain: [
    { item: item('CP-1'), in_cycle: false },
    { item: item('CP-2', { status: 'planning', blocked: true }), in_cycle: false },
    { item: item('CP-3', { blocked: true }), in_cycle: false },
  ],
  links: [link('CP-1', 'CP-2'), link('CP-2', 'CP-3')],
  next: { id: 'CP-1', reason: 'startable', why: 'It’s ready. Start it next.' },
  cycles: [],
  open_blockers: 2,
};

function wrap(ui: ReactNode, url = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('criticalOverlay', () => {
  it('numbers the chain and adds tickets the view doesn’t include', () => {
    const items = [item('CP-3', { blocked: true })];
    const o = criticalOverlay(path, items, [])!;
    expect([...o.steps]).toEqual([
      ['CP-1', 1],
      ['CP-2', 2],
      ['CP-3', 3],
    ]);
    expect(o.extras.map((i) => i.id)).toEqual(['CP-1', 'CP-2']);
    expect(o.links).toHaveLength(2);
  });

  it('doesn’t repeat a link the view already has', () => {
    const o = criticalOverlay(path, [], [link('CP-1', 'CP-2')])!;
    expect(o.links.filter((l) => l.link_id === 'l-CP-1-CP-2')).toHaveLength(1);
  });

  it('is empty without a chain', () => {
    expect(criticalOverlay(undefined, [], [])).toBeNull();
    expect(criticalOverlay({ ...path, chain: [] }, [], [])).toBeNull();
  });

  it('places added tickets in waves without changing the map’s counts', () => {
    const items = [item('CP-3', { blocked: true })];
    const o = criticalOverlay(path, items, [])!;
    const out = layoutMap(items, [], o.links, o.extras);
    expect(out.waves.map((w) => w.map((i) => i.id))).toEqual([['CP-1'], ['CP-2'], ['CP-3']]);
    expect(out.counts.total).toBe(1);
  });
});

describe('GoalMap', () => {
  const map = (url: string) =>
    wrap(
      <GoalMap items={[item('CP-3')]} outside={[]} links={[]} outsideTitle="Outside this view" />,
      url,
    );

  it('names the ticket to move next, with its reason in words', async () => {
    api['items.criticalPath'].mockResolvedValue(path);
    map('/?goal=CP-3');
    const next = await screen.findByText('Move next:');
    const line = next.closest('p')!;
    expect(line).toHaveProperty('dataset.criticalNext', 'CP-1');
    expect(within(line).getByText(NEXT_REASON.startable.label)).toBeTruthy();
    expect(within(line).getByText(path.next!.why)).toBeTruthy();
  });

  it('gives the same chain as an ordered list', async () => {
    api['items.criticalPath'].mockResolvedValue(path);
    map('/?goal=CP-3');
    const list = await screen.findByRole('list', { name: /Chain holding up CP-3/, hidden: true });
    const rows = within(list).getAllByRole('listitem', { hidden: true });
    expect(rows.map((r) => r.textContent?.split(' ')[0])).toEqual(['CP-1', 'CP-2', 'CP-3']);
    expect(rows[0]!.textContent).toContain('move this next');
  });

  it('marks each card on the chain in words', async () => {
    api['items.criticalPath'].mockResolvedValue(path);
    map('/?goal=CP-3');
    expect(await screen.findByText('Move next · Step 1 of 3')).toBeTruthy();
    expect(screen.getByText('Step 3 of 3')).toBeTruthy();
  });

  it('asks for nothing without a goal', () => {
    map('/');
    expect(api['items.criticalPath']).not.toHaveBeenCalled();
    expect(screen.getByLabelText('What’s holding up')).toBeTruthy();
  });

  it('says a finished goal needs nothing', async () => {
    api['items.criticalPath'].mockResolvedValue({
      ...path,
      state: 'finished',
      chain: [],
      links: [],
      next: null,
      open_blockers: 0,
    });
    map('/?goal=CP-3');
    expect(await screen.findByText(/is finished/)).toBeTruthy();
  });

  it('names a blocker loop', async () => {
    api['items.criticalPath'].mockResolvedValue({
      ...path,
      cycles: [['CP-1', 'CP-2']],
    });
    map('/?goal=CP-3');
    expect(await screen.findByText(/CP-1, CP-2 block each other/)).toBeTruthy();
  });
});

const wt = (n: number, over: Partial<RepoWorktreeRow> = {}): RepoWorktreeRow => ({
  path: `/work/wt-${n}`,
  branch: `feat/${n}`,
  last_activity_at: '2026-11-01T00:00:00.000Z',
  tracked: true,
  item_id: `CP-${n}`,
  item_title: `Ticket ${n}`,
  uncommitted_files: 0,
  unpushed_commits: 0,
  merged: true,
  verdict: 'safe_to_remove',
  why: 'Clean, merged to main, and nothing is running in it.',
  owner: null,
  command: `git -C '/work/app' worktree remove '/work/wt-${n}'`,
  source: 'container',
  ...over,
});
const cleanupOf = (rows: RepoWorktreeRow[]): WorktreeCleanupResponse => ({
  project: 'CP',
  main_branch: 'main',
  repo: 'ok',
  checked_at: '2026-11-23T00:00:00.000Z',
  scanning: null,
  host: { state: 'none', checked_at: null },
  rows,
});
const opened = (rows: RepoWorktreeRow[]) => {
  api['workspaces.cleanup'].mockResolvedValue(cleanupOf(rows));
  api['bootstrap.get'].mockResolvedValue({ projects: [] });
  return wrap(<WorktreeCleanup />);
};

describe('filterWorktrees', () => {
  const rows = [
    wt(1),
    wt(2, { verdict: 'holds_work', tracked: false, item_id: null, item_title: null }),
  ];
  const none = { verdict: null, untracked: false, text: '' };
  it('filters by verdict, tracking and text', () => {
    expect(filterWorktrees(rows, { ...none, verdict: 'holds_work' })).toHaveLength(1);
    expect(filterWorktrees(rows, { ...none, untracked: true })[0]!.path).toBe('/work/wt-2');
    expect(filterWorktrees(rows, { ...none, text: 'FEAT/1' })[0]!.path).toBe('/work/wt-1');
    expect(filterWorktrees(rows, { ...none, text: 'wt-2' })).toHaveLength(1);
    expect(filterWorktrees(rows, { ...none, text: 'nothing' })).toHaveLength(0);
  });
});

describe('WorktreeCleanup', () => {
  it('offers a command only for Safe to remove', async () => {
    opened([
      wt(1),
      wt(2, { verdict: 'holds_work', command: null, uncommitted_files: 3, why: 'It has work.' }),
      wt(3, { verdict: 'unknown', command: null, merged: null, why: 'Not known.' }),
      wt(4, { verdict: 'in_use', command: null, why: 'Running.' }),
      wt(5, { verdict: 'kept_for_later', command: null, why: 'Kept.' }),
    ]);
    await screen.findByRole('table', { name: /Every worktree/ });
    const commands = document.querySelectorAll('.wc-command');
    expect(commands).toHaveLength(1);
    expect(commands[0]!.closest('tr')!.dataset.verdict).toBe('safe_to_remove');
    expect(screen.getByText(/Docket never removes a worktree/)).toBeTruthy();
  });

  it('says Not tracked by Docket, and never shows a verdict as colour alone', async () => {
    opened([wt(1, { tracked: false, item_id: null, item_title: null })]);
    const row = (await screen.findByRole('table')).querySelector('[data-verdict]')!;
    expect(row.textContent).toContain('Not tracked by Docket');
    expect(row.textContent).toContain('Safe to remove');
  });

  it('shows an unread count as Unknown, not zero', async () => {
    opened([
      wt(1, {
        verdict: 'unknown',
        command: null,
        uncommitted_files: null,
        unpushed_commits: null,
        merged: null,
      }),
    ]);
    const row = (await screen.findByRole('table')).querySelector('[data-verdict]')!;
    expect(row.textContent?.match(/Unknown/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('keeps a very long group short until asked', async () => {
    const user = userEvent.setup();
    opened(Array.from({ length: GROUP_LIMIT + 20 }, (_, i) => wt(i + 1)));
    await screen.findByRole('table');
    expect(document.querySelectorAll('tr[data-worktree]')).toHaveLength(GROUP_LIMIT);
    await user.click(screen.getByRole('button', { name: /Show all 70/ }));
    expect(document.querySelectorAll('tr[data-worktree]')).toHaveLength(GROUP_LIMIT + 20);
  });

  it('filters with the verdict chips', async () => {
    const user = userEvent.setup();
    opened([wt(1), wt(2, { verdict: 'holds_work', command: null })]);
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: /^Holds work/ }));
    expect(document.querySelectorAll('tr[data-worktree]')).toHaveLength(1);
    expect(document.querySelector('tr[data-worktree]')!.getAttribute('data-verdict')).toBe(
      'holds_work',
    );
  });

  it('says when the repository can’t be read', async () => {
    api['workspaces.cleanup'].mockResolvedValue({ ...cleanupOf([]), repo: 'unreadable' });
    api['bootstrap.get'].mockResolvedValue({ projects: [] });
    wrap(<WorktreeCleanup />);
    expect(await screen.findByText(/can’t be checked/)).toBeTruthy();
  });
});
