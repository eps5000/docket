/**
 * The Work page's filter model (B43, owner feedback from the Gameflow pilot;
 * UI_SPEC §6.2). The server applies it and counts it; the UI reads and
 * writes it in the URL. One shared definition, so the two can't drift.
 *
 * - **Quick filter** (one, a chip): *Active* (not done or canceled; the
 *   default), *Startable* or *Waiting* (Ready, split; decision 48), *Queued*
 *   (waits its turn behind moving work), *Blocked* (the wait needs attention;
 *   decision 57) or *In progress*.
 * - **Checks** (any, from the Filters menu): each narrows the view (AND).
 *   *In planning* and *Ready to start* aren't in the menu but still apply
 *   from the URL. *Archived* swaps the view to archived items.
 * - **Shows** (*Shows done*, *Shows canceled*): each adds those items back,
 *   on top of what the quick filter shows (OR). *Active* with both ticked is
 *   everything, the old *All*.
 *
 * - **Types** (decision 67, any, from the Filters menu): only tickets of the
 *   ticked types (OR among them). *Inferred type* and *Rollout* are checks.
 *
 * In the URL: `quick=blocked&has=for_you,live_run&show=done&type=Design`, each
 * left out at its default. The old `filter=<key>` links map onto the model
 * (`legacyWorkFilter`).
 */
import { FILTERS, ITEM_TYPES, type FilterKey, type ItemType, type Status } from './enums.js';
import type { WaitKind } from './wait-kind.js';

const queryOf = (key: FilterKey) => FILTERS.find((f) => f.key === key)?.query ?? '';

// ---- Quick filters ----

export const WORK_QUICK = [
  'active',
  'startable',
  'waiting',
  'queued',
  'blocked',
  'progress',
] as const;
export type WorkQuick = (typeof WORK_QUICK)[number];

/** The chips, in order. `query` is the chip's tooltip ("Agent query: …"; BUILD_SPEC §13). */
export const WORK_QUICK_FILTERS: readonly { key: WorkQuick; label: string; query: string }[] = [
  { key: 'active', label: 'Active', query: '-status:done -status:canceled' },
  // Decision 48: Ready, split by whether it can start now. The stored status doesn't change.
  { key: 'startable', label: 'Startable', query: queryOf('ready_to_start') },
  { key: 'waiting', label: 'Waiting', query: 'status:ready -startable' },
  // Decision 57: an open blocker splits into Queued (moving) and Blocked (needs attention).
  { key: 'queued', label: 'Queued', query: 'is:queued' },
  { key: 'blocked', label: 'Blocked', query: 'is:blocked -is:queued -is:held' },
  { key: 'progress', label: 'In progress', query: 'status:progress' },
];

// ---- Checks (narrow) ----

export const WORK_CHECKS = [
  'for_you',
  'human_review_later',
  'deferred_review',
  'live_run',
  'has_problem',
  'archived',
  'planning',
  'ready_to_start',
  'inferred_type',
  'rollout',
] as const;
export type WorkCheck = (typeof WORK_CHECKS)[number];

/**
 * The Filters menu's checks, in order. `menu`: `always`; `when-any` (only
 * while something is archived, or it's ticked); `never` (URL only; a pill
 * while applied).
 */
export const WORK_CHECK_FILTERS: readonly {
  key: WorkCheck;
  label: string;
  query: string;
  menu: 'always' | 'when-any' | 'never';
}[] = [
  { key: 'for_you', label: 'For you', query: queryOf('for_you'), menu: 'always' },
  {
    key: 'human_review_later',
    label: 'Human review later',
    query: queryOf('human_review_later'),
    menu: 'always',
  },
  {
    key: 'deferred_review',
    label: 'Deferred review',
    query: queryOf('deferred_review'),
    menu: 'always',
  },
  { key: 'live_run', label: 'Live run', query: queryOf('live_run'), menu: 'always' },
  { key: 'has_problem', label: 'Has a problem', query: 'has:problem', menu: 'always' },
  { key: 'archived', label: 'Archived', query: queryOf('archived'), menu: 'when-any' },
  { key: 'planning', label: 'In planning', query: queryOf('planning'), menu: 'never' },
  {
    key: 'ready_to_start',
    label: 'Ready to start',
    query: queryOf('ready_to_start'),
    menu: 'never',
  },
  // Decision 67: Story and Task tickets whose type nobody has checked, and rollouts.
  { key: 'inferred_type', label: 'Inferred type', query: 'is:inferred-type', menu: 'always' },
  { key: 'rollout', label: 'Rollout', query: 'is:rollout', menu: 'always' },
];

// ---- Types (decision 67) ----

