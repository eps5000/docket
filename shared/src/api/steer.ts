/**
 * Steering a ticket: answers, notes, lead actions, and the owner's own
 * checklist entries (BUILD_SPEC §5.3, §5.5, §5.7, §7; contracts/ui-api.md
 * US6). Shared contract file (tasks.md, Slice rules).
 */
import { z } from 'zod';
import { SPLIT_RELATIONS } from '../enums.js';
import { itemId, objectId, text } from '../mcp/common.js';
import { splitCarry } from '../mcp/items.js';
import { QUESTION_FORM, TEXT_LIMITS } from '../mcp/limits.js';
import { getStepOutput, stepDetails } from '../mcp/checklist.js';
import {
  checkSchema,
  humanReviewItemSchema,
  itemSummarySchema,
  questionSchema,
  workStepSchema,
} from '../mcp/types.js';
import { expectedVersion, input, jsonResponse, noInput, ownerMutationOutput } from './common.js';
import { json, route } from './route.js';

const itemParams = input({ id: itemId });
const removed = ownerMutationOutput({ removed: z.literal(true) });

// ---- Messages ----

/**
 * Either `text` (a free-text answer) or `option` (the label of one of the
 * question's options, with an optional `note`; decision 47). The service
 * checks which, because only it knows the question's options.
 */
export const answerBody = input({
  question_id: objectId,
  text: text(TEXT_LIMITS.question).optional(),
  option: text(QUESTION_FORM.label).optional(),
  note: text(QUESTION_FORM.note).optional(),
});
export const answerResponse = ownerMutationOutput({ question: questionSchema });

/** Decision 48: split this ticket; the same fields as `create_item`'s `split_from`. */
export const splitItemBody = input({
  expected_version: expectedVersion,
  type: z.enum(['Story', 'Task', 'Bug']),
  title: text(TEXT_LIMITS.title),
  move: z.array(z.number().int()),
  copy: z.array(z.number().int()).optional(),
  relation: z.enum(SPLIT_RELATIONS),
  also: z.array(splitCarry).optional(),
});
export const splitItemResponse = ownerMutationOutput({
  /** The new ticket. */
  item: itemSummarySchema,
  /** The original, after the split. */
  source: itemSummarySchema,
});

export const noteBody = input({ text: text(TEXT_LIMITS.note) });
export const noteResponse = ownerMutationOutput({
  note: z.object({ id: z.string(), text: z.string(), at: z.string() }),
});

// ---- Lead and runs ----

/** *Release lead claim* and *Return to Ready*: confirmed in the UI, focus on Cancel. */
export const leadActionBody = input({
  expected_version: expectedVersion.optional(),
  reason: text(TEXT_LIMITS.note).optional(),
});
export const leadActionResponse = ownerMutationOutput({ item: itemSummarySchema });

// ---- Owner work steps and checks ----

export const addStepBody = input({
  text: text(TEXT_LIMITS.step),
  /** Insert after this step; otherwise at the end. */
  after: objectId.optional(),
});
export const addStepResponse = ownerMutationOutput({ step: workStepSchema });
export const stepParams = input({ id: itemId, stepId: objectId });

/**
 * The step dialog's *Edit details* (decision 33; UI_SPEC §6.3.1a): the new
 * Markdown (`null` or empty clears it) and the `details_version` the owner
 * opened, checked like any `expected_version` (a stale one is `409 conflict`).
 */
export const stepDetailsBody = input({
  details: stepDetails,
  expected_version: expectedVersion,
});
/** The step with its details (`details_md`, `details_version`). */
export const stepDetailsResponse = ownerMutationOutput({ step: workStepSchema });

/**
 * The step dialog's contents (decision 33; UI_SPEC §6.3.1a; B34): the step
 * with its details and its history, exactly as `get_step` reads them, plus
 * the project's Jira site, the normalised origin its latest Jira import
 * recorded (`https://example.atlassian.net`), so a Jira key in `source`
 * links to the issue. Null when the project wasn't imported from Jira.
 */
export const stepResponse = jsonResponse({
  step: getStepOutput.shape.step,
  history: getStepOutput.shape.history,
  jira_site: z.string().nullable(),
});
export type StepResponse = z.infer<typeof stepResponse>;

export const addCheckBody = input({ text: text(TEXT_LIMITS.step) });
export const addCheckResponse = ownerMutationOutput({ check: checkSchema });
export const checkParams = input({ id: itemId, checkId: objectId });

