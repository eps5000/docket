/**
 * Lead claims, leases, runs and signals (BUILD_SPEC §5.3, §5.4): the `runs` service.
 *
 * Stub (tasks.md T047): each method throws `NotImplementedError` until
 * US1 (T064) and US6 (T107) fills it in, here, in place. The signatures are in contracts.ts.
 */
import { notImplemented, type RunsService, type ServiceDeps } from './contracts.js';

export function createRunsService(_deps: ServiceDeps): RunsService {
  return {
    claim: notImplemented('runs.claim'),
    release: notImplemented('runs.release'),
    ownerRelease: notImplemented('runs.ownerRelease'),
    returnToReady: notImplemented('runs.returnToReady'),
    startRun: notImplemented('runs.startRun'),
    heartbeat: notImplemented('runs.heartbeat'),
    finish: notImplemented('runs.finish'),
    // A no-op until US1: the MCP signal hook already calls it on every call with run_id.
    recordSignal: () => {},
    expireLeases: notImplemented('runs.expireLeases'),
    interruptOpenRuns: notImplemented('runs.interruptOpenRuns'),
    openRunSessions: notImplemented('runs.openRunSessions'),
  };
}
