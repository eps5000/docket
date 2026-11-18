/**
 * Onboarding (MCP_SPEC §5.11; owner decision 31; BUILD_SPEC §5.20):
 * `onboard_project` (create or adopt a project, start an onboarding session,
 * return the guide) and `finish_onboarding` (hand the session to the owner
 * for review), and the arguments of the `onboard` prompt. Shared contract
 * file (tasks.md, Slice rules).
 *
 * B29 resolutions (listed in the B29 PR): `key` follows the project-key rule
 * (2–5 uppercase letters); `name` is 1–100 characters, trimmed, and required
 * only when the key is free (the service checks it: `validation`); `color`
 * is `#rrggbb`; the summary is 1–4,000 characters and up to 20 questions of
 * 1–500. Both tools are mutating and not retry-safe.
 */
import { z } from 'zod';
import { mutationInput, mutationOutput, objectId, projectKey, text } from './common.js';
import { COLOR_RE, LIMITS } from './limits.js';

// ---- Building blocks ----

/** A project's name (B29: 1–100 characters, trimmed). */
export const projectName = text(LIMITS.project_name);

/** A project colour: `#rrggbb`. */
export const projectColor = z
  .string()
  .trim()
  .regex(COLOR_RE, { error: 'Expected a colour like #3b5bdb.' });

/** How many changes an onboarding session made (MCP_SPEC §5.11; the review card's counts). */
export const onboardingChangesSchema = z.object({
  created: z.number().int(),
  enriched: z.number().int(),
  documents: z.number().int(),
  decisions: z.number().int(),
  proposals: z.number().int(),
});
export type OnboardingChanges = z.infer<typeof onboardingChangesSchema>;

// ---- onboard_project ----

export const onboardProjectInput = mutationInput({
  /** The project's key. Free: the project is created. Taken: the project is adopted. */
  key: projectKey,
  /** Required when the key is free; ignored when adopting. */
  name: projectName.optional(),
  color: projectColor.optional(),
});

export const onboardProjectOutput = mutationOutput({
  project: z.object({
    key: z.string(),
    name: z.string(),
    /** True when this call created the project; false when it adopted an existing one. */
    created: z.boolean(),
  }),
  /** Pass it to finish_onboarding. The same client calling again while it is in progress gets it back. */
  session_id: z.string(),
  /** The onboarding guide in effect for the project, with the key filled in. */
  guide: z.string(),
  /** What the project already holds, so the agent reconciles before creating. */
  existing: z.object({
    items: z.number().int(),
    jira_items: z.number().int(),
    documents: z.number().int(),
  }),
});
export type OnboardProjectResult = z.infer<typeof onboardProjectOutput>;

// ---- finish_onboarding ----

export const finishOnboardingInput = mutationInput({
  session_id: objectId,
  summary: text(LIMITS.onboarding_summary),
  questions: z
    .array(text(LIMITS.onboarding_question))
    .max(LIMITS.onboarding_questions_max)
    .optional(),
});

export const finishOnboardingOutput = mutationOutput({
  session_id: z.string(),
  state: z.literal('ready_for_review'),
  changes: onboardingChangesSchema,
});
export type FinishOnboardingResult = z.infer<typeof finishOnboardingOutput>;

// ---- The `onboard` prompt (MCP_SPEC §5.11) ----

/** `prompts/get` arguments (MCP prompt arguments are strings). */
export const onboardPromptArgs = z.strictObject({
  project_key: projectKey,
  project_name: projectName.optional(),
});
export type OnboardPromptArgs = z.infer<typeof onboardPromptArgs>;
