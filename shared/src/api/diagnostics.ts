/**
 * The diagnostic call log, the owner's undo, and the agents' bulk upload:
 * routes outside the user-story groups (BUILD_SPEC §5.10, §5.11, §7;
 * decision T21). Shared contract file (tasks.md, Slice rules).
 */
import { z } from 'zod';
import { objectId, itemId, projectKey, text } from '../mcp/common.js';
import { LIMITS } from '../mcp/limits.js';
import { putDocumentOutput } from '../mcp/review.js';
import { input, jsonResponse, noInput, queryInt } from './common.js';
import { json, route } from './route.js';

// ---- GET /api/diagnostics/calls ----

/** One JSONL line per agent call: never arguments or results (FR-108). */
export const callLogLineSchema = z.object({
  time: z.string(),
  tool: z.string(),
  client: z.string().nullable(),
  label: z.string().nullable(),
  run: z.string().nullable(),
  duration_ms: z.number(),
  result: z.string(),
});
export type CallLogLine = z.infer<typeof callLogLineSchema>;

export const diagnosticsQuery = input({ days: queryInt(1, 7).default(7) });

// ---- POST /api/mutations/:id/undo ----

export const undoParams = input({ id: objectId });
export const undoResponse = jsonResponse({
  /** The undo's own mutation; it can't itself be undone. */
  mutation_id: z.string(),
  undone: z.string(),
});

// ---- POST /agent-upload ----

/** Up to 500 MB through bearer HTTP (decision T9). */
export const AGENT_UPLOAD_MAX_BYTES = 524_288_000;

/**
 * The multipart form fields besides `file` (BUILD_SPEC §5.10). The same
 * target and naming rules as `put_document`; returns the
 * `document_version_id` to reference from tools.
 */
export const agentUploadFields = input({
  item_id: itemId.optional(),
  project: projectKey.optional(),
  /** Defaults to the uploaded file's name. */
  name: text(LIMITS.document_name).optional(),
  kind: z.enum(['planning', 'packet_attachment', 'other']),
  mime: text(LIMITS.artifact_label).optional(),
  agent_label: text(LIMITS.agent_label).optional(),
  run_id: objectId.optional(),
}).superRefine((v, ctx) => {
  if ((v.item_id === undefined) === (v.project === undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: ['item_id'],
      message: 'Pass item_id or project (one of the two).',
    });
  }
});
export const agentUploadResponse = putDocumentOutput.omit({ replayed: true, warnings: true });
export type AgentUploadResponse = z.infer<typeof agentUploadResponse>;

export const diagnosticsRoutes = {
  'diagnostics.calls': route({
    method: 'GET',
    path: '/api/diagnostics/calls',
    group: 'diagnostics',
    params: noInput,
    query: diagnosticsQuery,
    body: null,
    response: { kind: 'jsonl' },
  }),
} as const;

export const undoRoutes = {
  /** Implemented in B2 (BUILD_SPEC §5.11). */
  'mutations.undo': route({
    method: 'POST',
    path: '/api/mutations/:id/undo',
    group: 'undo',
    params: undoParams,
    query: noInput,
    body: noInput,
    response: json(undoResponse),
  }),
} as const;

export const uploadRoutes = {
  /** Bearer auth (the agent token), never the owner session; no CSRF. */
  'agentUpload.post': route({
    method: 'POST',
    path: '/agent-upload',
    group: 'upload',
    auth: 'bearer',
    params: noInput,
    query: noInput,
    body: agentUploadFields,
    bodyKind: 'multipart',
    response: json(agentUploadResponse),
  }),
} as const;
