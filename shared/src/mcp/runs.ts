/**
 * Claiming and runs (MCP_SPEC §5.4): input and output schemas, including the
 * recovery fields (MCP_SPEC §3 "Workspaces, briefs and resources"; owner
 * decision 26) and `park_run`. Shared contract file (tasks.md, Slice rules).
 */
import { z } from 'zod';
import { RESOURCE_KINDS } from '../enums.js';
import {
  agentLabel,
  commitSha,
  isoTime,
  itemId,
  mutationInput,
  mutationOutput,
  objectId,
  runIdField,
  text,
} from './common.js';
import { instructionsInput } from './agent-files.js';
import { LIMITS, TEXT_LIMITS } from './limits.js';
import { itemSummarySchema, runStateSchema } from './types.js';

// ---- Recovery building blocks (MCP_SPEC §3; BUILD_SPEC §5.16) ----

/** Where the work lives, as passed to claim_lead and start_run. */
export const workspaceInput = z.strictObject({
  host: text(LIMITS.workspace_host).optional(),
  /** A remote URL or a name. */
  repo: text(LIMITS.workspace_repo).optional(),
  /** The worktree path. */
  path: text(LIMITS.workspace_path).optional(),
  branch: text(LIMITS.branch).optional(),
  /** e.g. `origin/main`. */
  base_ref: text(LIMITS.branch).optional(),
  base_sha: commitSha.optional(),
});

/** A heartbeat's workspace patch: what you leave out stays as it is. */
export const workspacePatchInput = z.strictObject({
  head_sha: commitSha.optional(),
  pushed_sha: commitSha.optional(),
  /** Uncommitted changes. */
  dirty: z.boolean().optional(),
  path: text(LIMITS.workspace_path).optional(),
  branch: text(LIMITS.branch).optional(),
});

/** The orchestrator's own IDs (for example Orca's). */
export const orchestratorInput = z.strictObject({
  name: text(LIMITS.orchestrator_name),
  dispatch_id: objectId.optional(),
  task_id: objectId.optional(),
  run_id: objectId.optional(),
});

/** UTF-8 bytes of a value's JSON (no TextEncoder: shared builds without DOM or Node types). */
export function jsonBytes(value: unknown): number {
  let bytes = 0;
  for (const ch of JSON.stringify(value) ?? '') {
    const code = ch.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** A namespaced map (`{"orca": {...}}`), ≤ 2 KB of JSON, stored as it is and never interpreted. */
export const externalInput = z
  .record(z.string().min(1).max(LIMITS.external_key), z.unknown())
  .refine((value) => jsonBytes(value) <= LIMITS.external_bytes, {
    error: `must be at most ${LIMITS.external_bytes} bytes of JSON`,
  });

/** Brief text: stored byte for byte as a `brief` document, so it is not trimmed. */
export const briefInput = z.string().min(1).max(LIMITS.brief);

/** The recovery fields claim_lead and start_run share (MCP_SPEC §5.4). */
const recoveryFields = {
  workspace: workspaceInput.optional(),
  orchestrator: orchestratorInput.optional(),
  /** The exact instructions the run was given (≤ 20,000), stored as an immutable `brief` document. */
  brief: briefInput.optional(),
  /** Or an existing document version as the brief. */
  brief_document_version_id: objectId.optional(),
  external: externalInput.optional(),
} as const;

/** `brief` and `brief_document_version_id` are mutually exclusive. */
function oneBrief(
  value: { brief?: string; brief_document_version_id?: string },
  ctx: z.RefinementCtx,
): void {
  if (value.brief !== undefined && value.brief_document_version_id !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['brief_document_version_id'],
      message: 'Pass brief or brief_document_version_id, not both.',
    });
  }
}

