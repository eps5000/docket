import { describe, expect, it, vi } from 'vitest';
import { PROBLEM_KINDS } from '@docket/shared';
import { keysForChange, queryKeys } from '../lib/api';
import { STORAGE_AREA, STORAGE_KEYS } from '../lib/persistence';
import { PROBLEM_ROWS } from '../routes/needs-you/ProblemsCard';
import { resolveTab } from '../routes/items/ItemPage';
import { safeNext } from '../routes/unlock/Unlock';
import { sortWorkspaces } from '../routes/agents/WorkspacesCard';
import { closeTab, EMPTY_TABS, MAX_OPEN_TABS, openTab, parseTabs, updateTab } from './openTabs';
import { shouldRetry } from './queryClient';
import { isPaletteShortcut } from './shortcuts';
import { navSection } from './Sidebar';
import { itemIdFromPath } from './AppShell';
import { applyChange } from './useLiveStream';
import { ApiError } from '../lib/api';

describe('open-item tabs (UI_SPEC §2)', () => {
  const open = (...ids: string[]) => ids.reduce((s, id) => openTab(s, id), EMPTY_TABS);

  it('keeps at most 8, closing the oldest inactive tab when a 9th opens', () => {
    const s = open('A-1', 'A-2', 'A-3', 'A-4', 'A-5', 'A-6', 'A-7', 'A-8', 'A-9');
    expect(MAX_OPEN_TABS).toBe(8);
    expect(s.tabs.map((t) => t.id)).toEqual([
      'A-2',
      'A-3',
      'A-4',
      'A-5',
      'A-6',
      'A-7',
      'A-8',
      'A-9',
    ]);
  });

  it('reopening an open tab changes nothing', () => {
    const s = open('A-1', 'A-2');
    expect(openTab(s, 'A-1')).toBe(s);
  });

  it('remembers each tab’s view and what it learned', () => {
    let s = open('A-1', 'A-2');
    s = updateTab(s, 'A-1', { view: 'activity', type: 'Story', title: 'One' });
    expect(s.tabs[0]).toEqual({ id: 'A-1', view: 'activity', type: 'Story', title: 'One' });
    expect(updateTab(s, 'A-1', { view: 'activity' })).toBe(s);
  });

  it('closing the active tab moves to its neighbour, or back to the page you came from', () => {
    const s = { ...open('A-1', 'A-2', 'A-3'), lastPage: '/work?layout=list' };
    expect(closeTab(s, 'A-2', 'A-2').goTo).toEqual({ tab: { id: 'A-3' } });
    expect(closeTab(s, 'A-3', 'A-3').goTo).toEqual({ tab: { id: 'A-2' } });
    expect(closeTab(s, 'A-1', 'A-3').goTo).toBeNull();
    const last = { ...open('A-1'), lastPage: '/work?layout=list' };
    expect(closeTab(last, 'A-1', 'A-1').goTo).toEqual({ page: '/work?layout=list' });
  });

  it('drops malformed sessionStorage', () => {
    expect(parseTabs('nope')).toEqual(EMPTY_TABS);
    expect(parseTabs({ tabs: [{ id: 'A-1' }, { x: 1 }], lastPage: 'http://evil' })).toEqual({
      tabs: [{ id: 'A-1' }],
      lastPage: '/',
    });
  });
});

describe('persistence keys (UI_SPEC §2)', () => {
  it('puts scope and tabs in sessionStorage, the rest in localStorage', () => {
    expect(STORAGE_AREA[STORAGE_KEYS.scope]).toBe('session');
    expect(STORAGE_AREA[STORAGE_KEYS.openTabs]).toBe('session');
    expect(STORAGE_AREA[STORAGE_KEYS.theme]).toBe('local');
    expect(STORAGE_AREA[STORAGE_KEYS.notifications]).toBe('local');
    expect(STORAGE_AREA[STORAGE_KEYS.notified]).toBe('local');
    expect(STORAGE_AREA[STORAGE_KEYS.collapsed]).toBe('local');
    expect(STORAGE_AREA[STORAGE_KEYS.workFilters]).toBe('local');
    expect(Object.keys(STORAGE_AREA).sort()).toEqual(Object.values(STORAGE_KEYS).sort());
  });
});

