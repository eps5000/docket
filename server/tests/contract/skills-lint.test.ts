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
 *
 * Decision 66 (B83): a skill keeps a core and loads references on demand.
 * Each `skills/<name>/references/<topic>.md` starts with its two gate lines,
 * `**Read when:**` and `**Don't read when:**`, and the skill's `SKILL.md`
 * ends with a References table listing every reference with the same two
 * gates. References get the same name checks, a cap of their own, and each
 * core keeps its safety rules.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
/** Decision 66: a reference is read only when its gate says so, and stays small too. */
export const REFERENCE_MAX_LINES = 300;
export const REFERENCE_MAX_TOKENS = 3_000;
/** Decision 66: after the split every core keeps headroom under the cap. */
export const CORE_TARGET_TOKENS = 3_600;

export const tokensOf = (text: string): number => Math.ceil(text.length / 4);

/** A snake_case word: lower case, at least one underscore. */
const SNAKE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

export interface SkillFile {
  folder: string;
  path: string;
  text: string;
}

const readText = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

export function skillFiles(dir = SKILLS_DIR): SkillFile[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'SKILL.md')))
    .map((d) => {
      const path = join(dir, d.name, 'SKILL.md');
      return { folder: d.name, path, text: readText(path) };
    });
}

export interface ReferenceFile {
  /** `references/<topic>.md`, as the skill's table names it. */
  file: string;
  path: string;
  text: string;
}

/** Every file in a skill's `references/` folder, sorted. */
export function referenceFiles(skill: SkillFile): ReferenceFile[] {
  const dir = join(dirname(skill.path), 'references');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .sort()
    .map((name) => ({
      file: `references/${name}`,
      path: join(dir, name),
      text: readText(join(dir, name)),
    }));
}

export interface Gates {
  read: string;
  dont: string;
}

const READ_WHEN = '**Read when:** ';
const DONT_READ_WHEN = "**Don't read when:** ";

/**
 * A reference's gates: the first two lines after its `# ` heading (blank lines
 * skipped), `**Read when:** …` then `**Don't read when:** …`. Null if either
 * is missing, empty or out of order.
 */
export function referenceGates(text: string): Gates | null {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  if (!lines[0]?.startsWith('# ')) return null;
  const read = lines[1]?.startsWith(READ_WHEN) ? lines[1].slice(READ_WHEN.length).trim() : '';
  const dont = lines[2]?.startsWith(DONT_READ_WHEN)
    ? lines[2].slice(DONT_READ_WHEN.length).trim()
    : '';
  return read && dont ? { read, dont } : null;
}

/**
 * The skill's References table: the last `## References` section, a table of
 * `| [`references/x.md`](references/x.md) | Read when | Don't read when |`.
 * Null when the skill has none; `last` says whether it is the final section.
 */
export function referencesTable(
  text: string,
): { rows: (Gates & { file: string })[]; last: boolean; malformed: string[] } | null {
  const at = text.lastIndexOf('\n## References\n');
  if (at < 0) return null;
  const section = text.slice(at + 1);
  const last = !/\n## /.test(section.slice(3));
  const rows: (Gates & { file: string })[] = [];
  const malformed: string[] = [];
  const tableLines = section.split('\n').filter((l) => l.startsWith('|'));
  const [head, rule, ...body] = tableLines;
  if (!head || !/^\|\s*File\s*\|\s*Read when\s*\|\s*Don't read when\s*\|$/.test(head) || !rule) {
    return {
      rows,
      last,
      malformed: ["the table header must be | File | Read when | Don't read when |"],
    };
  }
  for (const line of body) {
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    const m = /^\[`(references\/[a-z0-9-]+\.md)`\]\((references\/[a-z0-9-]+\.md)\)$/.exec(
      cells[0] ?? '',
    );
    if (cells.length !== 3 || !m || m[1] !== m[2] || !cells[1] || !cells[2]) {
      malformed.push(line);
      continue;
    }
    rows.push({ file: m[1]!, read: cells[1], dont: cells[2] });
  }
  return { rows, last, malformed };
}

