/**
 * Onboarding (MCP_SPEC §5.11; owner decision 31): tool handlers.
 *
 * Wired to the domain services (tasks.md T163): each handler calls the
 * `onboarding` service in domain/contracts.ts through `ctx.services`, inside
 * `ctx.mutate`. While the service is a stub, the tool answers `unavailable`
 * ("Not implemented yet: <tool>"). US15 (T164) implements the service;
 * registration, schemas and copy stay as they are.
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
