/**
 * zod → JSON Schema for MCP `inputSchema` and `outputSchema` (MCP_SPEC §9),
 * using zod's own converter (zod 4; `zod-to-json-schema` targets zod 3).
 *
 * Draft-07 output, which the official SDK client's validator (Ajv) compiles
 * without extra setup. The result is trimmed for tokens: no `$schema`, no
 * ±2^53 bounds on integers, and no `format` the validators don't know.
 *
 * `outputSchema` describes a successful result *or* a ToolError: §6 returns
 * errors as `structuredContent: ToolError`, and MCP clients (the official SDK
 * included) validate any `structuredContent` against `outputSchema`, error
 * or not. Shared contract file (tasks.md, Slice rules).
 */
import { z } from 'zod';
import { toolErrorSchema } from '../errors.js';
import type { AnyToolDef } from './tools.js';

export type JsonSchema = { [key: string]: unknown };

const SAFE_MAX = Number.MAX_SAFE_INTEGER;

function tidy(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(tidy);
  if (node === null || typeof node !== 'object') return node;
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node as JsonSchema)) {
    if (key === '$schema') continue;
    if (key === 'minimum' && value === -SAFE_MAX) continue;
    if (key === 'maximum' && value === SAFE_MAX) continue;
    if (key === 'format' && value === 'base64') continue;
    out[key] = tidy(value);
  }
  return out;
}

export function toJsonSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  return tidy(
    z.toJSONSchema(schema, { target: 'draft-07', io, unrepresentable: 'any' }),
  ) as JsonSchema;
}

/** The tool's `inputSchema`. */
export function inputJsonSchema(tool: Pick<AnyToolDef, 'input'>): JsonSchema {
  return toJsonSchema(tool.input, 'input');
}

/** The successful result's schema alone. */
export function resultJsonSchema(tool: Pick<AnyToolDef, 'output'>): JsonSchema {
  return toJsonSchema(tool.output, 'output');
}

export const TOOL_ERROR_JSON_SCHEMA: JsonSchema = toJsonSchema(toolErrorSchema, 'output');

/** The tool's `outputSchema`: its result, or a ToolError (§6). */
export function outputJsonSchema(tool: Pick<AnyToolDef, 'output'>): JsonSchema {
  return { type: 'object', anyOf: [resultJsonSchema(tool), TOOL_ERROR_JSON_SCHEMA] };
}