// ---- Human review items ----

export const addHumanReviewBody = input({ text: text(TEXT_LIMITS.step) });
export const humanReviewParams = input({ id: itemId, hrId: objectId });
export const updateHumanReviewBody = input({
  expected_version: expectedVersion,
  text: text(TEXT_LIMITS.step),
});
export const removeHumanReviewBody = input({ expected_version: expectedVersion.optional() });
export const humanReviewResponse = ownerMutationOutput({ hr_item: humanReviewItemSchema });

export const steerRoutes = {
  'items.answer': route({
    method: 'POST',
    path: '/api/items/:id/answer',
    group: 'steer',
    params: itemParams,
    query: noInput,
    body: answerBody,
    response: json(answerResponse),
    undoable: true,
  }),
  'items.split': route({
    method: 'POST',
    path: '/api/items/:id/split',
    group: 'steer',
    params: itemParams,
    query: noInput,
    body: splitItemBody,
    response: json(splitItemResponse),
    undoable: true,
  }),
  'items.addNote': route({
    method: 'POST',
    path: '/api/items/:id/notes',
    group: 'steer',
    params: itemParams,
    query: noInput,
    body: noteBody,
    response: json(noteResponse),
    undoable: true,
  }),
  'items.release': route({
    method: 'POST',
    path: '/api/items/:id/release',
    group: 'steer',
    params: itemParams,
    query: noInput,
    body: leadActionBody,
    response: json(leadActionResponse),
    undoable: true,
  }),
  'items.returnToReady': route({
    method: 'POST',
    path: '/api/items/:id/return-to-ready',
    group: 'steer',
    params: itemParams,
    query: noInput,
    body: leadActionBody,
    response: json(leadActionResponse),
    undoable: true,
  }),
  'steps.add': route({
    method: 'POST',
    path: '/api/items/:id/work',
    group: 'steer',
    params: itemParams,
    query: noInput,
    body: addStepBody,
    response: json(addStepResponse),
    undoable: true,
  }),
  /** The step dialog: one step in full, with its history and the project's Jira site (decision 33; B34). */
  'steps.get': route({
    method: 'GET',
    path: '/api/items/:id/work/:stepId',
    group: 'steer',
    params: stepParams,
    query: noInput,
    body: null,
    response: json(stepResponse),
  }),
  /** The owner's own undone steps only (BUILD_SPEC §5.5). */
  'steps.remove': route({
    method: 'DELETE',
    path: '/api/items/:id/work/:stepId',
    group: 'steer',
    params: stepParams,
    query: noInput,
    body: noInput,
    response: json(removed),
    undoable: true,
  }),
  /** Edit a step's details from the step dialog, any step on the current plan (decision 33). */
  'steps.details': route({
    method: 'PATCH',
    path: '/api/items/:id/work/:stepId/details',
    group: 'steer',
    params: stepParams,
    query: noInput,
    body: stepDetailsBody,
    response: json(stepDetailsResponse),
    undoable: true,
  }),
  'checks.add': route({
    method: 'POST',
    path: '/api/items/:id/checks',
    group: 'steer',
    params: itemParams,
    query: noInput,
    body: addCheckBody,
    response: json(addCheckResponse),
    undoable: true,
  }),
  /** The owner's own checks while still todo (BUILD_SPEC §5.5). */
  'checks.remove': route({
    method: 'DELETE',
    path: '/api/items/:id/checks/:checkId',
    group: 'steer',
    params: checkParams,
    query: noInput,
    body: noInput,
    response: json(removed),
    undoable: true,
  }),
  'humanReview.add': route({
    method: 'POST',
    path: '/api/items/:id/human-review',
    group: 'steer',
    params: itemParams,
    query: noInput,
    body: addHumanReviewBody,
    response: json(humanReviewResponse),
    undoable: true,
  }),
  'humanReview.update': route({
    method: 'PATCH',
    path: '/api/items/:id/human-review/:hrId',
    group: 'steer',
    params: humanReviewParams,
    query: noInput,
    body: updateHumanReviewBody,
    response: json(humanReviewResponse),
    undoable: true,
  }),
  'humanReview.remove': route({
    method: 'DELETE',
    path: '/api/items/:id/human-review/:hrId',
    group: 'steer',
    params: humanReviewParams,
    query: noInput,
    body: removeHumanReviewBody,
    response: json(removed),
    undoable: true,
  }),
} as const;
