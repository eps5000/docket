/**
 * The tool registry: all 51 tools in MCP_SPEC §5 order, with their group,
 * kind, input and output schemas and MCP annotations (§3 Tool annotations).
 * Descriptions live in mcp-copy.ts. Shared contract file (tasks.md, Slice rules).
 */
import type { z } from 'zod';
import * as agentFiles from './agent-files.js';
import * as batch from './batch.js';
import * as checklist from './checklist.js';
import * as digest from './digest.js';
import * as items from './items.js';
import * as onboarding from './onboarding.js';
import * as read from './read.js';
import * as recovery from './recovery.js';
import * as review from './review.js';
import * as runs from './runs.js';
import * as problems from './problems.js';
import * as shared from './shared-changes.js';

/** Server file each tool's handler lives in (`server/src/mcp/tools/<group>.ts`). */
export type ToolGroup =
  | 'read'
  | 'items'
  | 'runs'
  | 'checklist'
  | 'evidence'
  | 'review'
  | 'decisions'
  | 'recovery'
  | 'agent_files'
  | 'onboarding'
  | 'batch'
  | 'shared'
  | 'problems';

/**
 * - `read`: no side effects (`readOnlyHint: true`).
 * - `delivering`: a read that marks owner notes and answers as delivered (`get_item`).
 * - `mutating`: accepts `idempotency_key`; results may carry `replayed` and `warnings`.
 */
export type ToolKind = 'read' | 'delivering' | 'mutating';

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  /** Only on retry-safe tools: MCP's default is false (decision 40). */
  idempotentHint?: true;
}

export interface ToolDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  name: string;
  group: ToolGroup;
  kind: ToolKind;
  input: I;
  output: O;
}

/** Retry-safe mutating tools (§3 Tool annotations). */
export const IDEMPOTENT_TOOLS = [
  'heartbeat',
  'report_commit',
  'update_step',
  'update_check',
] as const;

const def = <const N extends string, I extends z.ZodType, O extends z.ZodType>(
  name: N,
  group: ToolGroup,
  kind: ToolKind,
  input: I,
  output: O,
) => ({ name, group, kind, input, output }) satisfies ToolDef<I, O>;

