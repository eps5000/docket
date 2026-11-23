/**
 * `get_digest` (owner decision 40; MCP_SPEC §5.2): one compact coordinator
 * snapshot in place of the usual round of reads. Every section is capped and
 * carries its full `total`, so the text can say "+N more", and the rendered
 * text never exceeds `DIGEST_MAX_CHARS`. Shared contract file.
 */
import { z } from 'zod';
import { cursor, projectKey, readInput, readOutput } from './common.js';
import { coordinatorParkSchema, prioritySchema, runStateSchema } from './types.js';

/** The most rows each section lists. */
export const DIGEST_CAPS = {
  ready: 8,
  runs: 8,
  blocked: 5,
  owner: 6,
  problems: 4,
  leases: 4,
  conflicts: 4,
  changed: 6,
} as const;

/** The hard cap on the text block: 1,000 tokens at characters ÷ 4 (MCP_SPEC §3.2). */
export const DIGEST_MAX_CHARS = 4_000;
/** The longest free text (a title, a question, a fix) on one digest line. */
export const DIGEST_TEXT_CHARS = 44;

const section = <T extends z.ZodType>(row: T) =>
  z.object({ total: z.number().int(), rows: z.array(row) });

export const digestReadySchema = z.object({
  id: z.string(),
  title: z.string(),
  priority: prioritySchema,
  unblocks: z.number().int(),
});

export const digestRunSchema = z.object({
  item_id: z.string(),
  run_id: z.string(),
  state: runStateSchema,
  label: z.string().nullable(),
  resume_ready: z.boolean(),
  waiting: z.string().nullable(),
  /** Decision 42: the story's producer, when it has one. */
  producer: z.string().optional(),
  /** Decision 42: "2 commits since parked", while flagged. */
  activity: z.string().optional(),
  /** Decision 42: the coordinator who last set this run's status. */
  updated_by: z.string().optional(),
  /** Decision 44: a coordinator's time-limited park, holding or just run out. */
  coordinator_park: coordinatorParkSchema.optional(),
});

export const digestBlockedSchema = z.object({
  id: z.string(),
  title: z.string(),
  priority: prioritySchema,
  unblocks: z.number().int(),
  blocked_by: z.array(z.string()),
});

export const digestOwnerSchema = z.object({
  kind: z.string(),
  item_id: z.string().nullable(),
  text: z.string(),
});

export const digestProblemSchema = z.object({
  id: z.string(),
  kind: z.string(),
  item_id: z.string().nullable(),
  fix: z.string(),
});

export const digestLeaseSchema = z.object({
  part: z.string(),
  item_id: z.string(),
  until: z.string(),
});

export const digestConflictSchema = z.object({
  items: z.array(z.string()),
  parts: z.array(z.string()),
  outcome: z.string(),
});

export const digestChangeSchema = z.object({
  cursor: z.string(),
  item_id: z.string().nullable(),
  type: z.string(),
});

export const getDigestInput = readInput({
  project: projectKey,
  /** Only what changed after this change cursor (`cursor` from an earlier digest or get_changes). */
  cursor: cursor.optional(),
});

export const getDigestOutput = readOutput({
  project: z.string(),
  /** The current change cursor: pass it to docket-wait, get_changes or the next digest. */
  cursor: z.string(),
  /** The cursor this digest is relative to; null for a full snapshot. */
  since: z.string().nullable(),
  ready: section(digestReadySchema),
  runs: section(digestRunSchema),
  blocked: section(digestBlockedSchema),
  owner: section(digestOwnerSchema),
  problems: section(digestProblemSchema),
  leases: section(digestLeaseSchema),
  conflicts: section(digestConflictSchema),
  changed: section(digestChangeSchema),
});
export type Digest = z.infer<typeof getDigestOutput>;
