/**
 * Skills lint (tasks.md T148; owner decision 27; skills/README.md "Keep them
 * in sync with the tools").
 *
 * Every `skills/<name>/SKILL.md`:
 * - has YAML frontmatter with a `name` (equal to its folder) and a
 *   `description`;
 * - names only things that exist: each snake_case word inside an inline
 *   code span or a fenced block must be a registered tool, a top-level input
 *   field of one, or an enum value from `shared/` (the enums module, the
 *   error codes, and every `enum` in the tools' JSON Schemas).
 *
 * The skills also name what a tool returns (`next_cursor`, `pushed_sha`) and
 * fields nested in an input (`workspace.base_sha`). Those are accepted only
 * when they are a property somewhere in a registered tool's input or result
 * schema, so a stale one still fails (B18: a deliberate widening of T148's
 * three lists, recorded in the PR).
 *
 * The tools come from the live `tools/list` of the in-process server, not
 * from a copy, so a renamed tool or field fails here.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as shared from '@docket/shared';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type ContractHarness } from './harness.js';

const SKILLS_DIR = fileURLToPath(new URL('../../../skills/', import.meta.url));

/** A snake_case word: lower case, at least one underscore. */
const SNAKE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

export interface SkillFile {
  folder: string;
  path: string;
  text: string;
}

export function skillFiles(dir = SKILLS_DIR): SkillFile[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'SKILL.md')))
    .map((d) => {
      const path = join(dir, d.name, 'SKILL.md');
      return { folder: d.name, path, text: readFileSync(path, 'utf8').replace(/\r\n/g, '\n') };
    });
}

/** The frontmatter's top-level `key: value` pairs, or null without frontmatter. */
export function frontmatter(text: string): Record<string, string> | null {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]!] = kv[2]!.trim();
  }
  return out;
}

/** Every snake_case word inside inline code spans and fenced blocks, with its line. */
export function codeNames(text: string): { name: string; line: number }[] {
  const out: { name: string; line: number }[] = [];
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, (fm) =>
    '\n'.repeat(fm.split('\n').length - 1),
  );
  let fenced = false;
  body.split('\n').forEach((raw, i) => {
    if (/^\s*```/.test(raw)) {
      fenced = !fenced;
      return;
    }
    const spans = fenced ? [raw] : [...raw.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    for (const span of spans) {
      // Quoted strings inside code are values a person writes (step text, notes), not names.
      const code = span.replace(/"[^"]*"/g, '""');
      for (const m of code.matchAll(SNAKE)) out.push({ name: m[0], line: i + 1 });
    }
  });
  return out;
}

/** Every string in an `enum` (or `const`) anywhere in a JSON Schema. */
function schemaEnums(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const n of node) schemaEnums(n, into);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'enum' && Array.isArray(value)) {
      for (const v of value) if (typeof v === 'string') into.add(v);
    } else if (key === 'const' && typeof value === 'string') {
      into.add(value);
    } else {
      schemaEnums(value, into);
    }
  }
}

/** Every property name anywhere in a JSON Schema. */
function schemaProperties(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const n of node) schemaProperties(n, into);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties' && value && typeof value === 'object') {
      for (const name of Object.keys(value)) into.add(name);
    }
    schemaProperties(value, into);
  }
}

/** String arrays exported by `@docket/shared` (the enums), and `key`s of the filter lists. */
function sharedEnums(into: Set<string>): void {
  for (const value of Object.values(shared)) {
    if (!Array.isArray(value)) continue;
    for (const v of value) {
      if (typeof v === 'string') into.add(v);
      else if (v && typeof v === 'object' && typeof (v as { key?: unknown }).key === 'string') {
        into.add((v as { key: string }).key);
      }
    }
  }
}

export interface Vocabulary {
  tools: Set<string>;
  /** Top-level input fields. */
  fields: Set<string>;
  enums: Set<string>;
  /** Nested input fields and result fields: any property in a tool's schemas. */
  properties: Set<string>;
}

export function vocabulary(tools: readonly Tool[]): Vocabulary {
  const fields = new Set<string>();
  const enums = new Set<string>();
  const properties = new Set<string>();
  for (const t of tools) {
    for (const f of Object.keys(t.inputSchema.properties ?? {})) fields.add(f);
    schemaEnums(t.inputSchema, enums);
    schemaEnums(t.outputSchema, enums);
    schemaProperties(t.inputSchema, properties);
    schemaProperties(t.outputSchema, properties);
  }
  sharedEnums(enums);
  return { tools: new Set(tools.map((t) => t.name)), fields, enums, properties };
}

export function unknownNames(text: string, v: Vocabulary): { name: string; line: number }[] {
  return codeNames(text).filter(
    ({ name }) =>
      !v.tools.has(name) && !v.fields.has(name) && !v.enums.has(name) && !v.properties.has(name),
  );
}

let h: ContractHarness;
let vocab: Vocabulary;

beforeAll(async () => {
  h = await startHarness({ seed: false });
  vocab = vocabulary((await h.a.listTools()).tools);
});
afterAll(async () => {
  await h.close();
});

const skills = skillFiles();

describe('skills lint (T148)', () => {
  it('finds the five shipped skills', () => {
    expect(skills.map((s) => s.folder).sort()).toEqual([
      'docket-coordinator',
      'docket-lead-subagents',
      'docket-planner',
      'docket-review-packet',
      'docket-worker',
    ]);
  });

  for (const skill of skills) {
    describe(skill.folder, () => {
      it('has name (its folder) and description frontmatter', () => {
        const fm = frontmatter(skill.text);
        expect(fm, `${skill.path} has no frontmatter`).not.toBeNull();
        expect(fm!.name).toBe(skill.folder);
        expect(fm!.description?.length ?? 0).toBeGreaterThan(20);
      });

      it('names only registered tools, top-level input fields and shared enum values', () => {
        const bad = unknownNames(skill.text, vocab).map((u) => `${u.name} (line ${u.line})`);
        expect(bad, `Unknown names in ${skill.folder}/SKILL.md`).toEqual([]);
      });
    });
  }

  // The lint itself: a deliberate stale name and a missing frontmatter are caught.
  it('catches a renamed tool, an unknown field and missing frontmatter', () => {
    const bad = [
      '---',
      'name: x',
      'description: A probe skill that names things which do not exist.',
      '---',
      'Call `claim_item { id, run_ident }`, then `get_context`.',
      '```',
      'finish_run { result: "finished", summary }',
      'publish_plan { steps }',
      '```',
    ].join('\n');
    expect(unknownNames(bad, vocab).map((u) => u.name)).toEqual([
      'claim_item',
      'run_ident',
      'publish_plan',
    ]);
    expect(frontmatter('# No frontmatter\n')).toBeNull();
  });
});
