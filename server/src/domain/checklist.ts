/**
 * Work steps, subagent logs and agent checks (BUILD_SPEC §5.5): the `checklist` service.
 *
 * Stub (tasks.md T047): each method throws `NotImplementedError` until
 * US1 (T066) and US6 (T107) fills it in, here, in place. The signatures are in contracts.ts.
 */
import { notImplemented, type ChecklistService, type ServiceDeps } from './contracts.js';

export function createChecklistService(_deps: ServiceDeps): ChecklistService {
  return {
    setPlan: notImplemented('checklist.setPlan'),
    updateStep: notImplemented('checklist.updateStep'),
    logSubagent: notImplemented('checklist.logSubagent'),
    setChecks: notImplemented('checklist.setChecks'),
    updateCheck: notImplemented('checklist.updateCheck'),
    ownerAddStep: notImplemented('checklist.ownerAddStep'),
    ownerRemoveStep: notImplemented('checklist.ownerRemoveStep'),
    ownerAddCheck: notImplemented('checklist.ownerAddCheck'),
    ownerRemoveCheck: notImplemented('checklist.ownerRemoveCheck'),
  };
}
