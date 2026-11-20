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
  LEASE_END_REASONS,
  OVERLAP_DECISIONS,
  OVERLAP_STATES,
  RADAR_STATES,
  UNDECLARED_DECISIONS,
  UNDECLARED_HOLD_STATES,
  UNDECLARED_HOLD_VIA,
} from '../enums.js';
import { itemId, objectId, projectKey, text } from '../mcp/common.js';
import { LIMITS } from '../mcp/limits.js';
import {
  branchInput,
  branchSourceSchema,
  checkDeclaration,
  declarationSchema,
  declaredChangeInput,
  inFlightChangeSchema,
  newPartInput,
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
});
export type RadarFindingRow = z.infer<typeof radarFindingRowSchema>;

/**
 * The item's branch for the conflict radar (B40). `name` is the branch the
 * radar trial-merges: the latest reported one (by an agent or the owner, or
 * on a claim, run or packet), else the one local branch the radar found that
 * names the item's key or Jira key. With several matches it uses none, and
 * `matches` lists them so the owner can report one.
 */
export const itemBranchSchema = z.object({
  /** The branch the radar uses; null when it has none. */
  name: z.string().nullable(),
  /** `reported` or `discovered`; null when `name` is null. */
  source: branchSourceSchema.nullable(),
  /** Who last reported or cleared the branch (`owner`, `claude · orca-w3`), and when. */
  reported_by: z.string().nullable(),
  reported_at: z.string().nullable(),
  /** Several local branches name the item: the radar uses none until one is reported. */
  matches: z.array(z.string()),
});
export type ItemBranch = z.infer<typeof itemBranchSchema>;

/** The item's Shared changes section (UI_SPEC §6.3.6). */
export const itemSharedResponse = jsonResponse({
  declaration: declarationSchema,
  /** B40: the branch the radar uses for the item. */
  branch: itemBranchSchema,
  overlaps: z.array(overlapRowSchema),
  /** Leases the item holds now. */
  leases: z.array(leaseRowSchema),
  /** Open findings for the item. */
  findings: z.array(radarFindingRowSchema),
  holds: z.array(undeclaredHoldRowSchema),
});
export type ItemSharedResponse = z.infer<typeof itemSharedResponse>;

/** The project's radar card (Settings → Shared parts). */
export const radarResponse = jsonResponse({
  project: z.string(),
  /** Inside `DOCKET_PUSH_ROOT`; null when not set. */
  repo_path: z.string().nullable(),
  main_branch: z.string(),
  state: z.enum(RADAR_STATES),
  /** "Radar off: no repository" and the like, when `state` is `off`. */
  off_reason: z.string().nullable(),
  last_run_at: z.string().nullable(),
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

// ---- PUT /api/items/:id/shared/branch (B40) ----

/** The owner reports the item's branch, or clears it (`null`): the radar then looks for one. */
export const putItemBranchBody = input({
  branch: branchInput.nullable(),
});
export const putItemBranchResponse = ownerMutationOutput(itemSharedResponse.shape);
export type PutItemBranchResponse = z.infer<typeof putItemBranchResponse>;

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
  /** B40: set or clear the item's branch for the radar (undoable). */
  'itemShared.branch': route({
    method: 'PUT',
    path: '/api/items/:id/shared/branch',
    group: 'shared',
    params: itemSharedParams,
    query: noInput,
    body: putItemBranchBody,
    response: json(putItemBranchResponse),
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
