/**
 * Agent files and Workflow notes (owner decision 29; BUILD_SPEC §5.17): the
 * bundled layer loaded at startup, layer resolution, versions, revert and
 * the bundled-updated flag, and each project's Workflow notes.
 *
 * Stub (tasks.md T150): each method throws `NotImplementedError` until US13
 * (T153, T157) fills it in, here, in place. The signatures are in
 * contracts.ts.
 */
import { notImplemented, type AgentFilesService, type ServiceDeps } from './contracts.js';

export function createAgentFilesService(_deps: ServiceDeps): AgentFilesService {
  return {
    syncBundled: notImplemented('agentFiles.syncBundled'),
    list: notImplemented('agentFiles.list'),
    get: notImplemented('agentFiles.get'),
    put: notImplemented('agentFiles.put'),
    revert: notImplemented('agentFiles.revert'),
    workflow: notImplemented('agentFiles.workflow'),
    putWorkflow: notImplemented('agentFiles.putWorkflow'),
  };
}
