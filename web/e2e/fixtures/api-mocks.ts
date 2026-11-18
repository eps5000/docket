/**
 * Typed API answers for shell tests. Every data route answers 501 until its
 * slice lands, so tests that need a screen's empty state or a link to follow
 * stub the route in the browser with `page.route`. Shapes come from the
 * shared route schemas, so a contract change breaks these at compile time.
 */
import type { Page, Route } from '@playwright/test';
import type {
  AgentsResponse,
  BootstrapResponse,
  NeedsYouResponse,
  SearchResponse,
  SettingsResponse,
  WorkResponse,
  WorkspacesResponse,
} from '@docket/shared';

export const bootstrap: BootstrapResponse = {
  server_version: 'e2e',
  server_time: '2026-11-06T11:00:00Z',
  projects: [
    {
      key: 'RCP',
      name: 'Sample · Recipe App',
      short_name: 'Recipe App',
      color: '#3b5bdb',
      default_satisfied_when: 'done',
      version: 1,
    },
    {
      key: 'DOC',
      name: 'Sample · Docs Site',
      short_name: 'Docs Site',
      color: '#d9480f',
      default_satisfied_when: 'done',
      version: 1,
    },
  ],
  labels: [{ project: 'RCP', name: 'ui-refresh', brief_md: null, brief_by: null, brief_at: null }],
  counts: { for_you: 0, problems: 0, planning: 0, runs: {} },
  settings: { live_window_s: 120, stale_after_s: 1800, lease_s: 900, undo_window_s: 60 },
  health: { status: 'ready', checks: { database: 'ok' } },
};

export const emptyNeedsYou: NeedsYouResponse = {
  for_you_now: [],
  problems: [],
  deferred: [],
  planning_queue: [],
  agent_counts: {},
};

export const needsYouWithPacket: NeedsYouResponse = {
  ...emptyNeedsYou,
  for_you_now: [
    {
      kind: 'packet',
      item_id: 'RCP-12',
      title: 'Weekly planner drag-and-drop',
      project: 'RCP',
      packet_id: 'pkt-1',
      round: 2,
      to_verify: 2,
      estimate: '10 min',
      stale: false,
      built_from_commit: '9c0e7f2',
      submitted_at: '2026-11-06T10:42:00Z',
    },
  ],
};

export const emptyWork: WorkResponse = {
  layout: 'list',
  items: [],
  epics: [],
  filter_counts: {},
  links: [],
  outside: [],
  timeline: null,
};

export const emptyAgents: AgentsResponse = { rows: [] };
export const emptyWorkspaces: WorkspacesResponse = { rows: [] };

export const emptySettings: SettingsResponse = {
  projects: [],
  connections: {
    clients: [],
    endpoint: {
      mcp_url: 'http://127.0.0.1:7420/mcp',
      web_url: 'http://127.0.0.1:7420/',
      bind: 'loopback',
      auth: 'bearer',
      origins: ['http://127.0.0.1:7420'],
    },
  },
  health: {
    database: { state: 'ready', bytes: 1 },
    documents: { state: 'ready', bytes: 1 },
    volume_free_bytes: null,
    backups: [],
    extra_backup_configured: false,
    restarted_at: '2026-11-06T08:00:00Z',
    interrupted_at_restart: 0,
  },
};

export const searchResults: SearchResponse = {
  items: [
    {
      id: 'RCP-14',
      title: 'Generate shopping list from week plan',
      type: 'Story',
      status: 'progress',
      project: 'RCP',
      jira_key: null,
      archived: false,
    },
  ],
  labels: [{ project: 'RCP', name: 'ui-refresh' }],
  views: [],
};

/** Answer `GET <path>` (ignoring the query string) with `body`. */
export async function mockGet(page: Page, path: string, body: unknown): Promise<void> {
  const pattern = new RegExp(`^[^?]*${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\?.*)?$`);
  await page.route(pattern, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}
