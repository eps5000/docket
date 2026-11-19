/**
 * Onboarding (MCP_SPEC §5.11; owner decision 31): tool handlers.
 *
 * Each handler calls the `onboarding` service (domain/onboarding.ts; US15,
 * T164) through `ctx.services`, inside `ctx.mutate`.
 */
import { serviceArgs, type ToolHandlers } from '../register.js';

export const onboardingHandlers: Pick<ToolHandlers, 'onboard_project' | 'finish_onboarding'> = {
  // Creates or adopts the project and starts (or resumes) a session; returns the guide.
  onboard_project: (args, ctx) =>
    ctx.mutate((w) => ctx.services.onboarding.start(w, serviceArgs(args))),
  // Hands the session to the owner for review.
  finish_onboarding: (args, ctx) =>
    ctx.mutate((w) => ctx.services.onboarding.finish(w, serviceArgs(args))),
};