/** The types the Filters menu offers: every ticket type (Work lists no epics). */
export const WORK_TYPES = ITEM_TYPES.filter((t) => t !== 'Epic') as Exclude<ItemType, 'Epic'>[];
export type WorkType = (typeof WORK_TYPES)[number];

// ---- Shows (widen) ----

export const WORK_SHOWS = ['done', 'canceled'] as const satisfies readonly Status[];
export type WorkShow = (typeof WORK_SHOWS)[number];

export const WORK_SHOW_FILTERS: readonly { key: WorkShow; label: string }[] = [
  { key: 'done', label: 'Shows done' },
  { key: 'canceled', label: 'Shows canceled' },
];

// ---- The filter ----

export interface WorkFilter {
  quick: WorkQuick;
  has: readonly WorkCheck[];
  show: readonly WorkShow[];
  /** Decision 67: only these types; empty means every type. */
  types?: readonly WorkType[];
}

export const DEFAULT_WORK_FILTER: WorkFilter = { quick: 'active', has: [], show: [], types: [] };

const inOrder = <T extends string>(order: readonly T[], keys: readonly string[]): T[] =>
  order.filter((k) => keys.includes(k));

/** Known keys only, without repeats, in the canonical order. */
export function normalizeWorkFilter(f: {
  quick?: string | null;
  has?: readonly string[];
  show?: readonly string[];
  types?: readonly string[] | undefined;
}): WorkFilter {
  return {
    quick: (WORK_QUICK as readonly string[]).includes(f.quick ?? '')
      ? (f.quick as WorkQuick)
      : 'active',
    has: inOrder(WORK_CHECKS, f.has ?? []),
    show: inOrder(WORK_SHOWS, f.show ?? []),
    types: inOrder(WORK_TYPES, f.types ?? []),
  };
}

const typesOf = (f: WorkFilter) => f.types ?? [];

export function isDefaultWorkFilter(f: WorkFilter): boolean {
  return (
    f.quick === 'active' && f.has.length === 0 && f.show.length === 0 && typesOf(f).length === 0
  );
}

export function sameWorkFilter(a: WorkFilter, b: WorkFilter): boolean {
  return (
    a.quick === b.quick &&
    a.has.join(',') === b.has.join(',') &&
    a.show.join(',') === b.show.join(',') &&
    typesOf(a).join(',') === typesOf(b).join(',')
  );
}

/** Decision 67: ticks or unticks one type. */
export function toggleWorkType(f: WorkFilter, type: WorkType): WorkFilter {
  const now = typesOf(f);
  return normalizeWorkFilter({
    ...f,
    types: now.includes(type) ? now.filter((t) => t !== type) : [...now, type],
  });
}

/** Ticks or unticks one check or show. */
export function toggleWorkFilter(f: WorkFilter, key: WorkCheck | WorkShow): WorkFilter {
  const flip = (list: readonly string[]) =>
    list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
  return (WORK_SHOWS as readonly string[]).includes(key)
    ? normalizeWorkFilter({ ...f, show: flip(f.show) })
    : normalizeWorkFilter({ ...f, has: flip(f.has) });
}

/**
 * The old single filters (`filter=<key>`, before B43), mapped so a saved or
 * shared link shows what it used to. The old views left out canceled and
 * archived items and kept done ones, so *All* is *Active* with *Shows done*,
 * and *Deferred review* (its items are usually done) and *Archived* keep
 * done items too.
 */
export const LEGACY_WORK_FILTERS: Readonly<Record<string, WorkFilter>> = {
  all: { quick: 'active', has: [], show: ['done'] },
  blocked: { quick: 'blocked', has: [], show: [] },
  for_you: { quick: 'active', has: ['for_you'], show: [] },
  human_review_later: { quick: 'active', has: ['human_review_later'], show: [] },
  deferred_review: { quick: 'active', has: ['deferred_review'], show: ['done'] },
  live_run: { quick: 'active', has: ['live_run'], show: [] },
  archived: { quick: 'active', has: ['archived'], show: ['done'] },
  planning: { quick: 'active', has: ['planning'], show: [] },
  ready_to_start: { quick: 'active', has: ['ready_to_start'], show: [] },
};

export function legacyWorkFilter(filter: string): WorkFilter | null {
  return Object.hasOwn(LEGACY_WORK_FILTERS, filter) ? LEGACY_WORK_FILTERS[filter]! : null;
}

/** The URL (and API) parameters, each left out at its default. */
export interface WorkFilterParams {
  quick?: string;
  has?: string;
  show?: string;
  type?: string;
}

