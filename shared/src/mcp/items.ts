/**
 * Creating and editing items (MCP_SPEC §5.3): input and output schemas.
 * Shared contract file (tasks.md, Slice rules).
 */
import { z } from 'zod';
import { LINK_TYPES } from '../enums.js';
import {
  date,
  itemId,
  longText,
  mutationInput,
  mutationOutput,
  objectId,
  projectKey,
  text,
} from './common.js';
import { LABEL_NAME_RE, LIMITS, TEXT_LIMITS } from './limits.js';
import {
  itemSummarySchema,
  itemTypeSchema,
  prioritySchema,
  satisfiedWhenSchema,
  statusSchema,
} from './types.js';

export const labelNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(LIMITS.label_name)
  .regex(LABEL_NAME_RE, { error: 'Expected a label name: lowercase a-z, 0-9 and -.' });

const acceptance = z.array(text(TEXT_LIMITS.step));
const labels = z.array(labelNameSchema);
const expectedVersion = z.number().int().min(0);

// ---- create_item ----

export const createItemInput = mutationInput({
  project: projectKey,
  type: itemTypeSchema,
  title: text(TEXT_LIMITS.title),
  description_md: longText(TEXT_LIMITS.markdown).optional(),
  outcome_md: longText(TEXT_LIMITS.markdown).optional(),
  acceptance: acceptance.optional(),
  priority: prioritySchema.default(2),
  /** An Epic in the same project. */
  epic: itemId.optional(),
  /** Created if missing. */
  labels: labels.optional(),
  status: z.enum(['inbox', 'planning']).default('inbox'),
  planned_start: date.optional(),
  planned_end: date.optional(),
  effort: z.number().min(0).optional(),
  /** Creates `blocks` links; cycle-checked. */
  blocked_by: z.array(itemId).optional(),
});
export const createItemOutput = mutationOutput({ item: itemSummarySchema });

// ---- update_item ----

export const updateItemInput = mutationInput({
  id: itemId,
  expected_version: expectedVersion,
  title: text(TEXT_LIMITS.title).optional(),
  description_md: longText(TEXT_LIMITS.markdown).optional(),
  outcome_md: longText(TEXT_LIMITS.markdown).optional(),
  acceptance: acceptance.optional(),
  priority: prioritySchema.optional(),
  /** `null` clears it. */
  epic: itemId.nullable().optional(),
  /** Replaces the set. */
  labels: labels.optional(),
  add_labels: labels.optional(),
  remove_labels: labels.optional(),
  /** `null` clears. */
  planned_start: date.nullable().optional(),
  planned_end: date.nullable().optional(),
  effort: z.number().min(0).nullable().optional(),
});
export const updateItemOutput = mutationOutput({ item: itemSummarySchema });

// ---- set_status ----

export const setStatusInput = mutationInput({
  id: itemId,
  status: statusSchema,
  expected_version: expectedVersion.optional(),
  /** Required for canceled and reopen. */
  reason: text(TEXT_LIMITS.note).optional(),
});
export const setStatusOutput = mutationOutput({ item: itemSummarySchema });

// ---- link_items ----

export const linkItemsInput = mutationInput({
  from: itemId,
  to: itemId,
  type: z.enum(LINK_TYPES),
  /** Blocks only; omit to use the project default. */
  satisfied_when: satisfiedWhenSchema.optional(),
});
export const linkItemsOutput = mutationOutput({
  link_id: z.string(),
  from: z.string(),
  to: z.string(),
  type: z.enum(LINK_TYPES),
  /** Null for relates links. */
  satisfied_when: satisfiedWhenSchema.nullable(),
  updated: z.boolean(),
});

// ---- unlink_items ----

export const unlinkItemsInput = mutationInput({
  link_id: objectId.optional(),
  from: itemId.optional(),
  to: itemId.optional(),
  type: z.enum(LINK_TYPES).optional(),
}).superRefine((value, ctx) => {
  const byId = value.link_id !== undefined;
  const byEnds = value.from !== undefined || value.to !== undefined || value.type !== undefined;
  if (byId && byEnds) {
    ctx.addIssue({
      code: 'custom',
      path: ['link_id'],
      message: 'Pass link_id or (from, to, type), not both.',
    });
  } else if (!byId) {
    for (const key of ['from', 'to', 'type'] as const) {
      if (value[key] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'Required unless link_id is given.',
        });
      }
    }
  }
});
export const unlinkItemsOutput = mutationOutput({ removed: z.literal(true) });

// ---- upsert_label ----

export const upsertLabelInput = mutationInput({
  project: projectKey,
  name: labelNameSchema,
  brief_md: longText(TEXT_LIMITS.brief_md).optional(),
});
export const upsertLabelOutput = mutationOutput({
  project: z.string(),
  name: z.string(),
  brief_md: z.string().nullable(),
});
