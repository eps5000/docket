/**
 * The host collector and the optional GitHub connection (owner decision 49;
 * BUILD_SPEC §5.35). Docket stores no GitHub token: `tools/docket-sync` reads
 * through the `gh` login on the host and posts here.
 *
 * - `GET /api/sync/:source`: the source's settings and status.
 * - `POST /api/sync/:source`: a batch of records, each idempotent by `key`,
 *   and how the run went.
 * - `/api/settings/github`: Settings → Connections → GitHub.
 * - `GET /api/items/:id/github`: the ticket's GitHub panel.
 */
import { z } from 'zod';
import { hasControlChars } from '../install.js';
import { projectKey } from '../mcp/common.js';
import { input, jsonResponse, noInput, ownerMutationOutput } from './common.js';
import { itemParams } from './read.js';
import { json, route } from './route.js';

/** Records in one POST. The runner sends 200. */
export const SYNC_RECORDS_MAX = 500;
/** A POST's body, enforced while it is read. */
export const SYNC_BODY_MAX_BYTES = 2 * 1024 * 1024;

export const BRANCH_RULES = ['off', 'warn'] as const;
export type BranchRule = (typeof BRANCH_RULES)[number];
export const DEFAULT_BRANCH_RULE: BranchRule = 'warn';
export const DEFAULT_BRANCH_EXEMPT = ['mergify/*', 'main', '*docket-agent-files*'] as const;

export const GITHUB_STATES = [
  'off',
  'no_repos',
  'helper_not_running',
  'gh_missing',
  'gh_signed_out',
  'rate_limited',
  'network',
  'error',
  'connected',
] as const;
export type GithubState = (typeof GITHUB_STATES)[number];

const sourceName = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, {
  error: 'A source name is lower-case letters, digits and hyphens.',
});
const errorCode = z.string().regex(/^[a-z0-9_]{1,40}$/, { error: 'Expected a short error code.' });

export const syncParams = input({ source: sourceName });

/** The run this batch belongs to. `partial`: more batches follow, so it isn't finished yet. */
export const syncRunSchema = z.strictObject({
  ok: z.boolean(),
  partial: z.boolean().optional(),
  error: errorCode.optional(),
  interval_ms: z.number().int().min(1000).max(86_400_000),
});

/** Each source checks its own fields; here, only that every record has a key. */
export const syncIngestBody = input({
  records: z
    .array(z.looseObject({ key: z.string().min(1).max(300) }))
    .max(SYNC_RECORDS_MAX, { error: `At most ${SYNC_RECORDS_MAX} records in one batch.` }),
  run: syncRunSchema,
});
export type SyncIngestBody = z.infer<typeof syncIngestBody>;

export const syncIngestResponse = jsonResponse({
  accepted: z.number().int(),
  changed: z.number().int(),
  ignored: z.number().int(),
});
export type SyncIngestResponse = z.infer<typeof syncIngestResponse>;

export const syncSourceResponse = jsonResponse({
  name: z.string(),
  /** What `enabled(settings)` and `collect` receive. Each source defines its own. */
  settings: z.record(z.string(), z.unknown()),
  status: z.object({
    last_report_at: z.string().nullable(),
    last_success_at: z.string().nullable(),
    last_error: z.string().nullable(),
    interval_ms: z.number().int().nullable(),
    records_total: z.number().int(),
    /** No successful run for three intervals (at least 15 minutes). */
    stale: z.boolean(),
  }),
});
export type SyncSourceResponse = z.infer<typeof syncSourceResponse>;

// ---- The GitHub record, as the source posts it ----

const repoName = z
  .string()
  .max(140)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, { error: 'Use owner/name.' })
  .refine((v) => !v.split('/').some((part) => part === '.' || part === '..'), {
    error: 'Use owner/name.',
  });
const isoTime = z.iso.datetime({ offset: true });

export const githubPrRecord = z.strictObject({
  key: z.string().max(300),
  kind: z.literal('pr'),
  repo: repoName,
  number: z.number().int().min(1),
  title: z.string().max(300),
  head_branch: z.string().max(255),
  state: z.enum(['open', 'closed', 'merged']),
  draft: z.boolean(),
  head_sha: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/i)
    .nullable(),
  merged_at: isoTime.nullable(),
  ci: z.enum(['passed', 'failed', 'pending', 'none']),
  opened_at: isoTime,
  remote_updated_at: isoTime,
  related_keys: z.array(z.string().max(30)).max(40),
});
export type GithubPrRecord = z.infer<typeof githubPrRecord>;

