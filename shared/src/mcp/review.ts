/**
 * Evidence, review and decisions (MCP_SPEC §5.6–5.8): input and output schemas.
 * Shared contract file (tasks.md, Slice rules).
 */
import { z } from 'zod';
import {
  ARTIFACT_KINDS,
  DECISION_SCOPE_KINDS,
  PACKET_STATES,
  REVIEW_FOLLOW,
  REVIEW_INTO,
} from '../enums.js';
import {
  commitSha,
  cursor,
  itemId,
  mutationInput,
  mutationOutput,
  nextCursor,
  objectId,
  pageLimit,
  projectKey,
  readInput,
  readOutput,
  text,
} from './common.js';
import { LIMITS, TEXT_LIMITS } from './limits.js';
import { branchInput, changedFilesInput } from './shared-changes.js';
import {
  artifactSchema,
  decisionRecordSchema,
  eventRowSchema,
  itemSummarySchema,
  provenanceSchema,
  reviewKindSchema,
} from './types.js';

const sha = commitSha;
const url = z.url().max(LIMITS.url);

// ---- add_note ----

export const addNoteInput = mutationInput({
  id: itemId,
  text: text(TEXT_LIMITS.note),
});
export const addNoteOutput = mutationOutput({ event: eventRowSchema });

// ---- put_document ----

const BASE64_MAX = Math.ceil(LIMITS.document_mcp_bytes / 3) * 4;

export const putDocumentInput = mutationInput({
  item_id: itemId.optional(),
  project: projectKey.optional(),
  /** A file name. */
  name: text(LIMITS.document_name),
  kind: z.enum(['planning', 'packet_attachment', 'other']),
  content_text: z.string().min(1).max(LIMITS.document_mcp_bytes).optional(),
  content_base64: z.base64().min(1).max(BASE64_MAX).optional(),
  /** Guessed from the name if omitted. */
  mime: text(LIMITS.artifact_label).optional(),
}).superRefine((value, ctx) => {
  if ((value.item_id === undefined) === (value.project === undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: ['item_id'],
      message: 'Pass item_id or project (one of the two).',
    });
  }
  if ((value.content_text === undefined) === (value.content_base64 === undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: ['content_text'],
      message: 'Pass content_text or content_base64 (one of the two).',
    });
  }
});
export const putDocumentOutput = mutationOutput({
  document_id: z.string(),
  version_no: z.number().int(),
  document_version_id: z.string(),
  sha256: z.string(),
  size: z.number().int(),
});

// ---- link_artifact ----

export const linkArtifactInput = mutationInput({
  id: itemId,
  kind: z.enum(ARTIFACT_KINDS),
  label: text(LIMITS.artifact_label),
  url: url.optional(),
  /** For example `passed`, `merged`. */
  state: text(LIMITS.artifact_state).optional(),
});
export const linkArtifactOutput = mutationOutput({ artifact: artifactSchema });

// ---- report_commit ----

export const reportCommitInput = mutationInput({
  id: itemId,
  sha,
  branch: text(LIMITS.branch).optional(),
  /** First line. */
  message: text(LIMITS.commit_message).optional(),
  pr_url: url.optional(),
  /** True once the commit is on the remote; it updates the run's `pushed_sha` (§5.16). */
  pushed: z.boolean().default(false),
});
export const reportCommitOutput = mutationOutput({
  recorded: z.literal(true),
  stale_packets: z.array(
    z.object({ item_id: z.string(), packet_id: z.string(), round: z.number().int() }),
  ),
});

// ---- submit_packet ----

const packetLine = text(LIMITS.packet_line);

export const submitPacketInput = mutationInput({
  id: itemId,
  /** Recorded with report_commit if not already. */
  built_from_commit: sha,
  /** For example "10 min". */
  estimate: text(LIMITS.estimate),
  /** Defaults to every declared item. */
  hr_item_ids: z.array(objectId).min(1).optional(),
  how: z.array(packetLine).min(1).max(LIMITS.packet_how_max),
  checked: z
    .array(
      z.strictObject({
        text: packetLine,
        provenance: provenanceSchema,
        evidence: text(LIMITS.evidence),
      }),
    )
    .max(LIMITS.packet_checked_max),
  gaps: z.array(packetLine).max(LIMITS.packet_gaps_max).optional(),
  attachments: z
    .array(
      z.strictObject({
        document_version_id: objectId,
        caption: packetLine.optional(),
      }),
    )
    .optional(),
  /**
   * Decision 36 (MCP_SPEC §5.15): every file the work changed (repo-relative,
   * ≤ 2,000), mapped through the shared parts' paths, and the branch.
   */
  changed_files: changedFilesInput.optional(),
  branch: branchInput.optional(),
});
export const submitPacketOutput = mutationOutput({
  packet_id: z.string(),
  round: z.number().int(),
  /** For example `pkt-9c0e`. */
  display_id: z.string(),
  item: itemSummarySchema,
  /**
   * Decision 36: shared parts the changed files touch that the item didn't
   * declare. Present only when the packet is held for the owner.
   */
  held_undeclared: z.array(z.string()).optional(),
});

// ---- get_review ----

export const getReviewInput = readInput({ id: itemId });
export const getReviewOutput = readOutput({
  rounds: z.array(
    z.object({
      packet_id: z.string(),
      round: z.number().int(),
      state: z.enum(PACKET_STATES),
      stale: z.boolean(),
      built_from_commit: z.string(),
      submitted_at: z.string(),
      decided_at: z.string().nullable(),
      items: z.array(
        z.object({
          hr_item_id: z.string(),
          text: z.string(),
          decision: z
            .object({
              kind: reviewKindSchema,
              note: z.string().nullable(),
              into: z.enum(REVIEW_INTO).nullable(),
              follow: z.enum(REVIEW_FOLLOW).nullable(),
              result_ref: z.string().nullable(),
            })
            .nullable(),
        }),
      ),
    }),
  ),
});

// ---- ask_owner ----

export const askOwnerInput = mutationInput({
  id: itemId,
  question: text(TEXT_LIMITS.question),
});
export const askOwnerOutput = mutationOutput({ question_id: z.string() });

// ---- publish_decision ----

export const decisionScopeInputSchema = z
  .strictObject({
    kind: z.enum(DECISION_SCOPE_KINDS),
    /** Required except for `project`. */
    id: objectId.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind !== 'project' && value.id === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['id'],
        message: `Required for scope kind ${value.kind}.`,
      });
    }
  });

export const publishDecisionInput = mutationInput({
  project: projectKey,
  scope: decisionScopeInputSchema,
  title: text(LIMITS.decision_title),
  /** Markdown. */
  decision: text(LIMITS.decision_md),
  rationale: text(LIMITS.rationale_md).optional(),
  supersedes: objectId.optional(),
});
export const publishDecisionOutput = mutationOutput({ decision: decisionRecordSchema });

// ---- list_decisions ----

export const listDecisionsInput = readInput({
  project: projectKey,
  scope: decisionScopeInputSchema.optional(),
  /** Everything that applies to this item (B3 resolution 5: top-level). */
  in_scope_of: itemId.optional(),
  include_inactive: z.boolean().default(false),
  cursor: cursor.optional(),
  limit: pageLimit,
});
export const listDecisionsOutput = readOutput({
  items: z.array(decisionRecordSchema),
  next_cursor: nextCursor,
});

// ---- withdraw_decision ----

export const withdrawDecisionInput = mutationInput({
  decision_id: objectId,
  reason: text(LIMITS.withdraw_reason),
});
export const withdrawDecisionOutput = mutationOutput({ decision: decisionRecordSchema });
