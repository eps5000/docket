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
