/**
 * Decision records (BUILD_SPEC §5.14): the `decisions` service.
 *
 * Stub (tasks.md T047): each method throws `NotImplementedError` until
 * US5 (T101) fills it in, here, in place. The signatures are in contracts.ts.
 */
import { notImplemented, type DecisionsService, type ServiceDeps } from './contracts.js';

export function createDecisionsService(_deps: ServiceDeps): DecisionsService {
  return {
    publish: notImplemented('decisions.publish'),
    list: notImplemented('decisions.list'),
    withdraw: notImplemented('decisions.withdraw'),
    confirm: notImplemented('decisions.confirm'),
  };
}
