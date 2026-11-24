/**
 * Shared changes and conflict guardrails, the owner's side (owner decision
 * 36; BUILD_SPEC §5.21, §7; UI_SPEC §6.3.6; contracts/ui-api.md US18): the
 * registry, an item's declaration, overlap and undeclared-parts decisions,
 * lease release, and the conflict radar. Shared contract file (tasks.md,
 * Slice rules).
 *
 * B38 resolutions (listed in the B38 PR):
 * - Parts are addressed by their `spt_…` ID in paths, since a key holds `:`,
 *   `/` and spaces. Key and kind are fixed once a part exists; archiving
 *   (`archived: true`) is how the owner removes one (FR-158), and it can be
 *   undone by `archived: false`.
 * - The registry and declaration edits are undoable like other owner edits.
 *   Overlap and undeclared decisions, lease release and the radar are not
 *   (they reach agents at once).
 * - The Ready gate's override is `override_reason` on `PATCH /api/items/:id`
 *   (planning.ts), recorded in Activity.
 * - In this group the routes call the `sharedChanges` service; B38 implements
 *   the registry and declarations, and the rest answer 501 until B39 (T183,
 *   T184).
 */
import { z } from 'zod';
import {
  DESIGN_REVIEW_DECISIONS,
  DESIGN_REVIEW_STATES,
  LEASE_END_REASONS,
  OVERLAP_DECISIONS,
  OVERLAP_HANDLING,
  OVERLAP_OVERRULES,
  OVERLAP_STATES,
  RADAR_STATES,
  SHARED_CHANGES,
  UNDECLARED_DECISIONS,
  UNDECLARED_HOLD_STATES,
  UNDECLARED_HOLD_VIA,
} from '../enums.js';
import { itemId, objectId, projectKey, text } from '../mcp/common.js';
import { LIMITS } from '../mcp/limits.js';
import { problemExplanationSchema } from './problems.js';
import {
  branchInput,
  branchSourceSchema,
  checkDeclaration,
  declarationSchema,
  declaredChangeInput,
  inFlightChangeSchema,
  newPartInput,
  overlapOutcomeSchema,
  overlapReasonSchema,
  sharedPartKey,
  sharedPartKindSchema,
  sharedPartPaths,
  sharedPartSchema,
} from '../mcp/shared-changes.js';
import { statusSchema } from '../mcp/types.js';
import {
  expectedVersion,
  input,
  jsonResponse,
  noInput,
  ownerMutationOutput,
  queryBool,
} from './common.js';
import { json, route } from './route.js';

// ---- Shapes ----

const itemRef = z.object({ id: z.string(), title: z.string(), status: statusSchema });

/** A registry row (Settings → Projects → <project> → Shared parts). */
export const sharedPartOwnerRowSchema = sharedPartSchema.extend({
  /** `spt_…`: how routes address it. */
  id: z.string(),
  archived_at: z.string().nullable(),
  version: z.number().int(),
  in_flight: z.array(inFlightChangeSchema),
  lease: z
    .object({
      lease_id: z.string(),
      item_id: z.string(),
      run_id: z.string().nullable(),
      held_until: z.string(),
    })
    .nullable(),
});
export type SharedPartOwnerRow = z.infer<typeof sharedPartOwnerRowSchema>;

/**
 * What an automatic outcome rests on (decision 39), shown on both tickets:
 * each item's declared changes to the shared parts, the design note when one
 * applies, and the files a real trial merge found in conflict. A clean trial
 * merge is not evidence that the two work together.
 */
export const overlapEvidenceSchema = z.object({
  changes: z.array(
    z.object({ item: z.string(), part: z.string(), change: z.enum(SHARED_CHANGES) }),
  ),
  design_note: z.string().nullable(),
  text_conflict: z.array(z.string()),
});
export type OverlapEvidence = z.infer<typeof overlapEvidenceSchema>;

/**
 * Decision 39: the owner's review of a declared change to an approved design,
 * with or without an overlap. A Needs you card and a ticket banner while
 * `open`; it pauses this item only.
 */
