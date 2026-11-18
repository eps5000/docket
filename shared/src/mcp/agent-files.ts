/**
 * Agent files (MCP_SPEC §5.10; owner decision 30; BUILD_SPEC §5.19):
 * `get_agent_files` (read-only) and `propose_agent_file_change` (a pending
 * proposal; nothing changes until the owner approves), and the
 * `claim_lead.instructions` report (MCP_SPEC §5.4). Shared contract file
 * (tasks.md, Slice rules).
 *
 * B26 resolutions (listed in the B26 PR): file keys are `agents_block`,
 * `workflow` or `skill:<name>`; installed files never include `workflow`;
 * content is never trimmed; a skill or the block is 1–50,000 characters and
 * Workflow notes 0–10,000; `workflow` needs a project; Workflow notes that
 * don't exist yet have `version_id: null`; sha256 is 64 hex characters in
 * either case; up to 20 reported files.
 */
import { z } from 'zod';
import { AGENT_FILE_KINDS, AGENT_FILE_SOURCES, WORKFLOW_KEY } from '../enums.js';
import {
  mutationInput,
  mutationOutput,
  objectId,
  projectKey,
  readInput,
  readOutput,
  text,
} from './common.js';
import { AGENT_FILE_TARGET_RE, INSTALLED_FILE_KEY_RE, LIMITS, SHA256_RE } from './limits.js';

// ---- Building blocks ----

/** An agent file or the Workflow notes: `agents_block`, `workflow` or `skill:<name>`. */
export const agentFileTarget = z.string().trim().regex(AGENT_FILE_TARGET_RE, {
  error: 'Expected agents_block, workflow, or skill:<name> like skill:tasklite-worker.',
});

/** An installed agent file: `agents_block` or `skill:<name>` (never `workflow`). */
export const installedFileKey = z.string().trim().regex(INSTALLED_FILE_KEY_RE, {
  error: 'Expected agents_block, or skill:<name> like skill:tasklite-worker.',
});

/** A sha256 in hex; either case (compared lowercased). */
export const sha256Hex = z
  .string()
  .trim()
  .regex(SHA256_RE, { error: 'Expected a sha256: 64 hex characters.' });

// ---- claim_lead.instructions (MCP_SPEC §5.4) ----

/** One installed file as the `tasklite-check` script reports it. */
export const instructionFileInput = z.strictObject({
  key: installedFileKey,
  sha256: sha256Hex,
  /** Only for files whose hash differs from the manifest; the installed text, not trimmed. */
  content: z.string().max(LIMITS.agent_file_content).optional(),
});

/** The output of the installed `tasklite-check` script. */
export const instructionsInput = z.strictObject({
  /** The install's ID, from its `.tasklite-manifest.json`. */
  install_id: objectId.optional(),
  /** Empty, with `install_id`, means every installed file is missing. */
  files: z.array(instructionFileInput).max(LIMITS.instruction_files_max),
});
export type InstructionsInput = z.infer<typeof instructionsInput>;

// ---- get_agent_files ----

export const getAgentFilesInput = readInput({
  project: projectKey,
  /** One file, with its full text; otherwise every file, listed without content. */
  file: agentFileTarget.optional(),
});

export const agentFileInEffectSchema = z.object({
  key: z.string(),
  kind: z.enum(AGENT_FILE_KINDS),
  /** The version in effect; null for Workflow notes that don't exist yet. */
  version_id: z.string().nullable(),
  sha256: z.string(),
  /** `default`: what every project uses; `project`: this project's copy (Workflow notes always). */
  source: z.enum(AGENT_FILE_SOURCES),
  /** The full text with `file`; null in the listing. */
  content: z.string().nullable(),
});
export type AgentFileInEffect = z.infer<typeof agentFileInEffectSchema>;

export const getAgentFilesOutput = readOutput({
  project: z.string(),
  files: z.array(agentFileInEffectSchema),
});
export type GetAgentFilesResult = z.infer<typeof getAgentFilesOutput>;

// ---- propose_agent_file_change ----

export const proposeAgentFileChangeInput = mutationInput({
  /** Omit to propose a change to the default. */
  project: projectKey.optional(),
  file: agentFileTarget,
  /** The whole new text, as written (not trimmed). */
  content: z.string().max(LIMITS.agent_file_content),
  reason: text(LIMITS.proposal_reason),
  /** The `version_id` you read with get_agent_files; null for Workflow notes that don't exist yet. */
  based_on_version_id: objectId.nullable(),
}).superRefine((v, ctx) => {
  if (v.file === WORKFLOW_KEY) {
    if (v.project === undefined) {
      ctx.addIssue({ code: 'custom', path: ['project'], message: 'is required for workflow' });
    }
    if (v.content.length > LIMITS.workflow_md) {
      ctx.addIssue({
        code: 'custom',
        path: ['content'],
        message: `must be at most ${LIMITS.workflow_md} characters for workflow`,
      });
    }
  } else {
    if (v.content.trim().length === 0) {
      ctx.addIssue({ code: 'custom', path: ['content'], message: 'must not be empty' });
    }
    if (v.based_on_version_id === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['based_on_version_id'],
        message: 'is null only for Workflow notes that do not exist yet',
      });
    }
  }
});

export const proposeAgentFileChangeOutput = mutationOutput({
  proposal_id: z.string(),
  state: z.literal('pending'),
});
