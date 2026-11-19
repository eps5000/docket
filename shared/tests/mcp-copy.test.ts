/**
 * The product copy is MCP_SPEC.md verbatim (constitution Principle IV;
 * tasks.md T038). Expected values are extracted from the spec at test time.
 */
import { describe, expect, it } from 'vitest';
import {
  fillSummary,
  ONBOARD_PROMPT_STUB,
  PROMPTS,
  SERVER_INSTRUCTIONS,
  TOOL_DESCRIPTIONS,
  TOOL_SUMMARIES,
} from '../src/mcp-copy.js';
import { TOOL_NAMES } from '../src/mcp/tools.js';
import {
  SPEC,
  specDescriptions,
  specInstructions,
  specPromptArguments,
  specPromptDescription,
} from './spec.js';

describe('mcp-copy matches MCP_SPEC.md', () => {
  it('the server instructions are §2 verbatim', () => {
    expect(SERVER_INSTRUCTIONS).toBe(specInstructions());
  });

  it('the spec defines 43 tools, and the copy has a description for exactly those', () => {
    const spec = specDescriptions();
    expect(spec).toHaveLength(43);
    expect(Object.keys(TOOL_DESCRIPTIONS)).toEqual(spec.map(([name]) => name));
  });

  it.each(specDescriptions())('%s: description is §5 verbatim', (name, description) => {
    expect(TOOL_DESCRIPTIONS[name as keyof typeof TOOL_DESCRIPTIONS]).toBe(description);
  });

  it('the registry lists the tools in §5 order', () => {
    expect(TOOL_NAMES).toEqual(specDescriptions().map(([name]) => name));
  });
});

describe('prompts match MCP_SPEC.md §5.11 (decision 31)', () => {
  it('there is exactly one prompt, onboard', () => {
    expect(PROMPTS.map((p) => p.name)).toEqual(['onboard']);
  });

  it.each(PROMPTS.map((p) => [p.name, p] as const))(
    '%s: description and arguments are §5.11 verbatim',
    (name, prompt) => {
      expect(prompt.description).toBe(specPromptDescription(name));
      expect(prompt.arguments.map((a) => [a.name, a.required, a.description])).toEqual(
        specPromptArguments(name),
      );
    },
  );

  it('the stub text is the one §5.11 names', () => {
    expect(SPEC).toContain(`the text is "${ONBOARD_PROMPT_STUB}"`);
  });
});

describe('result-summary templates', () => {
  it('there is one per tool', () => {
    expect(Object.keys(TOOL_SUMMARIES).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it('fills placeholders and marks missing values', () => {
    expect(
      fillSummary('Moved {id} to {status} · v{version}', {
        id: 'RCP-14',
        status: 'done',
        version: 9,
      }),
    ).toBe('Moved RCP-14 to done · v9');
    expect(fillSummary('{id} {nope}', { id: 'RCP-1' })).toBe('RCP-1 ?');
  });
});