/** Enough to find a resource again; at least one field. */
export const resourceLocatorInput = z
  .strictObject({
    pid: z.number().int().min(0).optional(),
    port: z.number().int().min(1).max(65_535).optional(),
    session_id: text(LIMITS.locator_text).optional(),
    container: text(LIMITS.locator_text).optional(),
    path: text(LIMITS.workspace_path).optional(),
    host: text(LIMITS.locator_text).optional(),
  })
  .refine((l) => Object.values(l).some((v) => v !== undefined), {
    error: 'must name at least one of pid, port, session_id, container, path or host',
  });

export const resourceStartInput = z.strictObject({
  kind: z.enum(RESOURCE_KINDS),
  /** e.g. `dev server :5173`. */
  label: text(LIMITS.resource_label),
  locator: resourceLocatorInput,
});

export const resourceReleaseInput = z.strictObject({
  resource_id: objectId,
  note: text(LIMITS.release_note).optional(),
});

/** What a parked run waits on. */
export const waitingOnInput = z.strictObject({
  items: z.array(itemId).min(1).max(LIMITS.waiting_on_items_max).optional(),
  orchestrator: z.boolean().optional(),
  person: z.boolean().optional(),
  until: isoTime.optional(),
});

// ---- claim_lead ----

export const claimLeadInput = mutationInput({
  id: itemId,
  /** For example `orca-w3`. */
  agent_label: agentLabel.optional(),
  ...recoveryFields,
  /** Decision 30: the installed `tasklite-check` script's output (MCP_SPEC §5.4; BUILD_SPEC §5.19). */
  instructions: instructionsInput.optional(),
}).superRefine(oneBrief);
export const claimLeadOutput = mutationOutput({
  run_id: z.string(),
  item: itemSummarySchema,
  lease_expires_at: z.string(),
});

// ---- release_lead ----

export const releaseLeadInput = mutationInput({
  id: itemId,
  run_id: runIdField,
  reason: text(TEXT_LIMITS.note),
});
export const releaseLeadOutput = mutationOutput({ item: itemSummarySchema });

// ---- start_run ----

export const startRunInput = mutationInput({
  id: itemId,
  parent_run_id: runIdField,
  agent_label: agentLabel.optional(),
  ...recoveryFields,
}).superRefine(oneBrief);
export const startRunOutput = mutationOutput({ run_id: z.string() });

// ---- heartbeat ----

export const heartbeatInput = mutationInput({
  run_id: runIdField,
  current_step_id: objectId.optional(),
  /** Short; shown as the run's "doing" line. */
  note: text(TEXT_LIMITS.note).optional(),
  workspace: workspacePatchInput.optional(),
  /** ≤ 10 per call; each gets an `rsc_…` ID. */
  resources_started: z
    .array(resourceStartInput)
    .min(1)
    .max(LIMITS.resources_started_max)
    .optional(),
  resources_released: z
    .array(resourceReleaseInput)
    .min(1)
    .max(LIMITS.resources_released_max)
    .optional(),
  external: externalInput.optional(),
});
export const heartbeatOutput = mutationOutput({
  run_state: runStateSchema,
  lease_expires_at: z.string().nullable(),
  /** The new resources have IDs `rsc_…`. */
  resources: z.array(z.object({ id: z.string(), label: z.string() })),
});

// ---- finish_run ----

export const finishRunInput = mutationInput({
  run_id: runIdField,
  result: z.enum(['finished', 'failed']),
  summary: text(LIMITS.run_summary),
  /** Shown monospaced. */
  error: text(LIMITS.run_error).optional(),
});
/**
 * Finishing with unreleased resources or unpushed commits succeeds but warns
 * (`warnings`, from `mutationOutput`): `1 resource still declared: dev server :5173`.
 */
export const finishRunOutput = mutationOutput({ run_state: runStateSchema });

// ---- park_run ----

export const parkRunInput = mutationInput({
  run_id: runIdField,
  reason: text(LIMITS.park_reason),
  waiting_on: waitingOnInput.optional(),
});
export const parkRunOutput = mutationOutput({
  run_state: z.literal('parked'),
  resume_ready: z.boolean(),
});
