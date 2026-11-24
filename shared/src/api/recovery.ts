/**
 * Recovery (owner decision 26; BUILD_SPEC §5.16, §7; UI_SPEC §6.1, §6.3.2,
 * §6.6; contracts/ui-api.md US11): the Agents → Workspaces card and the
 * Problems actions, *Mark released* on an orphaned resource and *Keep for
 * later* or *Safe to discard* on unpushed work (decision 41). Shared contract
 * file (tasks.md, Slice rules).
 */
import { z } from 'zod';
import { objectId, projectKey, text } from '../mcp/common.js';
import { LIMITS } from '../mcp/limits.js';
import { resourceSchema, runStateSchema, workspaceStateSchema } from '../mcp/types.js';
import { input, jsonResponse, noInput, ownerMutationOutput, scopeSchema } from './common.js';
import { json, route } from './route.js';

// ---- GET /api/workspaces ----

export const workspacesQuery = input({
  scope: scopeSchema,
  /** One state only; the "Hide safe to prune" chip filters on the client. */
  state: workspaceStateSchema.optional(),
});

/**
 * Who an at-risk worktree is waiting on (B56), from the Problems routing
 * (decision 41): `you` when its Problem is on Needs you, `kept` after *Keep for
 * later*, `acknowledged` when you acknowledged its Problem, `agents` when a lead
 * or coordinator has it, and `unknown` when Docket can't tell.
 */
export const AT_RISK_OWNERS = ['you', 'agents', 'kept', 'acknowledged', 'unknown'] as const;
export type AtRiskOwner = (typeof AT_RISK_OWNERS)[number];

/** One recorded worktree (UI_SPEC §6.6 Workspaces), from its latest run. */
export const workspaceRowSchema = z.object({
  path: z.string(),
  state: workspaceStateSchema,
  /** Null unless `state` is `at_risk`. */
  at_risk_owner: z.enum(AT_RISK_OWNERS).nullable(),
  branch: z.string().nullable(),
  host: z.string().nullable(),
  repo: z.string().nullable(),
  item_id: z.string(),
  item_title: z.string(),
  project: z.string(),
  /** The latest run in this worktree. */
  run_id: z.string(),
  run_state: runStateSchema,
  client: z.string(),
  label: z.string().nullable(),
  head_sha: z.string().nullable(),
  pushed_sha: z.string().nullable(),
  /** Reported commits not yet pushed ("n behind"); null when it can't be told. */
  unpushed_commits: z.number().int().nullable(),
  dirty: z.boolean().nullable(),
  unreleased_resources: z.number().int(),
  last_activity_at: z.string(),
});
export type WorkspaceRow = z.infer<typeof workspaceRowSchema>;

export const workspacesResponse = jsonResponse({ rows: z.array(workspaceRowSchema) });
export type WorkspacesResponse = z.infer<typeof workspacesResponse>;

// ---- GET /api/workspaces/cleanup ----

/**
 * The plain verdict on each worktree (owner decision 48). `unknown` is never
 * safe: it covers a read that timed out and a folder Docket can't reach.
 */
export const WORKTREE_VERDICTS = [
  'holds_work',
  'in_use',
  'unknown',
  'kept_for_later',
  'safe_to_remove',
] as const;
export type WorktreeVerdict = (typeof WORKTREE_VERDICTS)[number];

/** The host helper's facts for this project (B68): `none` until it has reported. */
export const WORKTREE_HOST_STATES = ['fresh', 'stale', 'none'] as const;
export type WorktreeHostState = (typeof WORKTREE_HOST_STATES)[number];

export const worktreeCleanupQuery = input({
  project: projectKey,
  /** `1` starts a new read of the repository now. */
  refresh: z.enum(['1']).optional(),
});

