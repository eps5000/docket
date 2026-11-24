/**
 * Planning and housekeeping: quick capture, the owner's field and text edits,
 * cancel, archive, the label page and document content (BUILD_SPEC §5.1,
 * §5.8, §5.10, §7; contracts/ui-api.md US7; decisions 22 and 23).
 * Shared contract file (tasks.md, Slice rules).
 */
import { z } from 'zod';
import { itemId, longText, objectId, projectKey, text } from '../mcp/common.js';
import { labelNameSchema } from '../mcp/items.js';
import { LIMITS, TEXT_LIMITS } from '../mcp/limits.js';
import {
  decisionRecordSchema,
  itemSummarySchema,
  itemTypeSchema,
  prioritySchema,
} from '../mcp/types.js';
import { expectedVersion, input, jsonResponse, noInput, ownerMutationOutput } from './common.js';
import { json, route } from './route.js';
import { SHAPING_NOTE_MAX } from '../shaping.js';
import { itemTextSchema, labelSchema } from './types.js';

const itemParams = input({ id: itemId });
const itemResult = ownerMutationOutput({ item: itemSummarySchema });

// ---- POST /api/items (quick capture) ----

export const createItemBody = input({
  title: text(TEXT_LIMITS.title),
  type: itemTypeSchema,
  project: projectKey,
  /** An Epic in the same project. */
  epic: itemId.optional(),
  /** Becomes the description. */
  notes: longText(TEXT_LIMITS.markdown).optional(),
});
export const createItemResponse = itemResult;

// ---- PATCH /api/items/:id ----

const PATCH_FIELDS = [
  'priority',
  'status',
  'title',
  'description_md',
  'outcome_md',
  'acceptance',
  'request_shaping',
] as const;

/**
 * Priority, the owner's status moves, and inline text edits (decision 22).
 * Same limits, secret checks and conflict handling as agents; a stale
 * `expected_version` is `409` with `current`.
 */
export const patchItemBody = input({
  expected_version: expectedVersion,
  priority: prioritySchema.optional(),
  status: z.enum(['planning', 'ready']).optional(),
  title: text(TEXT_LIMITS.title).optional(),
  description_md: longText(TEXT_LIMITS.markdown).optional(),
  outcome_md: longText(TEXT_LIMITS.markdown).optional(),
  acceptance: z.array(text(TEXT_LIMITS.step)).optional(),
  /**
   * Decision 36 (BUILD_SPEC §5.21 Ready gate): moving an item that hasn't
   * declared its shared changes to Ready needs a reason, recorded in Activity.
   */
  override_reason: text(LIMITS.shared_decision_note).optional(),
  /**
   * Decision 58: moving a Planning ticket with open known gaps to Ready
   * approves them, recorded as an owner decision on the ticket.
   */
  approve_gaps: z.literal(true).optional(),
  /**
   * Decision 65: *Ask a planner to shape this*, from a refused Move to Ready.
   * Marks the ticket Needs shaping with the owner's note; not with `status`.
   */
  request_shaping: z.strictObject({ note: text(SHAPING_NOTE_MAX).optional() }).optional(),
}).superRefine((v, ctx) => {
  if (v.request_shaping !== undefined && v.status !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['request_shaping'],
      message: 'Ask for shaping without moving the ticket.',
    });
  }
  if (v.approve_gaps !== undefined && v.status !== 'ready') {
    ctx.addIssue({
      code: 'custom',
      path: ['approve_gaps'],
      message: 'Approving known gaps goes with status ready.',
    });
  }
  if (v.override_reason !== undefined && v.status !== 'ready') {
    ctx.addIssue({
      code: 'custom',
      path: ['override_reason'],
      message: 'An override reason goes with status ready.',
    });
  }
  if (!PATCH_FIELDS.some((f) => v[f] !== undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: [],
      message: `Pass at least one of ${PATCH_FIELDS.join(', ')}`,
    });
  }
});
export const patchItemResponse = ownerMutationOutput({ item: itemTextSchema });

// ---- Archive and cancel ----

export const archiveManyBody = input({ ids: z.array(itemId).min(1).max(500) });
export const archiveManyResponse = ownerMutationOutput({ archived: z.array(z.string()) });

/** *Cancel item…* (owner decision 23): reason optional; undo restores the status, not the run. */
export const cancelItemBody = input({
  expected_version: expectedVersion,
  reason: text(TEXT_LIMITS.note).optional(),
});

// ---- The label page ----

export const labelParams = input({ project: projectKey, name: labelNameSchema });
export const labelPageResponse = jsonResponse({
  label: labelSchema,
  counts: z.object({
    total: z.number().int(),
    done: z.number().int(),
    planning: z.number().int(),
  }),
  by_epic: z.array(
    z.object({
      epic: z.object({ id: z.string(), title: z.string() }).nullable(),
      done: z.number().int(),
      total: z.number().int(),
      items: z.array(itemSummarySchema),
    }),
  ),
  decisions: z.array(decisionRecordSchema),
});
export type LabelPageResponse = z.infer<typeof labelPageResponse>;
export const moveToReadyResponse = ownerMutationOutput({ moved: z.array(z.string()) });

// ---- Document content ----

export const documentParams = input({ versionId: objectId });

export const planningRoutes = {
  'items.create': route({
    method: 'POST',
    path: '/api/items',
    group: 'planning',
    params: noInput,
    query: noInput,
    body: createItemBody,
    response: json(createItemResponse),
    undoable: true,
  }),
  'items.patch': route({
    method: 'PATCH',
    path: '/api/items/:id',
    group: 'planning',
    params: itemParams,
    query: noInput,
    body: patchItemBody,
    response: json(patchItemResponse),
    undoable: true,
  }),
  'items.archive': route({
    method: 'POST',
    path: '/api/items/:id/archive',
    group: 'planning',
    params: itemParams,
    query: noInput,
    body: noInput,
    response: json(itemResult),
    undoable: true,
  }),
  'items.unarchive': route({
    method: 'POST',
    path: '/api/items/:id/unarchive',
    group: 'planning',
    params: itemParams,
    query: noInput,
    body: noInput,
    response: json(itemResult),
    undoable: true,
  }),
  /** *Archive all* on the Done column. */
  'archive.many': route({
    method: 'POST',
    path: '/api/archive',
    group: 'planning',
    params: noInput,
    query: noInput,
    body: archiveManyBody,
    response: json(archiveManyResponse),
    undoable: true,
  }),
  'items.cancel': route({
    method: 'POST',
    path: '/api/items/:id/cancel',
    group: 'planning',
    params: itemParams,
    query: noInput,
    body: cancelItemBody,
    response: json(itemResult),
    undoable: true,
  }),
  'labels.get': route({
    method: 'GET',
    path: '/api/labels/:project/:name',
    group: 'planning',
    params: labelParams,
    query: noInput,
    body: null,
    response: json(labelPageResponse),
  }),
  'labels.moveToReady': route({
    method: 'POST',
    path: '/api/labels/:project/:name/move-to-ready',
    group: 'planning',
    params: labelParams,
    query: noInput,
    body: noInput,
    response: json(moveToReadyResponse),
    undoable: true,
  }),
  /** Preview or download; `Content-Disposition` and `nosniff` (BUILD_SPEC §5.10). */
  'documents.content': route({
    method: 'GET',
    path: '/api/documents/:versionId/content',
    group: 'planning',
    params: documentParams,
    query: noInput,
    body: null,
    response: { kind: 'file' },
  }),
} as const;
