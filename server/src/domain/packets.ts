/**
 * Packets, rounds, staleness and deferred reviews (BUILD_SPEC §5.6): the `packets` service.
 *
 * Stub (tasks.md T047): each method throws `NotImplementedError` until
 * US3 (T085) fills it in, here, in place. The signatures are in contracts.ts.
 */
import { notImplemented, type PacketsService, type ServiceDeps } from './contracts.js';

export function createPacketsService(_deps: ServiceDeps): PacketsService {
  return {
    submit: notImplemented('packets.submit'),
    getReview: notImplemented('packets.getReview'),
    deferredReviews: notImplemented('packets.deferredReviews'),
    screen: notImplemented('packets.screen'),
    refresh: notImplemented('packets.refresh'),
    markStale: notImplemented('packets.markStale'),
  };
}
