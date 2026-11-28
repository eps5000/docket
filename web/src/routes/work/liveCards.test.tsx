// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import type { EpicCard as EpicCardData, WorkItem } from '@docket/shared';
import { EpicCard, TicketCard } from '../../components/kit';
import { safeGithubPrUrl, safeGithubRunUrl } from '../../components/kit/WorkActivity';
import { ListLayout } from './ListLayout';

afterEach(cleanup);

const activity = (state: 'live' | 'stale' | 'waiting' | 'unknown') => ({
  state,
  action: state === 'live' ? 'Checking source' : null,
  actor: 'dkt-1-producer',
  observed_at: '2026-11-28T05:00:00Z',
});

const ticket = (over: Partial<WorkItem> = {}): WorkItem =>
  ({
    id: 'DKT-41',
    project: 'DKT',
    type: 'Implementation',
    title: 'Show live work',
    status: 'progress',
    priority: 1,
    epic: 'DKT-1',
    epic_title: 'Use Docket',
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
    updated_at: '2026-11-28T05:00:00Z',
    packet_ready: false,
    for_you: false,
    last_activity_at: '2026-11-28T05:00:00Z',
    activity: activity('live'),
    github: {
      item_id: 'DKT-41',
      repo: 'eps5000/docket',
      number: 244,
      state: 'open',
      checks_status: 'pending',
      stale: false,
      workflow_runs: [
        {
          phase: 'pr_head',
          run_id: 456,
          attempt: 2,
          head_sha: 'a'.repeat(40),
          status: 'failed',
          observed_at: '2026-11-28T05:00:00Z',
        },
      ],
    },
    ...over,
  }) as WorkItem;

const epic = (over: Partial<EpicCardData> = {}): EpicCardData =>
  ({
    ...ticket(),
    id: 'DKT-1',
    type: 'Epic',
    epic: null,
    epic_title: null,
    children: {
      total: 2,
      done: 0,
      by_status: { progress: 2 },
      for_you: 0,
      queued: 0,
      blocked: 0,
    },
    ...over,
  }) as EpicCardData;

const show = (node: React.ReactNode) => render(<MemoryRouter>{node}</MemoryRouter>);

function LocationProbe() {
  const location = useLocation();
  return <span data-path="">{location.pathname}</span>;
}