describe('navigation', () => {
  it('maps paths to the active nav item (the packet keeps Needs you)', () => {
    expect(navSection('/')).toBe('overview');
    expect(navSection('/review/RCP-12')).toBe('overview');
    expect(navSection('/overview/completed')).toBe('overview');
    expect(navSection('/work')).toBe('work');
    expect(navSection('/items/RCP-14')).toBe('work');
    expect(navSection('/labels/RCP/ui-refresh')).toBe('work');
    expect(navSection('/agents')).toBe('agents');
    expect(navSection('/agent-files')).toBe('agent-files');
    expect(navSection('/settings')).toBe('settings');
    expect(navSection('/nope')).toBeNull();
  });

  it('reads the item ID from the path', () => {
    expect(itemIdFromPath('/items/RCP-14')).toBe('RCP-14');
    expect(itemIdFromPath('/items/RCP-14/')).toBe('RCP-14');
    expect(itemIdFromPath('/work')).toBeNull();
  });

  it('opens items on the URL tab, else the remembered one, else Details; deps and map swap', () => {
    expect(resolveTab('ticket', null)).toBe('details');
    expect(resolveTab('ticket', null, 'activity')).toBe('activity');
    expect(resolveTab('ticket', 'checklist', 'activity')).toBe('checklist');
    expect(resolveTab('epic', 'deps')).toBe('map');
    expect(resolveTab('ticket', 'map')).toBe('deps');
    expect(resolveTab('ticket', 'bogus')).toBe('details');
  });

  it('only follows same-app paths after unlocking', () => {
    expect(safeNext('/items/RCP-14?tab=activity')).toBe('/items/RCP-14?tab=activity');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext('/unlock')).toBe('/');
    expect(safeNext(null)).toBe('/');
  });
});

describe('palette shortcut (UI_SPEC §7)', () => {
  const ev = (key: string, mods: Partial<KeyboardEvent> = {}, target: unknown = null) =>
    ({ key, ctrlKey: false, metaKey: false, altKey: false, target, ...mods }) as KeyboardEvent;
  it('opens on Ctrl K anywhere and on / outside fields', () => {
    expect(isPaletteShortcut(ev('k', { ctrlKey: true }))).toBe(true);
    expect(isPaletteShortcut(ev('K', { metaKey: true }))).toBe(true);
    expect(isPaletteShortcut(ev('/'))).toBe(true);
    expect(isPaletteShortcut(ev('/', {}, { tagName: 'TEXTAREA' }))).toBe(false);
    expect(isPaletteShortcut(ev('/', {}, { tagName: 'INPUT', type: 'text' }))).toBe(false);
    expect(isPaletteShortcut(ev('/', {}, { tagName: 'INPUT', type: 'checkbox' }))).toBe(true);
    expect(isPaletteShortcut(ev('k'))).toBe(false);
  });
});

describe('live stream', () => {
  it('invalidates exactly the keys keysForChange names', () => {
    const invalidateQueries = vi.fn(async () => {});
    const change = {
      seq: 7,
      type: 'run.parked',
      objects: [{ kind: 'item', id: 'RCP-23' }],
      for_you: false,
    };
    const keys = applyChange({ invalidateQueries }, JSON.stringify(change));
    expect(keys).toEqual(keysForChange(change as Parameters<typeof keysForChange>[0]));
    expect(
      invalidateQueries.mock.calls.map(
        (c) => (c as unknown as [{ queryKey: unknown }])[0].queryKey,
      ),
    ).toEqual(keys);
    expect(keys).toContainEqual(queryKeys.family('workspaces'));
    expect(applyChange({ invalidateQueries }, 'not json')).toEqual([]);
  });
});

describe('query retries', () => {
  it('never retries a 4xx or a 501, and retries other failures twice', () => {
    const err = (status: number) =>
      new ApiError('needsYou.get', status, {
        code: status === 501 ? 'unavailable' : 'internal',
        message: '',
      });
    expect(shouldRetry(0, err(501))).toBe(false);
    expect(shouldRetry(0, err(401))).toBe(false);
    expect(shouldRetry(0, err(500))).toBe(true);
    expect(shouldRetry(2, err(500))).toBe(false);
    expect(shouldRetry(0, new TypeError('network'))).toBe(true);
  });
});

describe('screen tables', () => {
  it('maps every Problems kind, recovery rows included, to an icon and its actions', () => {
    expect(Object.keys(PROBLEM_ROWS).sort()).toEqual([...PROBLEM_KINDS].sort());
    expect(PROBLEM_ROWS.orphaned_resources.actions.map((a) => a.label)).toEqual([
      'Mark released',
      'Open',
    ]);
    // Decision 41: *Keep for later* and *Safe to discard* render beside this link.
    expect(PROBLEM_ROWS.unpushed_work.actions.map((a) => a.label)).toEqual(['Open']);
    expect(PROBLEM_ROWS.backup_missed.actions.map((a) => a.label)).toEqual(['Open']);
    expect(PROBLEM_ROWS.parked_too_long.actions.map((a) => a.label)).toEqual(['Open']);
    expect(PROBLEM_ROWS.resume_unattended.actions.map((a) => a.label)).toEqual(['Open']);
  });

  it('sorts workspaces At risk, In use, Parked, Unknown, Safe to prune and hides safe ones by default', () => {
    const row = (state: Parameters<typeof sortWorkspaces>[0][number]['state']) =>
      ({ path: state, state }) as Parameters<typeof sortWorkspaces>[0][number];
    const rows = ['safe_to_prune', 'unknown', 'parked', 'in_use', 'at_risk'].map((s) =>
      row(s as never),
    );
    expect(sortWorkspaces(rows, false).map((r) => r.state)).toEqual([
      'at_risk',
      'in_use',
      'parked',
      'unknown',
      'safe_to_prune',
    ]);
    expect(sortWorkspaces(rows, true).map((r) => r.state)).not.toContain('safe_to_prune');
  });
});
