import type { EpicPick } from '@docket/shared';

export type PickSortKey = 'title' | 'own' | 'start' | 'waits' | 'unblocks' | 'shaped' | 'worked';
export interface PickSort {
  key: PickSortKey;
  dir: 'asc' | 'desc';
}

const VALUE: Record<PickSortKey, (p: EpicPick) => number | string> = {
  title: (p) => p.title.toLowerCase(),
  own: (p) => p.self_contained / p.open,
  start: (p) => p.can_start.count,
  waits: (p) => p.waits_on.reduce((n, w) => n + w.tickets, 0),
  unblocks: (p) => p.unblocks_elsewhere,
  shaped: (p) => p.not_shaped,
  worked: (p) => p.worked_by.length,
};

/** The first click: names and waits read best low to high, the rest high to low. */
const firstDir = (key: PickSortKey): PickSort['dir'] =>
  key === 'title' || key === 'waits' ? 'asc' : 'desc';

/** First click sorts, the second reverses, the third goes back to the best-fit order. */
export function nextSort(current: PickSort | null, key: PickSortKey): PickSort | null {
  if (current?.key !== key) return { key, dir: firstDir(key) };
  return current.dir === firstDir(key)
    ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
    : null;
}

/** Rows in this order; ties keep the server's best-fit order. No sort leaves them as they came. */
export function sortPicks(rows: readonly EpicPick[], sort: PickSort | null): EpicPick[] {
  if (!sort) return [...rows];
  const value = VALUE[sort.key];
  const sign = sort.dir === 'asc' ? 1 : -1;
  return rows
    .map((row, at) => ({ row, at, v: value(row) }))
    .sort((a, b) => {
      const c = typeof a.v === 'string' ? a.v.localeCompare(b.v as string) : a.v - (b.v as number);
      return sign * c || a.at - b.at;
    })
    .map((x) => x.row);
}