describe('live Work and Epic cards', () => {
  it('keeps the primary item link separate from keyboard-reachable exact CI links', async () => {
    const { container } = show(<TicketCard item={ticket()} />);
    const user = userEvent.setup();
    expect(container.querySelector('a a')).toBeNull();
    expect(container.querySelector('[data-work-activity="live"] .wa-dot')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Show live work/ }).getAttribute('href')).toBe(
      '/items/DKT-41',
    );
    expect(screen.getByRole('link', { name: /PR checks · pending/ }).getAttribute('href')).toBe(
      'https://github.com/eps5000/docket/pull/244/checks',
    );
    const run = screen.getByRole('link', { name: /PR run · failed \(run 456, attempt 2\)/ });
    expect(run.getAttribute('href')).toBe(
      'https://github.com/eps5000/docket/actions/runs/456/attempts/2',
    );
    expect(run.getAttribute('rel')).toContain('noopener');
    await user.tab();
    expect(document.activeElement?.getAttribute('href')).toBe('/items/DKT-41');
    await user.tab();
    expect(document.activeElement?.getAttribute('href')).toBe(
      'https://github.com/eps5000/docket/pull/244',
    );
    expect(container.querySelector('[data-ci-phase="combined"]')?.textContent).toContain('Unknown');
    expect(container.querySelector('[data-ci-phase="main"]')?.textContent).toContain('Unknown');
  });

  it('keeps list-row PR and exact-run links keyboard reachable without opening the item', async () => {
    const { container } = show(
      <>
        <ListLayout items={[ticket({ activity: activity('waiting') })]} />
        <LocationProbe />
      </>,
    );
    const user = userEvent.setup();
    expect(container.querySelector('a a')).toBeNull();
    await user.tab();
    expect(document.activeElement?.getAttribute('href')).toBe('/items/DKT-41');
    await user.tab();
    expect(document.activeElement?.getAttribute('href')).toBe(
      'https://github.com/eps5000/docket/pull/244',
    );
    await user.tab();
    expect(document.activeElement?.getAttribute('href')).toBe(
      'https://github.com/eps5000/docket/pull/244/checks',
    );
    await user.tab();
    expect(document.activeElement?.getAttribute('href')).toBe(
      'https://github.com/eps5000/docket/actions/runs/456/attempts/2',
    );
    document.activeElement?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    expect(container.querySelector('[data-path]')?.textContent).toBe('/');
  });

  it('shows stale and waiting without a green Live dot on the same cards and row', () => {
    const { container } = show(
      <>
        <EpicCard epic={epic({ activity: activity('waiting'), github: null })} />
        <ListLayout items={[ticket({ activity: activity('stale'), github: null })]} />
      </>,
    );
    expect(container.querySelector('[data-work-activity="waiting"]')).toBeTruthy();
    expect(container.querySelector('[data-work-activity="stale"]')).toBeTruthy();
    expect(container.querySelector('.wa-live')).toBeNull();
    expect(container.querySelector('a a')).toBeNull();
  });

  it('shows merged main CI as Unknown until its exact run is observed', () => {
    const merged = ticket({
      activity: activity('waiting'),
      github: { ...ticket().github!, state: 'merged', checks_status: 'passed', workflow_runs: [] },
    });
    const { container } = show(<TicketCard item={merged} />);
    expect(container.querySelector('[data-ci-phase="main"]')?.textContent).toContain('Unknown');
    expect(container.querySelector('[data-ci-phase="combined"]')?.textContent).toContain('Unknown');
    expect(container.querySelector('[data-ci-progress]')?.textContent).toBe(
      'Waiting for resulting-main CI evidence',
    );
  });

  it.each([
    ['pending', 'Waiting for CI (PR checks)'],
    ['failed', 'CI failed (PR checks)'],
    ['passed', 'Waiting for merge'],
  ] as const)('shows fresh open PR %s as %s on card and list', (checks_status, phrase) => {
    const current = ticket({
      activity: activity('waiting'),
      github: { ...ticket().github!, checks_status, workflow_runs: [] },
    });
    const { container } = show(
      <>
        <TicketCard item={current} />
        <ListLayout items={[current]} />
      </>,
    );
    expect(
      Array.from(container.querySelectorAll('[data-ci-progress]')).map((node) => node.textContent),
    ).toEqual([phrase, phrase]);
    expect(container.querySelectorAll('[data-ci-phase="combined"]')[0]?.textContent).toContain(
      'Unknown',
    );
    expect(container.querySelectorAll('[data-ci-phase="main"]')[0]?.textContent).toContain(
      'Unknown',
    );
  });

  it('does not call stale GitHub facts fresh CI or override verified Live', () => {
    const stale = ticket({
      activity: activity('stale'),
      github: { ...ticket().github!, stale: true, checks_status: 'passed' },
    });
    const live = ticket({ activity: activity('live') });
    const { container } = show(
      <>
        <TicketCard item={stale} />
        <TicketCard item={live} />
      </>,
    );
    expect(container.querySelector('.wa-stale [data-ci-progress]')?.textContent).toBe(
      'CI out of date',
    );
    expect(container.querySelector('.wa-live [data-ci-progress]')).toBeNull();
    expect(container.querySelector('[data-ci-phase="combined"]')?.textContent).toContain(
      'Out of date',
    );
  });

  it('shows exact resulting-main pending and failed states without inferring combined', () => {
    const main = ticket().github!.workflow_runs[0]!;
    const cases = [
      { ...main, phase: 'main' as const, status: 'pending' as const },
      { ...main, phase: 'main' as const, status: 'failed' as const },
    ];
    const { container } = show(
      <>
        {cases.map((run) => (
          <TicketCard
            key={run.status}
            item={ticket({
              id: `DKT-${run.status}`,
              activity: activity('waiting'),
              github: {
                ...ticket().github!,
                state: 'merged',
                checks_status: 'passed',
                workflow_runs: [run],
              },
            })}
          />
        ))}
      </>,
    );
    expect(
      Array.from(container.querySelectorAll('[data-ci-progress]')).map((node) => node.textContent),
    ).toEqual(['Waiting for resulting-main CI', 'Resulting-main CI failed']);
    expect(
      Array.from(container.querySelectorAll('[data-ci-phase="combined"]')).every((node) =>
        node.textContent?.includes('Unknown'),
      ),
    ).toBe(true);
  });

  it('refuses unsafe or nonexact external run addresses', () => {
    expect(safeGithubPrUrl('https://evil.example/x', 1)).toBeNull();
    expect(safeGithubPrUrl('eps5000/../docket', 1)).toBeNull();
    expect(safeGithubRunUrl('eps5000/docket', -1, 1)).toBeNull();
    expect(safeGithubRunUrl('eps5000/docket', 12, 0)).toBeNull();
    expect(safeGithubRunUrl('eps5000/docket', 456, 1)).toBe(
      'https://github.com/eps5000/docket/actions/runs/456/attempts/1',
    );
    expect(safeGithubRunUrl('eps5000/docket', 456, 2)).toBe(
      'https://github.com/eps5000/docket/actions/runs/456/attempts/2',
    );
  });
});
