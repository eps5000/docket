/**
 * Search, filters and the change feed (BUILD_SPEC §5.11, §13): the `search` service.
 *
 * US1 (T075) implements `whoami`, `list_projects`, `search_items` (the
 * agent filters, `fields`, cursor pagination) and `get_changes`. Still a
 * stub: the owner's command palette (US2).
 *
 * Sort orders (MCP_SPEC §5.2): `ready_to_start` by priority, then by how
 * many items each would unblock (most first), then by ID; everything else
 * by priority, then `updated_at` ascending.
 */
import {
  LIMITS,
  OPEN_STATUSES,
  ToolError,
  WHOAMI_LIMITS,
  type ItemSummary,
  type ItemSummaryView,
} from '@tasklite/shared';
import { APP_VERSION } from '../version.js';
import { notImplemented, type In, type SearchService, type ServiceDeps } from './contracts.js';
import {
  BlockIndex,
  EVENT_COLUMNS,
  EVENT_FROM,
  RESUMABLE_SQL,
  eventRow,
  summarize,
  windowsOf,
  type ItemRow,
  type StoredEvent,
} from './model.js';

const isOpen = (status: string) => (OPEN_STATUSES as readonly string[]).includes(status);

/** `RCP-9` before `RCP-10`. */
export function compareIds(a: string, b: string): number {
  const [pa, na] = a.split('-');
  const [pb, nb] = b.split('-');
  return pa === pb ? Number(na) - Number(nb) : pa! < pb! ? -1 : 1;
}

// ---- Cursors: opaque to agents ----

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}

function decodeCursor(cursor: string): number {
  try {
    const o = (JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown }).o;
    if (typeof o === 'number' && Number.isInteger(o) && o >= 0) return o;
  } catch {
    // Falls through to the error.
  }
  throw new ToolError(
    'validation',
    'That cursor is not valid here. Pass next_cursor from the previous page, or leave it out.',
    {
      details: { fields: { cursor: 'not a cursor from this list' } },
    },
  );
}

