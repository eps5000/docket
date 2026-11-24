/**
 * Structured errors (MCP_SPEC §4 ToolError and §6). Every MCP tool error and
 * every API error carries one of these codes, a one- or two-sentence message
 * (what happened, then what to do), and optional details or current state.
 * This is a shared contract file: slices must not edit it.
 */
import { z } from 'zod';

export const ERROR_CODES = [
  'validation',
  'conflict',
  'not_found',
  'forbidden',
  'unavailable',
  'internal',
  // Decision 36 (MCP_SPEC §5.15, §6): shared changes and conflict guardrails.
  'seam_conflict',
  'not_declared',
  'lease_held',
  // Decision 39: this item changes an approved design and the owner hasn't approved it.
  'design_review',
  // Decision 53: the owner paused this project, so no new claim or resume.
  'project_paused',
  // Decision 58: an epic can't start while any of its tickets is in Inbox or Planning.
  'epic_not_ready',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ToolErrorShape {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
  current?: unknown;
}

export const toolErrorSchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
  current: z.unknown().optional(),
});

/** HTTP status for each code on the UI API. */
export const HTTP_STATUS: Record<ErrorCode, number> = {
  validation: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  internal: 500,
  unavailable: 503,
  // Decision 36 (B38 resolution): a claim refused for an overlap, and a held lease, are
  // conflicts with other work; a missing declaration is a refused move, like validation.
  seam_conflict: 409,
  lease_held: 409,
  not_declared: 400,
  design_review: 409,
  project_paused: 409,
  epic_not_ready: 409,
};

export class ToolError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  readonly current?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    extras: { details?: Record<string, unknown>; current?: unknown } = {},
  ) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    if (extras.details !== undefined) this.details = extras.details;
    if (extras.current !== undefined) this.current = extras.current;
  }

  toJSON(): ToolErrorShape {
    const out: ToolErrorShape = { code: this.code, message: this.message };
    if (this.details !== undefined) out.details = this.details;
    if (this.current !== undefined) out.current = this.current;
    return out;
  }
}

export function isToolError(value: unknown): value is ToolError {
  return value instanceof ToolError;
}