/** One repository's result in this run: the others still sync when one fails. */
export const githubRepoRecord = z.strictObject({
  key: z.string().max(300),
  kind: z.literal('repo'),
  repo: repoName,
  ok: z.boolean(),
  error: errorCode.nullable(),
  at: isoTime,
});
export type GithubRepoRecord = z.infer<typeof githubRepoRecord>;

export const githubRecord = z.discriminatedUnion('kind', [githubPrRecord, githubRepoRecord]);
export type GithubRecord = z.infer<typeof githubRecord>;

// ---- The worktrees source (B68) ----

/** An absolute local path. Never a UNC or device path, and never a control character. */
const hostPath = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^(?:[A-Za-z]:[\\/]|\/(?!\/))/, { error: 'Expected an absolute local path.' })
  .refine((v) => !hasControlChars(v), { error: 'Expected an absolute local path.' });
const hostScanId = z.string().regex(/^[a-z0-9-]{1,40}$/);
const hostCount = z.number().int().min(0).max(1_000_000);

/** What the helper could tell about one worktree. Anything but `ok` is Unknown. */
export const HOST_TREE_READS = ['ok', 'missing', 'timed_out', 'unreadable'] as const;

/** One worktree. Strict, so a file name or anything else unexpected is refused. */
export const hostTreeRecord = z.strictObject({
  key: z.string().max(300),
  kind: z.literal('tree'),
  project: projectKey,
  scan_id: hostScanId,
  path: hostPath,
  branch: z.string().min(1).max(255).nullable(),
  head: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/i)
    .nullable(),
  is_main: z.boolean(),
  locked: z.boolean(),
  read: z.enum(HOST_TREE_READS),
  uncommitted_files: hostCount.nullable(),
  unpushed_commits: hostCount.nullable(),
  merged: z.boolean().nullable(),
  last_git_at: isoTime.nullable(),
});
export type HostTreeRecord = z.infer<typeof hostTreeRecord>;

/** Closes one project's scan. `complete`: every worktree git listed was attempted and sent. */
export const hostScanRecord = z.strictObject({
  key: z.string().max(300),
  kind: z.literal('scan'),
  project: projectKey,
  scan_id: hostScanId,
  repo_path: z.string().min(1).max(1024),
  main_branch: z.string().min(1).max(255),
  status: z.enum(['ok', 'unreadable']),
  complete: z.boolean(),
  tree_count: z.number().int().min(0).max(5000),
  checked_at: isoTime,
  main_path: hostPath.nullable(),
});
export type HostScanRecord = z.infer<typeof hostScanRecord>;

export const hostWorktreeRecord = z.discriminatedUnion('kind', [hostTreeRecord, hostScanRecord]);
export type HostWorktreeRecord = z.infer<typeof hostWorktreeRecord>;

/** A current, working Orca chat observed by the local host helper. No chat text is sent. */
export const orcaPresenceRecord = z.strictObject({
  key: z.string().regex(/^orca:[0-9a-f-]{36}$/i),
  session: z.uuid(),
  client: z.enum(['codex', 'claude']),
  item: z
    .string()
    .regex(/^[A-Z][A-Z0-9]*-[0-9]+$/)
    .max(40),
  path: hostPath,
  observed_at: isoTime,
});
export type OrcaPresenceRecord = z.infer<typeof orcaPresenceRecord>;

// ---- The git source (B76) ----

/**
 * Every git read Docket needs, made by the helper on the host. Strict records,
 * so anything unexpected is refused. The only file names allowed anywhere are
 * a trial merge's conflicting files (`merge-tree --name-only`), capped below.
 */
export const HOST_GIT_MAX_FILES = 50;
export const HOST_GIT_MAX_PATH = 300;
export const HOST_GIT_MAX_MATCHES = 20;
export const HOST_GIT_MAX_COMMITS = 50;

const gitBranch = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._/@+-]+$/)
  .refine((b) => !b.startsWith('-') && !b.includes('..') && !b.endsWith('.lock'));
const gitSha = z.string().regex(/^[0-9a-f]{40,64}$/i);
const conflictFiles = z
  .array(
    z
      .string()
      .min(1)
      .max(HOST_GIT_MAX_PATH)
      .refine((v) => !hasControlChars(v)),
  )
  .max(HOST_GIT_MAX_FILES);
/** `unknown`: git had no answer (timed out or cancelled), which says nothing. */
const readState = z.enum(['ok', 'missing', 'unknown']);
const mergeState = z.enum(['clean', 'conflict', 'failed', 'unknown']);
const base = {
  key: z.string().max(300),
  project: projectKey,
  pass_id: hostScanId,
};