export const designReviewRowSchema = z.object({
  /** `drv_…` */
  id: z.string(),
  project: z.string(),
  item: itemRef,
  /** What the owner is approving: each part, its change, and which design it alters. */
  entries: z.array(
    z.object({ part: z.string(), change: z.enum(SHARED_CHANGES), note: z.string() }),
  ),
  state: z.enum(DESIGN_REVIEW_STATES),
  /** The owner's note: required to send back, optional to approve. */
  note: z.string().nullable(),
  requested_by: z.string(),
  created_at: z.string(),
  decided_by: z.string().nullable(),
  decided_at: z.string().nullable(),
  version: z.number().int(),
  explanation: problemExplanationSchema,
});
export type DesignReviewRow = z.infer<typeof designReviewRowSchema>;

/** Two in-flight items that declare the same parts: a Needs you card while `open`. */
export const overlapRowSchema = z.object({
  /** `pov_…` */
  id: z.string(),
  project: z.string(),
  /** The item claimed first, then the other (*Run one after the other* runs them in this order). */
  items: z.tuple([itemRef, itemRef]),
  parts: z.array(z.string()),
  state: z.enum(OVERLAP_STATES),
  /** The owner's note on *They're compatible*. */
  note: z.string().nullable(),
  /** The `blocks` link *Run one after the other* added. */
  link_id: z.string().nullable(),
  raised_at: z.string(),
  decided_by: z.string().nullable(),
  decided_at: z.string().nullable(),
  version: z.number().int(),
  /** Decision 37 (B42; optional): what's wrong, what fixes it, and who acts. */
  explanation: problemExplanationSchema.optional(),
  /** Decision 39: the classification; null on a row from before it. */
  outcome: overlapOutcomeSchema.nullable().optional(),
  reason: overlapReasonSchema.nullable().optional(),
  evidence: overlapEvidenceSchema.nullable().optional(),
  /** Decision 39: why an automatic outcome reached the owner ("Not settled by agents for a day"). */
  reached_you: z.string().nullable().optional(),
});
export type OverlapRow = z.infer<typeof overlapRowSchema>;

/** A lease on a single-writer part. */
export const leaseRowSchema = z.object({
  /** `pls_…` */
  id: z.string(),
  part: z.string(),
  item_id: z.string(),
  run_id: z.string().nullable(),
  /** `claude · orca-w2`: who holds it. */
  holder: z.string().nullable(),
  taken_at: z.string(),
  expires_at: z.string(),
  ended_at: z.string().nullable(),
  end_reason: z.enum(LEASE_END_REASONS).nullable(),
});
export type LeaseRow = z.infer<typeof leaseRowSchema>;

/** A hand-off held for changes to parts the item didn't declare: a Needs you card while `open`. */
export const undeclaredHoldRowSchema = z.object({
  /** `udh_…` */
  id: z.string(),
  item: itemRef,
  /** The held packet; null when the hold came from `set_status` done. */
  packet_id: z.string().nullable(),
  via: z.enum(UNDECLARED_HOLD_VIA),
  parts: z.array(z.string()),
  /** The changed files that mapped to those parts. */
  files: z.array(z.string()),
  state: z.enum(UNDECLARED_HOLD_STATES),
  note: z.string().nullable(),
  created_at: z.string(),
  decided_by: z.string().nullable(),
  decided_at: z.string().nullable(),
  version: z.number().int(),
  /** Decision 37 (B42; optional): what's wrong, what fixes it, and who acts. */
  explanation: problemExplanationSchema.optional(),
});
export type UndeclaredHoldRow = z.infer<typeof undeclaredHoldRowSchema>;

