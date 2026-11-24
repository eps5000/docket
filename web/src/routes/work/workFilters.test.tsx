// @vitest-environment jsdom
/**
 * B43 (UI_SPEC §6.2): where Work's filter comes from (URL, old links, the
 * remembered choice, the default), the Filters menu's entries, pills and
 * keyboard, and the Epics strip hiding done epics.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_WORK_FILTER,
  normalizeWorkFilter,
  type EpicCard,
  type WorkFilter,
  type WorkResponse,
} from '@docket/shared';
import { STORAGE_KEYS } from '../../lib/persistence';
import { EpicsRow, splitEpics } from './EpicsRow';
import { activePills, FiltersMenu, menuEntries } from './WorkFilters';
import {
  isSettled,
  readStoredWorkFilter,
  resolveWorkFilter,
  SETTLED,
  storeWorkFilter,
  withWorkFilter,
} from './workFilterState';

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const f = (quick: WorkFilter['quick'], has: string[] = [], show: string[] = []) =>
  normalizeWorkFilter({ quick, has, show });
const qs = (s: string) => new URLSearchParams(s);

describe('resolving the filter', () => {
  const none = () => null;

  it('reads the URL, and never rewrites it', () => {
    expect(resolveWorkFilter(qs('quick=blocked&has=for_you'), false, none)).toEqual({
      filter: f('blocked', ['for_you']),
      settle: false,
    });
  });

  it('maps an old filter= link and rewrites it in place', () => {
    const r = resolveWorkFilter(qs('layout=list&filter=deferred_review'), true, none);
    expect(r).toEqual({ filter: f('active', ['deferred_review'], ['done']), settle: true });
    expect(withWorkFilter(qs('layout=list&filter=deferred_review'), r.filter).toString()).toBe(
      'layout=list&has=deferred_review&show=done',
    );
  });

  it('an arrival with no filter takes the remembered one; a settled entry means the default', () => {
    const stored = () => f('progress');
    expect(resolveWorkFilter(qs('layout=list'), false, stored)).toEqual({
      filter: f('progress'),
      settle: true,
    });
    expect(resolveWorkFilter(qs('layout=list'), false, none)).toEqual({
      filter: DEFAULT_WORK_FILTER,
      settle: true,
    });
    expect(resolveWorkFilter(qs('layout=list'), true, stored)).toEqual({
      filter: DEFAULT_WORK_FILTER,
      settle: false,
    });
    expect(isSettled(SETTLED)).toBe(true);
    expect(isSettled(null)).toBe(false);
    expect(isSettled({ other: 1 })).toBe(false);
  });

  it('withWorkFilter keeps the other parameters and leaves defaults out', () => {
    expect(withWorkFilter(qs('epic=RCP-1&quick=blocked'), DEFAULT_WORK_FILTER).toString()).toBe(
      'epic=RCP-1',
    );
  });
});

describe('the remembered choice (localStorage, per project)', () => {
  it('stores per scope, and drops the default', () => {
    storeWorkFilter('RCP', f('blocked', ['live_run']));
    storeWorkFilter('all', f('active', [], ['done']));
    expect(readStoredWorkFilter('RCP')).toEqual(f('blocked', ['live_run']));
    expect(readStoredWorkFilter('all')).toEqual(f('active', [], ['done']));
    expect(readStoredWorkFilter('DOC')).toBeNull();
    storeWorkFilter('RCP', DEFAULT_WORK_FILTER);
    expect(readStoredWorkFilter('RCP')).toBeNull();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.workFilters)!)).toEqual({
      all: { quick: 'active', has: [], show: ['done'] },
    });
  });

  it('ignores junk', () => {
    localStorage.setItem(STORAGE_KEYS.workFilters, '{not json');
    expect(readStoredWorkFilter('RCP')).toBeNull();
    localStorage.setItem(
      STORAGE_KEYS.workFilters,
      JSON.stringify({ RCP: { quick: 'nope', has: ['for_you', 7, 'x'], show: 'done' } }),
    );
    expect(readStoredWorkFilter('RCP')).toEqual(f('active', ['for_you']));
  });
});

const counts = (archived = 0): WorkResponse['filter_counts'] => ({
  quick: { active: 9, startable: 1, waiting: 1, queued: 4, blocked: 2, progress: 3 },
  has: {
    for_you: 3,
    human_review_later: 1,
    deferred_review: 0,
    live_run: 1,
    has_problem: 2,
    archived: 0,
    planning: 4,
    ready_to_start: 2,
    inferred_type: 0,
    rollout: 0,
  },
  show: { done: 5, canceled: 1 },
  archived,
});

describe('the Filters menu', () => {
  it('lists the seven checks, Archived only once something is archived, then the shows', () => {
    const keys = (filter: WorkFilter, c = counts()) => {
      const m = menuEntries(filter, c);
      return [...m.checks.map((x) => x.key), ...m.shows.map((x) => x.key)];
    };
    expect(keys(DEFAULT_WORK_FILTER)).toEqual([
      'for_you',
      'human_review_later',
      'deferred_review',
      'live_run',
      'has_problem',
      'inferred_type',
      'rollout',
      'done',
      'canceled',
    ]);
    expect(keys(DEFAULT_WORK_FILTER, counts(2))).toContain('archived');
    expect(keys(f('active', ['archived']))).toContain('archived');
    // URL-only checks are never menu entries, but show as pills.
    expect(keys(f('active', ['planning']))).not.toContain('planning');
    expect(activePills(f('active', ['planning', 'for_you'], ['done'])).map((p) => p.label)).toEqual(
      ['For you', 'In planning', 'Shows done'],
    );
  });

  function Harness({ initial = DEFAULT_WORK_FILTER }: { initial?: WorkFilter }) {
    const [filter, setFilter] = useState(initial);
    return (
      <>
        <FiltersMenu filter={filter} counts={counts()} onFilter={setFilter} />
        <output data-testid="state">{JSON.stringify(filter)}</output>
      </>
    );
  }
  const state = () => JSON.parse(screen.getByTestId('state').textContent!) as WorkFilter;

  it('opens from the keyboard, moves, ticks without closing, and Escape returns focus', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const button = screen.getByRole('button', { name: 'Filters' });
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    button.focus();
    await user.keyboard('{Enter}');
    const menu = screen.getByRole('menu', { name: 'Filters' });
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe(menu.id);
    const entries = within(menu).getAllByRole('menuitemcheckbox');
    expect(entries.map((e) => e.textContent)).toEqual([
      'For you3',
      'Human review later1',
      'Deferred review0',
      'Live run1',
      'Has a problem2',
      'Inferred type0',
      'Rollout0',
      'Shows done5',
      'Shows canceled1',
      'Type: Exploration',
      'Type: Design',
      'Type: Implementation',
      'Type: Bug',
      'Type: Release',
    ]);
    expect(document.activeElement).toBe(entries[0]);
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(document.activeElement).toBe(entries[3]);
    await user.keyboard(' ');
    expect(state().has).toEqual(['live_run']);
    expect(
      within(menu)
        .getByRole('menuitemcheckbox', { name: /Live run/ })
        .getAttribute('aria-checked'),
    ).toBe('true');
    await user.keyboard('{End}{Enter}');
    expect(state().types).toEqual(['Release']);
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(within(menu).getAllByRole('menuitemcheckbox')[0]);
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(
      within(menu).getByRole('menuitemcheckbox', { name: /Type: Release/ }),
    );
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
    // The badge counts what's ticked (jsdom drops the space before "on"; browsers keep it).
    expect(screen.getByRole('button', { name: /^Filters 2 ?on$/ })).toBeTruthy();
  });

  it('ArrowUp on the button opens on the last entry; Tab and a click outside close it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const button = screen.getByRole('button', { name: 'Filters' });
    button.focus();
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(
      screen.getByRole('menuitemcheckbox', { name: /Type: Release/ }),
    );
    await user.keyboard('{Tab}');
    expect(screen.queryByRole('menu')).toBeNull();
    await user.click(button);
    expect(screen.getByRole('menu')).toBeTruthy();
    await user.click(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

const epic = (id: string, status: EpicCard['status'], total: number): EpicCard =>
  ({
    id,
    title: `Epic ${id}`,
    status,
    type: 'Epic',
    children: { total, done: status === 'done' ? total : 0, by_status: {}, for_you: 0 },
  }) as unknown as EpicCard;

describe('the Epics strip', () => {
  const epics = [
    epic('E-1', 'progress', 3),
    epic('E-2', 'done', 4),
    epic('E-3', 'done', 0),
    epic('E-4', 'done', 2),
  ];

  it('hides done epics with tickets, except an empty one and the current one', () => {
    const split = (current?: string) => {
      const s = splitEpics(epics, current);
      return { shown: s.shown.map((e) => e.id), done: s.done.map((e) => e.id) };
    };
    expect(split()).toEqual({ shown: ['E-1', 'E-3'], done: ['E-2', 'E-4'] });
    expect(split('E-4')).toEqual({ shown: ['E-1', 'E-3', 'E-4'], done: ['E-2'] });
  });

  it('counts what shows, and Show N done / Hide done toggles', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <EpicsRow epics={epics} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Epics · 2' })).toBeTruthy();
    const toggle = screen.getByRole('button', { name: 'Show 2 done' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await user.click(toggle);
    expect(screen.getByRole('heading', { name: 'Epics · 4' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hide done' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });
});
