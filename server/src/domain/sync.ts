/**
 * The host collector's ingest, and the optional GitHub connection (owner
 * decision 49; BUILD_SPEC §5.35).
 *
 * - Docket stores no GitHub token and calls nothing outside itself.
 *   `tools/docket-sync` reads through the host's `gh` login and posts here.
 * - **A new source** adds one entry to `HANDLERS`: its settings, how to check a
 *   record, and how to store it. Records are idempotent by `key`: the same
 *   batch twice changes nothing and records no event.
 * - **Primary or related.** A PR is primary on a ticket only when its head branch
 *   names that one ticket, as a whole key. A key in its title or body, or a
 *   branch naming several tickets, is only ever related.
 * - Status is bookkeeping (`sync_sources`), so a quiet poll adds no event.
 */
import {
  DEFAULT_BRANCH_EXEMPT,
  ToolError,
  findSecret,
  githubRecord,
  hostGitRecord,
  hostWorktreeRecord,
  orcaPresenceRecord,
  type GithubPrRecord,
  type GithubRecord,
  type GithubRepoRecord,
  type GithubSettingsResponse,
  type GithubState,
  type HostGitRecord,
  type HostWorktreeRecord,
  type OrcaPresenceRecord,
  type ItemGithubResponse,
  type ItemPr,
  type PutGithubProjectBody,
  type SyncIngestBody,
  type SyncIngestResponse,
  type SyncSourceResponse,
} from '@docket/shared';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import type { ReadContext, ServiceDeps } from './contracts.js';
import { keysInBranch, suggestedBranch } from './git-naming.js';
import { applyHostGitRecords } from './host-git.js';
import { applyHostRecords, hostProjects, hostRepoPath } from './host-worktrees.js';
import { manifestRequest } from './install-main.js';
import { activityRequest } from './run-activity.js';
import { headRequest } from './worktree-check.js';
import { requireItem } from './model.js';
import { branchLacksKey, projectGit } from './project-git.js';
import { radarRequest, reportedBranches } from './radar.js';
import { SYSTEM_ACTOR, type WriteContext, type WritePath } from './write.js';

const GITHUB_SETTING = 'github_connection';
const STALE_MIN_MS = 15 * 60_000;
const STALE_INTERVALS = 3;
const TITLE_WITHHELD = 'Title withheld: it looks like it contains a secret';
const BRANCH_WITHHELD = 'withheld';
/** B76: a conflicting file whose name looks like a secret. */
const FILE_WITHHELD = '(a file name withheld: it looks like it contains a secret)';
const MAX_EVENT_OBJECTS = 50;

export interface SyncService {
  source(r: ReadContext, name: string): SyncSourceResponse;
  ingest(write: WritePath, name: string, body: SyncIngestBody): SyncIngestResponse;
  github(r: ReadContext): GithubSettingsResponse;
  setGithub(w: WriteContext, input: { enabled: boolean }): GithubSettingsResponse;
  setGithubProject(
    w: WriteContext,
    input: PutGithubProjectBody & { key: string },
  ): GithubSettingsResponse;
  itemGithub(r: ReadContext, id: string): ItemGithubResponse;
}

interface IngestCounts {
  accepted: number;
  changed: number;
  ignored: number;
}

/** What one source needs on this side. */
interface SyncHandler<R> {
  settings(db: Db, config: Config, now: string): Record<string, unknown>;
  /** The valid records, with secret-looking text withheld. Invalid ones are counted as ignored. */
  clean(records: readonly unknown[], known: readonly string[]): { records: R[]; dropped: number };
  ingest(w: WriteContext, records: readonly R[], config: Config): IngestCounts;
  /** Facts to keep beside the status, merged over what's there. */
  detail?(
    db: Db,
    records: readonly R[],
    previous: Record<string, unknown>,
    now: string,
  ): Record<string, unknown>;
}

// ---- Status ----

interface SourceRow {
  name: string;
  interval_ms: number | null;
  last_report_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  records_total: number;
  detail: string | null;
}

const sourceRow = (db: Db, name: string) =>
  db.sqlite.prepare('SELECT * FROM sync_sources WHERE name = ?').get(name) as SourceRow | undefined;

const staleAfter = (row: SourceRow | undefined) =>
  Math.max(STALE_MIN_MS, (row?.interval_ms ?? 0) * STALE_INTERVALS);

