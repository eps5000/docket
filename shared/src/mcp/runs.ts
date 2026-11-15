/**
 * Claiming and runs (MCP_SPEC §5.4): input and output schemas.
 * Shared contract file (tasks.md, Slice rules).
 */
import { z } from 'zod';
import {
  agentLabel,
  itemId,
  mutationInput,
  mutationOutput,
  objectId,
  runIdField,
  text,
} from './common.js';
import { LIMITS, TEXT_LIMITS } from './limits.js';
import { itemSummarySchema, runStateSchema } from './types.js';

// ---- claim_lead ----

export const claimLeadInput = mutationInput({
  id: itemId,
  /** For example `orca-w3`. */
  agent_label: agentLabel.optional(),
});
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
});
export const startRunOutput = mutationOutput({ run_id: z.string() });

// ---- heartbeat ----

export const heartbeatInput = mutationInput({
  run_id: runIdField,
  current_step_id: objectId.optional(),
  /** Short; shown as the run's "doing" line. */
  note: text(TEXT_LIMITS.note).optional(),
});
export const heartbeatOutput = mutationOutput({
  run_state: runStateSchema,
  lease_expires_at: z.string().nullable(),
});

// ---- finish_run ----

export const finishRunInput = mutationInput({
  run_id: runIdField,
  result: z.enum(['finished', 'failed']),
  summary: text(LIMITS.run_summary),
  /** Shown monospaced. */
  error: text(LIMITS.run_error).optional(),
});
export const finishRunOutput = mutationOutput({ run_state: runStateSchema });
