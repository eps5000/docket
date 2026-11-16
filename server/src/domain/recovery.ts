/**
 * Recovery (BUILD_SPEC §5.16; MCP_SPEC §5.9): the `recovery` service:
 * workspace state, `Item.resume`, `recovery_report`, Agents → Workspaces and
 * the owner's *Mark released* and *Handled*.
 *
 * Stub (tasks.md T055): each method throws `NotImplementedError` until
 * US11 (T100) fills it in, here, in place. The signatures are in contracts.ts.
 */
import { notImplemented, type RecoveryService, type ServiceDeps } from './contracts.js';

export function createRecoveryService(_deps: ServiceDeps): RecoveryService {
  return {
    report: notImplemented('recovery.report'),
    workspaceStates: notImplemented('recovery.workspaceStates'),
    itemResume: notImplemented('recovery.itemResume'),
    workspaces: notImplemented('recovery.workspaces'),
    ownerReleaseResource: notImplemented('recovery.ownerReleaseResource'),
    markUnpushedHandled: notImplemented('recovery.markUnpushedHandled'),
  };
}
