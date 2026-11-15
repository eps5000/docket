/**
 * Recovery (MCP_SPEC §5.9): `recovery_report`, the restart list after a
 * crash or restart. Read-only. Shared contract file (tasks.md, Slice rules).
 */
import { z } from 'zod';
import {
  cursor,
  isoTime,
  nextCursor,
  pageLimit,
  projectKey,
  readInput,
  readOutput,
} from './common.js';
import {
  endReasonSchema,
  itemSummarySchema,
  questionSchema,
  resourceSchema,
  runSchema,
  workspaceStateSchema,
} from './types.js';

export const recoveryReportInput = readInput({
  project: projectKey.optional(),
  /** Default: the last 7 days. */
  since: isoTime.optional(),
  /** Include the brief text; otherwise only document version IDs. */
  include_briefs: z.boolean().default(false),
  cursor: cursor.optional(),
  limit: pageLimit,
});

export const recoveryInterruptedSchema = z.object({
  item: itemSummarySchema,
  run: runSchema,
  end_reason: endReasonSchema,
  checklist: z.object({ done: z.number().int(), total: z.number().int() }),
  open_question: questionSchema.nullable(),
  /** With `include_briefs` only. */
  brief: z.string().optional(),
});

export const recoveryWorkspaceSchema = z.object({
  path: z.string(),
  branch: z.string().nullable(),
  item_id: z.string(),
  run_id: z.string(),
  state: workspaceStateSchema,
  head_sha: z.string().nullable(),
  pushed_sha: z.string().nullable(),
  dirty: z.boolean().nullable(),
  unreleased_resources: z.number().int(),
});
export type RecoveryWorkspace = z.infer<typeof recoveryWorkspaceSchema>;

export const orphanedResourceSchema = z.object({
  resource: resourceSchema,
  item_id: z.string(),
  run_id: z.string(),
  run_ended_at: z.string(),
});

export const recoveryReportOutput = readOutput({
  interrupted: z.array(recoveryInterruptedSchema),
  stale: z.array(z.object({ item: itemSummarySchema, run: runSchema })),
  parked: z.array(z.object({ item: itemSummarySchema, run: runSchema, resume_ready: z.boolean() })),
  workspaces: z.array(recoveryWorkspaceSchema),
  orphaned_resources: z.array(orphanedResourceSchema),
  next_cursor: nextCursor,
});
export type RecoveryReport = z.infer<typeof recoveryReportOutput>;
