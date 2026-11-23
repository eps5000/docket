/**
 * Token use per ticket and epic (owner decision 48; B63; BUILD_SPEC §5.34).
 *
 * The `usage` collector (`tools/docket-sync/sources/usage.mjs`) reads the local
 * agent logs and posts one record per model response. This file stores them,
 * matches each to a ticket, and answers the read routes.
 *
 * **Attribution never guesses.** In order:
 * 1. A folder the owner registered as a coordinator folder is project overhead.
 * 2. A turn in a run's recorded workspace, during that run, with exactly one
 *    ticket matching, is that ticket's.
 * 3. Anything else in a known workspace is *Not linked to a ticket* for the
 *    project, including two tickets sharing a folder at that moment.
 * A folder that isn't known is refused, so its turns are never stored.
 *
 * A run's workspace can be recorded after its first turns arrive, so each sync
 * looks again at recent unlinked turns.
 *
 * Advisory and read-only for everything else: no gate, no event per turn, and
 * no effect on Needs you. Tokens are measured; dollars are an API-equivalent
 * estimate from the dated price table (`usage-prices.ts`).
 */
import {
  LONG_CONTEXT_THRESHOLDS,
  ToolError,
  USAGE_HELPER_STALE_MS,
  USAGE_INTERVAL_MS,
  USAGE_PRICES_AS_OF,
  USAGE_SESSION_ROWS,
  USAGE_TOP_ROWS,
  estimateCost,
  modelPrice,
  normalizeWorkspace,
  type CoordinatorFolder,
  type RouteBody,
  type RouteParams,
  type RouteQuery,
  type UsageBucket,
  type UsageClient,
  type UsageCost,
  type UsageItemResponse,
  type UsageLink,
  type UsageModelRow,
  type UsageSessionRow,
  type UsageSettingsResponse,
  type UsageSummaryResponse,
  type UsageSyncBody,
  type UsageSyncConfigResponse,
  type UsageSyncResponse,
  type UsageTicketRow,
  type UsageTokens,
} from '@docket/shared';
import type { Db } from '../db/client.js';
import { dayStart } from './brief.js';
import type { ReadContext, ServiceDeps, WriteContext } from './contracts.js';
import { nextDay } from './flow.js';
import { localDay } from './forecast.js';
import { ms, requireItem, type RunRow } from './model.js';
import { OVERVIEW_WINDOW_MS } from './overview.js';
import { endedAt, parseJson } from './recovery-model.js';

const SETTING_KEY = 'usage_source';
const SEEN_KEY = 'usage_helper_seen_at';
/** Unlinked turns looked at again on each sync. */
const RELINK_LIMIT = 5000;

// ---- The setting ----

export interface UsageSetting {
  enabled: boolean;
  coordinator_folders: CoordinatorFolder[];
}

function readSettingValue(db: Db, key: string): unknown {
  const row = db.sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    { value: string | null } | undefined;
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    return null;
  }
}