/** A trial merge that conflicts: "Heading for a conflict with GF-240: 3 files". */
export const radarFindingRowSchema = z.object({
  /** `rdf_…` */
  id: z.string(),
  project: z.string(),
  branch_a: z.string(),
  /** The other branch: another item's, or the main branch. */
  branch_b: z.string(),
  item_a: itemRef.nullable(),
  /** Null when `branch_b` is the main branch. */
  item_b: itemRef.nullable(),
  /** B40: how the radar knew `branch_a`'s branch: `reported` or `discovered`. */
  source_a: branchSourceSchema.nullable(),
  /** B40: the same for `branch_b`; null for the main branch. */
  source_b: branchSourceSchema.nullable(),
  files: z.array(z.string()),
  seen_at: z.string(),
  cleared_at: z.string().nullable(),
  /** Decision 39: the item that merges first; the other rebases. Null for the main branch. */
  merge_first: z.string().nullable().optional(),
});
export type RadarFindingRow = z.infer<typeof radarFindingRowSchema>;

/** A branch reported for the item (B41): who reported it last and when. */
export const reportedBranchSchema = z.object({
  name: z.string(),
  /** `owner`, or the agent (`claude · orca-w3`); null for one migrated without a name. */
  reported_by: z.string().nullable(),
  reported_at: z.string(),
});
export type ReportedBranch = z.infer<typeof reportedBranchSchema>;

/**
 * The item's branches for the conflict radar (B40; B41: several). The radar
 * trial-merges every `reported` branch (by an agent or the owner, or on a
 * claim or hand-off). With none reported, it uses the one local branch it
 * found that names the item's key or Jira key (`discovered`); with several
 * matches it uses none, and `matches` lists them so the owner can add one.
 */
export const itemBranchesSchema = z.object({
  /** Up to 10, oldest first. */
  reported: z.array(reportedBranchSchema),
  /** The branch the radar found by name; it uses it only while none is reported. */
  discovered: z.string().nullable(),
  /** Several local branches name the item: the radar uses none until one is reported. */
  matches: z.array(z.string()),
});
export type ItemBranches = z.infer<typeof itemBranchesSchema>;

/** The item's Shared changes section (UI_SPEC §6.3.6). */
export const itemSharedResponse = jsonResponse({
  declaration: declarationSchema,
  /** B40, B41: the branches the radar checks for the item. */
  branches: itemBranchesSchema,
  overlaps: z.array(overlapRowSchema),
  /** Leases the item holds now. */
  leases: z.array(leaseRowSchema),
  /** Open findings for the item. */
  findings: z.array(radarFindingRowSchema),
  holds: z.array(undeclaredHoldRowSchema),
  /** Decision 39: the item's design reviews, newest first; absent when it has none. */
  design_reviews: z.array(designReviewRowSchema).optional(),
});
export type ItemSharedResponse = z.infer<typeof itemSharedResponse>;

/** The project's radar card (Settings → Shared parts). */
export const radarResponse = jsonResponse({
  project: z.string(),
  /** The repository folder as the host sees it; null when not set. */
  repo_path: z.string().nullable(),
  main_branch: z.string(),
  state: z.enum(RADAR_STATES),
  /** "Radar off: no repository" and the like, when `state` is `off`. */
  off_reason: z.string().nullable(),
  last_run_at: z.string().nullable(),
  /** B52: how long the last run took, in milliseconds; null before the first. */
  last_duration_ms: z.number().int().nonnegative().nullable(),
  /** B76: the host helper's git facts for this repository: `none` until it reports. */
  helper: z.object({
    state: z.enum(['fresh', 'stale', 'none']),
    checked_at: z.string().nullable(),
  }),
  findings: z.array(radarFindingRowSchema),
});
export type RadarResponse = z.infer<typeof radarResponse>;

// ---- GET /api/projects/:key/shared-parts ----

export const sharedProjectParams = input({ key: projectKey });
export const sharedPartsQuery = input({ include_archived: queryBool.optional() });
export const sharedPartsResponse = jsonResponse({
  project: z.string(),
  parts: z.array(sharedPartOwnerRowSchema),
});
export type SharedPartsResponse = z.infer<typeof sharedPartsResponse>;

// ---- POST /api/projects/:key/shared-parts ----

