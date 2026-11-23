/**
 * Reading the question contract back from its row (decision 47). Questions
 * asked before it have no form and keep rendering as plain text, and a value
 * that doesn't parse is treated the same way rather than breaking the page.
 */
import {
  questionChoiceSchema,
  questionFormSchema,
  type QuestionChoice,
  type QuestionForm,
} from '@docket/shared';

function parseJson(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function parseQuestionForm(raw: string | null | undefined): QuestionForm | null {
  const parsed = questionFormSchema.safeParse(parseJson(raw));
  return parsed.success ? parsed.data : null;
}

export function parseQuestionChoice(raw: string | null | undefined): QuestionChoice | null {
  const parsed = questionChoiceSchema.safeParse(parseJson(raw));
  return parsed.success ? parsed.data : null;
}

/** The `choice` field of a question view: left out unless the owner picked an option. */
export function choiceField(raw: string | null | undefined): { choice?: QuestionChoice } {
  const choice = parseQuestionChoice(raw);
  return choice ? { choice } : {};
}
