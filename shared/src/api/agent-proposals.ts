/**
 * Agent proposals and drift (owner decision 30; BUILD_SPEC §4, §5.19, §7;
 * UI_SPEC §6.7b-1; contracts/ui-api.md US14): the owner's review of agents'
 * proposed changes to agent files and Workflow notes, and of installed files
 * that changed outside Task Lite. Shared contract file (tasks.md, Slice rules).
 *
 * B26 resolutions (listed in the B26 PR):
 * - `project` omitted lists everything, including proposals to the default;
 *   `state` omitted lists every state.
 * - *Approve* (optionally with edited content) and *Adopt* are undoable;
 *   *Decline*, *Restore* and *Keep local* are not.
 * - *Restore* touches the host (a push install writes files), so it runs in
 *   two steps like an install: prepare outside the transaction, then record.
 */
import { z } from 'zod';
import {
  DRIFT_CHANGES,
  DRIFT_STATES,
  INSTALL_CLIENTS,
  INSTALL_METHODS,
  INSTALL_TARGET_KINDS,
  INSTRUCTION_REPORT_SOURCES,
  PROPOSAL_STATES,
} from '../enums.js';
import { objectId, projectKey, text } from '../mcp/common.js';
import { LIMITS } from '../mcp/limits.js';
import { createInstallResponse } from './agent-setup.js';
import { input, jsonResponse, noInput, ownerMutationOutput } from './common.js';
import { json, route } from './route.js';

const note = text(500);

// ---- Shapes ----

/** One proposal (UI_SPEC §6.7b-1 "Proposed changes"). */
export const proposalSchema = z.object({
  id: z.string(),
  /** Null: a proposal to the default. */
  project: z.string().nullable(),
  /** `agents_block`, `workflow` or `skill:<name>`. */
  file_key: z.string(),
  /** The skill's name, "AGENTS.md block" or "Workflow notes". */
  name: z.string(),
  content: z.string(),
  reason: z.string(),
  /** What the agent read; null for Workflow notes that didn't exist yet. */
  based_on_version_id: z.string().nullable(),
  /** The target's version in effect now; null when there is none yet. */
  current_version_id: z.string().nullable(),
  /** The target changed since the agent read it: the review shows a three-way view. */
  changed_since: z.boolean(),
  run_id: z.string().nullable(),
  /** The run's item, for "proposed by codex · orca-w3 on RCP-14". */
  item_id: z.string().nullable(),
  /** `codex · orca-w3`. */
  proposed_by: z.string(),
  state: z.enum(PROPOSAL_STATES),
  created_at: z.string(),
  decided_at: z.string().nullable(),
  decided_note: z.string().nullable(),
  /** The version the approval saved. */
  result_version_id: z.string().nullable(),
});
export type Proposal = z.infer<typeof proposalSchema>;

/** One drift record (UI_SPEC §6.7b-1 "Changed outside Task Lite"). */
export const driftSchema = z.object({
  id: z.string(),
  install_id: z.string(),
  install: z.object({
    client: z.enum(INSTALL_CLIENTS),
    target_kind: z.enum(INSTALL_TARGET_KINDS),
    method: z.enum(INSTALL_METHODS),
    /** Where: the install's host path, when known. */
    path: z.string().nullable(),
  }),
  /** Null for a user-wide install: *Adopt* then saves to the default. */
  project: z.string().nullable(),
  /** The manifest key, or the extra skill folder's `skill:<name>`. */
  file_key: z.string(),
  change: z.enum(DRIFT_CHANGES),
  state: z.enum(DRIFT_STATES),
  /** The installed file's hash; null when it is missing. *Keep local* accepts this hash. */
  local_sha256: z.string().nullable(),
  /** What the install sent (from its manifest); null for an extra file. */
  sent_version_id: z.string().nullable(),
  sent_sha256: z.string().nullable(),
  /** The installed text when it was reported, for the diff; null when unknown. */
  local_content: z.string().max(LIMITS.agent_file_content).nullable(),
  /** How it was found: the scheduled check, or reported by an agent on an item. */
  found_by: z.object({
    source: z.enum(INSTRUCTION_REPORT_SOURCES),
    run_id: z.string().nullable(),
    item_id: z.string().nullable(),
    client: z.string().nullable(),
    label: z.string().nullable(),
    at: z.string(),
  }),
  detected_at: z.string(),
  resolved_at: z.string().nullable(),
});
export type Drift = z.infer<typeof driftSchema>;

