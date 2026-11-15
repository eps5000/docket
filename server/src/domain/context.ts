/**
 * The context bundle (BUILD_SPEC §5.15): the `context` service.
 *
 * Stub (tasks.md T047): each method throws `NotImplementedError` until
 * US5 (T101) fills it in, here, in place. The signatures are in contracts.ts.
 */
import { notImplemented, type ContextService, type ServiceDeps } from './contracts.js';

export function createContextService(_deps: ServiceDeps): ContextService {
  return {
    getContext: notImplemented('context.getContext'),
  };
}
