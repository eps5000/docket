/**
 * zod → JSON Schema for MCP `inputSchema` and `outputSchema` (MCP_SPEC §9),
 * using zod's own converter (zod 4; `zod-to-json-schema` targets zod 3).
 *
 * Draft-07 output, which the official SDK client's validator (Ajv) compiles
 * without extra setup. The result is trimmed for tokens: no `$schema`, no
 * ±2^53 bounds on integers, and no `format` the validators don't know.
 *
 * **What a client receives is compact (owner decision 40).** Tool definitions
 * are resent to the model on every call, so:
 * - `inputSchema` drops what the server's own validation already says better:
 *   `minLength: 1`, the item-ID pattern, the event-type list on `get_changes`,
 *   and the length limits of the two fields every tool repeats (`run_id`,
 *   `idempotency_key`). Every other limit, enum, default and required field
 *   stays.
 * - `outputSchema` (structured sessions only) names each result's top-level
 *   fields and their types, and that a ToolError has `code` and `message`. The full
 *   result shape is `resultJsonSchema`, reviewed as its own snapshot and
 *   documented in MCP_SPEC §4; results are still validated against it.
 *
 * `outputSchema` describes a successful result *or* a ToolError: §6 returns
 * errors as `structuredContent: ToolError`, and MCP clients (the official SDK
 * included) validate any `structuredContent` against `outputSchema`, error
 * or not. Shared contract file (tasks.md, Slice rules).
 */
import { z } from 'zod';
import { toolErrorSchema } from '../errors.js';
import { ITEM_ID_RE } from './limits.js';
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

/**
 * Longer than any list an agent chooses from: the event types on `get_changes`.
 * MCP_SPEC §4 and the skills name the ones to watch, and validation lists them.
 */
const LONG_ENUM = 60;

/** An input node without what validation already reports: `minLength: 1`, the item-ID pattern, a very long enum. */
function leanInput(node: unknown, isPropertyMap = false): unknown {
  if (Array.isArray(node)) return node.map((n) => leanInput(n));
  if (node === null || typeof node !== 'object') return node;
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node as JsonSchema)) {
    // Inside `properties`, keys are field names (a field may be called `pattern`).
    if (!isPropertyMap) {
      if (key === 'minLength' && value === 1) continue;
      if (key === 'pattern' && value === ITEM_ID_RE.source) continue;
      if (key === 'enum' && Array.isArray(value) && value.length > LONG_ENUM) continue;
    }
    out[key] = leanInput(value, !isPropertyMap && key === 'properties');
  }
  return out;
}

/** The tool's `inputSchema`, as clients receive it (decision 40). */
export function inputJsonSchema(tool: Pick<AnyToolDef, 'input'>): JsonSchema {
  const schema = leanInput(toJsonSchema(tool.input, 'input')) as JsonSchema & {
    properties?: Record<string, JsonSchema>;
  };
  const props = schema.properties;
  // Repeated on every tool: their limits are in MCP_SPEC §3, and validation enforces them.
  if (props?.run_id) props.run_id = { type: 'string' };
  if (props?.idempotency_key) props.idempotency_key = { type: 'string' };
  return schema;
}

/** The successful result's full schema (MCP_SPEC §4), which results are validated against. */
export function resultJsonSchema(tool: Pick<AnyToolDef, 'output'>): JsonSchema {
  return toJsonSchema(tool.output, 'output');
}

export const TOOL_ERROR_JSON_SCHEMA: JsonSchema = toJsonSchema(toolErrorSchema, 'output');

/** The ToolError branch of every `outputSchema`: its two required fields (§6). */
export const COMPACT_ERROR_SCHEMA: JsonSchema = { type: 'object', required: ['code', 'message'] };

/** A field's JSON type, without its nested shape; a union (nullable) accepts anything. */
function fieldType(node: JsonSchema): JsonSchema {
  return typeof node.type === 'string' ? { type: node.type } : {};
}

/** A result's top-level fields and their types. Looser than the result, so it always validates. */
function compactResult(schema: JsonSchema): JsonSchema {
  const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
  return {
    type: 'object',
    properties: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, fieldType(v)])),
    ...(schema.required ? { required: schema.required } : {}),
  };
}

/** The tool's `outputSchema` for structured sessions: its result, or a ToolError (§6). */
export function outputJsonSchema(tool: Pick<AnyToolDef, 'output'>): JsonSchema {
  return { type: 'object', anyOf: [compactResult(resultJsonSchema(tool)), COMPACT_ERROR_SCHEMA] };
}