// ---- GET /api/agent-file-proposals?project&state ----

export const proposalsQuery = input({
  project: projectKey.optional(),
  state: z.enum(PROPOSAL_STATES).optional(),
});
export const proposalsResponse = jsonResponse({ proposals: z.array(proposalSchema) });
export type ProposalsResponse = z.infer<typeof proposalsResponse>;

export const proposalParams = input({ id: objectId });

// ---- POST /api/agent-file-proposals/:id/approve ----

export const approveProposalBody = input({
  /** *Edit, then approve*: the owner's text instead of the agent's (limits as for the target). */
  content: z.string().max(LIMITS.agent_file_content).optional(),
  note: note.optional(),
});
export const decideProposalResponse = ownerMutationOutput({ proposal: proposalSchema });
export type DecideProposalResponse = z.infer<typeof decideProposalResponse>;

// ---- POST /api/agent-file-proposals/:id/decline ----

export const declineProposalBody = input({ note: note.optional() });

// ---- GET /api/drift?project&state ----

export const driftQuery = input({
  project: projectKey.optional(),
  state: z.enum(DRIFT_STATES).optional(),
});
export const driftListResponse = jsonResponse({ drift: z.array(driftSchema) });
export type DriftListResponse = z.infer<typeof driftListResponse>;

export const driftParams = input({ id: objectId });

// ---- POST /api/drift/:id/adopt · /keep-local · /restore ----

export const driftActionResponse = ownerMutationOutput({ drift: driftSchema });
export type DriftActionResponse = z.infer<typeof driftActionResponse>;

/** *Restore*: the reinstall's result (push) or the command to run (command install). */
export const restoreDriftResponse = ownerMutationOutput({
  drift: driftSchema,
  install: createInstallResponse,
});
export type RestoreDriftResponse = z.infer<typeof restoreDriftResponse>;

// ---- Routes ----

export const agentProposalsRoutes = {
  'proposals.list': route({
    method: 'GET',
    path: '/api/agent-file-proposals',
    group: 'setup',
    params: noInput,
    query: proposalsQuery,
    body: null,
    response: json(proposalsResponse),
  }),
  'proposals.approve': route({
    method: 'POST',
    path: '/api/agent-file-proposals/:id/approve',
    group: 'setup',
    params: proposalParams,
    query: noInput,
    body: approveProposalBody,
    response: json(decideProposalResponse),
    undoable: true,
  }),
  'proposals.decline': route({
    method: 'POST',
    path: '/api/agent-file-proposals/:id/decline',
    group: 'setup',
    params: proposalParams,
    query: noInput,
    body: declineProposalBody,
    response: json(decideProposalResponse),
  }),
  'drift.list': route({
    method: 'GET',
    path: '/api/drift',
    group: 'setup',
    params: noInput,
    query: driftQuery,
    body: null,
    response: json(driftListResponse),
  }),
  'drift.adopt': route({
    method: 'POST',
    path: '/api/drift/:id/adopt',
    group: 'setup',
    params: driftParams,
    query: noInput,
    body: noInput,
    response: json(driftActionResponse),
    undoable: true,
  }),
  'drift.restore': route({
    method: 'POST',
    path: '/api/drift/:id/restore',
    group: 'setup',
    params: driftParams,
    query: noInput,
    body: noInput,
    response: json(restoreDriftResponse),
  }),
  'drift.keepLocal': route({
    method: 'POST',
    path: '/api/drift/:id/keep-local',
    group: 'setup',
    params: driftParams,
    query: noInput,
    body: noInput,
    response: json(driftActionResponse),
  }),
} as const;
