/**
 * Notes, artifacts and commits (BUILD_SPEC §5.6; A08): the `evidence` service.
 *
 * Stub (tasks.md T047): each method throws `NotImplementedError` until
 * US1 (T067) fills it in, here, in place. The signatures are in contracts.ts.
 */
import { notImplemented, type EvidenceService, type ServiceDeps } from './contracts.js';

export function createEvidenceService(_deps: ServiceDeps): EvidenceService {
  return {
    addNote: notImplemented('evidence.addNote'),
    linkArtifact: notImplemented('evidence.linkArtifact'),
    reportCommit: notImplemented('evidence.reportCommit'),
  };
}
