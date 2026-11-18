/**
 * Reads docs/MCP_SPEC.md at test time, so tests compare the code against the
 * spec itself, never against a copy (constitution Principle IV). Used by the
 * shared tests and by the server's contract snapshot test.
 */
import { readFileSync } from 'node:fs';

export const SPEC_PATH = new URL('../../docs/MCP_SPEC.md', import.meta.url);

/** MCP_SPEC.md with line endings normalised to `\n`. */
export const SPEC: string = readFileSync(SPEC_PATH, 'utf8').replace(/\r\n/g, '\n');

function after(marker: string): string {
  const at = SPEC.indexOf(marker);
  if (at < 0) throw new Error(`MCP_SPEC.md has no "${marker}"`);
  return SPEC.slice(at + marker.length);
}

/** The first fenced code block after `marker`. */
export function specBlock(marker: string): string {
  const m = /```[a-z]*\n([\s\S]*?)\n```/.exec(after(marker));
  if (!m) throw new Error(`No code block after "${marker}"`);
  return m[1]!;
}

/** The first inline code span after `marker`. */
export function specInline(marker: string): string {
  const m = /`([^`]+)`/.exec(after(marker));
  if (!m) throw new Error(`No inline code after "${marker}"`);
  return m[1]!;
}

/** §2: the server instructions, the code block under the heading. */
export function specInstructions(): string {
  return specBlock('## 2. Server instructions');
}

/** §5: every `#### \`tool\`` with its `**Description:** "…"`, in document order. */
export function specDescriptions(): [name: string, description: string][] {
  const re = /^#### `(\w+)`\n\*\*Description:\*\* "(.*)"$/gm;
  return [...SPEC.matchAll(re)].map((m) => [m[1]!, m[2]!]);
}

/** §5: the markdown of one tool's section (from its heading to the next heading). */
export function specToolSection(name: string): string {
  const start = SPEC.indexOf(`#### \`${name}\`\n`);
  if (start < 0) throw new Error(`MCP_SPEC.md has no tool ${name}`);
  const rest = SPEC.slice(start + 1);
  const end = rest.search(/\n#{2,4} /);
  return end < 0 ? rest : rest.slice(0, end);
}

/** The `- **Input:**` or `- **Output:**` part of a tool's section, up to the next top-level bullet. */
export function specToolPart(name: string, part: 'Input' | 'Output'): string {
  const section = specToolSection(name);
  const at = section.indexOf(`- **${part}:**`);
  if (at < 0) throw new Error(`${name} has no ${part} in MCP_SPEC.md`);
  const rest = section.slice(at + 1);
  const end = rest.search(/\n- \*\*/);
  return end < 0 ? rest : rest.slice(0, end);
}

/** §5.11: a prompt's `**Description:** "…"` under its `#### Prompt \`name\`` heading. */
export function specPromptDescription(name: string): string {
  const heading = `#### Prompt \`${name}\`\n**Description:** "`;
  const at = SPEC.indexOf(heading);
  if (at < 0) throw new Error(`MCP_SPEC.md has no prompt ${name} with a description`);
  const rest = SPEC.slice(at + heading.length);
  return rest.slice(0, rest.indexOf('"\n'));
}

/** §5.11: a prompt's arguments, from its `- **Arguments:**` list: [name, required, description]. */
export function specPromptArguments(name: string): [string, boolean, string][] {
  const start = SPEC.indexOf(`#### Prompt \`${name}\`\n`);
  if (start < 0) throw new Error(`MCP_SPEC.md has no prompt ${name}`);
  const rest = SPEC.slice(start + 1);
  const end = rest.search(/\n#{2,4} /);
  const section = end < 0 ? rest : rest.slice(0, end);
  const re = /^ {2}- `(\w+)` \((required|optional)\): "(.*)"$/gm;
  return [...section.matchAll(re)].map((m) => [m[1]!, m[2] === 'required', m[3]!]);
}
