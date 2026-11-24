/**
 * Tickets agents create arrive shaped or ask for a planner (owner decision 65;
 * BUILD_SPEC §5.43).
 *
 * - **Shaped** means an outcome, at least one acceptance criterion, and the
 *   shared changes declared (parts, or "none").
 * - **Needs shaping** is a ticket in Inbox or Planning that an agent created
 *   (`create_item`, or a split) without all three, or whose shaping the owner
 *   asked for from a refused *Move to Ready*. It goes to a planner, not the
 *   owner: it shows on the ticket, the epic, the map and the producer's
 *   `get_digest`, and stops showing once the ticket is shaped or Ready.
 * - It adds no gate. Ready still needs the shared changes declared (decision
 *   36) and open known gaps approved (decision 58).
 */
import { z } from 'zod';

/** What a shaped ticket has, in the order the words list them. */
export const SHAPING_PARTS = ['outcome', 'acceptance', 'shared_changes'] as const;
export type ShapingPart = (typeof SHAPING_PARTS)[number];

/** Who asked for the shaping: the agent that created the ticket, or the owner. */
export const SHAPING_ASKERS = ['agent', 'owner'] as const;
export type ShapingAsker = (typeof SHAPING_ASKERS)[number];

/** The owner's note to the planner, at most this long. */
export const SHAPING_NOTE_MAX = 500;

/** A ticket that needs shaping: what's missing, and who asked. Absent otherwise. */
export const needsShapingSchema = z.object({
  missing: z.array(z.enum(SHAPING_PARTS)),
  /** `agent`: an agent created it unshaped; `owner`: the owner asked a planner to shape it. */
  asked_by: z.enum(SHAPING_ASKERS),
  /** Who: the agent's name, or "owner". */
  by: z.string(),
  at: z.string(),
  /** The owner's note to the planner, when they left one. */
  note: z.string().nullable(),
});
export type NeedsShaping = z.infer<typeof needsShapingSchema>;

const MISSING_WORDS: Record<ShapingPart, string> = {
  outcome: 'no outcome',
  acceptance: 'no acceptance criteria',
  shared_changes: 'shared changes not declared',
};

/** "a", "a and b", "a, b and c". */
function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)!}`;
}

/** "no outcome, no acceptance criteria and shared changes not declared". */
export function missingText(missing: readonly ShapingPart[]): string {
  return joinWords(SHAPING_PARTS.filter((p) => missing.includes(p)).map((p) => MISSING_WORDS[p]));
}

/** "Needs shaping: no outcome and shared changes not declared". */
export function needsShapingText(n: Pick<NeedsShaping, 'missing'>): string {
  return `Needs shaping: ${missingText(n.missing)}`;
}

/** The owner's button on a refused Move to Ready. */
export const ASK_PLANNER_LABEL = 'Ask a planner to shape this';