/** One worktree of the project's repository, recorded by Docket or not. */
export const repoWorktreeRowSchema = z.object({
  path: z.string(),
  /** Null on a detached HEAD. */
  branch: z.string().nullable(),
  last_activity_at: z.string().nullable(),
  /** False: "Not tracked by Docket", no run ever reported this folder. */
  tracked: z.boolean(),
  item_id: z.string().nullable(),
  item_title: z.string().nullable(),
  /** Null when it couldn't be read. */
  uncommitted_files: z.number().int().nullable(),
  /** Commits on no remote and not in main. Null when it couldn't be read. */
  unpushed_commits: z.number().int().nullable(),
  merged: z.boolean().nullable(),
  verdict: z.enum(WORKTREE_VERDICTS),
  /** One plain sentence: why this verdict. */
  why: z.string(),
  /** Who it waits on, for a worktree Docket has at risk (B56). */
  owner: z.enum(AT_RISK_OWNERS).nullable(),
  /** To check and run by hand. Only ever set on `safe_to_remove`; never `--force`. */
  command: z.string().nullable(),
  /** Where this row's git facts came from: the helper on the host, or Docket's container. */
  source: z.enum(['host', 'container']),
});
export type RepoWorktreeRow = z.infer<typeof repoWorktreeRowSchema>;

export const worktreeCleanupResponse = jsonResponse({
  project: z.string(),
  main_branch: z.string(),
  /** `not_set`: no repository folder. `unreadable`: outside the push folder, or not a repository. */
  repo: z.enum(['ok', 'not_set', 'unreadable']),
  /** When git was last read; null before the first read ends. */
  checked_at: z.string().nullable(),
  /** A read in progress. */
  scanning: z.object({ done: z.number().int(), total: z.number().int() }).nullable(),
  host: z.object({ state: z.enum(WORKTREE_HOST_STATES), checked_at: z.string().nullable() }),
  rows: z.array(repoWorktreeRowSchema),
});
export type WorktreeCleanupResponse = z.infer<typeof worktreeCleanupResponse>;

// ---- POST /api/resources/:id/release ----

export const resourceParams = input({ id: objectId });
export const releaseResourceBody = input({ note: text(LIMITS.release_note).optional() });
export const releaseResourceResponse = ownerMutationOutput({ resource: resourceSchema });
export type ReleaseResourceResponse = z.infer<typeof releaseResourceResponse>;

// ---- POST /api/runs/:runId/unpushed-handled ----

export const runParams = input({ runId: objectId });
/**
 * What the owner decided about work left in a worktree (decision 41). Neither
 * commits, pushes, saves or deletes anything.
 * - `keep`: keep it for later. The worktree stays at risk, so it isn't pruned.
 * - `discard`: it's safe to lose. The worktree can count as safe to prune.
 */
export const UNPUSHED_OUTCOMES = ['keep', 'discard'] as const;
export type UnpushedOutcome = (typeof UNPUSHED_OUTCOMES)[number];
/** Without `outcome`, `discard`: what *Handled* did before decision 41. */
export const unpushedHandledBody = input({ outcome: z.enum(UNPUSHED_OUTCOMES).optional() });
export const unpushedHandledResponse = ownerMutationOutput({
  run_id: z.string(),
  unpushed_handled_at: z.string(),
  outcome: z.enum(UNPUSHED_OUTCOMES),
});
export type UnpushedHandledResponse = z.infer<typeof unpushedHandledResponse>;

export const recoveryRoutes = {
  'workspaces.list': route({
    method: 'GET',
    path: '/api/workspaces',
    group: 'recovery',
    params: noInput,
    query: workspacesQuery,
    body: null,
    response: json(workspacesResponse),
  }),
  'workspaces.cleanup': route({
    method: 'GET',
    path: '/api/workspaces/cleanup',
    group: 'recovery',
    params: noInput,
    query: worktreeCleanupQuery,
    body: null,
    response: json(worktreeCleanupResponse),
  }),
  'resources.release': route({
    method: 'POST',
    path: '/api/resources/:id/release',
    group: 'recovery',
    params: resourceParams,
    query: noInput,
    body: releaseResourceBody,
    response: json(releaseResourceResponse),
    undoable: true,
  }),
  'runs.unpushedHandled': route({
    method: 'POST',
    path: '/api/runs/:runId/unpushed-handled',
    group: 'recovery',
    params: runParams,
    query: noInput,
    body: unpushedHandledBody,
    response: json(unpushedHandledResponse),
    undoable: true,
  }),
} as const;
