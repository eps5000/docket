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

/**
 * Decision 40: line counts hide size, so each skill also has a token cap
 * (characters ÷ 4, MCP_SPEC §3.2). 4,800 fits the largest today (docket-worker,
 * about 4,300) with a little headroom. Move rarely used detail out instead of
 * raising it.
 */
export const SKILL_MAX_LINES = 500;
export const SKILL_MAX_TOKENS = 4_800;

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
      if (typeof v === 'string') {
        into.add(v);
        // An event type's name after its dot (`run.park_expired`), as the skills write it.
        for (const part of v.split('.')) into.add(part);
      } else if (v && typeof v === 'object' && typeof (v as { key?: unknown }).key === 'string') {
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
    // The full result, not the compact `outputSchema` clients get (decision 40).
    const result = shared.resultJsonSchema(shared.getTool(t.name)!);
    schemaEnums(t.inputSchema, enums);
    schemaEnums(result, enums);
    schemaProperties(t.inputSchema, properties);
    schemaProperties(result, properties);
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

/**
 * What a skill shipped to every project must not name (decision 52): the
 * pilot, a ticket ID, this repo or its owner, a specific CI or merge tool, a
 * batch, PR or decision number, or this service's port.
 */
const PROJECT_SPECIFIC = [
  /gameflow/gi,
  /\b[A-Z][A-Z0-9]+-\d+\b/g,
  /task-?lite|eps5000|\borca\b/gi,
  /github|gitlab|bitbucket|jenkins|circleci|mergify/gi,
  /\bB\d{2}\b/g,
  /\bPR #\d+|\bdecision \d+/gi,
  /\b7420\b/g,
];

export const projectSpecific = (text: string): string[] =>
  PROJECT_SPECIFIC.flatMap((re) => [...text.matchAll(re)].map((m) => m[0]));

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
  it('finds the seven shipped skills', () => {
    expect(skills.map((s) => s.folder).sort()).toEqual([
      'docket-coordinator',
      'docket-delivery',
      'docket-lead-subagents',
      'docket-planner',
      'docket-producer',
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

      it(`stays within ${SKILL_MAX_LINES} lines and ${SKILL_MAX_TOKENS} tokens (decision 40)`, () => {
        expect(skill.text.split('\n').length).toBeLessThanOrEqual(SKILL_MAX_LINES);
        expect(Math.ceil(skill.text.length / 4)).toBeLessThanOrEqual(SKILL_MAX_TOKENS);
      });
    });
  }

  // Decision 52: it ships to every project, so it names none of them.
  describe('docket-delivery stays project-agnostic', () => {
    const delivery = () => skills.find((s) => s.folder === 'docket-delivery')!.text;

    it('names no pilot, ticket, repo, provider or number of this project', () => {
      expect(projectSpecific(delivery())).toEqual([]);
    });

    it('stays subordinate to the project and grants no authority', () => {
      expect(delivery()).toContain("**The project's rules come first.**");
      expect(delivery()).toContain('**This skill grants no authority.**');
    });

    it('the guard catches a planted name', () => {
      expect(
        projectSpecific('See Gameflow, GF-243, PR #120, B64, decision 50, Mergify and port 7420.'),
      ).toHaveLength(7);
    });

    it('is pointed to from the worker and coordinator skills', () => {
      for (const folder of ['docket-worker', 'docket-coordinator']) {
        const text = skills.find((s) => s.folder === folder)!.text;
        expect(text.split('`docket-delivery`').length - 1, folder).toBe(1);
      }
    });
  });

  // Decision 55: the producer role, for any project and any orchestrator.
  describe('docket-producer', () => {
    const producer = () => skills.find((s) => s.folder === 'docket-producer')!.text;

    it('names no pilot, ticket, repo, provider, orchestrator or number of this project', () => {
      expect(projectSpecific(producer())).toEqual([]);
    });

    it('stays subordinate to the project and grants no authority', () => {
      expect(producer()).toContain("**The project's rules come first.**");
      expect(producer()).toContain('its own workflow skills override everything here');
      expect(producer()).toContain('**This skill grants no authority.**');
      expect(producer()).toContain('**Any orchestrator, or none.**');
    });

    it('stays short and points to the mechanics instead of copying them', () => {
      expect(producer().split('\n').length).toBeLessThan(150);
      for (const name of ['coordinator', 'planner', 'worker', 'delivery']) {
        expect(producer()).toContain(`\`docket-${name}\``);
      }
      expect(producer()).not.toContain('docket-wait.sh');
    });

    it('teaches the owner-approved hard and soft dependency rules', () => {
      expect(producer()).toContain("current acceptance criteria can't be met without");
      expect(producer()).toContain('**proceed**, **adjust**, **split**, or **upgrade to hard**');
      expect(producer()).toContain('**If a blocker holds only some criteria, prefer a split:**');
    });

    it('is pointed to once from the coordinator skill', () => {
      const text = skills.find((s) => s.folder === 'docket-coordinator')!.text;
      expect(text.split('`docket-producer`').length - 1).toBe(1);
    });
  });

  // Decision 61 (B78): implementers report how they finished, and producers resolve it.
  describe('exit reports', () => {
    const text = (folder: string) => skills.find((s) => s.folder === folder)!.text;

    it('docket-worker checks acceptance before starting and reports on every exit', () => {
      expect(text('docket-worker')).toContain('**Check each acceptance item before you start.**');
      expect(text('docket-worker')).toContain('**Report how you finished, on every exit**');
      expect(text('docket-worker')).toContain('`release_lead { reason, exit }`');
    });

    it('docket-producer reads partial exits in every digest and resolves each one', () => {
      expect(text('docket-producer')).toContain('## 7. Resolve partial exits');
      expect(text('docket-producer')).toContain('Read `finished partly` in **every** digest');
    });

    it('docket-planner keeps acceptance items to what the ticket can finish', () => {
      expect(text('docket-planner')).toContain(
        '**and each one this ticket can finish on its own**',
      );
    });
  });

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