export const createSharedPartBody = input({
  key: sharedPartKey,
  /** Must match the key's prefix when given. */
  kind: sharedPartKindSchema.optional(),
  paths: sharedPartPaths.optional(),
  single_writer: z.boolean().optional(),
  note: text(LIMITS.shared_part_note).optional(),
}).superRefine((v, ctx) => {
  if (v.kind !== undefined && !v.key.startsWith(`${v.kind}:`)) {
    ctx.addIssue({ code: 'custom', path: ['kind'], message: `doesn't match the key ${v.key}` });
  }
});
export const sharedPartResult = ownerMutationOutput({ part: sharedPartOwnerRowSchema });
export type SharedPartResult = z.infer<typeof sharedPartResult>;

// ---- PATCH /api/shared-parts/:id ----

export const sharedPartParams = input({ id: objectId });
const PART_PATCH_FIELDS = ['paths', 'single_writer', 'note', 'archived'] as const;
export const patchSharedPartBody = input({
  expected_version: expectedVersion,
  paths: sharedPartPaths.optional(),
  single_writer: z.boolean().optional(),
  /** `null` clears it. */
  note: text(LIMITS.shared_part_note).nullable().optional(),
  /** True archives the part (the owner's remove); false restores it. */
  archived: z.boolean().optional(),
}).superRefine((v, ctx) => {
  if (!PART_PATCH_FIELDS.some((f) => v[f] !== undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: [],
      message: `Pass at least one of ${PART_PATCH_FIELDS.join(', ')}`,
    });
  }
});

// ---- GET and PUT /api/items/:id/shared ----

export const itemSharedParams = input({ id: itemId });
/** The owner edits the declaration with the same rules as declare_shared_changes (new parts may be single-writer). */
export const putItemSharedBody = input({
  changes: z.array(declaredChangeInput).min(1).max(LIMITS.shared_changes_max).optional(),
  none: z.literal(true).optional(),
  new_parts: z
    .array(newPartInput.extend({ single_writer: z.boolean().optional() }))
    .min(1)
    .max(LIMITS.shared_new_parts_max)
    .optional(),
}).superRefine(checkDeclaration);
export const putItemSharedResponse = ownerMutationOutput({
  ...itemSharedResponse.shape,
  registered: z.array(z.string()),
});
export type PutItemSharedResponse = z.infer<typeof putItemSharedResponse>;

// ---- POST /api/items/:id/shared/branches (B41) ----

/**
 * The owner adds a branch to the item's reported branches, or removes one
 * (B41; B40 had one branch, set or cleared). Removing the last lets the radar
 * look for one by name. `not_active` (B45; *Not an active branch*, with
 * `remove`) also keeps the radar from finding this branch by name, until Undo
 * or someone reports it again.
 */
export const postItemBranchesBody = input({
  op: z.enum(['add', 'remove']),
  branch: branchInput,
  not_active: z.boolean().optional(),
});
export const postItemBranchesResponse = ownerMutationOutput(itemSharedResponse.shape);
export type PostItemBranchesResponse = z.infer<typeof postItemBranchesResponse>;

// ---- POST /api/overlaps/:id/decide ----

export const overlapParams = input({ id: objectId });
export const decideOverlapBody = input({
  /** *Run one after the other* (`sequence`) or *They're compatible*. */
  decision: z.enum(OVERLAP_DECISIONS),
  /** With `compatible`, posted to both items as an owner note. */
  note: text(LIMITS.shared_decision_note).optional(),
}).superRefine((v, ctx) => {
  if (v.decision === 'sequence' && v.note !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['note'], message: 'A note goes with compatible.' });
  }
});
export const decideOverlapResponse = ownerMutationOutput({ overlap: overlapRowSchema });
export type DecideOverlapResponse = z.infer<typeof decideOverlapResponse>;

// ---- POST /api/overlaps/:id/overrule (decision 39) ----

/**
 * The owner overrules an automatic outcome from the ticket: *Run in parallel*
 * or *Run in order*. Undoable, unlike a decision on an owner question.
 */
export const overruleOverlapBody = input({ decision: z.enum(OVERLAP_OVERRULES) });
export const overruleOverlapResponse = ownerMutationOutput({ overlap: overlapRowSchema });
export type OverruleOverlapResponse = z.infer<typeof overruleOverlapResponse>;

// ---- GET and PUT /api/settings/overlap-handling (decision 39) ----