/** Branch discovery for an item with no reported branch: the local branches naming it. */
export const hostGitItemRecord = z.strictObject({
  ...base,
  kind: z.literal('item'),
  item: z.string().min(1).max(40),
  read: z.enum(['ok', 'unknown']),
  matches: z.array(gitBranch).max(HOST_GIT_MAX_MATCHES),
});

/** One branch: where it is, whether it's on main, and its trial merge with main. */
export const hostGitBranchRecord = z.strictObject({
  ...base,
  kind: z.literal('branch'),
  name: gitBranch,
  read: readState,
  /** Which ref was found: the local branch, or origin's copy. */
  ref: z.enum(['heads', 'origin']).nullable(),
  /** Its commits are already on main. */
  merged: z.boolean().nullable(),
  main: mergeState,
  files: conflictFiles,
  /** More conflicting files than were sent. */
  more: z.boolean(),
});

/** A trial merge of two items' branches (`a` < `b`). Only pairs the helper judged related. */
export const hostGitPairRecord = z.strictObject({
  ...base,
  kind: z.literal('pair'),
  a: gitBranch,
  b: gitBranch,
  state: mergeState,
  files: conflictFiles,
  more: z.boolean(),
});

/** Commits on a branch since a time: SHAs and times only. */
export const hostGitCommitsRecord = z.strictObject({
  ...base,
  kind: z.literal('commits'),
  branch: gitBranch,
  since: isoTime,
  read: z.enum(['ok', 'unknown']),
  commits: z.array(z.strictObject({ sha: gitSha, at: isoTime })).max(HOST_GIT_MAX_COMMITS),
});

/** Where a worktree's commit stands: on main, on a remote, and how many commits are on none. */
export const hostGitHeadRecord = z.strictObject({
  ...base,
  kind: z.literal('head'),
  /** The commit as Docket asked for it, which may be abbreviated. */
  sha: z.string().regex(/^[0-9a-f]{7,64}$/i),
  /** The full commit; null when the repository doesn't have it. */
  head: gitSha.nullable(),
  read: readState,
  on_main: z.boolean().nullable(),
  on_remote: z.boolean().nullable(),
  unpushed: hostCount.nullable(),
});

/**
 * Docket's own install manifest on the main branch (owner decision 56). The
 * helper parses it on the host and sends only Docket's identifiers and hashes.
 */
export const hostGitManifestRecord = z.strictObject({
  ...base,
  kind: z.literal('manifest'),
  client: z.enum(['claude', 'codex']),
  state: z.enum(['present', 'absent', 'unknown']),
  install_id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,80}$/)
    .nullable(),
  files: z
    .array(
      z.strictObject({
        key: z
          .string()
          .regex(/^[A-Za-z0-9:._/-]{1,200}$/)
          .refine((v) => !v.includes('..')),
        version_id: z.string().regex(/^[A-Za-z0-9:._-]{1,80}$/),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .max(200),
});

/** Closes one project's pass. What it didn't reach is left out, and so stays as it was. */
export const hostGitPassRecord = z.strictObject({
  ...base,
  kind: z.literal('pass'),
  repo_path: z.string().min(1).max(1024),
  main_branch: z.string().min(1).max(255),
  status: z.enum(['ok', 'unreadable', 'unknown']),
  /** The radar's main branch: the local one, or origin's copy; null when neither exists. */
  main_ref: z.enum(['heads', 'origin']).nullable(),
  checked_at: isoTime,
  /** Every requested read was attempted. */
  complete: z.boolean(),
  /**
   * Every pair of read branches was judged, and `pairs` related pairs were
   * sent, so a pair not sent is unrelated rather than unknown.
   */
  pairs_done: z.boolean(),
  pairs: z.number().int().min(0).max(5000),
});

export const hostGitRecord = z.discriminatedUnion('kind', [
  hostGitItemRecord,
  hostGitBranchRecord,
  hostGitPairRecord,
  hostGitCommitsRecord,
  hostGitHeadRecord,
  hostGitManifestRecord,
  hostGitPassRecord,
]);
export type HostGitRecord = z.infer<typeof hostGitRecord>;
export type HostGitPassRecord = z.infer<typeof hostGitPassRecord>;
export type HostGitBranchRecord = z.infer<typeof hostGitBranchRecord>;
export type HostGitPairRecord = z.infer<typeof hostGitPairRecord>;
export type HostGitItemRecord = z.infer<typeof hostGitItemRecord>;
export type HostGitCommitsRecord = z.infer<typeof hostGitCommitsRecord>;
export type HostGitHeadRecord = z.infer<typeof hostGitHeadRecord>;
export type HostGitManifestRecord = z.infer<typeof hostGitManifestRecord>;

// ---- Settings → Connections → GitHub ----

const branchPattern = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._/*-]+$/, {
    error: 'A pattern uses letters, digits, . _ / - and * only.',
  });

const githubProjectSchema = z.object({
  key: z.string(),
  name: z.string(),
  github_repo: z.string().nullable(),
  branch_rule: z.enum(BRANCH_RULES),
  branch_exempt: z.array(z.string()),
});

export const githubSettingsResponse = jsonResponse({
  enabled: z.boolean(),
  state: z.enum(GITHUB_STATES),
  /** The last sync is too old to treat as current. */
  stale: z.boolean(),
  last_sync_at: z.string().nullable(),
  last_error: z.string().nullable(),
  repos: z.array(
    z.object({
      repo: z.string(),
      projects: z.array(z.string()),
      last_sync_at: z.string().nullable(),
      error: z.string().nullable(),
    }),
  ),
  projects: z.array(githubProjectSchema),
  default_exempt: z.array(z.string()),
});
export type GithubSettingsResponse = z.infer<typeof githubSettingsResponse>;

