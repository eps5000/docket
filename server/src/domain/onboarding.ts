/**
 * Onboarding (owner decision 31; BUILD_SPEC §5.20; FR-135–FR-140; MCP_SPEC
 * §5.11): `onboard_project`, `finish_onboarding`, the `onboard` prompt's
 * guide, and the owner's list and *Mark reviewed*.
 *
 * Stub (tasks.md T163): each method throws `NotImplementedError` until US15
 * (T164) fills it in, here, in place. The signatures are in contracts.ts.
 */
import { notImplemented, type OnboardingService, type ServiceDeps } from './contracts.js';

export function createOnboardingService(_deps: ServiceDeps): OnboardingService {
  return {
    start: notImplemented('onboarding.start'),
    finish: notImplemented('onboarding.finish'),
    guide: notImplemented('onboarding.guide'),
    list: notImplemented('onboarding.list'),
    markReviewed: notImplemented('onboarding.markReviewed'),
  };
}
