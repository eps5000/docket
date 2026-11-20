/**
 * Problems that say what to do (owner decision 37; MCP_SPEC §5.16):
 * `propose_resolution`. Shared contract file (tasks.md, Slice rules).
 *
 * An agent proposes how to resolve a problem that needs the owner (split the
 * work, change its scope or its order, or something else): a plan in
 * Markdown and a reason. The owner approves it, asks for a different way
 * (with a note), or acknowledges it; each choice is posted to the item as an
 * owner note and shows in get_context. Routine fixes (rebasing onto main,
 * removing an old branch from the item's branches) need no proposal.
 */
import { z } from 'zod';
import { RESOLUTION_KINDS, RESOLUTION_STATES } from '../enums.js';
import { itemId, mutationInput, mutationOutput, text } from './common.js';
import { LIMITS } from './limits.js';

export const resolutionKindSchema = z.enum(RESOLUTION_KINDS);

export const proposeResolutionInput = mutationInput({
  /**
   * The problem to resolve: its ID from get_context `problems` (`rdf_…` for a
   * radar finding). Give this, `id`, or both.
   */
  problem: text(LIMITS.problem_id).optional(),
  /** The item: with no `problem`, a proposal about the item in general. */
  id: itemId.optional(),
  kind: resolutionKindSchema,
  /** The plan, in Markdown: what you would do, in order. */
  plan_md: text(LIMITS.resolution_plan),
  /** Why this resolves the problem. */
  reason: text(LIMITS.resolution_reason),
}).superRefine((v, ctx) => {
  if (v.problem === undefined && v.id === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['problem'],
      message: 'is required unless you give id',
    });
  }
});

export const proposeResolutionOutput = mutationOutput({
  resolution: z.object({
    id: z.string(),
    item_id: z.string(),
    problem_id: z.string().nullable(),
    kind: resolutionKindSchema,
    state: z.enum(RESOLUTION_STATES),
    created_at: z.string(),
  }),
  /** Your earlier open proposals for the same problem, which this one replaces. */
  superseded: z.array(z.string()),
});
