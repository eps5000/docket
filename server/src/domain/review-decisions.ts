/**
 * The owner's packet decisions and deferred follow-ups (BUILD_SPEC §5.6): the `reviewDecisions` service.
 *
 * Stub (tasks.md T047): each method throws `NotImplementedError` until
 * US3 (T086) fills it in, here, in place. The signatures are in contracts.ts.
 */
import { notImplemented, type ReviewDecisionsService, type ServiceDeps } from './contracts.js';

export function createReviewDecisionsService(_deps: ServiceDeps): ReviewDecisionsService {
  return {
    decide: notImplemented('reviewDecisions.decide'),
    createFollowUp: notImplemented('reviewDecisions.createFollowUp'),
  };
}
