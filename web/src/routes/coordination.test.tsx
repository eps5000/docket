// @vitest-environment jsdom
/**
 * B20, the coordination design pass: the item's agent bar (parked lead, live
 * lead, no lead), Agents in three sections with the `?state=` filter, the
 * Needs you strip's links, and the Problems rows (key fact first, whole facts,
 * the workspace chip).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentRow,
  ItemDetailResponse,
  NeedsYouResponse,
  Problem,
  Run,
  WorkspaceRow,
} from '@docket/shared';
import { AgentBar } from './items/AgentBar';
import { ActivityTab } from './items/ActivityTab';
import {
  ActiveRunsSection,
  RecentRunsSection,
  activeRows,
  recentRows,
  stateFilter,
} from './agents/RunsCard';
import { AT_RISK_NEXT, atRiskSummary } from './agents/atRisk';
import { WorkspacesCard } from './agents/WorkspacesCard';
import { ShellStateProvider } from '../app/ShellState';
import { HealthCard } from './overview/HealthCard';
import { ProblemsCard, reasonFacts, workspaceFor } from './needs-you/ProblemsCard';

const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

// ---- The agent bar ----

function run(over: Partial<Run> = {}): Run {
  return {
    run_id: 'run_1',
    parent_run_id: null,
    client: 'claude',
    label: 'orca-w4',
    is_lead: true,
    run_state: 'live',
    started_at: ago(30),
    last_signal_at: ago(1),
    lease_expires_at: null,
    current_step_id: null,
    summary: null,
    error: null,
    end_reason: null,
    parked: null,
    workspace: {
      host: null,
      repo: null,
      path: 'C:/work/rcp-17',
      branch: 'rcp-17-week-reload',
      base_ref: null,
      base_sha: null,
      head_sha: '4be1c09',
      pushed_sha: '4be1c09',
      dirty: false,
      state: 'in_use',
      updated_at: ago(1),
    },
    orchestrator: null,
    brief_document_version_id: null,
    resources: [],
    ...over,
  };
}

function detail(
  opts: { runs?: Run[]; status?: string; leadOf?: Run | null; type?: string } = {},
): ItemDetailResponse {
  const runs = opts.runs ?? [];
  const lead = opts.leadOf === undefined ? (runs[0] ?? null) : opts.leadOf;
  return {
    item: {
      id: 'RCP-17',
      type: opts.type ?? 'Bug',
      title: 'Planner jumps back to the current week after reload',
      status: opts.status ?? 'progress',
      version: 3,
      lead: lead
        ? {
            client: lead.client,
            label: lead.label,
            run_id: lead.run_id,
            run_state: lead.run_state,
          }
        : null,
      runs,
      commits: [],
      checklist: {
        plan_version: 1,
        work: [
          { id: 's1', text: 'Reproduce', state: 'done' },
          { id: 's2', text: 'Keep the week in the URL', state: 'current' },
          { id: 's3', text: 'Add a test', state: 'todo' },
        ],
        checks: [],
        human_review: [],
        reviewed_with_epic: null,
      },
    },
    activity: [],
  } as unknown as ItemDetailResponse;
}

const bar = () => screen.getByRole('region', { name: 'Lead agent' });

describe('the agent bar (B20)', () => {
  it('a parked lead: run line, last signal, step n/m, workspace chip, actions and the parked line', () => {
    const parked = run({
      run_state: 'parked',
      workspace: { ...run().workspace!, state: 'parked' },
      parked: {
        reason: 'Waiting for the coordinator to send the next batch',
        waiting_on: { orchestrator: true },
        since: ago(20),
        resume_ready: true,
      },
    });
    wrap(<AgentBar data={detail({ runs: [parked] })} />);
    const b = bar();
    expect(b.getAttribute('data-agent-bar')).toBe('parked');
    expect(b.querySelector('.runline .rl')!.textContent).toBe(
      `parked${String.fromCharCode(0xa0)}· claude · orca-w4`,
    );
    expect(within(b).getByText(/^last signal 1m ago$/)).toBeTruthy();
    const step = b.querySelector('[data-ab="step"]')!;
    expect(step.textContent).toBe('step 2/3');
    expect(step.getAttribute('title')).toBe('Keep the week in the URL');
    expect(within(b).getByText('Parked', { selector: '.chip' })).toBeTruthy();
    const line = b.querySelector('[data-ab="parked"]')!;
    expect(line.textContent).toMatch(/^Parked: waiting on the coordinator since \d\d:\d\d/);
    expect(line.getAttribute('title')).toBe('Waiting for the coordinator to send the next batch');
    expect(within(b).getByText('Ready to resume')).toBeTruthy();
    expect(within(b).getByRole('button', { name: 'Release lead claim…' })).toBeTruthy();
    expect(within(b).getByRole('button', { name: 'Copy resume note' })).toBeTruthy();
  });

  it('a parked lead shows its wait card, with the next step and how it resumes (decision 45)', () => {
    const parked = run({
      run_state: 'parked',
      parked: {
        reason: 'Waiting for the prerequisite',
        waiting_on: { items: ['RCP-12'] },
        since: ago(5),
        resume_ready: false,
      },
    });
    const wait: NonNullable<ItemDetailResponse['wait']> = {
      run_id: parked.run_id,
      item_id: 'RCP-17',
      label: 'orca-w4',
      client: 'claude',
      orchestrator: { name: 'orca', dispatch_id: 'ctx_1', task_id: null, run_id: null },
      blockers: [
        {
          id: 'RCP-12',
          status: 'planning',
          clears_when: 'done',
          cleared: false,
          waited_since: ago(40),
          lead: null,
          moves: null,
        },
      ],
      more_blockers: 0,
      person: false,
      coordinator: false,
      until: null,
      waited_since: ago(40),
      next_owner: {
        kind: 'orchestrator',
        name: 'orca',
        item_id: 'RCP-12',
        step: 'RCP-12: shape it or assign it',
      },
      resumes_when: 'Resumes when RCP-12 is done: orca relays it to dispatch ctx_1.',
      resume_ready: false,
      flags: [
        {
          kind: 'wait_no_next_step',
          on: 'RCP-12',
          since: ago(1),
          step: 'RCP-12: shape it or assign it',
        },
      ],
      held_by: null,
    };
    wrap(<AgentBar data={{ ...detail({ runs: [parked] }), wait }} />);
    const card = bar().querySelector('[data-ab="wait"]')!;
    expect(card.textContent).toContain('Waiting on RCP-12 (planning, clears when done)');
    expect(card.textContent).toContain('Next: orca · RCP-12: shape it or assign it');
    expect(card.textContent).toContain('Resumes when RCP-12 is done');
    expect(
      within(card as HTMLElement).getByText(/Waiting, with no next step: RCP-12/),
    ).toBeTruthy();
  });

  it('a blocker nobody leads still says which parked run it frees (decision 45)', () => {
    const data = {
      ...detail({ runs: [], leadOf: null, status: 'planning' }),
      waiting_runs: {
        total: 1,
        rows: [
          { item_id: 'RCP-20', run_id: 'run_2', label: 'w2', waited_since: ago(30), via: null },
        ],
      },
    };
    wrap(<AgentBar data={data} />);
    expect(bar().querySelector('[data-ab="waiting-runs"]')!.textContent).toMatch(
      /^Unblocks RCP-20, waiting since/,
    );
  });

  it("a coordinator's park says who and until when, in place of 'Status updated by' (decision 44)", () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const parked = run({
      run_state: 'parked',
      parked: {
        reason: 'Waiting for the producer',
        waiting_on: { orchestrator: true },
        since: ago(5),
        resume_ready: false,
      },
      status_update: { by: 'orca', client: 'codex', at: ago(5) },
      coordinator_park: { by: 'orca', at: ago(5), until },
    });
    wrap(<AgentBar data={detail({ runs: [parked] })} />);
    const line = bar().querySelector('[data-ab="coordinator-park"]')!;
    expect(line.textContent).toMatch(/^Parked by orca until \w+ \d+ \d\d:\d\d$/);
    expect(line.getAttribute('title')).toBe(until);
    expect(bar().querySelector('[data-ab="updated-by"]')).toBeNull();
  });

  it("a coordinator's park that ran out says the run has a short lease (decision 44)", () => {
    const ended = run({
      coordinator_park: {
        by: 'orca',
        at: ago(65),
        until: ago(5),
        ended_at: ago(5),
      },
    });
    wrap(<AgentBar data={detail({ runs: [ended] })} />);
    expect(bar().querySelector('[data-ab="coordinator-park"]')!.textContent).toMatch(
      /^Park by orca ran out at \d\d:\d\d\. It has a short lease to call back\.$/,
    );
  });

  it('a live lead: no parked line and no recovery actions', () => {
    wrap(<AgentBar data={detail({ runs: [run()] })} />);
    const b = bar();
    expect(b.getAttribute('data-agent-bar')).toBe('live');
    expect(within(b).getByText('In use')).toBeTruthy();
    expect(b.querySelector('[data-ab="parked"]')).toBeNull();
    // No recovery actions: the only button is the Help "?" (B22).
    expect(
      within(b)
        .getAllByRole('button')
        .map((x) => x.getAttribute('aria-label')),
    ).toEqual(['Help: Run states: live, parked, stale and more']);
  });

  it('an Epic shows its live producer and an owner handoff on the bar and Activity tab', async () => {
    const data = detail({ type: 'Epic', runs: [run()] });
    const { unmount } = wrap(<AgentBar data={data} />);
    const button = within(bar()).getByRole('button', { name: 'Release lead claim…' });
    await userEvent.click(button);
    const dialog = screen.getByRole('dialog', { name: 'Release lead claim on RCP-17?' });
    expect(within(dialog).getByText(/keep RCP-17 In progress/)).toBeTruthy();
    expect(within(dialog).getByText(/another producer can claim it immediately/)).toBeTruthy();
    unmount();

    wrap(<ActivityTab kind="epic" data={data} />);
    expect(screen.getByText('Lead and runs')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Release lead claim…' })).toBeTruthy();
  });

  it('no lead: a quiet "No agent on this" while In progress, nothing otherwise', () => {
    const { unmount } = wrap(<AgentBar data={detail({ leadOf: null })} />);
    expect(bar().textContent).toContain('No agent on this');
    unmount();
    wrap(<AgentBar data={detail({ leadOf: null, status: 'ready' })} />);
    expect(screen.queryByRole('region', { name: 'Lead agent' })).toBeNull();
  });

  it('announces a change of run state politely, not the first render', () => {
    const { rerender } = wrap(<AgentBar data={detail({ runs: [run()] })} />);
    const live = bar().querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toBe('');
    const client = new QueryClient();
    rerender(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AgentBar data={detail({ runs: [run({ run_state: 'stale' })] })} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(bar().querySelector('[aria-live="polite"]')!.textContent).toBe(
      'claude · orca-w4 is stale on RCP-17.',
    );
  });
});

// ---- Agents ----

function row(state: AgentRow['run_state'], over: Partial<AgentRow> = {}): AgentRow {
  return {
    row_kind: 'run',
    run_id: `run_${state}_${over.at ?? ''}`,
    run_state: state,
    client: 'codex',
    label: null,
    item_id: 'RCP-15',
    item_title: 'Pantry inventory schema',
    project: 'RCP',
    doing: 'Lead',
    last_signal_at: ago(1),
    last_signal_kind: null,
    lease_expires_at: null,
    lease: 'held',
    provenance: null,
    lead_parked: null,
    at: ago(1),
    ...over,
  };
}

describe('Agents in three sections (B20)', () => {
  const rows: AgentRow[] = [
    row('live'),
    row('reported'),
    row('parked', {
      lead_parked: { waiting_on: { items: ['RCP-12'] }, since: ago(5), resume_ready: false },
    }),
    row('stale'),
    row('failed'),
    row('needs_input'),
    row('finished', { at: ago(60) }),
    row('interrupted', { at: ago(120) }),
    row('finished', { at: ago(60 * 30) }),
    row(null, { row_kind: 'subagent_log', run_id: null, client: 'explorer' }),
  ];

  it('Active now: needs input, failed, stale, parked, live, reported, in that order', () => {
    expect(activeRows(rows).map((r) => r.run_state)).toEqual([
      'needs_input',
      'failed',
      'stale',
      'parked',
      'live',
      'reported',
    ]);
    expect(activeRows(rows, 'parked').map((r) => r.run_state)).toEqual(['parked']);
  });

  it('Recent: finished and interrupted in the last 24 h; no subagent log entries anywhere', () => {
    expect(recentRows(rows).map((r) => r.run_state)).toEqual(['finished', 'interrupted']);
    expect([...activeRows(rows), ...recentRows(rows)].some((r) => r.row_kind !== 'run')).toBe(
      false,
    );
  });

  it('?state= accepts active states only', () => {
    expect(stateFilter('parked')).toBe('parked');
    expect(stateFilter('needs_input')).toBe('needs_input');
    expect(stateFilter('finished')).toBeNull();
    expect(stateFilter('nonsense')).toBeNull();
    expect(stateFilter(null)).toBeNull();
  });

  it('filtered to one state, with Show all; the parked row says what it waits on', () => {
    wrap(<ActiveRunsSection rows={rows} only="parked" />);
    const sec = screen.getByRole('region', { name: 'Active now' });
    expect(sec.querySelector('.sectog')!.textContent).toContain('1 parked run');
    expect(within(sec).getByRole('link', { name: 'Show all' }).getAttribute('href')).toBe(
      '/agents',
    );
    const table = within(sec).getByRole('table', { name: 'Active runs: parked' });
    expect(table.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(table.querySelector('.rl')!.textContent).toBe(
      `parked${String.fromCharCode(0xa0)}· waiting on RCP-12`,
    );
  });

  it('Recent is collapsed by default and opens to its table', async () => {
    wrap(<RecentRunsSection rows={rows} />);
    const toggle = screen.getByRole('button', { name: /Recent/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('2 in the last 24 h');
    expect(screen.queryByRole('table')).toBeNull();
    await userEvent.setup().click(toggle);
    expect(
      screen.getByRole('table', { name: 'Recent runs' }).querySelectorAll('tbody tr'),
    ).toHaveLength(2);
  });
});

// ---- Needs you ----

describe('Overview Health (B20, decision 43)', () => {
  const needs = (over: Partial<NeedsYouResponse> = {}): NeedsYouResponse => ({
    for_you_now: [],
    problems: [],
    deferred: [],
    planning_queue: [],
    agent_counts: { live: 2 },
    ...over,
  });
  const at = (state: WorkspaceRow['state'], at_risk_owner: WorkspaceRow['at_risk_owner'] = null) =>
    ({ state, at_risk_owner, dirty: true }) as WorkspaceRow;

  it('links worktrees at risk, proposals and all runs, and shows no raw run counts', () => {
    wrap(
      <HealthCard
        data={needs({ agent_file_proposals: 2 })}
        lastBackupAt={ago(60)}
        metricsLoaded
        workspaces={[at('at_risk', 'agents'), at('at_risk', 'kept')]}
      />,
    );
    const health = document.querySelector('[data-card="health"]') as HTMLElement;
    const href = (name: string) => within(health).getByRole('link', { name }).getAttribute('href');
    expect(
      href('2 worktrees hold unsaved work. None need you: agents own 1, and you kept 1 for later.'),
    ).toBe('/agents#workspaces');
    // Nothing for the owner to do, so it isn't a warning.
    const line = health.querySelector('[data-state="workspaces-at-risk"]')?.closest('li');
    expect(line?.getAttribute('data-health')).toBe('ok');
    expect(href('2 agent file changes proposed')).toBe('/agent-files#proposals');
    expect(href('All runs →')).toBe('/agents');
    expect(href('Last backup 1h ago')).toBe('/settings');
    expect(health.textContent).not.toContain('live');
  });

  it('shows no at-risk link at zero, and says when no backup has run', () => {
    wrap(<HealthCard data={needs()} lastBackupAt={null} metricsLoaded workspaces={[]} />);
    expect(screen.getByText('No problems need you')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'No backup yet' })).toBeTruthy();
    expect(screen.queryByText(/worktree/)).toBeNull();
  });

  it('warns only when a worktree really needs the owner', () => {
    wrap(
      <HealthCard
        data={needs()}
        lastBackupAt={ago(60)}
        metricsLoaded
        workspaces={[at('at_risk', 'you'), at('at_risk', 'agents')]}
      />,
    );
    const line = document.querySelector('[data-state="workspaces-at-risk"]') as HTMLElement;
    expect(line.textContent).toBe(
      '2 worktrees hold unsaved work. 1 needs your choice, and agents own 1.',
    );
    expect(line.closest('li')?.dataset.health).toBe('warn');
  });
});

describe('at-risk wording (B56)', () => {
  const row = (
    at_risk_owner: WorkspaceRow['at_risk_owner'],
    over: Partial<WorkspaceRow> = {},
  ): WorkspaceRow =>
    ({
      state: 'at_risk',
      last_activity_at: ago(1),
      at_risk_owner,
      dirty: true,
      unpushed_commits: 0,
      ...over,
    }) as WorkspaceRow;

  it.each<[string, WorkspaceRow[], 'ok' | 'info' | 'warn', string]>([
    [
      'all agent-owned',
      [row('agents'), row('agents')],
      'ok',
      '2 worktrees hold unsaved work. None need you: agents own 2.',
    ],
    [
      'one agent-owned',
      [row('agents')],
      'ok',
      '1 worktree holds unsaved work. It doesn’t need you: an agent owns it.',
    ],
    [
      'the owner’s live case',
      [row('agents'), row('agents'), row('kept')],
      'ok',
      '3 worktrees hold unsaved work. None need you: agents own 2, and you kept 1 for later.',
    ],
    [
      'one kept',
      [row('kept')],
      'ok',
      '1 worktree holds unsaved work. It doesn’t need you: you kept it for later.',
    ],
    [
      'acknowledged',
      [row('acknowledged'), row('agents')],
      'ok',
      '2 worktrees hold unsaved work. None need you: agents own 1, and you acknowledged 1.',
    ],
    [
      'needs the owner',
      [row('you')],
      'warn',
      '1 worktree holds unsaved work. It needs your choice.',
    ],
    [
      'two need the owner',
      [row('you'), row('you'), row('kept')],
      'warn',
      '3 worktrees hold unsaved work. 2 need your choice, and you kept 1 for later.',
    ],
    [
      'unknown is said, not guessed',
      [row('unknown'), row('agents')],
      'info',
      '2 worktrees hold unsaved work. Agents own 1, and Docket can’t tell who owns 1.',
    ],
    [
      'only unknown',
      [row('unknown')],
      'info',
      '1 worktree holds unsaved work. Docket can’t tell who owns it.',
    ],
    [
      'several unknown',
      [row('unknown'), row('unknown')],
      'info',
      '2 worktrees hold unsaved work. Docket can’t tell who owns them.',
    ],
    [
      'needs the owner and unknown',
      [row('you'), row('unknown')],
      'warn',
      '2 worktrees hold unsaved work. 1 needs your choice, and Docket can’t tell who owns 1.',
    ],
    [
      'clean but interrupted',
      [row('agents', { dirty: false })],
      'ok',
      '1 worktree holds unsaved or unfinished work. It doesn’t need you: an agent owns it.',
    ],
  ])('%s', (_name, rows, tone, text) => {
    expect(atRiskSummary(rows)).toEqual({ tone, text, count: rows.length });
  });

  it('is nothing with none at risk, and never suggests deleting', () => {
    expect(atRiskSummary([{ state: 'in_use', at_risk_owner: null } as WorkspaceRow])).toBeNull();
    for (const words of Object.values(AT_RISK_NEXT)) expect(words).not.toMatch(/delet|prune/i);
  });

  it('the Workspaces table says what at risk means and what to do', async () => {
    const rows = [
      { ...row('you'), path: 'C:/work/a', item_id: 'RCP-1', run_state: 'finished' },
      { ...row('agents'), path: 'C:/work/b', item_id: 'RCP-2', run_state: 'finished' },
      { ...row(null, { state: 'in_use' }), path: 'C:/work/c', item_id: 'RCP-3' },
    ] as WorkspaceRow[];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ rows }), { status: 200 })),
    );
    wrap(
      <ShellStateProvider>
        <WorkspacesCard />
      </ShellStateProvider>,
    );
    const note = await waitFor(() => {
      const el = document.querySelector('[data-at-risk-note]');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(note.textContent).toContain('work could still be lost');
    expect(note.textContent).not.toMatch(/delet/i);
    const you = document.querySelector('[data-at-risk-owner="you"]') as HTMLElement;
    expect(you.textContent).toContain('Needs your choice.');
    expect(within(you).getByRole('link').getAttribute('href')).toBe('/#problems');
    const agents = document.querySelector('[data-at-risk-owner="agents"]') as HTMLElement;
    expect(agents.textContent).toBe('Nothing for you: an agent owns it.');
    expect(within(agents).queryByRole('link')).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe('Problems rows (B20)', () => {
  const ws = (over: Partial<WorkspaceRow>): WorkspaceRow => ({
    path: 'C:/work/rcp-25',
    state: 'at_risk',
    at_risk_owner: 'you',
    branch: 'rcp-25-pantry-screens',
    host: null,
    repo: null,
    item_id: 'RCP-25',
    item_title: 'Pantry screens',
    project: 'RCP',
    run_id: 'run_25',
    run_state: 'interrupted',
    client: 'codex',
    label: 'orca-w2',
    head_sha: null,
    pushed_sha: null,
    unpushed_commits: 1,
    dirty: true,
    unreleased_resources: 0,
    last_activity_at: ago(1),
    ...over,
  });
  const problem = (over: Partial<Problem>): Problem => ({
    kind: 'unpushed_work',
    item_id: 'RCP-25',
    title: 'Pantry screens and empty states',
    reason: '1 commit not pushed · uncommitted changes · C:/work/rcp-25 · run ended (released)',
    related: [],
    link_id: null,
    run_id: 'run_25',
    resource_ids: [],
    ...over,
  });

  it('splits the reason into whole facts, key fact first', () => {
    expect(reasonFacts(problem({}).reason)).toEqual([
      '1 commit not pushed',
      'uncommitted changes',
      'C:/work/rcp-25',
      'run ended (released)',
    ]);
  });

  it('finds a recovery row’s worktree by run, else the item’s only one; none for other kinds', () => {
    const rows = [ws({}), ws({ path: 'C:/work/doc-5', item_id: 'DOC-5', run_id: 'run_5' })];
    expect(workspaceFor(problem({}), rows)?.path).toBe('C:/work/rcp-25');
    expect(workspaceFor(problem({ run_id: 'run_other' }), rows)?.path).toBe('C:/work/rcp-25');
    expect(workspaceFor(problem({ kind: 'stale_run' }), rows)).toBeUndefined();
  });

  it('renders the facts as whole units with the workspace chip; the full reason in title', () => {
    wrap(<ProblemsCard problems={[problem({})]} workspaces={[ws({})]} />);
    const r = document.querySelector('[data-problem="unpushed_work"]')!;
    expect(within(r as HTMLElement).getByText('At risk')).toBeTruthy();
    const reason = r.querySelector('.reason')!;
    expect(reason.getAttribute('title')).toBe(problem({}).reason);
    expect([...reason.querySelectorAll('.fact')].map((f) => f.textContent)).toEqual([
      `1 commit not pushed${String.fromCharCode(0xa0)}·`,
      `uncommitted changes${String.fromCharCode(0xa0)}·`,
      `C:/work/rcp-25${String.fromCharCode(0xa0)}·`,
      'run ended (released)',
    ]);
  });
});
