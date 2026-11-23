/**
 * Turn a zod input failure into a `validation` ToolError (MCP_SPEC §6): one
 * message an agent can act on in a single retry, plus `details.fields`
 * (field path → problem).
 *
 * Inputs are strict (B3 resolution 4): each unknown key is named, with the
 * closest valid field when one is near, in the message and in
 * `details.unknown`: 'Unknown field "expected_verison"; did you mean "expected_version"?'.
 *
 * Shared contract file (tasks.md, Slice rules).
 */
import type { z } from 'zod';
import { ToolError } from '../errors.js';
import { ASK_OWNER_SHAPE, isOldAskOwnerCall } from './question-form.js';

export interface UnknownField {
  field: string;
  suggestion: string | null;
}

/** Levenshtein distance, for "did you mean". */
export function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = Math.min(up + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length]!;
}

/** The closest of `candidates` to `key`, if it is near enough to be a typo. */
export function closestField(key: string, candidates: readonly string[]): string | null {
  const lower = key.toLowerCase();
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const c of candidates) {
    const d = editDistance(lower, c.toLowerCase());
    if (d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  if (best === null) return null;
  const threshold = Math.max(2, Math.floor(Math.max(key.length, best.length) / 3));
  return bestDistance <= threshold ? best : null;
}

type Def = {
  type: string;
  innerType?: z.ZodType;
  element?: z.ZodType;
  shape?: Record<string, z.ZodType>;
  in?: z.ZodType;
};

const defOf = (schema: z.ZodType) => (schema as unknown as { _zod: { def: Def } })._zod.def;

/** Unwrap optional/default/nullable/pipe wrappers. */
function unwrap(schema: z.ZodType): z.ZodType {
  let s = schema;
  for (;;) {
    const def = defOf(s);
    if (
      def.innerType &&
      ['optional', 'default', 'nullable', 'readonly', 'prefault', 'catch', 'nonoptional'].includes(
        def.type,
      )
    ) {
      s = def.innerType;
    } else if (def.type === 'pipe' && def.in) {
      s = def.in;
    } else {
      return s;
    }
  }
}

/** The valid keys of the object schema at `path`, or [] when there is none. */
export function keysAt(schema: z.ZodType, path: readonly PropertyKey[]): string[] {
  let s = unwrap(schema);
  for (const seg of path) {
    const def = defOf(s);
    if (typeof seg === 'number' && def.type === 'array' && def.element) s = unwrap(def.element);
    else if (typeof seg === 'string' && def.type === 'object' && def.shape?.[seg])
      s = unwrap(def.shape[seg]);
    else return [];
  }
  const def = defOf(s);
  if (def.type === 'array' && def.element) return keysAt(def.element, []);
  return def.type === 'object' && def.shape ? Object.keys(def.shape) : [];
}

export function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out ? `.${String(seg)}` : String(seg);
  }
  return out;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One problem, phrased to follow the field name. */
function describe(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return issue.input === undefined
        ? 'is required'
        : `must be ${issue.expected === 'int' ? 'an integer' : `a ${issue.expected}`}`;
    case 'too_big': {
      const max = Number(issue.maximum);
      if (issue.origin === 'string') return `must be at most ${plural(max, 'character')}`;
      if (issue.origin === 'array' || issue.origin === 'set')
        return `must have at most ${plural(max, 'entry').replace('entrys', 'entries')}`;
      return `must be at most ${max}`;
    }
    case 'too_small': {
      const min = Number(issue.minimum);
      if (issue.origin === 'string')
        return min <= 1 ? 'must not be empty' : `must be at least ${plural(min, 'character')}`;
      if (issue.origin === 'array' || issue.origin === 'set')
        return `must have at least ${plural(min, 'entry').replace('entrys', 'entries')}`;
      return `must be at least ${min}`;
    }
    case 'invalid_value':
      return `must be ${issue.values.length === 1 ? JSON.stringify(issue.values[0]) : `one of ${issue.values.map((v) => JSON.stringify(v)).join(', ')}`}`;
    case 'invalid_format':
      return issue.message && !issue.message.startsWith('Invalid')
        ? lowerFirst(issue.message)
        : `must be a valid ${issue.format}`;
    case 'not_multiple_of':
      return `must be a multiple of ${String(issue.divisor)}`;
    default:
      return lowerFirst(issue.message || 'is invalid');
  }
}

function lowerFirst(text: string): string {
  const t = text.replace(/\.$/, '');
  return t.charAt(0).toLowerCase() + t.slice(1);
}

/** A `validation` ToolError for a tool call whose arguments failed `schema`. */
export function validationError(tool: string, schema: z.ZodType, error: z.ZodError): ToolError {
  const fields: Record<string, string> = {};
  const unknown: UnknownField[] = [];
  // Unknown fields first: a misspelt key is the likeliest cause of the rest.
  const unknownSentences: string[] = [];
  const sentences: string[] = [];
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      const candidates = keysAt(schema, issue.path);
      for (const key of issue.keys) {
        const field = formatPath([...issue.path, key]);
        const suggestion = closestField(key, candidates);
        const text = `Unknown field "${field}"${suggestion ? `; did you mean "${formatPath([...issue.path, suggestion])}"?` : '.'}`;
        unknown.push({
          field,
          suggestion: suggestion ? formatPath([...issue.path, suggestion]) : null,
        });
        fields[field] = text;
        unknownSentences.push(text);
      }
      continue;
    }
    const field = formatPath(issue.path) || '(arguments)';
    const problem = describe(issue);
    if (!(field in fields)) {
      fields[field] = problem;
      sentences.push(`${field} ${problem}.`);
    }
  }
  sentences.unshift(...unknownSentences);
  const shown = sentences.slice(0, 6);
  if (sentences.length > shown.length)
    shown.push(`(${sentences.length - shown.length} more in details.fields.)`);
  // Decision 47: a call in the old single-text shape learns the new one from this error.
  const teach =
    tool === 'ask_owner' && isOldAskOwnerCall(error.issues) ? ` ${ASK_OWNER_SHAPE}` : '';
  const message = `Invalid arguments for ${tool}: ${shown.join(' ')} Fix ${sentences.length === 1 ? 'it' : 'them'} and retry.${teach}`;
  const details: Record<string, unknown> = { fields };
  if (unknown.length > 0) details.unknown = unknown;
  return new ToolError('validation', message, { details });
}
