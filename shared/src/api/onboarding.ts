/**
 * New project and onboarding review (owner decision 31; BUILD_SPEC §4,
 * §5.20, §7; UI_SPEC §6.7d; contracts/ui-api.md US15): the owner's *New
 * project* in Settings, and the review of an agent's onboarding from one
 * card on Needs you. Shared contract file (tasks.md, Slice rules).
 *
 * B29 resolutions (listed in the B29 PR):
 * - `POST /api/projects` is in the `settings` group, follows the key and
 *   tombstone rules (§5.12, US9), and is not undoable.
 * - `GET /api/onboarding`: `project` omitted lists every project; `state`
 *   omitted lists every state. Newest first.
 * - *Mark reviewed* is not undoable.
 */
import { z } from 'zod';
import { ONBOARDING_STATES } from '../enums.js';
import { objectId, projectKey } from '../mcp/common.js';
import { onboardingChangesSchema, projectColor, projectName } from '../mcp/onboarding.js';
import { input, jsonResponse, noInput, ownerMutationOutput } from './common.js';
import { json, route } from './route.js';
import { satisfiedWhenSchema } from '../mcp/types.js';
import { projectSchema } from './types.js';

// ---- Shapes ----

/** One onboarding session (UI_SPEC §6.7d, the Needs you review card). */
export const onboardingSessionSchema = z.object({
  id: z.string(),
  project: z.string(),
  project_name: z.string(),
  /** `claude · orca-w3`: who started it. */
  started_by: z.string(),
  /** The run it was started under, if any. */
  run_id: z.string().nullable(),
  state: z.enum(ONBOARDING_STATES),
  /** The agent's summary; null while in progress. */
  summary: z.string().nullable(),
  questions: z.array(z.string()),
  /** What the session changed: the card's counts, each linking to a filtered view. */
  changes: onboardingChangesSchema,
  /** The proposed Workflow notes, linking to the proposal; null when none was proposed. */
  workflow_proposal_id: z.string().nullable(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
  reviewed_at: z.string().nullable(),
});
export type OnboardingSession = z.infer<typeof onboardingSessionSchema>;

// ---- POST /api/projects ----

export const createProjectBody = input({
  /** 2–5 uppercase letters; the UI uppercases as you type. */
  key: projectKey,
  name: projectName,
  color: projectColor.optional(),
  /** *Blockers clear when*; the default is done. */
  default_satisfied_when: satisfiedWhenSchema.optional(),
});
export const createProjectResponse = ownerMutationOutput({ project: projectSchema });
export type CreateProjectResponse = z.infer<typeof createProjectResponse>;

// ---- GET /api/onboarding?project&state ----

export const onboardingQuery = input({
  project: projectKey.optional(),
  state: z.enum(ONBOARDING_STATES).optional(),
});
export const onboardingListResponse = jsonResponse({
  sessions: z.array(onboardingSessionSchema),
});
export type OnboardingListResponse = z.infer<typeof onboardingListResponse>;

// ---- POST /api/onboarding/:id/reviewed ----

export const onboardingParams = input({ id: objectId });
export const onboardingReviewedResponse = ownerMutationOutput({ session: onboardingSessionSchema });
export type OnboardingReviewedResponse = z.infer<typeof onboardingReviewedResponse>;

// ---- Routes ----

export const onboardingRoutes = {
  /** *New project* (Settings). Not undoable. */
  'projects.create': route({
    method: 'POST',
    path: '/api/projects',
    group: 'settings',
    params: noInput,
    query: noInput,
    body: createProjectBody,
    response: json(createProjectResponse),
  }),
  'onboarding.list': route({
    method: 'GET',
    path: '/api/onboarding',
    group: 'onboarding',
    params: noInput,
    query: onboardingQuery,
    body: null,
    response: json(onboardingListResponse),
  }),
  /** *Mark reviewed* on the review card. Not undoable. */
  'onboarding.reviewed': route({
    method: 'POST',
    path: '/api/onboarding/:id/reviewed',
    group: 'onboarding',
    params: onboardingParams,
    query: noInput,
    body: noInput,
    response: json(onboardingReviewedResponse),
  }),
} as const;
