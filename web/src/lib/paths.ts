/**
 * Client routes (UI_SPEC §2 "Routes"). Every link builds its URL here, so
 * the route table in app/router.tsx and the links can't drift.
 */
import type { WORK_LAYOUTS } from '@tasklite/shared';

export type WorkLayout = (typeof WORK_LAYOUTS)[number];
export type ItemTab = 'details' | 'checklist' | 'deps' | 'map' | 'activity';
export const ITEM_TABS: readonly ItemTab[] = ['details', 'checklist', 'deps', 'map', 'activity'];

function withQuery(path: string, query: Record<string, string | number | undefined | null>) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

export const paths = {
  needsYou: () => '/',
  work: (q: { layout?: WorkLayout; epic?: string; label?: string; filter?: string } = {}) =>
    withQuery('/work', q),
  item: (id: string, tab?: ItemTab) => withQuery(`/items/${encodeURIComponent(id)}`, { tab }),
  review: (id: string, round?: number) => withQuery(`/review/${encodeURIComponent(id)}`, { round }),
  label: (project: string, name: string) =>
    `/labels/${encodeURIComponent(project)}/${encodeURIComponent(name)}`,
  /** `/agents?state=parked` (Active now, one state) or `/agents#workspaces` (B20). */
  agents: (q: { state?: string; section?: 'workspaces' } = {}) =>
    `${withQuery('/agents', { state: q.state })}${q.section ? `#${q.section}` : ''}`,
  settings: () => '/settings',
  unlock: (next?: string) =>
    withQuery('/unlock', { next: next && next !== '/' ? next : undefined }),
  devKit: () => '/dev/kit',
};