export const putGithubBody = input({ enabled: z.boolean() });
export const putGithubResponse = ownerMutationOutput(githubSettingsResponse.shape);

export const githubProjectParams = input({ key: projectKey });
export const putGithubProjectBody = input({
  github_repo: repoName.nullable(),
  branch_rule: z.enum(BRANCH_RULES),
  branch_exempt: z.array(branchPattern).max(20),
});
export type PutGithubProjectBody = z.infer<typeof putGithubProjectBody>;
export const putGithubProjectResponse = ownerMutationOutput(githubSettingsResponse.shape);

// ---- The ticket's GitHub panel ----

const itemPrSchema = z.object({
  repo: z.string(),
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  branch: z.string(),
  branch_url: z.string(),
  state: z.enum(['open', 'closed', 'merged']),
  draft: z.boolean(),
  ci: z.enum(['passed', 'failed', 'pending', 'none']),
  checks_url: z.string(),
  merged_at: z.string().nullable(),
  /** The run active on this ticket when the PR was opened, when one is known. */
  run_id: z.string().nullable(),
});
export type ItemPr = z.infer<typeof itemPrSchema>;

export const itemGithubResponse = jsonResponse({
  enabled: z.boolean(),
  state: z.enum(GITHUB_STATES),
  stale: z.boolean(),
  last_sync_at: z.string().nullable(),
  /** The PR whose head branch names this ticket. */
  primary: z.array(itemPrSchema),
  /** PRs that only mention it in their title or body, or a branch naming several tickets. */
  related: z.array(itemPrSchema),
  /** Reported branches that don't name this ticket, under a project's Warn rule. */
  naming: z.object({ suggested: z.string(), unnamed: z.array(z.string()) }).nullable(),
});
export type ItemGithubResponse = z.infer<typeof itemGithubResponse>;

export const syncRoutes = {
  'sync.source': route({
    method: 'GET',
    path: '/api/sync/:source',
    group: 'settings',
    params: syncParams,
    query: noInput,
    body: null,
    response: json(syncSourceResponse),
  }),
  /** From the host collector: local, behind the owner guards, size-capped. */
  'sync.ingest': route({
    method: 'POST',
    path: '/api/sync/:source',
    group: 'settings',
    params: syncParams,
    query: noInput,
    body: syncIngestBody,
    response: json(syncIngestResponse),
  }),
  'github.get': route({
    method: 'GET',
    path: '/api/settings/github',
    group: 'settings',
    params: noInput,
    query: noInput,
    body: null,
    response: json(githubSettingsResponse),
  }),
  'github.set': route({
    method: 'PUT',
    path: '/api/settings/github',
    group: 'settings',
    params: noInput,
    query: noInput,
    body: putGithubBody,
    response: json(putGithubResponse),
  }),
  'github.setProject': route({
    method: 'PUT',
    path: '/api/settings/github/projects/:key',
    group: 'settings',
    params: githubProjectParams,
    query: noInput,
    body: putGithubProjectBody,
    response: json(putGithubProjectResponse),
  }),
  'items.github': route({
    method: 'GET',
    path: '/api/items/:id/github',
    group: 'read',
    params: itemParams,
    query: noInput,
    body: null,
    response: json(itemGithubResponse),
  }),
} as const;
