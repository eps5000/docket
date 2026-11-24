/**
 * Where Work's filter comes from (B43; UI_SPEC §2 and §6.2):
 *
 * 1. the URL (`quick`, `has`, `show`), so a link is shareable and Back works;
 * 2. an old `filter=` link, mapped onto the model and rewritten in place;
 * 3. else the last choice for this project, from localStorage;
 * 4. else the default, *Active*.
 *
 * The remembered choice applies only on arrival: once a history entry has
 * been settled (marked in `location.state`), an entry with no filter in its
 * URL means the default, so Back to it shows what it showed before.
 */
import {
  DEFAULT_WORK_FILTER,
  isDefaultWorkFilter,
  normalizeWorkFilter,
  workFilterFromParams,
  workFilterToParams,
  type WorkFilter,
} from '@docket/shared';
import { readJson, STORAGE_KEYS, writeJson } from '../../lib/persistence';

/** The URL parameters the filter owns. */
export const WORK_FILTER_PARAMS = ['quick', 'has', 'show', 'type', 'filter'] as const;

/** `location.state` on a settled Work history entry. */
export const SETTLED = { workFilter: true } as const;

export const isSettled = (state: unknown) =>
  typeof state === 'object' &&
  state !== null &&
  (state as { workFilter?: unknown }).workFilter === true;

type Stored = Record<string, { quick?: string; has?: string[]; show?: string[]; types?: string[] }>;

export function readStoredWorkFilter(scope: string): WorkFilter | null {
  const map = readJson<Stored | null>(STORAGE_KEYS.workFilters, null);
  const entry = map && typeof map === 'object' ? map[scope] : undefined;
  if (!entry || typeof entry !== 'object') return null;
  const f = normalizeWorkFilter({
    quick: typeof entry.quick === 'string' ? entry.quick : undefined,
    has: Array.isArray(entry.has) ? entry.has.filter((k) => typeof k === 'string') : [],
    show: Array.isArray(entry.show) ? entry.show.filter((k) => typeof k === 'string') : [],
    types: Array.isArray(entry.types) ? entry.types.filter((k) => typeof k === 'string') : [],
  });
  return isDefaultWorkFilter(f) ? null : f;
}

export function storeWorkFilter(scope: string, f: WorkFilter): void {
  const map = { ...readJson<Stored | null>(STORAGE_KEYS.workFilters, null) };
  if (isDefaultWorkFilter(f)) delete map[scope];
  else
    map[scope] = {
      quick: f.quick,
      has: [...f.has],
      show: [...f.show],
      ...(f.types?.length ? { types: [...f.types] } : {}),
    };
  writeJson(STORAGE_KEYS.workFilters, map);
}

/**
 * The filter for this URL and history entry, and whether the entry should be
 * rewritten in place (an old `filter=` link, or an unsettled arrival).
 */
export function resolveWorkFilter(
  params: URLSearchParams,
  settled: boolean,
  stored: () => WorkFilter | null,
): { filter: WorkFilter; settle: boolean } {
  const fromUrl = workFilterFromParams({
    quick: params.get('quick'),
    has: params.get('has'),
    show: params.get('show'),
    type: params.get('type'),
    filter: params.get('filter'),
  });
  if (fromUrl) return { filter: fromUrl.filter, settle: fromUrl.legacy };
  if (settled) return { filter: DEFAULT_WORK_FILTER, settle: false };
  return { filter: stored() ?? DEFAULT_WORK_FILTER, settle: true };
}

/** `params` with the filter's parameters replaced by `f`'s (defaults left out). */
export function withWorkFilter(params: URLSearchParams, f: WorkFilter): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const k of WORK_FILTER_PARAMS) next.delete(k);
  for (const [k, v] of Object.entries(workFilterToParams(f))) if (v) next.set(k, v);
  return next;
}
