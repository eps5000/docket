/**
 * What every problem says (owner decision 37; BUILD_SPEC §5.22 Problems;
 * UI_SPEC §6.1): what's wrong, what fixes it, and who acts, in plain words.
 * The server writes the text (server/src/domain/problems.ts), so agents and
 * the owner read the same wording.
 */
import { z } from 'zod';
import { RESOLUTION_DECISIONS, RESOLUTION_KINDS, RESOLUTION_STATES } from '../enums.js';
import { objectId, text } from '../mcp/common.js';
import { LIMITS } from '../mcp/limits.js';
import { input, noInput, ownerMutationOutput } from './common.js';
import { json, route } from './route.js';

/** Who acts on a problem: an agent (the lead of the items involved) or the owner (a decision). */
export const PROBLEM_ACTORS = ['agent', 'owner'] as const;
export type ProblemActor = (typeof PROBLEM_ACTORS)[number];

export const problemExplanationSchema = z.object({
  /** What's wrong: "GF-228's branch eps5000/redesign-438-shell is out of date with main: 53 files conflict." */
  what: z.string(),
  /** What fixes it: "Rebase it onto main, or split it into short story PRs. …" */
  fix: z.string(),
  who: z.enum(PROBLEM_ACTORS),
  /** "An agent: the lead of GF-228", "An agent: nobody leads GF-228 yet", "You: a decision". */
  who_text: z.string(),
});
export type ProblemExplanation = z.infer<typeof problemExplanationSchema>;

/**
 * The owner note *Remind the agent* posts (decision 37): the explanation's
 * first two lines, so the agent reads what the owner reads.
 */
export function reminderText(e: Pick<ProblemExplanation, 'what' | 'fix'>): string {
  return `Reminder from Docket's Problems: ${e.what} ${e.fix}`;
}

/** An agent's proposed resolution of a problem (decision 37; MCP_SPEC §5.16 `propose_resolution`). */
export const resolutionRowSchema = z.object({
  /** `prs_…` */
  id: z.string(),
  item_id: z.string(),
  /** The problem it resolves; null for one about the item in general. */
  problem_id: z.string().nullable(),
  problem_kind: z.string().nullable(),
  kind: z.enum(RESOLUTION_KINDS),
  plan_md: z.string(),
  reason: z.string(),
  /** `claude · orca-w3` */
  proposed_by: z.string(),
  state: z.enum(RESOLUTION_STATES),
  /** The owner's note (required for *Go a different way*). */
  note: z.string().nullable(),
  decided_by: z.string().nullable(),
  decided_at: z.string().nullable(),
  created_at: z.string(),
  version: z.number().int(),
});
export type ResolutionRow = z.infer<typeof resolutionRowSchema>;

/** Who acknowledged a problem, and when (decision 37). */
export const problemAckSchema = z.object({
  /** `owner` */
  by: z.string(),
  at: z.string(),
});
export type ProblemAck = z.infer<typeof problemAckSchema>;

// ---- POST /api/problems/acknowledge ----

/**
 * The owner acknowledges a problem (decision 37; undoable): it leaves Needs
 * you until it needs a human step again (a proposed resolution arrives, or it
 * materially changes).
 */
export const acknowledgeProblemBody = input({
  problem_id: text(LIMITS.problem_id),
});
export const acknowledgeProblemResponse = ownerMutationOutput({
  problem_id: z.string(),
  acknowledged: problemAckSchema,
});
export type AcknowledgeProblemResponse = z.infer<typeof acknowledgeProblemResponse>;

// ---- POST /api/resolutions/:id/decide ----

export const resolutionParams = input({ id: objectId });
/**
 * The owner's choice on a proposed resolution (decision 37; undoable):
 * *Approve*, *Go a different way* (a note is required) or *Acknowledge*
 * (fine, proceed). Each is posted to the item as an owner note and counts as
 * acknowledging the problem.
 */
export const decideResolutionBody = input({
  decision: z.enum(RESOLUTION_DECISIONS),
  note: text(LIMITS.resolution_note).optional(),
}).superRefine((v, ctx) => {
  if (v.decision === 'different' && v.note === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['note'],
      message: 'is required: say which way to go instead',
    });
  }
});
export const decideResolutionResponse = ownerMutationOutput({ resolution: resolutionRowSchema });
export type DecideResolutionResponse = z.infer<typeof decideResolutionResponse>;

/** The problem routes (decision 37), in the `steer` group: the owner steers agents. */
export const problemRoutes = {
  'problems.acknowledge': route({
    method: 'POST',
    path: '/api/problems/acknowledge',
    group: 'steer',
    params: noInput,
    query: noInput,
    body: acknowledgeProblemBody,
    response: json(acknowledgeProblemResponse),
    undoable: true,
  }),
  'resolutions.decide': route({
    method: 'POST',
    path: '/api/resolutions/:id/decide',
    group: 'steer',
    params: resolutionParams,
    query: noInput,
    body: decideResolutionBody,
    response: json(decideResolutionResponse),
    undoable: true,
  }),
} as const;