export const TOOLS = [
  // §5.1 Orientation
  def('whoami', 'read', 'read', read.whoamiInput, read.whoamiOutput),
  def('list_projects', 'read', 'read', read.listProjectsInput, read.listProjectsOutput),
  // §5.2 Finding work
  def('search_items', 'read', 'read', read.searchItemsInput, read.searchItemsOutput),
  def('get_item', 'read', 'delivering', read.getItemInput, read.getItemOutput),
  def('get_context', 'read', 'read', read.getContextInput, read.getContextOutput),
  def(
    'dependency_subgraph',
    'read',
    'read',
    read.dependencySubgraphInput,
    read.dependencySubgraphOutput,
  ),
  def('deferred_reviews', 'read', 'read', read.deferredReviewsInput, read.deferredReviewsOutput),
  def('get_changes', 'read', 'read', read.getChangesInput, read.getChangesOutput),
  def('get_digest', 'read', 'read', digest.getDigestInput, digest.getDigestOutput),
  // §5.3 Creating and editing items
  def('create_item', 'items', 'mutating', items.createItemInput, items.createItemOutput),
  def('update_item', 'items', 'mutating', items.updateItemInput, items.updateItemOutput),
  def('set_status', 'items', 'mutating', items.setStatusInput, items.setStatusOutput),
  def('link_items', 'items', 'mutating', items.linkItemsInput, items.linkItemsOutput),
  def('unlink_items', 'items', 'mutating', items.unlinkItemsInput, items.unlinkItemsOutput),
  def('upsert_label', 'items', 'mutating', items.upsertLabelInput, items.upsertLabelOutput),
  // §5.4 Claiming and runs
  def('claim_lead', 'runs', 'mutating', runs.claimLeadInput, runs.claimLeadOutput),
  def('release_lead', 'runs', 'mutating', runs.releaseLeadInput, runs.releaseLeadOutput),
  def('start_run', 'runs', 'mutating', runs.startRunInput, runs.startRunOutput),
  def('heartbeat', 'runs', 'mutating', runs.heartbeatInput, runs.heartbeatOutput),
  def('finish_run', 'runs', 'mutating', runs.finishRunInput, runs.finishRunOutput),
  def('park_run', 'runs', 'mutating', runs.parkRunInput, runs.parkRunOutput),
  def(
    'update_run_status',
    'runs',
    'mutating',
    runs.updateRunStatusInput,
    runs.updateRunStatusOutput,
  ),
  // §5.5 Checklist
  def('set_plan', 'checklist', 'mutating', checklist.setPlanInput, checklist.setPlanOutput),
  def(
    'update_step',
    'checklist',
    'mutating',
    checklist.updateStepInput,
    checklist.updateStepOutput,
  ),
  def(
    'log_subagent',
    'checklist',
    'mutating',
    checklist.logSubagentInput,
    checklist.logSubagentOutput,
  ),
  def('set_checks', 'checklist', 'mutating', checklist.setChecksInput, checklist.setChecksOutput),
  def(
    'update_check',
    'checklist',
    'mutating',
    checklist.updateCheckInput,
    checklist.updateCheckOutput,
  ),
  def(
    'declare_human_review',
    'checklist',
    'mutating',
    checklist.declareHumanReviewInput,
    checklist.declareHumanReviewOutput,
  ),
  def(
    'update_human_review',
    'checklist',
    'mutating',
    checklist.updateHumanReviewInput,
    checklist.updateHumanReviewOutput,
  ),
  // §5.6 Evidence
  def('add_note', 'evidence', 'mutating', review.addNoteInput, review.addNoteOutput),
  def('put_document', 'evidence', 'mutating', review.putDocumentInput, review.putDocumentOutput),
  def('link_artifact', 'evidence', 'mutating', review.linkArtifactInput, review.linkArtifactOutput),
  def('report_commit', 'evidence', 'mutating', review.reportCommitInput, review.reportCommitOutput),
  // §5.7 Review and the owner
  def('submit_packet', 'review', 'mutating', review.submitPacketInput, review.submitPacketOutput),
  def('get_review', 'review', 'read', review.getReviewInput, review.getReviewOutput),
  def('ask_owner', 'review', 'mutating', review.askOwnerInput, review.askOwnerOutput),
  // §5.8 Decisions
  def(
    'publish_decision',
    'decisions',
    'mutating',
    review.publishDecisionInput,
    review.publishDecisionOutput,
  ),
  def('list_decisions', 'decisions', 'read', review.listDecisionsInput, review.listDecisionsOutput),
  def(
    'withdraw_decision',
    'decisions',
    'mutating',
    review.withdrawDecisionInput,
    review.withdrawDecisionOutput,
  ),
  // §5.9 Recovery
  def(
    'recovery_report',
    'recovery',
    'read',
    recovery.recoveryReportInput,
    recovery.recoveryReportOutput,
  ),
  // §5.10 Agent files (decision 30)
  def(
    'get_agent_files',
    'agent_files',
    'read',
    agentFiles.getAgentFilesInput,
    agentFiles.getAgentFilesOutput,
  ),
  def(
    'propose_agent_file_change',
    'agent_files',
    'mutating',
    agentFiles.proposeAgentFileChangeInput,
    agentFiles.proposeAgentFileChangeOutput,
  ),
  // §5.11 Onboarding (decision 31)
  def(
    'onboard_project',
    'onboarding',
    'mutating',
    onboarding.onboardProjectInput,
    onboarding.onboardProjectOutput,
  ),
  def(
    'finish_onboarding',
    'onboarding',
    'mutating',
    onboarding.finishOnboardingInput,
    onboarding.finishOnboardingOutput,
  ),
  // §5.12 Step details (decision 33)
  def('get_step', 'checklist', 'read', checklist.getStepInput, checklist.getStepOutput),
  // §5.13 Batches (decision 34)
  def('apply_batch', 'batch', 'mutating', batch.applyBatchInput, batch.applyBatchOutput),
  // §5.15 Shared changes (decision 36)
  def(
    'declare_shared_changes',
    'shared',
    'mutating',
    shared.declareSharedChangesInput,
    shared.declareSharedChangesOutput,
  ),
  def(
    'list_shared_parts',
    'shared',
    'read',
    shared.listSharedPartsInput,
    shared.listSharedPartsOutput,
  ),
  def('take_lease', 'shared', 'mutating', shared.takeLeaseInput, shared.takeLeaseOutput),
  def('release_lease', 'shared', 'mutating', shared.releaseLeaseInput, shared.releaseLeaseOutput),
  // §5.16 Problems (decision 37)
  def(
    'propose_resolution',
    'problems',
    'mutating',
    problems.proposeResolutionInput,
    problems.proposeResolutionOutput,
  ),
] as const;

export type ToolName = (typeof TOOLS)[number]['name'];
export type AnyToolDef = (typeof TOOLS)[number];
export type ToolByName<N extends ToolName> = Extract<AnyToolDef, { name: N }>;
export type ToolInput<N extends ToolName> = z.output<ToolByName<N>['input']>;
export type ToolOutput<N extends ToolName> = z.output<ToolByName<N>['output']>;

export const TOOL_NAMES = TOOLS.map((t) => t.name) as ToolName[];

const BY_NAME: ReadonlyMap<string, AnyToolDef> = new Map(TOOLS.map((t) => [t.name, t]));

export function getTool<N extends ToolName>(name: N): ToolByName<N>;
export function getTool(name: string): AnyToolDef | undefined;
export function getTool(name: string): AnyToolDef | undefined {
  return BY_NAME.get(name);
}

/** MCP annotations per §3: reads are read-only, `get_item` is not, nothing is destructive. */
export function toolAnnotations(tool: Pick<ToolDef, 'name' | 'kind'>): ToolAnnotations {
  return {
    readOnlyHint: tool.kind === 'read',
    destructiveHint: false,
    ...((IDEMPOTENT_TOOLS as readonly string[]).includes(tool.name)
      ? { idempotentHint: true as const }
      : {}),
  };
}
