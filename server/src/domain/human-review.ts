/**
 * Human review items (BUILD_SPEC §5.5): the `humanReview` service.
 *
 * Stub (tasks.md T047): each method throws `NotImplementedError` until
 * US3 (T084) fills it in, here, in place. The signatures are in contracts.ts.
 */
import { notImplemented, type HumanReviewService, type ServiceDeps } from './contracts.js';

export function createHumanReviewService(_deps: ServiceDeps): HumanReviewService {
  return {
    declare: notImplemented('humanReview.declare'),
    update: notImplemented('humanReview.update'),
    ownerAdd: notImplemented('humanReview.ownerAdd'),
    ownerUpdate: notImplemented('humanReview.ownerUpdate'),
    ownerRemove: notImplemented('humanReview.ownerRemove'),
  };
}
