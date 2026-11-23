/**
 * The question contract (owner decision 47; MCP_SPEC §5.7): every limit,
 * exactly one recommendation, the plain-language guard in both directions,
 * and the error an old single-text call gets. All content is synthetic.
 */
import { describe, expect, it } from 'vitest';
import {
  QUESTION_FORM,
  askOwnerInput,
  findInternalRef,
  formatChoice,
  TOOL_DESCRIPTIONS,
  getTool,
  inputJsonSchema,
  validationError,
} from '../src/index.js';

const option = (label: string, recommended = false) => ({
  label,
  description: 'What this means in practice.',
  consequences: 'What happens next, including the downside.',
  ...(recommended ? { recommended: true } : {}),
});
const valid = {
  id: 'RCP-14',
  question: 'Should the recipe card show nutrition per serving?',
  context: 'The card has room for one nutrition figure on a phone.',
  why_it_matters: 'People compare recipes by this number.',
  options: [option('Per serving', true), option('Per 100 g')],
  recommendation_reason: 'Most people want the amount they actually eat.',
};

const errorFor = (args: unknown) => {
  const parsed = askOwnerInput.safeParse(args);
  expect(parsed.success, 'expected a validation failure').toBe(false);
  return validationError('ask_owner', askOwnerInput, parsed.error!);
};
const fieldsOf = (args: unknown) =>
  (errorFor(args).toJSON().details as { fields: Record<string, string> }).fields;

describe('ask_owner contract', () => {
  it('accepts a complete question, with and without details', () => {
    expect(askOwnerInput.safeParse(valid).success).toBe(true);
    expect(
      askOwnerInput.safeParse({ ...valid, details: 'See dec_01 and server/src/domain/items.ts' })
        .success,
    ).toBe(true);
  });

  it.each([
    ['question', QUESTION_FORM.question],
    ['context', QUESTION_FORM.context],
    ['why_it_matters', QUESTION_FORM.why_it_matters],
    ['recommendation_reason', QUESTION_FORM.recommendation_reason],
    ['details', QUESTION_FORM.details],
  ])('limits %s to %i characters', (field, max) => {
    const at =
      field === 'question' ? `${'a'.repeat(max - 1)}?` : 'a '.repeat(max).slice(0, max - 1) + 'a';
    const over = field === 'question' ? `${'a'.repeat(max)}?` : 'a'.repeat(max + 1);
    expect(askOwnerInput.safeParse({ ...valid, [field]: at }).success).toBe(true);
    expect(fieldsOf({ ...valid, [field]: over })[field]).toBe(
      `must be at most ${max.toLocaleString('en-US').replace(/,/g, '')} characters`,
    );
  });

  it.each([
    ['label', QUESTION_FORM.label],
    ['description', QUESTION_FORM.option_text],
    ['consequences', QUESTION_FORM.option_text],
  ])('limits an option %s to %i characters', (field, max) => {
    const withField = (value: string) => ({
      ...valid,
      options: [{ ...option('Per serving', true), [field]: value }, option('Per 100 g')],
    });
    expect(askOwnerInput.safeParse(withField('a'.repeat(max))).success).toBe(true);
    expect(fieldsOf(withField('a'.repeat(max + 1)))[`options[0].${field}`]).toMatch(/at most/);
  });

  it('takes 2 to 4 options', () => {
    expect(fieldsOf({ ...valid, options: [option('Only', true)] }).options).toMatch(/at least 2/);
    const five = ['A', 'B', 'C', 'D', 'E'].map((l, i) => option(l, i === 0));
    expect(fieldsOf({ ...valid, options: five }).options).toMatch(/at most 4/);
    expect(askOwnerInput.safeParse({ ...valid, options: five.slice(0, 4) }).success).toBe(true);
  });

  it('needs exactly one recommended option', () => {
    expect(fieldsOf({ ...valid, options: [option('A'), option('B')] }).options).toContain(
      'exactly one option recommended: true (found 0)',
    );
    expect(
      fieldsOf({ ...valid, options: [option('A', true), option('B', true)] }).options,
    ).toContain('(found 2)');
  });

  it('refuses two options with the same label, ignoring case', () => {
    const fields = fieldsOf({ ...valid, options: [option('Keep', true), option('keep')] });
    expect(fields['options[1].label']).toContain('repeats "keep"');
  });

  it('wants one plain sentence ending in "?"', () => {
    expect(fieldsOf({ ...valid, question: 'Pick a unit.' }).question).toBe('must end with "?"');
    expect(fieldsOf({ ...valid, question: 'Grams? Or ounces?' }).question).toContain('one "?"');
    expect(fieldsOf({ ...valid, question: 'Grams\nor ounces?' }).question).toBe('must be one line');
  });

  it('an old single-text call gets a validation error that teaches the new shape', () => {
    const err = errorFor({
      id: 'RCP-14',
      question: 'Per serving or per 100 g? I would use serving.',
    });
    expect(err.code).toBe('validation');
    for (const word of [
      'context',
      'why_it_matters',
      'options',
      'consequences',
      'recommended: true on exactly one',
      'recommendation_reason',
      'details?',
    ]) {
      expect(err.message).toContain(word);
    }
  });

  it('a call in the new shape with one mistake is not told about the old shape', () => {
    expect(errorFor({ ...valid, question: 'No question mark' }).message).not.toContain(
      'ask_owner now takes',
    );
  });
});

