/**
 * `get_digest` (owner decision 40; MCP_SPEC §5.2): one compact coordinator
 * snapshot in place of the usual round of reads. Every section is capped and
 * carries its full `total`, so the text can say "+N more", and the rendered
 * text never exceeds `DIGEST_MAX_CHARS`. Shared contract file.
 */
import { z } from 'zod';
import { cursor, projectKey, readInput, readOutput } from './common.js';
import { WAIT_FLAG_KINDS, coordinatorParkSchema, prioritySchema, runStateSchema } from './types.js';
import { WAIT_KINDS } from '../wait-kind.js';
import { SHAPING_ASKERS, SHAPING_PARTS } from '../shaping.js';

/** The most rows each section lists. */
export const DIGEST_CAPS = {
  next_work: 5,
  bottlenecks: 3,
  ready: 8,
  runs: 8,
  blocked: 5,
  owner: 6,
  problems: 4,
  leases: 4,
  conflicts: 4,
  changed: 6,
  unshaped_epics: 3,
  needs_shaping: 5,
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

/** Decision 48: what to start next, ranked by priority, tickets unlocked, then age. */
export const digestNextWorkSchema = z.object({
  id: z.string(),
  title: z.string(),
  priority: prioritySchema,
  /** Open tickets it unlocks, directly or further down. */
  unlocks: z.number().int(),
  reason: z.string(),
});

/** Decision 48: an unowned Inbox or Planning ticket holding up real work. */
export const digestBottleneckSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['inbox', 'planning']),
  unlocks: z.number().int(),
  next: z.string(),
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
  /** Decision 45: on a parked row, how long it has waited, who moves it and how it resumes. */
  wait: z
    .object({
      since: z.string(),
      /** "orca: shape GF-381 or assign it". */
      next: z.string(),
      flags: z.array(z.enum(WAIT_FLAG_KINDS)),
      /** Decision 48: the active owner decision holding this wait. */
      held_by: z.object({ decision_id: z.string(), title: z.string() }).optional(),
      /** Once it can resume: the same run and dispatch to tell. */
      relay: z.string().optional(),
    })
    .optional(),
});

export const digestBlockedSchema = z.object({
  id: z.string(),
  title: z.string(),
  priority: prioritySchema,
  unblocks: z.number().int(),
  blocked_by: z.array(z.string()),
  /** Decision 57: Queued (its blockers are moving), Blocked (needs attention) or Held. */
  wait: z.enum(WAIT_KINDS),
  /** Why it is Blocked or Held, in plain words; absent when Queued. */
  why: z.string().optional(),
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

/** Decision 58: an epic already In progress (or in Review) with Inbox or Planning tickets. */
export const digestUnshapedEpicSchema = z.object({
  id: z.string(),
  title: z.string(),
  unshaped: z.array(z.string()),
});

/** Decision 65: a ticket for a planner to shape: what it lacks, and who asked. */
export const digestNeedsShapingSchema = z.object({
  id: z.string(),
  title: z.string(),
  epic: z.string().nullable(),
  missing: z.array(z.enum(SHAPING_PARTS)),
  asked_by: z.enum(SHAPING_ASKERS),
  /** The owner's note to the planner. */
  note: z.string().nullable(),
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
  /** Decision 53: one plain line, only while the owner has this project paused. */
  paused: z.string().optional(),
  /** Decision 56: this project's installed files are behind, and how to take the update. */
  agent_files_update: z.string().optional(),
  /** The current change cursor: pass it to docket-wait, get_changes or the next digest. */
  cursor: z.string(),
  /** The cursor this digest is relative to; null for a full snapshot. */
  since: z.string().nullable(),
  next_work: section(digestNextWorkSchema),
  bottlenecks: section(digestBottleneckSchema),
  ready: section(digestReadySchema),
  runs: section(digestRunSchema),
  blocked: section(digestBlockedSchema),
  owner: section(digestOwnerSchema),
  problems: section(digestProblemSchema),
  leases: section(digestLeaseSchema),
  conflicts: section(digestConflictSchema),
  changed: section(digestChangeSchema),
  /** Decision 58: "Started with N unshaped tickets", on full snapshots only; absent when none. */
  unshaped_epics: section(digestUnshapedEpicSchema).optional(),
  /** Decision 65: "Needs shaping: N", tickets for the producer to give a planner; absent when none. */
  needs_shaping: section(digestNeedsShapingSchema).optional(),
});
export type Digest = z.infer<typeof getDigestOutput>;
