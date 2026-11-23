/**
 * The packet screen and owner review decisions (BUILD_SPEC §5.6, §7;
 * contracts/ui-api.md US3). Shared contract file (tasks.md, Slice rules).
 */
import { z } from 'zod';
import { PACKET_STATES, REVIEW_FOLLOW, REVIEW_INTO, REVIEW_KEEP } from '../enums.js';
import { itemId, objectId, text } from '../mcp/common.js';
import { TEXT_LIMITS } from '../mcp/limits.js';
import {
  humanReviewStateSchema,
  itemSummarySchema,
  provenanceSchema,
  reviewKindSchema,
} from '../mcp/types.js';
import { input, jsonResponse, noInput, ownerMutationOutput, queryInt } from './common.js';
import { json, route } from './route.js';

// ---- GET /api/review/:id ----

export const reviewParams = input({ id: itemId });
export const reviewQuery = input({
  /** Defaults to the latest round. */
  round: queryInt(1, 10_000).optional(),
});

export const reviewVerdictSchema = z.object({
  kind: reviewKindSchema,
  note: z.string().nullable(),
  into: z.enum(REVIEW_INTO).nullable(),
  follow: z.enum(REVIEW_FOLLOW).nullable(),
  /**
   * An approval with a note (owner decision 35): where the note was kept;
   * null otherwise. `epic` and `project` also published an owner decision.
   */
  keep: z.enum(REVIEW_KEEP).nullable(),
  /** The owner decision a kept note became (`epic` or `project`), else null. */
  decision_id: z.string().nullable(),
  /** "→ bug RCP-30", "→ test ticket RCP-29", "→ checklist item", "→ decision for the epic". */
  result_ref: z.string().nullable(),
  decided_at: z.string(),
});

export const packetViewSchema = z.object({
  packet_id: z.string(),
  /** `pkt-9c0e`. */
  display_id: z.string(),
  round: z.number().int(),
  state: z.enum(PACKET_STATES),
  stale: z.boolean(),
  /** Decision 48: a split moved acceptance criteria after this packet was built. */
  criteria_changed: z.boolean().optional(),
  built_from_commit: z.string(),
  estimate: z.string(),
  /** `codex · orca-w3`. */
  created_by: z.string(),
  created_at: z.string(),
  items: z.array(
    z.object({
      hr_item_id: z.string(),
      /** The text as it was in this round. */
      text: z.string(),
      state: humanReviewStateSchema,
      decision: reviewVerdictSchema.nullable(),
    }),
  ),
  how: z.array(z.string()),
  checked: z.array(
    z.object({ text: z.string(), provenance: provenanceSchema, evidence: z.string() }),
  ),
  gaps: z.array(z.string()),
  attachments: z.array(
    z.object({
      document_version_id: z.string(),
      name: z.string(),
      mime: z.string(),
      caption: z.string().nullable(),
    }),
  ),
  /**
   * Decision 36 (B39; BUILD_SPEC §5.21 Hand-off): the changed files and branch
   * as reported; `held_undeclared` lists the parts they touch that the item
   * didn't declare (the review gate stays closed until the owner decides the
   * hold `hold_id`); `not_reported` is "Changed files not reported" on an
   * item with declarations. Optional: absent from older responses.
   */
  shared: z
    .object({
      changed_files: z.array(z.string()).nullable(),
      branch: z.string().nullable(),
      held_undeclared: z.array(z.string()).nullable(),
      hold_id: z.string().nullable(),
      not_reported: z.boolean(),
    })
    .optional(),
});
export type PacketView = z.infer<typeof packetViewSchema>;

export const reviewResponse = jsonResponse({
  item: itemSummarySchema,
  /** "Ready for you · N": other open packets. */
  queue: z.array(
    z.object({
      item_id: z.string(),
      title: z.string(),
      round: z.number().int(),
      estimate: z.string(),
      stale: z.boolean(),
    }),
  ),
  rounds: z.array(
    z.object({
      round: z.number().int(),
      state: z.enum(PACKET_STATES),
      outcome: z.enum(['sent_back', 'approved', 'closed_with_deferred']).nullable(),
    }),
  ),
  packet: packetViewSchema,
  /** Items that finishing this one would unblock ("which unblocks RCP-22, RCP-23"). */
  unblocks: z.array(z.string()),
});
export type ReviewResponse = z.infer<typeof reviewResponse>;

