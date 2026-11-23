/**
 * Recovery (owner decision 26; BUILD_SPEC §5.16, §7; UI_SPEC §6.1, §6.3.2,
 * §6.6; contracts/ui-api.md US11): the Agents → Workspaces card and the
 * Problems actions, *Mark released* on an orphaned resource and *Keep for
 * later* or *Safe to discard* on unpushed work (decision 41). Shared contract
 * file (tasks.md, Slice rules).
 */
import { z } from 'zod';
import { objectId, text } from '../mcp/common.js';
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
