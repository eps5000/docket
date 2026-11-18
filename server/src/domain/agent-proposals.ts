/**
 * Agent proposals (owner decision 30; BUILD_SPEC §5.19; FR-128–FR-130):
 * `get_agent_files`, `propose_agent_file_change`, and the owner's list,
 * approve (optionally edited) and decline.
 *
 * Stub (tasks.md T159): each method throws `NotImplementedError` until US14
 * (T160) fills it in, here, in place. The signatures are in contracts.ts.
 */
import { notImplemented, type AgentProposalsService, type ServiceDeps } from './contracts.js';

export function createAgentProposalsService(_deps: ServiceDeps): AgentProposalsService {
  return {
    files: notImplemented('agentProposals.files'),
    propose: notImplemented('agentProposals.propose'),
    list: notImplemented('agentProposals.list'),
    approve: notImplemented('agentProposals.approve'),
    decline: notImplemented('agentProposals.decline'),
  };
}