// ---- POST /api/review/:id/decisions ----

export const verdictInputSchema = z
  .strictObject({
    hr_item_id: objectId,
    kind: reviewKindSchema,
    /**
     * Required for `changes`, optional for `defer` and `approve`. On an
     * approval it's a note for later (owner decision 35): stored on the
     * verdict and posted to the item's agent as an owner note.
     */
    note: text(TEXT_LIMITS.note).optional(),
    /** `changes` only: a checklist item on this ticket, or a new Bug in Ready. */
    into: z.enum(REVIEW_INTO).optional(),
    /** `defer` only: a test ticket in Inbox, or none. */
    follow: z.enum(REVIEW_FOLLOW).optional(),
    /**
     * `approve` with a note only: keep the note for this item (the default),
     * or also publish it as an owner decision for the item's epic or the
     * whole project, so agents on future tickets get it (owner decision 35).
     */
    keep: z.enum(REVIEW_KEEP).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'changes') {
      if (v.note === undefined)
        ctx.addIssue({ code: 'custom', path: ['note'], message: 'Required for changes.' });
      if (v.into === undefined)
        ctx.addIssue({ code: 'custom', path: ['into'], message: 'Required for changes.' });
    }
    if (v.kind !== 'changes' && v.into !== undefined)
      ctx.addIssue({ code: 'custom', path: ['into'], message: 'Only for changes.' });
    if (v.kind !== 'defer' && v.follow !== undefined)
      ctx.addIssue({ code: 'custom', path: ['follow'], message: 'Only for defer.' });
    if (v.keep !== undefined && (v.kind !== 'approve' || v.note === undefined))
      ctx.addIssue({ code: 'custom', path: ['keep'], message: 'Only for approve with a note.' });
  });

/** One atomic call with a verdict for every `ready` item (BUILD_SPEC §5.6). */
export const decideBody = input({
  /** The round being decided; a different open round is `conflict`. */
  round: z.number().int().min(1),
  verdicts: z.array(verdictInputSchema).min(1).max(50),
});
export const decideResponse = ownerMutationOutput({
  /** Any `changes` → `progress`; otherwise `done` with `closed_by=owner`. */
  outcome: z.enum(['progress', 'done']),
  item: itemSummarySchema,
  /** Bugs and test tickets the decision created. */
  created: z.array(z.object({ id: z.string(), kind: z.enum(['bug', 'test_ticket']) })),
  /** Items this close unblocked. */
  unblocked: z.array(z.string()),
});
export type DecideResponse = z.infer<typeof decideResponse>;

// ---- POST /api/review/:id/refresh ----

/** Ask for a fresh packet: withdraw it, `ready` → `declared`, item → progress, post an owner note. */
export const refreshBody = input({ packet_id: objectId });
export const refreshResponse = ownerMutationOutput({ item: itemSummarySchema });

// ---- POST /api/deferred/:hrId/follow-up ----

export const followUpParams = input({ hrId: objectId });
export const followUpResponse = ownerMutationOutput({
  /** The new test ticket in Inbox. */
  item: itemSummarySchema,
});

export const reviewRoutes = {
  'review.get': route({
    method: 'GET',
    path: '/api/review/:id',
    group: 'review',
    params: reviewParams,
    query: reviewQuery,
    body: null,
    response: json(reviewResponse),
  }),
  'review.decide': route({
    method: 'POST',
    path: '/api/review/:id/decisions',
    group: 'review',
    params: reviewParams,
    query: noInput,
    body: decideBody,
    response: json(decideResponse),
    undoable: true,
  }),
  'review.refresh': route({
    method: 'POST',
    path: '/api/review/:id/refresh',
    group: 'review',
    params: reviewParams,
    query: noInput,
    body: refreshBody,
    response: json(refreshResponse),
    undoable: true,
  }),
  'deferred.followUp': route({
    method: 'POST',
    path: '/api/deferred/:hrId/follow-up',
    group: 'review',
    params: followUpParams,
    query: noInput,
    body: noInput,
    response: json(followUpResponse),
    undoable: true,
  }),
} as const;