/** What's wrong with a skill's references and its table; empty when nothing is. */
export function referenceProblems(skill: SkillFile, refs: readonly ReferenceFile[]): string[] {
  const out: string[] = [];
  const table = referencesTable(skill.text);
  if (refs.length === 0 && !table) return out;
  if (!table) return [`${skill.folder} has references but no "## References" table`];
  out.push(...table.malformed.map((l) => `malformed row: ${l}`));
  if (!table.last) out.push('"## References" must be the last section of SKILL.md');
  const listed = new Map(table.rows.map((r) => [r.file, r]));
  for (const ref of refs) {
    const gates = referenceGates(ref.text);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*\.md$/.test(ref.file.slice('references/'.length))) {
      out.push(`${ref.file}: name it <topic>.md with a-z, 0-9 and single hyphens`);
    }
    if (!gates)
      out.push(
        `${ref.file}: no "**Read when:**" and "**Don't read when:**" lines under its heading`,
      );
    const row = listed.get(ref.file);
    if (!row) out.push(`${ref.file} isn't listed in the References table`);
    else if (gates && (row.read !== gates.read || row.dont !== gates.dont)) {
      out.push(`${ref.file}: the table's gates differ from the file's`);
    }
  }
  const present = new Set(refs.map((r) => r.file));
  for (const row of table.rows) {
    if (!present.has(row.file)) out.push(`${row.file} is listed but doesn't exist`);
  }
  return out;
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
  it('finds the eight shipped skills', () => {
    expect(skills.map((s) => s.folder).sort()).toEqual([
      'docket-bug-investigator',
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
        expect(tokensOf(skill.text)).toBeLessThanOrEqual(SKILL_MAX_TOKENS);
      });

      it(`keeps its core within ${CORE_TARGET_TOKENS} tokens, with headroom (decision 66)`, () => {
        expect(tokensOf(skill.text)).toBeLessThanOrEqual(CORE_TARGET_TOKENS);
      });

      const refs = referenceFiles(skill);

      it('lists every reference with its gates, and every listed reference exists (decision 66)', () => {
        expect(referenceProblems(skill, refs)).toEqual([]);
      });

      for (const ref of refs) {
        it(`${ref.file}: names only registered tools, fields and enum values`, () => {
          const bad = unknownNames(ref.text, vocab).map((u) => `${u.name} (line ${u.line})`);
          expect(bad, `Unknown names in ${skill.folder}/${ref.file}`).toEqual([]);
        });

        it(`${ref.file}: stays within ${REFERENCE_MAX_LINES} lines and ${REFERENCE_MAX_TOKENS} tokens`, () => {
          expect(ref.text.split('\n').length).toBeLessThanOrEqual(REFERENCE_MAX_LINES);
          expect(tokensOf(ref.text)).toBeLessThanOrEqual(REFERENCE_MAX_TOKENS);
        });

        it(`${ref.file}: has no frontmatter, so no client loads it as a skill`, () => {
          expect(frontmatter(ref.text)).toBeNull();
        });
      }
    });
  }

  // Decision 66: a gate may hide detail, never a safety rule. Each core keeps these.
  describe('each core keeps its safety rules (decision 66)', () => {
    const SAFETY: Record<string, string[]> = {
      'docket-bug-investigator': [
        'Do not change production data or use destructive cleanup to obtain evidence.',
        'Do not implement a fix, change priority or epic, move the Bug to Ready, merge, deploy or close it.',
      ],
      'docket-worker': [
        '**Never retry in a loop.**',
        '**Never wait in a loop.**',
        '**Never just go quiet.**',
        '**Never wait in a `sleep` loop:**',
        "Don't claim. Call `heartbeat { run_id",
        'clear `design_review` by removing the flag, and never work around an owner decision',
        "Don't edit installed files",
        '**Never paste secrets.**',
        "Work on an item you haven't claimed, or one someone else holds.",
        'Move items to Ready unless the project rules allow it.',
      ],
      'docket-coordinator': [
        'Never prune `in_use`, `parked` or `at_risk`, and treat `unknown` as not safe. **Idle is not finished.**',
        '**Prune only workspaces in `safe_to_prune`.**',
        '**Never poll.**',
        'Never fork it or let it inherit your conversation',
        "**Don't answer for the owner**",
        '**Never answer for the owner,** and never push work on a canceled item',
        'Never rebuild a brief from memory, and never edit lines inside a stored brief.',
        "Don't edit installed files",
        '## Owner-only (don',
        'Run two workers on one item.',
      ],
      'docket-delivery': [
        "**The project's rules come first.**",
        '**This skill grants no authority.**',
        'Never skip, weaken or bypass a check to get a merge through.',
        "**Never queue something the gate can't actually stop.**",
        '**Never cancel merge-queue or main runs:**',
        "Never remove containers, volumes, caches or data you didn't create.",
        '**When a precondition fails, stop and report it.**',
        "**Moving to paid capacity is the owner's decision.**",
        'Never commit it, or paste it into logs, tickets or fixtures.',
        'Never report green from memory',
      ],
      'docket-producer': [
        "**The project's rules come first.**",
        '**This skill grants no authority.**',
        "don't co-produce",
        'Never leave it for the owner to find blank.',
        '**Claim, dispatch and resume nothing.**',
        'never approval',
      ],
      'docket-planner': [
        '**Planning belongs to the owner.**',
        '**Never leave a ticket undeclared.**',
        '**only if the project allows it**',
      ],
      'docket-review-packet': [],
      'docket-lead-subagents': ['Never mark relayed work as observed.'],
    };

    it('covers every shipped skill', () => {
      expect(Object.keys(SAFETY).sort()).toEqual(skills.map((s) => s.folder).sort());
    });

    for (const [folder, rules] of Object.entries(SAFETY)) {
      it(folder, () => {
        const text = skills.find((s) => s.folder === folder)!.text;
        expect(rules.filter((r) => !text.includes(r))).toEqual([]);
      });
    }
  });

  describe('the reference checks themselves (decision 66)', () => {
    const skill = (table: string): SkillFile => ({
      folder: 'probe',
      path: join(SKILLS_DIR, 'probe', 'SKILL.md'),
      text: `---\nname: probe\ndescription: x\n---\n\n# Probe\n\n## References\n\n${table}`,
    });
    const head = "| File | Read when | Don't read when |\n| --- | --- | --- |\n";
    const row = (topic: string, read = 'A.', dont = 'B.') =>
      `| [\`references/${topic}.md\`](references/${topic}.md) | ${read} | ${dont} |\n`;
    const ref = (topic: string, body = "# T\n\n**Read when:** A.\n**Don't read when:** B.\n") => ({
      file: `references/${topic}.md`,
      path: '',
      text: body,
    });

    it('accepts a listed reference with matching gates', () => {
      expect(referenceProblems(skill(head + row('one')), [ref('one')])).toEqual([]);
    });

    it('catches missing gates, an unlisted file, a missing file and different gates', () => {
      const problems = referenceProblems(
        skill(head + row('one') + row('gone') + row('two', 'C.')),
        [ref('one', '# T\n\nNo gates here.\n'), ref('two'), ref('three')],
      );
      expect(problems).toEqual([
        'references/one.md: no "**Read when:**" and "**Don\'t read when:**" lines under its heading',
        "references/two.md: the table's gates differ from the file's",
        "references/three.md isn't listed in the References table",
        "references/gone.md is listed but doesn't exist",
      ]);
    });

    it("catches a references folder without a table, a malformed row and a table that isn't last", () => {
      const bare: SkillFile = {
        ...skill(''),
        text: '---\nname: probe\ndescription: x\n---\n# P\n',
      };
      expect(referenceProblems(bare, [ref('one')])).toEqual([
        'probe has references but no "## References" table',
      ]);
      expect(
        referenceProblems(skill(`${head}| one.md | A. | B. |\n\n## After\n`), []).sort(),
      ).toEqual([
        '"## References" must be the last section of SKILL.md',
        'malformed row: | one.md | A. | B. |',
      ]);
    });
  });

  // Decision 52: it ships to every project, so it names none of them.
  describe('docket-delivery stays project-agnostic', () => {
    const delivery = () => skills.find((s) => s.folder === 'docket-delivery')!.text;

    it('names no pilot, ticket, repo, provider or number of this project, references included', () => {
      expect(projectSpecific(delivery())).toEqual([]);
      for (const ref of referenceFiles(skills.find((s) => s.folder === 'docket-delivery')!)) {
        expect(projectSpecific(ref.text), ref.file).toEqual([]);
      }
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

    it('names no pilot, ticket, repo, provider, orchestrator or number of this project, references included', () => {
      expect(projectSpecific(producer())).toEqual([]);
      for (const ref of referenceFiles(skills.find((s) => s.folder === 'docket-producer')!)) {
        expect(projectSpecific(ref.text), ref.file).toEqual([]);
      }
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
      const refs = referenceFiles(skills.find((s) => s.folder === 'docket-producer')!);
      expect(refs.find((r) => r.file === 'references/partial-exits.md')!.text).toContain(
        'Resolve each item:',
      );
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
