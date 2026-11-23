/**
 * The question contract (owner decision 47; MCP_SPEC §5.7): what `ask_owner`
 * must say so the owner can answer without decoding it.
 *
 * The plain-language guard is narrow and deterministic. It finds Docket and
 * tool internals (object IDs, commit hashes, code paths, links), which belong
 * in `details`. It never judges reading level. Ticket keys such as GF-243 are
 * allowed. Shared contract file (tasks.md, Slice rules).
 */
import { z } from 'zod';
import { text } from './common.js';
import { ID_PREFIXES, QUESTION_FORM } from './limits.js';

export const questionOptionInput = z.strictObject({
  label: text(QUESTION_FORM.label),
  description: text(QUESTION_FORM.option_text),
  consequences: text(QUESTION_FORM.option_text),
  recommended: z.boolean().optional(),
});

/** What the answer dialog shows. Absent on questions asked before decision 47. */
export const questionFormSchema = z.object({
  context: z.string(),
  why_it_matters: z.string(),
  options: z.array(
    z.object({
      label: z.string(),
      description: z.string(),
      consequences: z.string(),
      recommended: z.boolean().optional(),
    }),
  ),
  recommendation_reason: z.string(),
  details: z.string().nullable(),
});
export type QuestionForm = z.infer<typeof questionFormSchema>;

/** The option the owner picked, as `get_item` delivers it. Null for a free-text answer. */
export const questionChoiceSchema = z.object({
  option: z.string(),
  recommended: z.boolean(),
  note: z.string().nullable(),
});
export type QuestionChoice = z.infer<typeof questionChoiceSchema>;

/** The readable form of a choice: what a text-only client sees as the answer. */
export function formatChoice(choice: QuestionChoice): string {
  const picked = `Chose: ${choice.option}${choice.recommended ? ' (the recommended option)' : ''}`;
  return choice.note ? `${picked}. Note: ${choice.note}` : picked;
}

const ID_WORDS = [
  ...Object.values(ID_PREFIXES).map((p) => p.slice(0, -1)),
  // Owner notes, and the coordinator's dispatch and task IDs.
  'note',
  'ctx',
  'task',
];
const INTERNAL_ID = new RegExp(`\\b(?:${ID_WORDS.join('|')})_[A-Za-z0-9]+`);
/** 7 to 40 hex characters with at least one digit and one letter, so "defaced" and 1234567 pass. */
const COMMIT_HASH = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{7,40}\b/i;
const CODE_FOLDERS = new Set(['src', 'node_modules', '.github', '.claude', '__tests__', 'dist']);

/** A file path or link, but not "and/or", "24/7", "11/23/2026" or "React/Node.js". */
function isCodePath(word: string): boolean {
  const t = word.replace(/^[("'`“‘[{<]+/, '').replace(/[)"'`”’\]}>.,;:!?]+$/, '');
  if (!/[\\/]/.test(t)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return true;
  if (/^[A-Za-z]:[\\/]/.test(t)) return true;
  if (/^(?:\.{1,2}|~)[\\/]/.test(t)) return true;
  if (/^[\\/][\w.-]+[\\/]/.test(t)) return true;
  const parts = t.split(/[\\/]/).filter(Boolean);
  if (parts.length < 2) return false;
  if (parts.some((p) => CODE_FOLDERS.has(p))) return true;
  return /^[a-z0-9_.-]+$/.test(parts[0]!) && /\.[a-z][a-z0-9]{1,5}$/i.test(parts.at(-1)!);
}

/** The first Docket or tool internal in `value`, or null when it reads as plain language. */
export function findInternalRef(value: string): string | null {
  const id = INTERNAL_ID.exec(value) ?? COMMIT_HASH.exec(value);
  if (id) return id[0];
  return value.split(/\s+/).find(isCodePath) ?? null;
}

/** The new shape, taught by the error an old single-text call gets. */
export const ASK_OWNER_SHAPE =
  'ask_owner now takes a question the owner can read without knowing this work: { id, question (one plain sentence ending in "?"), context, why_it_matters, options: 2 to 4 of { label, description, consequences, recommended: true on exactly one }, recommendation_reason, details? (IDs, hashes, paths and links go here) }.';

const NEW_FIELDS = ['context', 'why_it_matters', 'options', 'recommendation_reason'];

/** True when a required field of the contract is missing: the call uses the old shape. */
export function isOldAskOwnerCall(issues: readonly z.core.$ZodIssue[]): boolean {
  return issues.some(
    (i) =>
      i.code === 'invalid_type' &&
      i.input === undefined &&
      i.path.length === 1 &&
      NEW_FIELDS.includes(String(i.path[0])),
  );
}

interface FormInput {
  question: string;
  context: string;
  why_it_matters: string;
  options: { label: string; description: string; consequences: string; recommended?: boolean }[];
  recommendation_reason: string;
}

/** The rules a schema can't state: one sentence, one recommendation, no internals. */
export function checkQuestionForm(value: FormInput, ctx: z.core.$RefinementCtx<FormInput>): void {
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: 'custom', path, message });
  const plain = (path: (string | number)[], field: string) => {
    const found = findInternalRef(field);
    if (found) {
      issue(
        path,
        `contains "${found}". Say it in everyday words and move IDs, hashes, paths and links to details`,
      );
    }
  };

  if (!value.question.endsWith('?')) issue(['question'], 'must end with "?"');
  if (/[\r\n]/.test(value.question)) issue(['question'], 'must be one line');
  if (value.question.indexOf('?') < value.question.length - 1) {
    issue(['question'], 'must be one sentence with one "?". Put the background in context');
  }
  plain(['question'], value.question);
  plain(['context'], value.context);
  plain(['why_it_matters'], value.why_it_matters);
  plain(['recommendation_reason'], value.recommendation_reason);

  const recommended = value.options.filter((o) => o.recommended === true).length;
  if (recommended !== 1) {
    issue(['options'], `must mark exactly one option recommended: true (found ${recommended})`);
  }
  const seen = new Set<string>();
  value.options.forEach((o, i) => {
    const key = o.label.toLowerCase();
    if (seen.has(key)) issue(['options', i, 'label'], `repeats "${o.label}". Labels must differ`);
    seen.add(key);
    plain(['options', i, 'label'], o.label);
    plain(['options', i, 'description'], o.description);
    plain(['options', i, 'consequences'], o.consequences);
  });
}
