/**
 * Client routes (UI_SPEC §2 "Routes"). Every link builds its URL here, so
 * the route table in app/router.tsx and the links can't drift.
 */
import type { WORK_LAYOUTS } from '@docket/shared';

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
  work: (
    q: {
      layout?: WorkLayout;
      epic?: string;
      label?: string;
      /** B43: the quick filter (`blocked`, `progress`; Active when omitted). */
      quick?: 'active' | 'blocked' | 'progress';
      /** B43: ticked checks, comma-separated (`for_you,live_run`). */
      has?: string;
      /** B43: `done`, `canceled` or both, comma-separated. */
      show?: string;
      /** The onboarding review card's links (decision 31; B30): one session's items. */
      onboarding?: string;
      onboarding_change?: 'created' | 'enriched';
    } = {},
  ) => withQuery('/work', q),
  /**
   * `step` (B35) opens that work step's dialog on the Checklist tab;
   * `problem` (decision 37) focuses that problem's banner.
   */
  item: (id: string, tab?: ItemTab, step?: string, problem?: string) =>
    withQuery(`/items/${encodeURIComponent(id)}`, { tab, step, problem }),
  review: (id: string, round?: number) => withQuery(`/review/${encodeURIComponent(id)}`, { round }),
  label: (project: string, name: string) =>
    `/labels/${encodeURIComponent(project)}/${encodeURIComponent(name)}`,
  /** `/agents?state=parked` (Active now, one state) or `/agents#workspaces` (B20). */
  agents: (q: { state?: string; section?: 'workspaces' } = {}) =>
    `${withQuery('/agents', { state: q.state })}${q.section ? `#${q.section}` : ''}`,
  settings: () => '/settings',
  /**
   * A project's Decisions page (owner decision 38; UI_SPEC §6.3.7): `filter=review`
   * shows only agents' unconfirmed records; `decision` scrolls to one and focuses it.
   */
  projectDecisions: (project: string, q: { filter?: 'review'; decision?: string } = {}) =>
    withQuery(`/projects/${encodeURIComponent(project)}/decisions`, q),
  /** Settings → Projects → <project> → Shared parts: the registry and the radar (decision 36). */
  sharedParts: (project: string) =>
    `/settings/projects/${encodeURIComponent(project)}/shared-parts`,
  /**
   * Agent files (UI_SPEC §6.7b) follows the project switcher. `project` (a
   * key, or `all`) switches the scope first, so a link can open one
   * project's view of a file; `file` opens that file.
   */
  agentFiles: (q: { project?: string; file?: string } = {}) => withQuery('/agent-files', q),
  /** `/help` (`?q=` searches) or one article, `/help/run-states` (UI_SPEC §6.7c). */
  help: (slug?: string, q?: string) =>
    slug ? `/help/${encodeURIComponent(slug)}` : withQuery('/help', { q }),
  unlock: (next?: string) =>
    withQuery('/unlock', { next: next && next !== '/' ? next : undefined }),
  devKit: () => '/dev/kit',
};