const olderThan = (at: string | null | undefined, ms: number, now: number) =>
  !at || now - Date.parse(at) > ms;

const parseDetail = (row: SourceRow | undefined): Record<string, unknown> => {
  if (!row?.detail) return {};
  try {
    const parsed = JSON.parse(row.detail) as unknown;
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

function report(
  db: Db,
  name: string,
  run: SyncIngestBody['run'],
  accepted: number,
  detail: Record<string, unknown> | null,
  now: string,
): void {
  const before = sourceRow(db, name);
  const finished = run.ok && !run.partial;
  const failed = !run.ok && !run.partial;
  db.sqlite
    .prepare(
      `INSERT INTO sync_sources
         (name, interval_ms, last_report_at, last_success_at, last_error, records_total, detail, created_at, updated_at)
       VALUES (@name, @interval, @now, @success, @error, @accepted, @detail, @now, @now)
       ON CONFLICT(name) DO UPDATE SET
         interval_ms = @interval, last_report_at = @now, last_success_at = @success,
         last_error = @error, records_total = records_total + @accepted, detail = @detail,
         updated_at = @now`,
    )
    .run({
      name,
      interval: run.interval_ms,
      now,
      success: finished ? now : (before?.last_success_at ?? null),
      error: finished ? null : failed ? (run.error ?? 'error') : (before?.last_error ?? null),
      accepted,
      detail: detail ? JSON.stringify(detail) : (before?.detail ?? null),
    });
}

// ---- GitHub: settings ----

const githubEnabled = (db: Db): boolean => {
  const row = db.sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(GITHUB_SETTING) as
    { value: string | null } | undefined;
  if (!row?.value) return false;
  try {
    return (JSON.parse(row.value) as { enabled?: unknown }).enabled === true;
  } catch {
    return false;
  }
};

interface ConnectedRepo {
  repo: string;
  projects: string[];
}

/** Each repository set on a live project, once, ignoring case. */
function connectedRepos(db: Db): ConnectedRepo[] {
  const rows = db.sqlite
    .prepare(
      `SELECT g.project_key, g.github_repo FROM project_git g
       JOIN projects p ON p.key = g.project_key
       WHERE p.deleted_at IS NULL AND g.github_repo IS NOT NULL
       ORDER BY g.project_key`,
    )
    .all() as { project_key: string; github_repo: string }[];
  const byName = new Map<string, ConnectedRepo>();
  for (const row of rows) {
    const key = row.github_repo.toLowerCase();
    const entry = byName.get(key) ?? { repo: row.github_repo, projects: [] };
    entry.projects.push(row.project_key);
    byName.set(key, entry);
  }
  return [...byName.values()];
}

const GH_ERROR_STATES: Record<string, GithubState> = {
  gh_missing: 'gh_missing',
  gh_signed_out: 'gh_signed_out',
  rate_limited: 'rate_limited',
  network: 'network',
};

interface GithubStatus {
  enabled: boolean;
  state: GithubState;
  stale: boolean;
  last_sync_at: string | null;
  last_error: string | null;
}

function githubStatus(db: Db, nowIso: string): GithubStatus {
  const enabled = githubEnabled(db);
  const row = sourceRow(db, 'github');
  const now = Date.parse(nowIso);
  const limit = staleAfter(row);
  const last_sync_at = row?.last_success_at ?? null;
  const last_error = row?.last_error ?? null;
  const base = {
    enabled,
    last_sync_at,
    last_error,
    // Data this old is labeled everywhere it shows, whatever the reason.
    stale: last_sync_at !== null && olderThan(last_sync_at, limit, now),
  };
  if (!enabled) return { ...base, state: 'off', stale: false };
  if (connectedRepos(db).length === 0) return { ...base, state: 'no_repos' };
  if (olderThan(row?.last_report_at, limit, now)) return { ...base, state: 'helper_not_running' };
  if (last_error) return { ...base, state: GH_ERROR_STATES[last_error] ?? 'error' };
  return { ...base, state: last_sync_at ? 'connected' : 'helper_not_running' };
}

function githubSettings(db: Db, now: string): GithubSettingsResponse {
  const status = githubStatus(db, now);
  const detail = parseDetail(sourceRow(db, 'github')).repos as
    Record<string, { last_sync_at?: string | null; error?: string | null }> | undefined;
  const repos = connectedRepos(db).map((r) => {
    const facts = detail?.[r.repo.toLowerCase()];
    return {
      repo: r.repo,
      projects: r.projects,
      last_sync_at: facts?.last_sync_at ?? null,
      error: facts?.error ?? null,
    };
  });
  const projects = (
    db.sqlite
      .prepare('SELECT key, name FROM projects WHERE deleted_at IS NULL ORDER BY key')
      .all() as { key: string; name: string }[]
  ).map((p) => ({ key: p.key, name: p.name, ...projectGit(db, p.key) }));
  return { ...status, repos, projects, default_exempt: [...DEFAULT_BRANCH_EXEMPT] };
}

// ---- GitHub: ingest ----

const isMergeQueuePr = (r: GithubPrRecord) =>
  /^merge queue:/i.test(r.title) || /^mergify\/merge-queue\//i.test(r.head_branch);

interface KeyTarget {
  id: string;
  project: string;
}

/** Every ticket's ID and imported Jira key in these projects, upper-cased. */
function keyIndex(db: Db, projects: readonly string[]): Map<string, KeyTarget> {
  const index = new Map<string, KeyTarget>();
  if (projects.length === 0) return index;
  const rows = db.sqlite
    .prepare(
      `SELECT id, jira_key, project_key FROM items WHERE project_key IN (${projects.map(() => '?').join(', ')})`,
    )
    .all(...projects) as { id: string; jira_key: string | null; project_key: string }[];
  for (const row of rows) {
    if (row.jira_key) {
      index.set(row.jira_key.toUpperCase(), { id: row.id, project: row.project_key });
    }
  }
  // Set last, so an item's own ID wins over another item's Jira key.
  for (const row of rows) {
    index.set(row.id.toUpperCase(), { id: row.id, project: row.project_key });
  }
  return index;
}

/** The run on this ticket with this branch, or else the lead active when the PR opened. */
function runFor(db: Db, itemId: string, branch: string, openedAt: string): string | null {
  const byBranch = db.sqlite
    .prepare(
      `SELECT id FROM runs WHERE item_id = ? AND is_lead = 1
         AND json_extract(workspace, '$.branch') = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(itemId, branch) as { id: string } | undefined;
  if (byBranch) return byBranch.id;
  const byTime = db.sqlite
    .prepare(
      `SELECT id FROM runs WHERE item_id = @item AND is_lead = 1 AND created_at <= @at
         AND (state IN ('open', 'needs_input', 'parked') OR last_signal_at >= @at)
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get({ item: itemId, at: openedAt }) as { id: string } | undefined;
  return byTime?.id ?? null;
}

/** Which tickets this PR belongs to. At most one is primary. */
export function linksFor(
  record: Pick<GithubPrRecord, 'head_branch' | 'related_keys'>,
  lookup: (key: string) => string | undefined,
): { primary: string | null; related: string[] } {
  const inBranch = [...new Set(keysInBranch(record.head_branch).flatMap((k) => lookup(k) ?? []))];
  const primary = inBranch.length === 1 ? inBranch[0]! : null;
  const related = new Set([
    ...(primary ? [] : inBranch),
    ...record.related_keys.flatMap((k) => lookup(k.toUpperCase()) ?? []),
  ]);
  if (primary) related.delete(primary);
  return { primary, related: [...related].sort() };
}

const PR_FIELDS = [
  'title',
  'head_branch',
  'state',
  'draft',
  'head_sha',
  'merged_at',
  'ci',
  'opened_at',
  'remote_updated_at',
] as const;

function storePr(w: WriteContext, id: string, record: GithubPrRecord): boolean {
  const before = w.get('github_prs', id);
  const fields = Object.fromEntries(PR_FIELDS.map((f) => [f, record[f]]));
  if (!before) {
    w.insert('github_prs', { id, repo: record.repo, number: record.number, ...fields });
    return true;
  }
  const changed = PR_FIELDS.filter((f) => {
    const old = f === 'draft' ? Boolean(before[f]) : before[f];
    return old !== record[f];
  });
  if (changed.length === 0) return false;
  w.update('github_prs', id, Object.fromEntries(changed.map((f) => [f, record[f]])));
  return true;
}

function storeLinks(
  w: WriteContext,
  prId: string,
  record: GithubPrRecord,
  wanted: { primary: string | null; related: string[] },
  touched: Set<string>,
): boolean {
  const existing = w.db.sqlite
    .prepare('SELECT id, item_id, kind FROM github_pr_links WHERE pr_id = ?')
    .all(prId) as { id: string; item_id: string; kind: 'primary' | 'related' }[];
  const next = new Map<string, 'primary' | 'related'>(wanted.related.map((id) => [id, 'related']));
  if (wanted.primary) next.set(wanted.primary, 'primary');
  let changed = false;
  for (const link of existing) {
    const kind = next.get(link.item_id);
    if (!kind) {
      w.remove('github_pr_links', link.id);
    } else if (kind !== link.kind) {
      w.update('github_pr_links', link.id, { kind });
    } else {
      next.delete(link.item_id);
      continue;
    }
    next.delete(link.item_id);
    touched.add(link.item_id);
    changed = true;
  }
  for (const [itemId, kind] of next) {
    w.insert('github_pr_links', {
      id: `${prId}|${itemId}`,
      pr_id: prId,
      item_id: itemId,
      kind,
      run_id: runFor(w.db, itemId, record.head_branch, record.opened_at),
    });
    touched.add(itemId);
    changed = true;
  }
  return changed;
}

const githubHandler: SyncHandler<GithubRecord> = {
  settings(db) {
    return {
      enabled: githubEnabled(db),
      repos: connectedRepos(db).map((r) => ({ repo: r.repo, projects: r.projects })),
    };
  },

  clean(raw, known) {
    const records: GithubRecord[] = [];
    let dropped = 0;
    for (const entry of raw) {
      const parsed = githubRecord.safeParse(entry);
      if (!parsed.success) {
        dropped += 1;
        continue;
      }
      const record = parsed.data;
      if (record.kind === 'repo') {
        if (record.key === `repo:${record.repo}`) records.push(record);
        else dropped += 1;
        continue;
      }
      if (record.key !== `${record.repo}#${record.number}` || isMergeQueuePr(record)) {
        dropped += 1;
        continue;
      }
      records.push({
        ...record,
        title: findSecret(record.title, { known }) ? TITLE_WITHHELD : record.title,
        head_branch: findSecret(record.head_branch, { known })
          ? BRANCH_WITHHELD
          : record.head_branch,
        related_keys: record.related_keys.filter((k) => !findSecret(k, { known })),
      });
    }
    return { records, dropped };
  },

  ingest(w, records) {
    const counts: IngestCounts = { accepted: 0, changed: 0, ignored: 0 };
    const prs = records.filter((r): r is GithubPrRecord => r.kind === 'pr');
    if (!githubEnabled(w.db)) return { ...counts, ignored: prs.length };
    const repos = new Map(connectedRepos(w.db).map((r) => [r.repo.toLowerCase(), r]));
    const index = keyIndex(w.db, [...new Set([...repos.values()].flatMap((r) => r.projects))]);
    const touched = new Set<string>();
    for (const record of prs) {
      const connected = repos.get(record.repo.toLowerCase());
      if (!connected) {
        counts.ignored += 1;
        continue;
      }
      counts.accepted += 1;
      // One row per PR, however the repository's name was cased.
      const prId = `${connected.repo}#${record.number}`;
      const canonical = { ...record, repo: connected.repo };
      const lookup = (key: string) => {
        const target = index.get(key);
        return target && connected.projects.includes(target.project) ? target.id : undefined;
      };
      const prChanged = storePr(w, prId, canonical);
      const linksChanged = storeLinks(w, prId, canonical, linksFor(record, lookup), touched);
      if (prChanged || linksChanged) counts.changed += 1;
      if (prChanged) {
        for (const row of w.db.sqlite
          .prepare('SELECT item_id FROM github_pr_links WHERE pr_id = ?')
          .all(prId) as { item_id: string }[]) {
          touched.add(row.item_id);
        }
      }
    }
    if (counts.changed > 0) {
      w.event({
        type: 'sync.ingested',
        summary: `GitHub sync: ${counts.changed} pull request${counts.changed === 1 ? '' : 's'} changed`,
        data: { source: 'github', changed: counts.changed, ignored: counts.ignored },
        // Too many to name: no objects, so open screens refresh every ticket's panel.
        objects:
          touched.size <= MAX_EVENT_OBJECTS
            ? [...touched].map((id) => ({ kind: 'item' as const, id }))
            : [],
      });
    }
    return counts;
  },

  detail(db, records, previous) {
    const repos = {
      ...((previous.repos ?? {}) as Record<
        string,
        { last_sync_at: string | null; error: string | null }
      >),
    };
    for (const record of records) {
      if (record.kind !== 'repo') continue;
      const r: GithubRepoRecord = record;
      const key = r.repo.toLowerCase();
      repos[key] = {
        last_sync_at: r.ok ? r.at : (repos[key]?.last_sync_at ?? null),
        error: r.ok ? null : r.error,
      };
    }
    // Only repositories a project still has, so this can't grow without bound.
    const connected = new Set(connectedRepos(db).map((r) => r.repo.toLowerCase()));
    const kept = Object.fromEntries(Object.entries(repos).filter(([k]) => connected.has(k)));
    return { ...previous, repos: kept };
  },
};

/**
 * The host helper's worktree facts (B68). They change on every pass, so they're
 * bookkeeping beside the source's status: no row changes here and no event.
 */
const worktreesHandler: SyncHandler<HostWorktreeRecord> = {
  settings(db, config) {
    const projects = hostProjects(db).flatMap((p) => {
      const host_path = hostRepoPath(config, p.repo_path);
      return host_path ? [{ ...p, host_path }] : [];
    });
    return { enabled: projects.length > 0, projects };
  },

  clean(raw, known) {
    const records: HostWorktreeRecord[] = [];
    let dropped = 0;
    for (const entry of raw) {
      const parsed = hostWorktreeRecord.safeParse(entry);
      if (!parsed.success) {
        dropped += 1;
        continue;
      }
      const record = parsed.data;
      if (record.kind === 'scan') {
        if (
          record.key !== `scan:${record.project}:${record.scan_id}` ||
          findSecret(record.repo_path, { known })
        ) {
          dropped += 1;
          continue;
        }
        const leaks = record.main_path && findSecret(record.main_path, { known });
        records.push({
          ...record,
          main_path: leaks ? null : record.main_path,
          // One spelling of a time, because these are compared as text.
          checked_at: new Date(record.checked_at).toISOString(),
        });
        continue;
      }
      // A path is the row's identity, so it's left out rather than altered. Its scan then
      // has fewer rows than it says, which makes it partial, so nothing is removed.
      if (
        !record.key.startsWith(`tree:${record.project}:${record.scan_id}:`) ||
        findSecret(record.path, { known })
      ) {
        dropped += 1;
        continue;
      }
      records.push({
        ...record,
        branch:
          record.branch && findSecret(record.branch, { known }) ? BRANCH_WITHHELD : record.branch,
        last_git_at: record.last_git_at ? new Date(record.last_git_at).toISOString() : null,
      });
    }
    return { records, dropped };
  },

  ingest: (_w, records) => ({ accepted: records.length, changed: 0, ignored: 0 }),

  detail: (db, records, previous, now) =>
    applyHostRecords(previous, records, hostProjects(db), now),
};

/**
 * B76: every git read Docket needs, made by the helper on the host. The
 * settings say what to read; the facts are bookkeeping beside the source's
 * status, like the worktree facts. A record naming a secret-looking branch is
 * left out (so that read stays unknown), and a secret-looking conflicting file
 * is withheld by name, so the count stays true.
 */
const gitHandler: SyncHandler<HostGitRecord> = {
  settings(db, config, now) {
    const commits = activityRequest(db, config, now);
    const projects = hostProjects(db).flatMap((p) => {
      const host_path = hostRepoPath(config, p.repo_path);
      if (!host_path) return [];
      return [
        {
          ...p,
          host_path,
          items: radarRequest(db, p.key, now),
          commits: commits.get(p.key) ?? [],
          heads: headRequest(db, p.key, now),
          manifests: manifestRequest(),
        },
      ];
    });
    return { enabled: projects.length > 0, projects };
  },

  clean(raw, known) {
    const records: HostGitRecord[] = [];
    let dropped = 0;
    const leaks = (s: string | null | undefined) => !!s && !!findSecret(s, { known });
    const withheld = (files: string[]) => files.map((f) => (leaks(f) ? FILE_WITHHELD : f));
    for (const entry of raw) {
      const parsed = hostGitRecord.safeParse(entry);
      if (
        !parsed.success ||
        !parsed.data.key.startsWith(
          `${parsed.data.kind}:${parsed.data.project}:${parsed.data.pass_id}`,
        )
      ) {
        dropped += 1;
        continue;
      }
      const r = parsed.data;
      switch (r.kind) {
        case 'pass':
          if (leaks(r.repo_path)) {
            dropped += 1;
            continue;
          }
          records.push({ ...r, checked_at: new Date(r.checked_at).toISOString() });
          break;
        case 'branch':
          if (leaks(r.name)) dropped += 1;
          else records.push({ ...r, files: withheld(r.files) });
          break;
        case 'pair':
          if (leaks(r.a) || leaks(r.b)) dropped += 1;
          else records.push({ ...r, files: withheld(r.files) });
          break;
        case 'item':
          // Leaving one match out would change what discovery decides, so the item stays unknown.
          if (r.matches.some(leaks)) dropped += 1;
          else records.push(r);
          break;
        case 'commits':
          if (leaks(r.branch)) dropped += 1;
          else {
            records.push({
              ...r,
              since: new Date(r.since).toISOString(),
              commits: r.commits.map((c) => ({ ...c, at: new Date(c.at).toISOString() })),
            });
          }
          break;
        default:
          records.push(r);
      }
    }
    return { records, dropped };
  },

  ingest: (_w, records) => ({ accepted: records.length, changed: 0, ignored: 0 }),

  detail: (db, records, previous, now) =>
    applyHostGitRecords(previous, records, hostProjects(db), now),
};

const normalizedHostPath = (path: string) =>
  path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** Host-observed work is presence, separate from the agent's own MCP report. */
const orcaPresenceHandler: SyncHandler<OrcaPresenceRecord> = {
  settings() {
    return { enabled: true };
  },

  clean(raw, known) {
    const records: OrcaPresenceRecord[] = [];
    let dropped = 0;
    for (const value of raw) {
      const parsed = orcaPresenceRecord.safeParse(value);
      if (
        !parsed.success ||
        parsed.data.key !== `orca:${parsed.data.session.toLowerCase()}` ||
        findSecret(parsed.data.path, { known })
      ) {
        dropped += 1;
        continue;
      }
      records.push(parsed.data);
    }
    return { records, dropped };
  },

  ingest(w, records, config) {
    const current = w.db.sqlite
      .prepare(
        `SELECT r.id, r.item_id, r.client, r.workspace, r.orca_presence_at,
              r.last_signal_at, r.last_signal_kind, r.lease_expires_at, i.project_key
       FROM runs r JOIN items i ON i.id = r.item_id
       WHERE r.state = 'open' AND r.is_lead = 1`,
      )
      .all() as {
      id: string;
      item_id: string;
      client: string;
      workspace: string | null;
      orca_presence_at: string | null;
      last_signal_at: string;
      last_signal_kind: string;
      lease_expires_at: string | null;
      project_key: string;
    }[];
    const eligible = new Map<string, typeof current>();
    for (const run of current) {
      if (run.lease_expires_at && Date.parse(run.lease_expires_at) <= Date.parse(w.now)) continue;
      let path: unknown;
      try {
        path = JSON.parse(run.workspace ?? 'null')?.path;
      } catch {
        continue;
      }
      if (typeof path !== 'string') continue;
      const key = `${run.item_id.toUpperCase()}|${run.client}|${normalizedHostPath(path)}`;
      eligible.set(key, [...(eligible.get(key) ?? []), run]);
    }
    const byRun = new Map<string, OrcaPresenceRecord[]>();
    let ignored = 0;
    for (const record of records) {
      const observed = Date.parse(record.observed_at);
      if (observed < Date.parse(w.now) - 90_000 || observed > Date.parse(w.now) + 5_000) {
        ignored += 1;
        continue;
      }
      const matches = eligible.get(
        `${record.item}|${record.client}|${normalizedHostPath(record.path)}`,
      );
      if (matches?.length !== 1) {
        ignored += 1;
        continue;
      }
      const run = matches[0]!;
      byRun.set(run.id, [...(byRun.get(run.id) ?? []), record]);
    }
    let changed = 0;
    const update = w.db.sqlite.prepare(
      `UPDATE runs SET orca_presence_at = ?,
         lease_expires_at = CASE WHEN lease_expires_at < ? THEN ? ELSE lease_expires_at END
       WHERE id = ? AND state = 'open'`,
    );
    for (const run of current) {
      const matches = byRun.get(run.id);
      if (matches?.length !== 1) {
        ignored += matches?.length ?? 0;
        continue;
      }
      const wasLive =
        (run.orca_presence_at !== null &&
          Date.parse(w.now) - Date.parse(run.orca_presence_at) <= 120_000) ||
        (run.last_signal_kind === 'session' &&
          Date.parse(w.now) - Date.parse(run.last_signal_at) <= 120_000);
      const renewed = new Date(Date.parse(w.now) + config.leaseMs).toISOString();
      update.run(w.now, renewed, renewed, run.id);
      if (!wasLive) {
        changed += 1;
        w.event({
          type: 'run.status_updated',
          summary: `${run.item_id} agent is working in Orca`,
          item_id: run.item_id,
          project_key: run.project_key,
          data: { run_id: run.id, source: 'orca-presence' },
          objects: [{ kind: 'run', id: run.id }],
        });
      }
    }
    return { accepted: records.length, changed, ignored };
  },
};

/** One entry per source in `tools/docket-sync/sources/`. */
const HANDLERS: Record<string, SyncHandler<never>> = {
  github: githubHandler as unknown as SyncHandler<never>,
  worktrees: worktreesHandler as unknown as SyncHandler<never>,
  git: gitHandler as unknown as SyncHandler<never>,
  'orca-presence': orcaPresenceHandler as unknown as SyncHandler<never>,
};

const handlerOf = (name: string) => {
  const handler = Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : undefined;
  if (!handler) throw new ToolError('not_found', `No sync source ${name}.`);
  return handler;
};

// ---- Merged counts on Overview ----

export interface SyncedMerges {
  /** Each synced merge in scope: the PR's URL key and when it merged. */
  rows: { key: string; at: string }[];
  /** Tickets with a merged PR as their primary link. */
  items: Set<string>;
  /** Projects whose merges come from GitHub. */
  projects: Set<string>;
  synced_at: string;
  stale: boolean;
}

export const prUrlKey = (repo: string, number: number) =>
  `https://github.com/${repo}/pull/${number}`.toLowerCase();

/**
 * The synced merges in a scope, or null when GitHub isn't the source there: off,
 * never synced, or no project in scope has a repository. A PR whose primary
 * ticket is outside the scope belongs to that other project.
 */
export function syncedMerges(
  db: Db,
  now: string,
  inScope: (project: string) => boolean,
  items: ReadonlySet<string>,
): SyncedMerges | null {
  const status = githubStatus(db, now);
  if (!status.enabled || !status.last_sync_at) return null;
  const repos = connectedRepos(db).filter((r) => r.projects.some(inScope));
  if (repos.length === 0) return null;
  const projects = new Set(repos.flatMap((r) => r.projects).filter(inScope));
  const rows: SyncedMerges['rows'] = [];
  const linked = new Set<string>();
  const select = db.sqlite.prepare(
    'SELECT id, number, merged_at FROM github_prs WHERE repo = ? AND merged_at IS NOT NULL',
  );
  const primary = db.sqlite.prepare(
    `SELECT item_id FROM github_pr_links WHERE pr_id = ? AND kind = 'primary'`,
  );
  for (const repo of repos) {
    for (const pr of select.all(repo.repo) as { id: string; number: number; merged_at: string }[]) {
      const owner = primary.get(pr.id) as { item_id: string } | undefined;
      if (owner && !items.has(owner.item_id)) continue;
      if (owner) linked.add(owner.item_id);
      rows.push({ key: prUrlKey(repo.repo, pr.number), at: pr.merged_at });
    }
  }
  return { rows, items: linked, projects, synced_at: status.last_sync_at, stale: status.stale };
}

// ---- The service ----

const branchUrl = (repo: string, branch: string) =>
  `https://github.com/${repo}/tree/${branch.split('/').map(encodeURIComponent).join('/')}`;

export function createSyncService(deps: ServiceDeps): SyncService {
  return {
    source(r, name) {
      const handler = handlerOf(name);
      const row = sourceRow(r.db, name);
      return {
        name,
        settings: handler.settings(r.db, deps.config, r.now),
        status: {
          last_report_at: row?.last_report_at ?? null,
          last_success_at: row?.last_success_at ?? null,
          last_error: row?.last_error ?? null,
          interval_ms: row?.interval_ms ?? null,
          records_total: row?.records_total ?? 0,
          stale:
            !!row?.last_success_at &&
            olderThan(row.last_success_at, staleAfter(row), Date.parse(r.now)),
        },
      };
    },

    ingest(write, name, body) {
      const handler = handlerOf(name);
      const { records, dropped } = handler.clean(body.records, deps.secrets.known());
      const { result } = write.run(
        {
          actor: SYSTEM_ACTOR,
          operation: 'sync.ingest',
          args: { source: name, records },
        },
        (w) => handler.ingest(w, records, deps.config),
      );
      const before = parseDetail(sourceRow(write.db, name));
      const now = write.now().toISOString();
      const detail = handler.detail ? handler.detail(write.db, records, before, now) : null;
      report(write.db, name, body.run, result.accepted, detail, now);
      return { ...result, ignored: result.ignored + dropped };
    },

    github: (r) => githubSettings(r.db, r.now),

    setGithub(w, input) {
      if (githubEnabled(w.db) !== input.enabled) {
        const value = { enabled: input.enabled };
        if (w.get('settings', GITHUB_SETTING)) w.update('settings', GITHUB_SETTING, { value });
        else w.insert('settings', { key: GITHUB_SETTING, value });
        w.event({
          type: 'github.settings_changed',
          summary: `GitHub connection turned ${input.enabled ? 'on' : 'off'}`,
          data: { enabled: input.enabled },
        });
      }
      return githubSettings(w.db, w.now);
    },

    setGithubProject(w, input) {
      const project = w.db.sqlite
        .prepare('SELECT key FROM projects WHERE key = ? AND deleted_at IS NULL')
        .get(input.key);
      if (!project) throw new ToolError('not_found', `No project ${input.key}.`);
      const patterns = [...new Set(input.branch_exempt)];
      const isDefault =
        patterns.length === DEFAULT_BRANCH_EXEMPT.length &&
        DEFAULT_BRANCH_EXEMPT.every((p) => patterns.includes(p));
      const next = {
        github_repo: input.github_repo,
        branch_rule: input.branch_rule,
        branch_exempt: isDefault ? null : patterns,
      };
      const before = w.get('project_git', input.key);
      const same =
        before &&
        before.github_repo === next.github_repo &&
        before.branch_rule === next.branch_rule &&
        before.branch_exempt === (next.branch_exempt ? JSON.stringify(next.branch_exempt) : null);
      if (!same) {
        if (before) w.update('project_git', input.key, next);
        else w.insert('project_git', { project_key: input.key, ...next });
        w.event({
          type: 'github.settings_changed',
          summary: `Git settings changed for ${input.key}`,
          project_key: input.key,
          data: { repo: input.github_repo, branch_rule: input.branch_rule },
        });
      }
      return githubSettings(w.db, w.now);
    },

    itemGithub(r, id) {
      const item = requireItem(r.db, id);
      const status = githubStatus(r.db, r.now);
      const rows = r.db.sqlite
        .prepare(
          `SELECT l.kind, l.run_id, p.repo, p.number, p.title, p.head_branch, p.state, p.draft,
                  p.ci, p.merged_at
           FROM github_pr_links l JOIN github_prs p ON p.id = l.pr_id
           WHERE l.item_id = ? ORDER BY p.number DESC`,
        )
        .all(id) as (Omit<ItemPr, 'url' | 'branch' | 'branch_url' | 'checks_url' | 'draft'> & {
        kind: 'primary' | 'related';
        head_branch: string;
        draft: number;
      })[];
      const toPr = (row: (typeof rows)[number]): ItemPr => {
        const url = `https://github.com/${row.repo}/pull/${row.number}`;
        return {
          repo: row.repo,
          number: row.number,
          title: row.title,
          url,
          branch: row.head_branch,
          branch_url: branchUrl(row.repo, row.head_branch),
          state: row.state,
          draft: row.draft === 1,
          ci: row.ci,
          checks_url: `${url}/checks`,
          merged_at: row.merged_at,
          run_id: row.run_id,
        };
      };
      const git = projectGit(r.db, item.project_key);
      const unnamed = reportedBranches(r.db, id)
        .map((b) => b.name)
        .filter((name) => branchLacksKey(git, item, name));
      return {
        enabled: status.enabled,
        state: status.state,
        stale: status.stale,
        last_sync_at: status.last_sync_at,
        primary: rows.filter((row) => row.kind === 'primary').map(toPr),
        related: rows.filter((row) => row.kind === 'related').map(toPr),
        naming:
          git.branch_rule === 'warn' && unnamed.length > 0
            ? { suggested: suggestedBranch(item.id, item.title), unnamed }
            : null,
      };
    },
  };
}
