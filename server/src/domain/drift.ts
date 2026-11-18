/**
 * Drift (owner decision 30; BUILD_SPEC §5.19; FR-131–FR-133): instruction
 * reports from `claim_lead` and the scheduled push-folder check, drift
 * records against each install's manifest, and the remedies (*Adopt*,
 * *Restore*, *Keep local*).
 *
 * Stub (tasks.md T159): each method throws `NotImplementedError` until US14
 * (T161) fills it in, here, in place. The signatures are in contracts.ts.
 * Nothing calls `recordReport` or the scheduled check yet: `claim_lead`
 * accepts `instructions` and ignores them until T161.
 */
import { notImplemented, type DriftService, type ServiceDeps } from './contracts.js';

export function createDriftService(_deps: ServiceDeps): DriftService {
  return {
    recordReport: notImplemented('drift.recordReport'),
    checkPushInstalls: notImplemented('drift.checkPushInstalls'),
    recordChecks: notImplemented('drift.recordChecks'),
    list: notImplemented('drift.list'),
    adopt: notImplemented('drift.adopt'),
    restorePrepare: notImplemented('drift.restorePrepare'),
    restoreRecord: notImplemented('drift.restoreRecord'),
    keepLocal: notImplemented('drift.keepLocal'),
  };
}
