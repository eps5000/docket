/**
 * The diagnostic call log (decision T21): the `diagnostics` service.
 *
 * Stub (tasks.md T047): each method throws `NotImplementedError` until
 * US10 (T118) fills it in, here, in place. The signatures are in contracts.ts.
 */
import { notImplemented, type DiagnosticsService, type ServiceDeps } from './contracts.js';

export function createDiagnosticsService(_deps: ServiceDeps): DiagnosticsService {
  return {
    calls: notImplemented('diagnostics.calls'),
  };
}