function writeSettingValue(db: Db, key: string, value: unknown, now: string): void {
  db.sqlite
    .prepare(
      `INSERT INTO settings (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, JSON.stringify(value), now, now);
}

/** Off unless the owner turned it on. */
export function usageSetting(db: Db): UsageSetting {
  const value = readSettingValue(db, SETTING_KEY) as Partial<UsageSetting> | null;
  const folders = Array.isArray(value?.coordinator_folders) ? value.coordinator_folders : [];
  return {
    enabled: value?.enabled === true,
    coordinator_folders: folders.filter(
      (f): f is CoordinatorFolder => typeof f?.project === 'string' && typeof f?.path === 'string',
    ),
  };
}

function liveProjects(db: Db): Set<string> {
  return new Set(
    (
      db.sqlite.prepare('SELECT key FROM projects WHERE deleted_at IS NULL').all() as {
        key: string;
      }[]
    ).map((p) => p.key),
  );
}

// ---- Attribution ----

export interface RunWindow {
  item_id: string;
  project: string;
  start: number;
  /** Null while the run hasn't ended. */
  end: number | null;
}

export interface Attribution {
  /** Normalized run workspace → the runs recorded there. */
  windows: Map<string, RunWindow[]>;
  /** Normalized coordinator folder → its project. */
  coordinators: Map<string, string>;
}

export function attributionOf(db: Db): Attribution {
  const live = liveProjects(db);
  const rows = db.sqlite
    .prepare(
      `SELECT r.*, i.project_key AS project_key FROM runs r JOIN items i ON i.id = r.item_id
       WHERE json_extract(r.workspace, '$.path') IS NOT NULL`,
    )
    .all() as (RunRow & { project_key: string })[];
  const ended = endedAt(db, rows);
  const windows = new Map<string, RunWindow[]>();
  for (const run of rows) {
    if (!live.has(run.project_key)) continue;
    const path = parseJson<{ path?: string | null }>(run.workspace)?.path;
    if (!path) continue;
    const key = normalizeWorkspace(path);
    const end = ended.get(run.id);
    const list = windows.get(key) ?? [];
    list.push({
      item_id: run.item_id,
      project: run.project_key,
      start: ms(run.created_at),
      end: end ? ms(end) : null,
    });
    windows.set(key, list);
  }
  const coordinators = new Map<string, string>();
  for (const folder of usageSetting(db).coordinator_folders) {
    if (live.has(folder.project)) coordinators.set(normalizeWorkspace(folder.path), folder.project);
  }
  return { windows, coordinators };
}

export interface TurnLink {
  project_key: string;
  item_id: string | null;
  link: UsageLink;
}

/** Where one turn belongs; null when its folder isn't a known workspace. */
export function attribute(
  turn: { workspace: string; at: string },
  a: Attribution,
): TurnLink | null {
  const coordinator = a.coordinators.get(turn.workspace);
  if (coordinator) return { project_key: coordinator, item_id: null, link: 'overhead' };
  const windows = a.windows.get(turn.workspace);
  if (!windows || windows.length === 0) return null;
  const at = ms(turn.at);
  const during = windows.filter((w) => w.start <= at && (w.end === null || at <= w.end));
  const tickets = new Set(during.map((w) => w.item_id));
  if (tickets.size === 1) {
    const only = during[0]!;
    return { project_key: only.project, item_id: only.item_id, link: 'ticket' };
  }
  // No single ticket. It still belongs to a project: the latest run that had started, else the first.
  const byStart = [...windows].sort((x, y) => x.start - y.start);
  const started = byStart.filter((w) => w.start <= at);
  const nearest = started[started.length - 1] ?? byStart[0]!;
  return { project_key: nearest.project, item_id: null, link: 'unlinked' };
}

/** The folders the collector may report, and nothing else. */
export function knownWorkspaces(a: Attribution): string[] {
  return [...new Set([...a.windows.keys(), ...a.coordinators.keys()])].sort();
}

// ---- Adding up ----

const TIER_SQL = `CASE WHEN fresh_input + cached_input + cache_write > ${LONG_CONTEXT_THRESHOLDS[1]}
    THEN ${LONG_CONTEXT_THRESHOLDS[1] + 1}
  WHEN fresh_input + cached_input + cache_write > ${LONG_CONTEXT_THRESHOLDS[0]}
    THEN ${LONG_CONTEXT_THRESHOLDS[0] + 1}
  ELSE 0 END`;

const SUMS_SQL = `SUM(fresh_input) AS fresh_input, SUM(cached_input) AS cached_input,
  SUM(cache_write) AS cache_write, SUM(cache_write_1h) AS cache_write_1h,
  SUM(output) AS output, COUNT(*) AS turns`;

interface SumRow {
  model: string | null;
  tier: number;
  fresh_input: number;
  cached_input: number;
  cache_write: number;
  cache_write_1h: number;
  output: number;
  turns: number;
}

/** Adds up token rows, pricing each by its model and prompt-length tier. */
class Tally {
  fresh_input = 0;
  cached_input = 0;
  cache_write = 0;
  output = 0;
  turns = 0;
  private usd = 0;
  private priced = false;
  private unpriced = 0;
  private readonly unpricedModels = new Set<string>();

  add(row: SumRow): void {
    this.fresh_input += row.fresh_input;
    this.cached_input += row.cached_input;
    this.cache_write += row.cache_write;
    this.output += row.output;
    this.turns += row.turns;
    const cost = estimateCost(row.model, row, row.tier);
    this.unpriced += cost.unpriced_tokens;
    if (cost.usd !== null) {
      this.usd += cost.usd;
      this.priced = true;
    }
    if (!modelPrice(row.model)) this.unpricedModels.add(row.model ?? 'unknown model');
  }

  tokens(): UsageTokens {
    return {
      fresh_input: this.fresh_input,
      cached_input: this.cached_input,
      cache_write: this.cache_write,
      output: this.output,
    };
  }

  cost(): UsageCost {
    return {
      usd: this.priced ? this.usd : null,
      unpriced_tokens: this.unpriced,
      unpriced_models: [...this.unpricedModels].sort(),
    };
  }

  bucket(sessions: number): UsageBucket {
    return { tokens: this.tokens(), cost: this.cost(), turns: this.turns, sessions };
  }

  /** Everything but cache reads: what ranks a ticket, so cheap reads can't dominate. */
  get weight(): number {
    return this.fresh_input + this.cache_write + this.output;
  }

  get all(): number {
    return this.fresh_input + this.cached_input + this.cache_write + this.output;
  }
}

function tallyBy<K>(rows: readonly (SumRow & { group: K })[]): Map<K, Tally> {
  const out = new Map<K, Tally>();
  for (const row of rows) {
    const tally = out.get(row.group) ?? new Tally();
    tally.add(row);
    out.set(row.group, tally);
  }
  return out;
}

function modelRows(rows: readonly SumRow[]): UsageModelRow[] {
  const byModel = tallyBy(rows.map((r) => ({ ...r, group: r.model })));
  return [...byModel]
    .map(([model, t]) => ({
      model,
      tokens: t.tokens(),
      cost: t.cost(),
      turns: t.turns,
      w: t.weight,
    }))
    .sort((a, b) => b.w - a.w || (a.model ?? '').localeCompare(b.model ?? ''))
    .map(({ w: _w, ...row }) => row);
}

const EMPTY_BUCKET = (): UsageBucket => new Tally().bucket(0);

function lastTurnAt(db: Db): string | null {
  const row = db.sqlite.prepare('SELECT MAX(at) AS at FROM usage_turns').get() as {
    at: string | null;
  };
  return row.at;
}

function ticketRows(db: Db, byItem: Map<string, Tally>): UsageTicketRow[] {
  const items = new Map(
    (
      db.sqlite
        .prepare(
          `SELECT id, title, project_key, status FROM items
           WHERE id IN (SELECT value FROM json_each(?))`,
        )
        .all(JSON.stringify([...byItem.keys()])) as {
        id: string;
        title: string;
        project_key: string;
        status: UsageTicketRow['status'];
      }[]
    ).map((i) => [i.id, i]),
  );
  return [...byItem]
    .flatMap(([id, t]) => {
      const item = items.get(id);
      return item ? [{ item, t }] : [];
    })
    .sort((a, b) => b.t.weight - a.t.weight || a.item.id.localeCompare(b.item.id))
    .map(({ item, t }) => ({
      id: item.id,
      title: item.title,
      project: item.project_key,
      status: item.status,
      tokens: t.tokens(),
      cost: t.cost(),
    }));
}

// ---- The service ----

export interface UsageService {
  /** Overview's card (a window) or the brief's section (a day). */
  summary(r: ReadContext, input: RouteQuery<'usage.get'>): UsageSummaryResponse;
  /** One ticket, or an epic with its tickets. */
  item(r: ReadContext, input: RouteParams<'usage.item'>): UsageItemResponse;
  settings(r: ReadContext): UsageSettingsResponse;
  setSettings(w: WriteContext, input: RouteBody<'usageSettings.set'>): UsageSettingsResponse;
  /** What the collector reads first: whether to read at all, and the folders it may report. */
  syncConfig(r: ReadContext): UsageSyncConfigResponse;
  ingest(r: ReadContext, body: UsageSyncBody): UsageSyncResponse;
}

function spanOf(
  now: string,
  tz: string | null,
  input: RouteQuery<'usage.get'>,
): { from: string; to: string } {
  if (input.day) {
    const today = localDay(now, tz);
    const day = input.day > today ? today : input.day;
    const start = dayStart(day, tz) - 1;
    const end = Math.min(ms(now), dayStart(nextDay(day), tz) - 1);
    return { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
  }
  const span = OVERVIEW_WINDOW_MS[input.window ?? '7d'];
  return { from: new Date(ms(now) - span).toISOString(), to: now };
}

function settingsView(db: Db, now: string): UsageSettingsResponse {
  const setting = usageSetting(db);
  const seen = readSettingValue(db, SEEN_KEY);
  const lastRead = typeof seen === 'string' ? seen : null;
  const fresh = lastRead !== null && ms(now) - ms(lastRead) < USAGE_HELPER_STALE_MS;
  const { n } = db.sqlite.prepare('SELECT COUNT(*) AS n FROM usage_turns').get() as { n: number };
  return {
    enabled: setting.enabled,
    coordinator_folders: setting.coordinator_folders,
    helper: !setting.enabled ? 'off' : fresh ? 'running' : 'not_running',
    last_read_at: lastRead,
    turns_stored: n,
  };
}

/** Look again at turns the owner's folders or a late-recorded workspace may now explain. */
function relink(db: Db, a: Attribution, where: string, ...params: unknown[]): void {
  const rows = db.sqlite
    .prepare(
      `SELECT key, workspace, at, project_key, item_id, link FROM usage_turns
       WHERE ${where} ORDER BY at DESC LIMIT ${RELINK_LIMIT}`,
    )
    .all(...params) as ({ key: string; workspace: string; at: string } & TurnLink)[];
  const update = db.sqlite.prepare(
    'UPDATE usage_turns SET project_key = ?, item_id = ?, link = ? WHERE key = ?',
  );
  for (const row of rows) {
    const next = attribute(row, a);
    if (!next) continue;
    if (
      next.link !== row.link ||
      next.item_id !== row.item_id ||
      next.project_key !== row.project_key
    ) {
      update.run(next.project_key, next.item_id, next.link, row.key);
    }
  }
}

export function createUsageService(deps: ServiceDeps): UsageService {
  return {
    summary(r, input) {
      const db = r.db;
      const { from, to } = spanOf(r.now, deps.config.tz, input);
      const enabled = usageSetting(db).enabled;
      const base = {
        enabled,
        prices_as_of: USAGE_PRICES_AS_OF,
        last_turn_at: enabled ? lastTurnAt(db) : null,
        from,
        to,
      };
      if (!enabled) {
        return {
          ...base,
          total: EMPTY_BUCKET(),
          linked: EMPTY_BUCKET(),
          overhead: EMPTY_BUCKET(),
          unlinked: EMPTY_BUCKET(),
          linked_pct: null,
          models: [],
          top_tickets: { count: 0, rows: [] },
        };
      }
      const scoped = input.scope !== 'all';
      const where = `at > @from AND at <= @to${scoped ? ' AND project_key = @scope' : ''}`;
      const params = { from, to, ...(scoped ? { scope: input.scope } : {}) };
      const rows = db.sqlite
        .prepare(
          `SELECT link AS "group", model, ${TIER_SQL} AS tier, ${SUMS_SQL}
           FROM usage_turns WHERE ${where} GROUP BY link, model, tier`,
        )
        .all(params) as (SumRow & { group: UsageLink })[];
      const sessions = new Map(
        (
          db.sqlite
            .prepare(
              `SELECT link, COUNT(DISTINCT session_id) AS n FROM usage_turns
               WHERE ${where} GROUP BY link`,
            )
            .all(params) as { link: UsageLink; n: number }[]
        ).map((s) => [s.link, s.n]),
      );
      const allSessions = (
        db.sqlite
          .prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM usage_turns WHERE ${where}`)
          .get(params) as { n: number }
      ).n;
      const byLink = tallyBy(rows);
      const total = new Tally();
      for (const row of rows) total.add(row);
      const bucket = (link: UsageLink) =>
        byLink.get(link)?.bucket(sessions.get(link) ?? 0) ?? EMPTY_BUCKET();
      const linkedTokens = byLink.get('ticket')?.all ?? 0;
      const itemRows = db.sqlite
        .prepare(
          `SELECT item_id AS "group", model, ${TIER_SQL} AS tier, ${SUMS_SQL}
           FROM usage_turns WHERE link = 'ticket' AND item_id IS NOT NULL AND ${where}
           GROUP BY item_id, model, tier`,
        )
        .all(params) as (SumRow & { group: string })[];
      const tickets = ticketRows(db, tallyBy(itemRows));
      return {
        ...base,
        total: total.bucket(allSessions),
        linked: bucket('ticket'),
        overhead: bucket('overhead'),
        unlinked: bucket('unlinked'),
        linked_pct: total.all > 0 ? Math.round((linkedTokens / total.all) * 100) : null,
        models: modelRows(rows),
        top_tickets: { count: tickets.length, rows: tickets.slice(0, USAGE_TOP_ROWS) },
      };
    },

    item(r, input) {
      const db = r.db;
      const row = requireItem(db, input.id);
      const enabled = usageSetting(db).enabled;
      const rollup = row.type === 'Epic';
      const base = {
        enabled,
        prices_as_of: USAGE_PRICES_AS_OF,
        last_turn_at: enabled ? lastTurnAt(db) : null,
        item_id: row.id,
        rollup,
      };
      if (!enabled) {
        return {
          ...base,
          total: EMPTY_BUCKET(),
          models: [],
          sessions: { count: 0, rows: [] },
          children: [],
        };
      }
      const childIds = rollup
        ? (
            db.sqlite.prepare('SELECT id FROM items WHERE epic_id = ?').all(row.id) as {
              id: string;
            }[]
          ).map((c) => c.id)
        : [];
      const ids = JSON.stringify([row.id, ...childIds]);
      const where = `item_id IN (SELECT value FROM json_each(?))`;
      const rows = db.sqlite
        .prepare(
          `SELECT item_id AS "group", model, ${TIER_SQL} AS tier, ${SUMS_SQL}
           FROM usage_turns WHERE ${where} GROUP BY item_id, model, tier`,
        )
        .all(ids) as (SumRow & { group: string })[];
      const total = new Tally();
      for (const sum of rows) total.add(sum);
      const sessionRows = db.sqlite
        .prepare(
          `SELECT session_id, client, model, ${TIER_SQL} AS tier, MIN(at) AS first_at,
             MAX(at) AS last_at, ${SUMS_SQL}
           FROM usage_turns WHERE ${where} GROUP BY session_id, client, model, tier`,
        )
        .all(ids) as (SumRow & {
        session_id: string;
        client: UsageClient;
        first_at: string;
        last_at: string;
      })[];
      const sessions = new Map<
        string,
        {
          t: Tally;
          session_id: string;
          client: UsageClient;
          first_at: string;
          last_at: string;
          models: Set<string>;
        }
      >();
      for (const s of sessionRows) {
        const key = `${s.client}:${s.session_id}`;
        const held = sessions.get(key) ?? {
          t: new Tally(),
          session_id: s.session_id,
          client: s.client,
          first_at: s.first_at,
          last_at: s.last_at,
          models: new Set<string>(),
        };
        held.t.add(s);
        if (s.first_at < held.first_at) held.first_at = s.first_at;
        if (s.last_at > held.last_at) held.last_at = s.last_at;
        if (s.model) held.models.add(s.model);
        sessions.set(key, held);
      }
      const sessionList: UsageSessionRow[] = [...sessions.values()]
        .sort(
          (a, b) => b.last_at.localeCompare(a.last_at) || a.session_id.localeCompare(b.session_id),
        )
        .map((s) => ({
          session_id: s.session_id,
          client: s.client,
          first_at: s.first_at,
          last_at: s.last_at,
          turns: s.t.turns,
          models: [...s.models].sort(),
          tokens: s.t.tokens(),
          cost: s.t.cost(),
        }));
      const children = rollup
        ? ticketRows(db, tallyBy(rows.filter((c) => c.group !== row.id)))
        : [];
      return {
        ...base,
        total: total.bucket(sessions.size),
        models: modelRows(rows),
        sessions: { count: sessionList.length, rows: sessionList.slice(0, USAGE_SESSION_ROWS) },
        children,
      };
    },

    settings(r) {
      return settingsView(r.db, r.now);
    },

    setSettings(w, input) {
      const was = usageSetting(w.db);
      const live = liveProjects(w.db);
      const folders = input.coordinator_folders ?? was.coordinator_folders;
      for (const folder of folders) {
        if (!live.has(folder.project)) {
          throw new ToolError('not_found', `No project ${folder.project}.`);
        }
      }
      const next: UsageSetting = {
        enabled: input.enabled,
        coordinator_folders: folders.map((f) => ({
          project: f.project,
          path: normalizeWorkspace(f.path),
        })),
      };
      const foldersChanged =
        JSON.stringify(next.coordinator_folders) !== JSON.stringify(was.coordinator_folders);
      if (next.enabled === was.enabled && !foldersChanged) return settingsView(w.db, w.now);
      writeSettingValue(w.db, SETTING_KEY, next, w.now);
      if (foldersChanged) {
        const paths = [
          ...was.coordinator_folders.map((f) => normalizeWorkspace(f.path)),
          ...next.coordinator_folders.map((f) => f.path),
        ];
        relink(
          w.db,
          attributionOf(w.db),
          'workspace IN (SELECT value FROM json_each(?))',
          JSON.stringify(paths),
        );
      }
      // Paths aren't in the event: the activity log has no need of them.
      w.event({
        type: 'project.updated',
        summary:
          next.enabled === was.enabled
            ? 'You changed the coordinator folders for token use'
            : next.enabled
              ? 'You turned on measuring token use from local agent logs'
              : 'You turned off measuring token use from local agent logs',
        data: {
          usage_source: { old: was.enabled, new: next.enabled },
          coordinator_folders: next.coordinator_folders.length,
        },
      });
      return settingsView(w.db, w.now);
    },

    syncConfig(r) {
      const view = settingsView(r.db, r.now);
      return {
        name: 'usage',
        settings: view.enabled
          ? { enabled: true, workspaces: knownWorkspaces(attributionOf(r.db)) }
          : { enabled: false, workspaces: [] },
        status: {
          last_report_at: view.last_read_at,
          last_success_at: view.last_read_at,
          last_error: null,
          interval_ms: USAGE_INTERVAL_MS,
          records_total: view.turns_stored,
          stale: view.helper === 'not_running' && view.last_read_at !== null,
        },
      };
    },

    ingest(r, { records, run }) {
      const db = r.db;
      const out: UsageSyncResponse = { accepted: 0, changed: 0, ignored: 0 };
      // Checked here too: turning the source off stops storage even if a pass is in flight.
      if (!usageSetting(db).enabled) return { ...out, ignored: records.length };
      const attribution = attributionOf(db);
      const upsert = db.sqlite.prepare(
        `INSERT INTO usage_turns (key, project_key, item_id, link, client, session_id, at,
           workspace, model, fresh_input, cached_input, cache_write, cache_write_1h, output,
           received_at)
         VALUES (@key, @project_key, @item_id, @link, @client, @session_id, @at, @workspace,
           @model, @fresh_input, @cached_input, @cache_write, @cache_write_1h, @output, @received_at)
         ON CONFLICT (key) DO UPDATE SET
           fresh_input = max(fresh_input, excluded.fresh_input),
           cached_input = max(cached_input, excluded.cached_input),
           cache_write = max(cache_write, excluded.cache_write),
           cache_write_1h = max(cache_write_1h, excluded.cache_write_1h),
           output = max(output, excluded.output),
           model = coalesce(model, excluded.model),
           received_at = excluded.received_at
         WHERE excluded.fresh_input > fresh_input OR excluded.cached_input > cached_input
           OR excluded.cache_write > cache_write OR excluded.cache_write_1h > cache_write_1h
           OR excluded.output > output OR (model IS NULL AND excluded.model IS NOT NULL)`,
      );
      db.sqlite
        .transaction(() => {
          for (const record of records) {
            const at = new Date(record.at).toISOString();
            const workspace = normalizeWorkspace(record.workspace);
            const link = attribute({ workspace, at }, attribution);
            if (!link) {
              out.ignored += 1;
              continue;
            }
            const { changes } = upsert.run({
              ...record,
              ...link,
              at,
              workspace,
              received_at: r.now,
            });
            out.accepted += 1;
            if (changes > 0) out.changed += 1;
          }
          relink(db, attribution, "link = 'unlinked'");
          // "Last read" is the last pass that finished, so a failing helper can't look healthy.
          if (run.ok && !run.partial) writeSettingValue(db, SEEN_KEY, r.now, r.now);
        })
        .immediate();
      return out;
    },
  };
}