describe('plain-language guard', () => {
  it.each([
    'dec_01JABCDEF',
    'dv_9c0e',
    'run_01J2',
    'q_01J3',
    'ctx_034b9669f019',
    'wst_7',
    'pkt_12',
    'see 4be1c09 for it',
    '02d9a7a1d43163a870032ab472af6a848afae61d',
    'server/src/domain/items.ts',
    'src/lib',
    'docs/design/notes.md',
    'C:\\Users\\someone\\work',
    './run.sh',
    '../secrets',
    '~/projects',
    '/api/items',
    'https://example.com/page',
    '(web/src/App.tsx)',
  ])('flags %s', (text) => {
    expect(findInternalRef(text)).not.toBeNull();
  });

  it.each([
    'GF-243 and RCP-14 need the same change',
    'and/or',
    'open 24/7',
    'by 11/23/2026',
    'client/server',
    'React/Node.js',
    'km/h',
    'N/A',
    'version 1.2/1.3',
    'a defaced card',
    'call 1234567',
    'a 1024 px screen',
    'the run finished',
    'a decision about the question',
    "Don't show prices until checkout, e.g. on the card.",
  ])('allows %s', (text) => {
    expect(findInternalRef(text)).toBeNull();
  });

  it.each([
    ['question', { question: 'Should we follow dec_01ABC?' }],
    ['context', { context: 'The change is in server/src/domain/items.ts today.' }],
    ['why_it_matters', { why_it_matters: 'Commit 4be1c09 broke this.' }],
    ['recommendation_reason', { recommendation_reason: 'See run_01ABC.' }],
  ])('names the field and what to do for %s', (field, patch) => {
    const message = fieldsOf({ ...valid, ...patch })[field];
    expect(message).toContain('contains "');
    expect(message).toContain('move IDs, hashes, paths and links to details');
  });

  it.each(['label', 'description', 'consequences'])('covers an option %s', (field) => {
    const fields = fieldsOf({
      ...valid,
      options: [{ ...option('Per serving', true), [field]: 'Uses ctx_01ABC' }, option('Per 100 g')],
    });
    expect(fields[`options[0].${field}`]).toContain('"ctx_01ABC"');
  });

  it('allows internals in details, and ticket keys everywhere', () => {
    expect(
      askOwnerInput.safeParse({
        ...valid,
        context: 'GF-243 asks for this, and GF-250 depends on it.',
        details: 'dec_01ABC, run_01ABC, 4be1c09, server/src/domain/items.ts, https://example.com',
      }).success,
    ).toBe(true);
  });
});

describe('the readable form of a choice', () => {
  it('names the option, whether it was recommended, and the note', () => {
    expect(formatChoice({ option: 'Per serving', recommended: true, note: null })).toBe(
      'Chose: Per serving (the recommended option)',
    );
    expect(formatChoice({ option: 'Per 100 g', recommended: false, note: 'Add a footnote.' })).toBe(
      'Chose: Per 100 g. Note: Add a footnote.',
    );
  });
});

describe('schema cost', () => {
  it('stays within its token budget (MCP_SPEC §3.2)', () => {
    const schema = JSON.stringify(inputJsonSchema(getTool('ask_owner')!));
    const tokens = Math.ceil((schema.length + TOOL_DESCRIPTIONS.ask_owner.length) / 4);
    console.log(`ask_owner definition: ${tokens} tokens`);
    expect(tokens).toBeLessThanOrEqual(310);
  });
});