/** An FTS5 query: every word must match, as a prefix. */
function ftsQuery(text: string): string | null {
  const words = text
    .split(/\s+/)
    .map((w) => w.replace(/"/g, '').trim())
    .filter(Boolean);
  return words.length > 0 ? words.map((w) => `"${w}"*`).join(' ') : null;
}

export function createSearchService(deps: ServiceDeps): SearchService {
  const windows = () => windowsOf(deps.config);
  return {
    whoami(r, input) {
      return {
        client: input.client,
        session_id: input.session_id,
        server_version: APP_VERSION,
        server_time: r.now,
        limits: {
          page_max: WHOAMI_LIMITS.page_max,
          changes_max: WHOAMI_LIMITS.changes_max,
          document_mcp_bytes: WHOAMI_LIMITS.document_mcp_bytes,
          text_limits: { ...WHOAMI_LIMITS.text_limits },
        },
        live_window_s: Math.round(deps.config.liveWindowMs / 1000),
        stale_after_s: Math.round(deps.config.staleAfterMs / 1000),
        lease_s: Math.round(deps.config.leaseMs / 1000),
      };
    },

    listProjects(r) {
      const projects = r.db.sqlite
        .prepare('SELECT key, name FROM projects WHERE deleted_at IS NULL ORDER BY key')
        .all() as { key: string; name: string }[];
      const rows = r.db.sqlite
        .prepare(
          'SELECT i.* FROM items i JOIN projects p ON p.key = i.project_key WHERE p.deleted_at IS NULL',
        )
        .all() as ItemRow[];
      const summaries = summarize({ db: r.db, windows: windows(), now: r.now }, rows);
      return {
        projects: projects.map((p) => {
          const mine = summaries.filter((s) => s.project === p.key);
          return {
            key: p.key,
            name: p.name,
            counts: {
              open: mine.filter((s) => isOpen(s.status)).length,
              ready_to_start: mine.filter((s) => s.status === 'ready' && !s.blocked && !s.lead)
                .length,
              in_progress: mine.filter((s) => s.status === 'progress').length,
              review: mine.filter((s) => s.status === 'review').length,
              blocked: mine.filter((s) => s.blocked).length,
            },
          };
        }),
      };
    },

    searchItems(r, input: In<'search_items'>) {
      const sql = r.db.sqlite;
      const where = ['p.deleted_at IS NULL'];
      const params: unknown[] = [];
      if (input.project) {
        where.push('i.project_key = ?');
        params.push(input.project);
      }
      if (input.status) {
        where.push(`i.status IN (${input.status.map(() => '?').join(', ')})`);
        params.push(...input.status);
      }
      if (input.type) {
        where.push(`i.type IN (${input.type.map(() => '?').join(', ')})`);
        params.push(...input.type);
      }
      if (input.epic) {
        where.push('i.epic_id = ?');
        params.push(input.epic);
      }
      if (input.include_archived === false) where.push('i.archived_at IS NULL');
      if (input.label) {
        where.push(
          'EXISTS (SELECT 1 FROM item_labels il JOIN labels l ON l.id = il.label_id WHERE il.item_id = i.id AND l.name = ?)',
        );
        params.push(input.label);
      }
      if (input.text) {
        const q = ftsQuery(input.text);
        if (q) {
          where.push('i.id IN (SELECT id FROM search_fts WHERE search_fts MATCH ?)');
          params.push(q);
        }
      }
      switch (input.filter) {
        case 'ready_to_start':
          where.push("i.status = 'ready'");
          break;
        case 'resumable':
          where.push(RESUMABLE_SQL('i'));
          break;
        case 'waiting_for_review':
          where.push("i.status = 'review'");
          break;
        case 'deferred_review':
          // Deferred, not verified (§5.6): a deferred item whose follow-up isn't done, or has none.
          where.push(
            `EXISTS (SELECT 1 FROM hr_items h LEFT JOIN items f ON f.id = h.follow_up_item_id
               WHERE h.item_id = i.id AND h.state = 'deferred' AND (f.id IS NULL OR f.status <> 'done'))`,
          );
          break;
      }
      const rows = sql
        .prepare(
          `SELECT i.* FROM items i JOIN projects p ON p.key = i.project_key WHERE ${where.join(' AND ')}`,
        )
        .all(...params) as ItemRow[];
      const index = new BlockIndex(r.db);
      let items = summarize({ db: r.db, windows: windows(), now: r.now, index }, rows);
      const row = new Map(rows.map((x) => [x.id, x]));

      switch (input.filter) {
        case 'ready_to_start':
          items = items.filter((s) => !s.blocked && !s.lead);
          break;
        case 'resumable':
          items = items.filter((s) => !s.lead);
          break;
        case 'blocked':
          items = items.filter((s) => s.blocked);
          break;
        case 'mine':
          items = items.filter(
            (s) =>
              s.lead !== null &&
              s.lead.client === r.actor.client &&
              (input.agent_label === undefined || s.lead.label === input.agent_label),
          );
          break;
      }

      const byPriority = (a: ItemSummary, b: ItemSummary) => a.priority - b.priority;
      items.sort(
        input.filter === 'ready_to_start'
          ? (a, b) => byPriority(a, b) || b.unblocks - a.unblocks || compareIds(a.id, b.id)
          : (a, b) =>
              byPriority(a, b) ||
              (row.get(a.id)!.updated_at < row.get(b.id)!.updated_at
                ? -1
                : row.get(a.id)!.updated_at > row.get(b.id)!.updated_at
                  ? 1
                  : 0) ||
              compareIds(a.id, b.id),
      );

      const offset = input.cursor ? decodeCursor(input.cursor) : 0;
      const limit = Math.min(input.limit ?? LIMITS.page_default, LIMITS.page_max);
      const page = items.slice(offset, offset + limit);
      const fields = input.fields;
      return {
        items: page.map((s): ItemSummaryView =>
          fields
            ? (Object.fromEntries(
                Object.entries(s).filter(
                  ([k]) => k === 'id' || k === 'version' || fields.includes(k as never),
                ),
              ) as ItemSummaryView)
            : s,
        ),
        next_cursor: offset + limit < items.length ? encodeCursor(offset + limit) : null,
      };
    },

    getChanges(r, input) {
      const sql = r.db.sqlite;
      const latest = (
        sql.prepare('SELECT coalesce(max(seq), 0) AS m FROM events').get() as { m: number }
      ).m;
      if (input.cursor === undefined) return { events: [], next_cursor: String(latest) };
      if (!/^\d+$/.test(input.cursor)) {
        throw new ToolError(
          'validation',
          'That cursor is not valid. Pass next_cursor from get_changes, or leave it out to get the latest.',
          { details: { fields: { cursor: 'not a change cursor' } } },
        );
      }
      const from = Number(input.cursor);
      const limit = Math.min(input.limit ?? LIMITS.changes_default, LIMITS.changes_max);
      const where = ['e.seq > ?', 'e.seq <= ?'];
      const params: unknown[] = [from, latest];
      if (input.project) {
        where.push('e.project_key = ?');
        params.push(input.project);
      }
      if (input.item_id) {
        where.push('e.item_id = ?');
        params.push(input.item_id);
      }
      if (input.types) {
        where.push(`e.type IN (${input.types.map(() => '?').join(', ')})`);
        params.push(...input.types);
      }
      const rows = sql
        .prepare(
          `SELECT ${EVENT_COLUMNS} FROM ${EVENT_FROM} WHERE ${where.join(' AND ')} ORDER BY e.seq LIMIT ?`,
        )
        .all(...params, limit) as StoredEvent[];
      // A full page continues after its last row; a short one has scanned everything up to `latest`.
      const next = rows.length === limit ? rows[rows.length - 1]!.seq : Math.max(from, latest);
      return { events: rows.map(eventRow), next_cursor: String(next) };
    },

    palette: notImplemented('search.palette'),
  };
}