export function workFilterToParams(f: WorkFilter): WorkFilterParams {
  const out: WorkFilterParams = {};
  if (f.quick !== 'active') out.quick = f.quick;
  if (f.has.length) out.has = f.has.join(',');
  if (f.show.length) out.show = f.show.join(',');
  if (typesOf(f).length) out.type = typesOf(f).join(',');
  return out;
}

const list = (v: string | null | undefined) => (v ? v.split(',').filter(Boolean) : []);

/**
 * The filter from the URL (or an API query): the new parameters if any is
 * present, else the old `filter=`, else null (the caller then uses the
 * remembered choice or the default).
 */
export function workFilterFromParams(p: {
  quick?: string | null;
  has?: string | null;
  show?: string | null;
  type?: string | null;
  filter?: string | null;
}): { filter: WorkFilter; legacy: boolean } | null {
  if (p.quick || p.has || p.show || p.type) {
    return {
      filter: normalizeWorkFilter({
        quick: p.quick,
        has: list(p.has),
        show: list(p.show),
        types: list(p.type),
      }),
      legacy: false,
    };
  }
  const old = p.filter ? legacyWorkFilter(p.filter) : null;
  return old ? { filter: old, legacy: true } : null;
}

// ---- Matching and counting ----

/** What the model needs to know about one item. `check` answers the checks other than Archived. */
export interface WorkFilterFacts {
  status: Status;
  /** Decision 67: the ticket's type, for the type filter. */
  type?: ItemType;
  /** Decision 57: the server's one classification; null without an open blocker. */
  wait: WaitKind | null;
  archived: boolean;
  check: (key: WorkCheck) => boolean;
}

const closed = (s: Status) => s === 'done' || s === 'canceled';

export function quickMatches(quick: WorkQuick, i: WorkFilterFacts): boolean {
  if (quick === 'active') return !closed(i.status);
  if (quick === 'startable') return i.status === 'ready' && i.check('ready_to_start');
  if (quick === 'waiting') return i.status === 'ready' && !i.check('ready_to_start');
  if (quick === 'queued') return i.wait === 'queued' && !closed(i.status);
  if (quick === 'blocked') return i.wait === 'blocked' && !closed(i.status);
  return i.status === 'progress';
}

/** The checks hold (archived items only under *Archived*, and only then), and the types. */
function checksPass(f: WorkFilter, i: WorkFilterFacts): boolean {
  if (i.archived !== f.has.includes('archived')) return false;
  const types = typesOf(f) as readonly string[];
  if (types.length > 0 && !(i.type && types.includes(i.type))) return false;
  return f.has.every((k) => k === 'archived' || i.check(k));
}

export function workFilterPasses(f: WorkFilter, i: WorkFilterFacts): boolean {
  if (!checksPass(f, i)) return false;
  return quickMatches(f.quick, i) || f.show.some((s) => s === i.status);
}

export interface WorkFilterCounts {
  /** Each chip: what you'd see with it chosen (the ticked checks and shows kept). */
  quick: Record<WorkQuick, number>;
  /** Each check: what you'd see with it ticked too. */
  has: Record<WorkCheck, number>;
  /** Each show: the done (or canceled) items it adds, under the ticked checks. */
  show: Record<WorkShow, number>;
  /** Archived items in scope, any status (*Archived* is in the menu only then). */
  archived: number;
  /** Decision 67: each type, what you'd see with only it ticked (the rest of the filter kept). */
  types?: Record<WorkType, number>;
}

/** The counts for the chips and the menu, over the items in the epic and label scope. */
export function workFilterCounts(
  f: WorkFilter,
  items: readonly WorkFilterFacts[],
): WorkFilterCounts {
  const count = (g: WorkFilter) => items.filter((i) => workFilterPasses(g, i)).length;
  const quick = Object.fromEntries(WORK_QUICK.map((q) => [q, count({ ...f, quick: q })])) as Record<
    WorkQuick,
    number
  >;
  const has = Object.fromEntries(
    WORK_CHECKS.map((k) => [
      k,
      count(f.has.includes(k) ? f : normalizeWorkFilter({ ...f, has: [...f.has, k] })),
    ]),
  ) as Record<WorkCheck, number>;
  const show = Object.fromEntries(
    WORK_SHOWS.map((s) => [s, items.filter((i) => i.status === s && checksPass(f, i)).length]),
  ) as Record<WorkShow, number>;
  const types = Object.fromEntries(
    WORK_TYPES.map((t) => [t, count(normalizeWorkFilter({ ...f, types: [t] }))]),
  ) as Record<WorkType, number>;
  return { quick, has, show, archived: items.filter((i) => i.archived).length, types };
}
