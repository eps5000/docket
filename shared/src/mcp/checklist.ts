/**
 * The checklist (MCP_SPEC §5.5): work steps, checks and human review.
 * Writes patch by default (§3.3): what you don't restate, you don't change.
 * Shared contract file (tasks.md, Slice rules).
 */
import { z } from 'zod';
import {
  itemId,
  longText,
  mutationInput,
  mutationOutput,
  objectId,
  readInput,
  readOutput,
  text,
} from './common.js';
import { LIMITS, TEXT_LIMITS } from './limits.js';
import {
  checkSchema,
  checkStateSchema,
  humanReviewItemSchema,
  provenanceSchema,
  stepHistoryEntrySchema,
  workStepSchema,
  workStepStateSchema,
} from './types.js';
import { SUBAGENT_PROVENANCES } from '../enums.js';

const patchMode = z.enum(['patch', 'replace']).default('patch');

/**
 * A step's details (decision 33; MCP_SPEC §5.12): Markdown, at most 10,000
 * characters; `null` (or empty) clears them; omitted leaves them unchanged.
 */
export const stepDetails = longText(LIMITS.step_details).nullable();
/** A step's source, for example a Jira key: at most 100 characters; `null` clears it (B33). */
export const stepSource = text(LIMITS.step_source).nullable();

// ---- set_plan ----

export const planStepInputSchema = z.strictObject({
  id: objectId.optional(),
  text: text(TEXT_LIMITS.step).optional(),
  state: workStepStateSchema.optional(),
  change_reason: text(TEXT_LIMITS.note).optional(),
  /** Insert after this step; otherwise at the end. */
  after: objectId.optional(),
  details: stepDetails.optional(),
  source: stepSource.optional(),
});

export const setPlanInput = mutationInput({
  id: itemId,
  /** Required unless this is the first plan. */
  reason: text(TEXT_LIMITS.note).optional(),
  mode: patchMode,
  steps: z.array(planStepInputSchema).max(LIMITS.plan_steps_max).optional(),
  remove: z.array(objectId).optional(),
});
export const setPlanOutput = mutationOutput({
  plan_version: z.number().int(),
  work: z.array(workStepSchema),
});

// ---- update_step ----

export const updateStepInput = mutationInput({
  id: itemId,
  step_id: objectId,
  state: workStepStateSchema,
  /** Required for blocked and skipped. */
  note: text(TEXT_LIMITS.note).optional(),
  /** Replace the step's details; `null` clears them (decision 33). */
  details: stepDetails.optional(),
  /** The `details_version` you read; a mismatch is a conflict. */
  expected_details_version: z.number().int().min(0).optional(),
}).superRefine((value, ctx) => {
  if ((value.state === 'blocked' || value.state === 'skipped') && value.note === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['note'],
      message: `Required when state is ${value.state}.`,
    });
  }
});
export const updateStepOutput = mutationOutput({ step: workStepSchema });

// ---- get_step (decision 33; MCP_SPEC §5.12) ----

export const getStepInput = readInput({ id: itemId, step_id: objectId });
export const getStepOutput = readOutput({
  /** The step with its details: `details_md` and `details_version` are always present. */
  step: workStepSchema.extend({
    details_md: z.string().nullable(),
    details_version: z.number().int(),
  }),
  history: z.array(stepHistoryEntrySchema),
});

// ---- log_subagent ----

export const logSubagentInput = mutationInput({
  id: itemId,
  step_id: objectId.optional(),
  name: text(LIMITS.subagent_name),
  outcome: text(LIMITS.subagent_outcome),
  evidence: text(LIMITS.evidence).optional(),
  provenance: z.enum(SUBAGENT_PROVENANCES),
  child_run_id: objectId.optional(),
});
export const logSubagentOutput = mutationOutput({ logged: z.literal(true) });

// ---- set_checks ----

export const checkInputSchema = z.strictObject({
  id: objectId.optional(),
  text: text(TEXT_LIMITS.step).optional(),
  state: checkStateSchema.optional(),
  evidence: text(LIMITS.evidence).optional(),
  provenance: provenanceSchema.default('agent'),
});

export const setChecksInput = mutationInput({
  id: itemId,
  mode: patchMode,
  checks: z.array(checkInputSchema).max(LIMITS.checks_max).optional(),
  remove: z.array(objectId).optional(),
});
export const setChecksOutput = mutationOutput({ checks: z.array(checkSchema) });

// ---- update_check ----

export const updateCheckInput = mutationInput({
  id: itemId,
  check_id: objectId,
  state: checkStateSchema,
  evidence: text(LIMITS.evidence).optional(),
  provenance: provenanceSchema.optional(),
});
export const updateCheckOutput = mutationOutput({ check: checkSchema });

// ---- declare_human_review ----

export const declareHumanReviewInput = mutationInput({
  id: itemId,
  items: z.array(text(TEXT_LIMITS.step)).min(1).max(LIMITS.human_review_declare_max),
});
export const declareHumanReviewOutput = mutationOutput({
  human_review: z.array(humanReviewItemSchema),
});

// ---- update_human_review ----

export const updateHumanReviewInput = mutationInput({
  id: itemId,
  hr_item_id: objectId,
  expected_version: z.number().int().min(0),
  text: text(TEXT_LIMITS.step).optional(),
  remove: z.literal(true).optional(),
}).superRefine((value, ctx) => {
  if ((value.text === undefined) === (value.remove === undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: ['text'],
      message: 'Pass text to edit the item or remove: true to remove it (one of the two).',
    });
  }
});
export const updateHumanReviewOutput = mutationOutput({
  human_review: z.array(humanReviewItemSchema),
});
