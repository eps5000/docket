/**
 * Decision records for the owner (BUILD_SPEC §5.14, §7; contracts/ui-api.md
 * US5). The fields match `publish_decision`, `list_decisions` and
 * `withdraw_decision` (MCP_SPEC §5.8); the owner's records carry
 * `authority=owner`. Shared contract file (tasks.md, Slice rules).
 */
import { z } from 'zod';
import { DECISION_SCOPE_KINDS } from '../enums.js';
import { cursor, objectId, projectKey, text } from '../mcp/common.js';
import { LIMITS } from '../mcp/limits.js';
import { decisionScopeInputSchema } from '../mcp/review.js';
import { decisionRecordSchema } from '../mcp/types.js';
import {
  expectedVersion,
  input,
  jsonResponse,
  noInput,
  ownerMutationOutput,
  queryBool,
} from './common.js';
import { json, route } from './route.js';

export const decisionsQuery = input({
  project: projectKey,
  scope_kind: z.enum(DECISION_SCOPE_KINDS).optional(),
  /** Required with `scope_kind` other than `project`. */
  scope_id: objectId.optional(),
  include_inactive: queryBool.default(false),
  cursor: cursor.optional(),
}).superRefine((v, ctx) => {
  if (v.scope_id !== undefined && v.scope_kind === undefined) {
    ctx.addIssue({ code: 'custom', path: ['scope_kind'], message: 'Required with scope_id.' });
  }
  if (v.scope_kind !== undefined && v.scope_kind !== 'project' && v.scope_id === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['scope_id'],
      message: `Required for scope kind ${v.scope_kind}.`,
    });
  }
});
export const decisionsResponse = jsonResponse({
  items: z.array(decisionRecordSchema),
  next_cursor: z.string().nullable(),
});

export const publishDecisionBody = input({
  project: projectKey,
  scope: decisionScopeInputSchema,
  title: text(LIMITS.decision_title),
  decision: text(LIMITS.decision_md),
  rationale: text(LIMITS.rationale_md).optional(),
  /** The owner may supersede any record. */
  supersedes: objectId.optional(),
});
export const decisionResponse = ownerMutationOutput({ decision: decisionRecordSchema });

export const decisionParams = input({ id: objectId });
export const confirmDecisionBody = input({ expected_version: expectedVersion.optional() });
export const withdrawDecisionBody = input({
  reason: text(LIMITS.withdraw_reason),
  expected_version: expectedVersion.optional(),
});

/**
 * *Acknowledge* on Needs you (owner decision 38; B44): keep agents'
 * project-wide records as agent decisions and take them off Needs you. One
 * record from its card, or every record of a grouped card.
 */
export const acknowledgeDecisionsBody = input({
  // A grouped card sends all its records (one project's, at most a few hundred).
  decision_ids: z.array(objectId).min(1).max(500),
});
export const acknowledgeDecisionsResponse = ownerMutationOutput({
  decisions: z.array(decisionRecordSchema),
});

export const decisionsRoutes = {
  'decisions.list': route({
    method: 'GET',
    path: '/api/decisions',
    group: 'decisions',
    params: noInput,
    query: decisionsQuery,
    body: null,
    response: json(decisionsResponse),
  }),
  'decisions.create': route({
    method: 'POST',
    path: '/api/decisions',
    group: 'decisions',
    params: noInput,
    query: noInput,
    body: publishDecisionBody,
    response: json(decisionResponse),
    undoable: true,
  }),
  /** Sets `authority=owner` and `confirmed_at` on an agent record. */
  'decisions.confirm': route({
    method: 'POST',
    path: '/api/decisions/:id/confirm',
    group: 'decisions',
    params: decisionParams,
    query: noInput,
    body: confirmDecisionBody,
    response: json(decisionResponse),
    undoable: true,
  }),
  'decisions.withdraw': route({
    method: 'POST',
    path: '/api/decisions/:id/withdraw',
    group: 'decisions',
    params: decisionParams,
    query: noInput,
    body: withdrawDecisionBody,
    response: json(decisionResponse),
    undoable: true,
  }),
  /** Decision 38: sets `acknowledged_at`; the records stay agent decisions. */
  'decisions.acknowledge': route({
    method: 'POST',
    path: '/api/decisions/acknowledge',
    group: 'decisions',
    params: noInput,
    query: noInput,
    body: acknowledgeDecisionsBody,
    response: json(acknowledgeDecisionsResponse),
    undoable: true,
  }),
} as const;
