/**
 * The Work filter model (B43; UI_SPEC §6.2): matching, the counts, the URL
 * round trip and the old `filter=` links.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORK_FILTER,
  FILTERS,
  LEGACY_WORK_FILTERS,
  WORK_CHECK_FILTERS,
  WORK_CHECKS,
  isDefaultWorkFilter,
  normalizeWorkFilter,
  sameWorkFilter,
  toggleWorkFilter,
  workFilterCounts,
  workFilterFromParams,
  workFilterPasses,
  workFilterToParams,
  workQuery,
  type Status,
  type WorkCheck,
  type WorkFilter,
  type WorkFilterFacts,
} from '../src/index.js';

const item = (
  status: Status,
  opts: { blocked?: boolean; archived?: boolean; checks?: WorkCheck[] } = {},
): WorkFilterFacts & { name: string } => ({
  name: `${status}${opts.blocked ? '+blocked' : ''}${opts.archived ? '+archived' : ''}${(opts.checks ?? []).map((c) => `+${c}`).join('')}`,
  status,
  blocked: opts.blocked ?? false,
  archived: opts.archived ?? false,
  check: (k) => (opts.checks ?? []).includes(k),
});

const ITEMS = [
  item('inbox'),
  item('ready', { blocked: true }),
  item('progress', { checks: ['live_run'] }),
  item('progress', { checks: ['for_you', 'has_problem'] }),
  item('review', { checks: ['for_you'] }),
  item('done', { checks: ['deferred_review'] }),
  item('done', { archived: true }),
  item('canceled'),
];

const names = (f: WorkFilter) => ITEMS.filter((i) => workFilterPasses(f, i)).map((i) => i.name);
const f = (quick: WorkFilter['quick'], has: WorkCheck[] = [], show: WorkFilter['show'] = []) =>
  normalizeWorkFilter({ quick, has, show });

describe('matching', () => {
  it('Active (the default) is everything not done, canceled or archived', () => {
    expect(names(DEFAULT_WORK_FILTER)).toEqual([
      'inbox',
      'ready+blocked',
      'progress+live_run',
      'progress+for_you+has_problem',
      'review+for_you',
    ]);
  });

  it('Blocked and In progress', () => {
    expect(names(f('blocked'))).toEqual(['ready+blocked']);
    expect(names(f('progress'))).toEqual(['progress+live_run', 'progress+for_you+has_problem']);
  });

  it('checks narrow (AND) and shows add back (OR)', () => {
    expect(names(f('active', ['for_you']))).toEqual([
      'progress+for_you+has_problem',
      'review+for_you',
    ]);
    expect(names(f('active', ['for_you', 'has_problem']))).toEqual([
      'progress+for_you+has_problem',
    ]);
    expect(names(f('progress', [], ['done']))).toEqual([
      'progress+live_run',
      'progress+for_you+has_problem',
      'done+deferred_review',
    ]);
    // Active with both shows is everything not archived: the old All, plus canceled.
    expect(names(f('active', [], ['done', 'canceled']))).toHaveLength(7);
    // A check also applies to the items a show adds.
    expect(names(f('active', ['deferred_review'], ['done']))).toEqual(['done+deferred_review']);
  });

  it('Archived swaps the view to archived items', () => {
    expect(names(f('active', ['archived']))).toEqual([]);
    expect(names(f('active', ['archived'], ['done']))).toEqual(['done+archived']);
  });
});

describe('counts', () => {
  it('chips and checks count what you would see; shows count what they add', () => {
    const c = workFilterCounts(DEFAULT_WORK_FILTER, ITEMS);
    expect(c.quick).toMatchObject({ active: 5, blocked: 1, progress: 2 });
    expect(c.has).toMatchObject({ for_you: 2, live_run: 1, has_problem: 1, deferred_review: 0 });
    expect(c.show).toEqual({ done: 1, canceled: 1 });
    expect(c.archived).toBe(1);
  });

  it('are faceted: the ticked checks and shows carry over', () => {
    const c = workFilterCounts(f('active', ['for_you'], ['done']), ITEMS);
    expect(c.quick).toMatchObject({ active: 2, blocked: 0, progress: 1 });
    expect(c.has.for_you).toBe(2);
    expect(c.has.has_problem).toBe(1);
    expect(c.has.deferred_review).toBe(0);
    expect(c.show.done).toBe(0);
    const d = workFilterCounts(f('active', ['deferred_review']), ITEMS);
    expect(d.has.deferred_review).toBe(0);
    expect(d.show.done).toBe(1); // ticking Shows done would add it
  });
});

describe('the model', () => {
  it('normalizes: known keys, no repeats, canonical order, Active by default', () => {
    expect(
      normalizeWorkFilter({
        quick: 'nope',
        has: ['live_run', 'for_you', 'x', 'for_you'],
        show: ['canceled', 'done'],
      }),
    ).toEqual({ quick: 'active', has: ['for_you', 'live_run'], show: ['done', 'canceled'] });
    expect(isDefaultWorkFilter(normalizeWorkFilter({}))).toBe(true);
  });

  it('toggles checks and shows', () => {
    const a = toggleWorkFilter(DEFAULT_WORK_FILTER, 'done');
    expect(a.show).toEqual(['done']);
    const b = toggleWorkFilter(toggleWorkFilter(a, 'live_run'), 'for_you');
    expect(b.has).toEqual(['for_you', 'live_run']);
    expect(toggleWorkFilter(b, 'live_run').has).toEqual(['for_you']);
    expect(sameWorkFilter(toggleWorkFilter(a, 'done'), DEFAULT_WORK_FILTER)).toBe(true);
  });

  it('every check and show has a label, and every old UI filter maps', () => {
    expect(WORK_CHECK_FILTERS.map((c) => c.key).sort()).toEqual([...WORK_CHECKS].sort());
    for (const old of FILTERS.filter((x) => x.ui)) {
      expect(LEGACY_WORK_FILTERS[old.key], old.key).toBeDefined();
    }
  });
});

describe('the URL', () => {
  const roundTrip = (filter: WorkFilter) => {
    const qs = new URLSearchParams(workFilterToParams(filter) as Record<string, string>);
    return workFilterFromParams({
      quick: qs.get('quick'),
      has: qs.get('has'),
      show: qs.get('show'),
      filter: qs.get('filter'),
    });
  };

  it('leaves defaults out, and round-trips', () => {
    expect(workFilterToParams(DEFAULT_WORK_FILTER)).toEqual({});
    expect(roundTrip(DEFAULT_WORK_FILTER)).toBeNull();
    for (const filter of [
      f('blocked'),
      f('progress', ['live_run']),
      f('active', ['for_you', 'has_problem'], ['done']),
      f('active', [], ['done', 'canceled']),
      f('active', ['archived'], ['done']),
    ]) {
      expect(roundTrip(filter)).toEqual({ filter, legacy: false });
    }
    expect(workFilterToParams(f('blocked', ['for_you'], ['canceled']))).toEqual({
      quick: 'blocked',
      has: 'for_you',
      show: 'canceled',
    });
  });

  it('maps the old filter= links', () => {
    const old = (filter: string) => workFilterFromParams({ filter });
    expect(old('all')).toEqual({ filter: f('active', [], ['done']), legacy: true });
    expect(old('blocked')).toEqual({ filter: f('blocked'), legacy: true });
    expect(old('for_you')?.filter).toEqual(f('active', ['for_you']));
    expect(old('deferred_review')?.filter).toEqual(f('active', ['deferred_review'], ['done']));
    expect(old('archived')?.filter).toEqual(f('active', ['archived'], ['done']));
    expect(old('planning')?.filter).toEqual(f('active', ['planning']));
    expect(old('ready_to_start')?.filter).toEqual(f('active', ['ready_to_start']));
    expect(old('nonsense')).toBeNull();
    expect(old('constructor')).toBeNull();
    // The new parameters win over an old one.
    expect(workFilterFromParams({ filter: 'for_you', quick: 'blocked' })?.filter).toEqual(
      f('blocked'),
    );
  });

  it('the API query accepts the lists and rejects unknown keys', () => {
    const base = { scope: 'all' };
    expect(workQuery.safeParse({ ...base, has: 'for_you,has_problem', show: 'done' }).success).toBe(
      true,
    );
    expect(workQuery.safeParse({ ...base, has: 'for_you,nope' }).success).toBe(false);
    expect(workQuery.safeParse({ ...base, show: 'archived' }).success).toBe(false);
    expect(workQuery.safeParse({ ...base, quick: 'all' }).success).toBe(false);
    expect(workQuery.safeParse({ ...base, filter: 'for_you' }).success).toBe(true);
  });
});