const overlapHandlingSchema = z.enum(OVERLAP_HANDLING);

/** Settings → Overlap handling: the global default and each project's optional override. */
export const overlapHandlingResponse = jsonResponse({
  default: overlapHandlingSchema,
  projects: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      /** Null follows the default. */
      override: overlapHandlingSchema.nullable(),
      effective: overlapHandlingSchema,
    }),
  ),
});
export type OverlapHandlingResponse = z.infer<typeof overlapHandlingResponse>;

/** Owner only (no MCP tool). With `project`, `mode: null` clears the override. */
export const putOverlapHandlingBody = input({
  project: projectKey.optional(),
  mode: overlapHandlingSchema.nullable(),
}).superRefine((v, ctx) => {
  if (v.project === undefined && v.mode === null) {
    ctx.addIssue({ code: 'custom', path: ['mode'], message: 'The default needs a mode.' });
  }
});
export const putOverlapHandlingResponse = ownerMutationOutput(overlapHandlingResponse.shape);
export type PutOverlapHandlingResponse = z.infer<typeof putOverlapHandlingResponse>;

// ---- POST /api/design-reviews/:id/decide (decision 39) ----

export const designReviewParams = input({ id: objectId });
/** Owner only, undoable. `expected_version` is the version the owner read. */
export const decideDesignReviewBody = input({
  expected_version: expectedVersion,
  decision: z.enum(DESIGN_REVIEW_DECISIONS),
  /** Required with `send_back`; posted to the item as an owner note. */
  note: text(LIMITS.shared_decision_note).optional(),
}).superRefine((v, ctx) => {
  if (v.decision === 'send_back' && !v.note?.trim()) {
    ctx.addIssue({ code: 'custom', path: ['note'], message: 'Say what to do instead.' });
  }
});
export const decideDesignReviewResponse = ownerMutationOutput({ review: designReviewRowSchema });
export type DecideDesignReviewResponse = z.infer<typeof decideDesignReviewResponse>;

// ---- POST /api/undeclared-holds/:id/decide ----

export const holdParams = input({ id: objectId });
export const decideHoldBody = input({
  /** *Add to the declaration* (`add`) or *Send back*. */
  decision: z.enum(UNDECLARED_DECISIONS),
  /** With `send_back`, posted to the item as an owner note. */
  note: text(LIMITS.shared_decision_note).optional(),
});
export const decideHoldResponse = ownerMutationOutput({ hold: undeclaredHoldRowSchema });
export type DecideHoldResponse = z.infer<typeof decideHoldResponse>;

// ---- POST /api/leases/:id/release ----

export const leaseParams = input({ id: objectId });
export const releaseLeaseResponse = ownerMutationOutput({ lease: leaseRowSchema });
export type ReleaseLeaseResponse = z.infer<typeof releaseLeaseResponse>;

// ---- GET and PUT /api/projects/:key/radar, POST /api/projects/:key/radar/run ----

export const putRadarBody = input({
  /** A repository folder inside `DOCKET_PUSH_ROOT`; `null` turns the radar off. */
  repo_path: text(LIMITS.workspace_path).nullable(),
  /** Default `main`. */
  main_branch: text(LIMITS.branch).optional(),
});
export const putRadarResponse = ownerMutationOutput({ radar: radarResponse });
export type PutRadarResponse = z.infer<typeof putRadarResponse>;
export const runRadarResponse = ownerMutationOutput({ radar: radarResponse });
export type RunRadarResponse = z.infer<typeof runRadarResponse>;

// ---- Routes ----

