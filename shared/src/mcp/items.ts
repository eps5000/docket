/**
 * Creating and editing items (MCP_SPEC §5.3): input and output schemas.
 * Shared contract file (tasks.md, Slice rules).
 */
import { z } from 'zod';
import { LINK_TYPES, SPLIT_CARRY_KINDS, SPLIT_RELATIONS } from '../enums.js';
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
import { KNOWN_GAPS } from '../epic-readiness.js';
import { LABEL_NAME_RE, LIMITS, TEXT_LIMITS } from './limits.js';
import { branchInput, changedFilesInput, sharedPartKey } from './shared-changes.js';
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

// ---- Splitting a ticket (decision 48; MCP_SPEC §5.3) ----

/** 1-based positions in the original's acceptance list, as `get_item` shows them. */
const criteria = z.array(z.number().int());

export const splitCarry = z.strictObject({
  kind: z.enum(SPLIT_CARRY_KINDS),
  /** The blocker's item ID, the shared part's key, or the step's ID. */
  id: text(LIMITS.shared_part_key),
  /** Copy instead of move. */
  copy: z.boolean().optional(),
});

export const splitFromInput = z.strictObject({
  id: itemId,
  expected_version: expectedVersion,
  move: criteria,
  copy: criteria.optional(),
  relation: z.enum(SPLIT_RELATIONS),
  also: z.array(splitCarry).optional(),
  /** Your name, when you split a claimed ticket as its coordinator. */
  coordinator: text(LIMITS.orchestrator_name).optional(),
});

// ---- create_item ----

export const createItemInput = mutationInput({
  project: projectKey,
  type: itemTypeSchema,
  title: text(TEXT_LIMITS.title),
  description_md: longText(TEXT_LIMITS.markdown).optional(),
  outcome_md: longText(TEXT_LIMITS.markdown).optional(),
  acceptance: acceptance.optional(),
  /** Defaults to 2, or to the original's priority in a split. */
  priority: prioritySchema.optional(),
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
  /** Decision 48: create this ticket by splitting an existing one, in one step. */
  split_from: splitFromInput.optional(),
  /**
   * Decision 65: the shared parts it changes (registered or new keys, each a
   * `change`), or `none`. Left out, the ticket is Needs shaping. Precise
   * changes, members and notes go through declare_shared_changes.
   */
  shared: z.union([z.literal('none'), z.array(sharedPartKey)]).optional(),
}).superRefine((v, ctx) => {
  const parts = Array.isArray(v.shared) ? v.shared : [];
  if (Array.isArray(v.shared) && parts.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['shared'],
      message: "Name at least one part, or pass 'none'.",
    });
  }
  if (parts.length > LIMITS.shared_changes_max) {
    ctx.addIssue({
      code: 'custom',
      path: ['shared'],
      message: `At most ${LIMITS.shared_changes_max} parts.`,
    });
  }
  if (new Set(parts).size !== parts.length) {
    ctx.addIssue({ code: 'custom', path: ['shared'], message: 'Lists a part twice.' });
  }
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
  /**
   * Decision 58: what implementation will settle. Replaces the list; on a
   * ticket the owner approved, only `settled` may change.
   */
  known_gaps: z
    .array(
      z.strictObject({
        gap: text(KNOWN_GAPS.gap),
        settled: text(KNOWN_GAPS.settled).optional(),
      }),
    )
    .max(KNOWN_GAPS.max)
    .optional(),
  /** Decision 64, on an epic: its release ticket, when the links don't settle it; `null` clears. */
  finish_line: itemId.nullable().optional(),
});
export const updateItemOutput = mutationOutput({ item: itemSummarySchema });

// ---- set_status ----

export const setStatusInput = mutationInput({
  id: itemId,
  status: statusSchema,
  expected_version: expectedVersion.optional(),
  /** Required for canceled and reopen. */
  reason: text(TEXT_LIMITS.note).optional(),
  /**
   * Decision 36 (MCP_SPEC §5.15): when closing as done, the files the work
   * changed (repo-relative, ≤ 2,000) and its branch. Ignored for other moves.
   */
  changed_files: changedFilesInput.optional(),
  branch: branchInput.optional(),
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