export const sharedChangesRoutes = {
  'sharedParts.list': route({
    method: 'GET',
    path: '/api/projects/:key/shared-parts',
    group: 'shared',
    params: sharedProjectParams,
    query: sharedPartsQuery,
    body: null,
    response: json(sharedPartsResponse),
  }),
  'sharedParts.create': route({
    method: 'POST',
    path: '/api/projects/:key/shared-parts',
    group: 'shared',
    params: sharedProjectParams,
    query: noInput,
    body: createSharedPartBody,
    response: json(sharedPartResult),
    undoable: true,
  }),
  /** Paths, single-writer, note, archive (the owner's remove) and restore. */
  'sharedParts.update': route({
    method: 'PATCH',
    path: '/api/shared-parts/:id',
    group: 'shared',
    params: sharedPartParams,
    query: noInput,
    body: patchSharedPartBody,
    response: json(sharedPartResult),
    undoable: true,
  }),
  'itemShared.get': route({
    method: 'GET',
    path: '/api/items/:id/shared',
    group: 'shared',
    params: itemSharedParams,
    query: noInput,
    body: null,
    response: json(itemSharedResponse),
  }),
  'itemShared.put': route({
    method: 'PUT',
    path: '/api/items/:id/shared',
    group: 'shared',
    params: itemSharedParams,
    query: noInput,
    body: putItemSharedBody,
    response: json(putItemSharedResponse),
    undoable: true,
  }),
  /** B41: add or remove one of the item's branches for the radar (undoable). */
  'itemShared.branches': route({
    method: 'POST',
    path: '/api/items/:id/shared/branches',
    group: 'shared',
    params: itemSharedParams,
    query: noInput,
    body: postItemBranchesBody,
    response: json(postItemBranchesResponse),
    undoable: true,
  }),
  'overlaps.decide': route({
    method: 'POST',
    path: '/api/overlaps/:id/decide',
    group: 'shared',
    params: overlapParams,
    query: noInput,
    body: decideOverlapBody,
    response: json(decideOverlapResponse),
  }),
  /** Decision 39: *Run in parallel* or *Run in order* on an automatic outcome (undoable). */
  'overlaps.overrule': route({
    method: 'POST',
    path: '/api/overlaps/:id/overrule',
    group: 'shared',
    params: overlapParams,
    query: noInput,
    body: overruleOverlapBody,
    response: json(overruleOverlapResponse),
    undoable: true,
  }),
  /** Decision 39: Settings → Overlap handling. */
  'overlapHandling.get': route({
    method: 'GET',
    path: '/api/settings/overlap-handling',
    group: 'shared',
    params: noInput,
    query: noInput,
    body: null,
    response: json(overlapHandlingResponse),
  }),
  'overlapHandling.set': route({
    method: 'PUT',
    path: '/api/settings/overlap-handling',
    group: 'shared',
    params: noInput,
    query: noInput,
    body: putOverlapHandlingBody,
    response: json(putOverlapHandlingResponse),
  }),
  /** Decision 39: *Approve the design change* or *Send back* (undoable). */
  'designReviews.decide': route({
    method: 'POST',
    path: '/api/design-reviews/:id/decide',
    group: 'shared',
    params: designReviewParams,
    query: noInput,
    body: decideDesignReviewBody,
    response: json(decideDesignReviewResponse),
    undoable: true,
  }),
  'undeclaredHolds.decide': route({
    method: 'POST',
    path: '/api/undeclared-holds/:id/decide',
    group: 'shared',
    params: holdParams,
    query: noInput,
    body: decideHoldBody,
    response: json(decideHoldResponse),
  }),
  /** *Release lease* in the item's Shared changes section. */
  'leases.release': route({
    method: 'POST',
    path: '/api/leases/:id/release',
    group: 'shared',
    params: leaseParams,
    query: noInput,
    body: noInput,
    response: json(releaseLeaseResponse),
  }),
  'radar.get': route({
    method: 'GET',
    path: '/api/projects/:key/radar',
    group: 'shared',
    params: sharedProjectParams,
    query: noInput,
    body: null,
    response: json(radarResponse),
  }),
  'radar.settings': route({
    method: 'PUT',
    path: '/api/projects/:key/radar',
    group: 'shared',
    params: sharedProjectParams,
    query: noInput,
    body: putRadarBody,
    response: json(putRadarResponse),
  }),
  /** *Run radar now*. */
  'radar.run': route({
    method: 'POST',
    path: '/api/projects/:key/radar/run',
    group: 'shared',
    params: sharedProjectParams,
    query: noInput,
    body: noInput,
    response: json(runRadarResponse),
  }),
} as const;
