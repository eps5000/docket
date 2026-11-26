/**
 * Implementers report how they finished (owner decision 61; BUILD_SPEC §5.42).
 *
 * - **Every exit reports how it finished.** Parking, releasing and finishing
 *   a run take an optional `exit`: `complete` (everything in the acceptance
 *   criteria is done) or `partial`, with each item left, why, and what would
 *   finish it (another ticket, a flag, an environment, an owner decision).
 *   Closing a ticket as Done is a complete exit.
 * - **A partial exit goes back to the producer.** `get_digest` lists it as
 *   *Finished partly* until someone acts on the ticket: moves the items,
 *   links the ticket that will finish them, starts work, asks the owner, or
 *   closes them with a note. The relay mails the producer where it can.
 * - **The owner sees it** on the card and the item page as "Finished partly:
 *   N items left", with the reasons.
 * - **Done waits for the items.** An agent can't close a ticket as Done while
 *   a partial exit's items are still left: remove them with a note first, or
 *   move them to the ticket that can do them.
 */
import { z } from 'zod';

export const EXIT_OUTCOMES = ['complete', 'partial'] as const;
export type ExitOutcome = (typeof EXIT_OUTCOMES)[number];

/** At most this many items left, each field this long. */
export const EXIT_LIMITS = { left_max: 10, text: 300 } as const;

/** Where the exit was reported. `done`: the ticket was closed, which is a complete exit. */
export const EXIT_VIAS = ['park', 'release', 'finish', 'done'] as const;
export type ExitVia = (typeof EXIT_VIAS)[number];

/**
 * What settled a partial exit, from the ticket's own record after it:
 * `moved` (its acceptance criteria were edited, or it was split), `linked` (a
 * link to the ticket that will finish them), `started` (a new lead claimed
 * it), `asked` (a question to the owner on the ticket or its epic), `reviewed`
 * (the owner approved the one remaining review item), `noted`
 * (a note closing them), `closed` (the owner closed or canceled the ticket).
 */
export const EXIT_SETTLE_KINDS = [
  'moved',
  'linked',
  'started',
  'asked',
  'reviewed',
  'noted',
  'closed',
] as const;
export type ExitSettleKind = (typeof EXIT_SETTLE_KINDS)[number];

/** The words for each settle kind, after "Settled: ". */
export const EXIT_SETTLE_TEXT: Record<ExitSettleKind, string> = {
  moved: 'the items were moved',
  linked: 'linked to the ticket that will finish them',
  started: 'new work started',
  asked: 'the owner was asked',
  reviewed: 'the owner approved the remaining review',
  noted: 'closed with a note',
  closed: 'the ticket was closed',
};

export const exitLeftSchema = z.object({
  text: z.string(),
  why: z.string(),
  /** What would finish it: another ticket, a flag, an environment, an owner decision. */
  needs: z.string(),
  /** The ticket that would finish it, when one is named. */
  item: z.string().nullable(),
});
export type ExitLeft = z.infer<typeof exitLeftSchema>;

/** A run's exit report, as it is shown (MCP_SPEC §4 Run.exit). */
export const exitReportSchema = z.object({
  outcome: z.enum(EXIT_OUTCOMES),
  left: z.array(exitLeftSchema),
  via: z.enum(EXIT_VIAS),
  at: z.string(),
  /** A partial exit someone acted on; null while its items wait on the producer. */
  settled: z.object({ how: z.enum(EXIT_SETTLE_KINDS), at: z.string(), by: z.string() }).nullable(),
});
export type ExitReport = z.infer<typeof exitReportSchema>;

/** "Finished partly: 2 items left". */
export const finishedPartlyText = (left: number): string =>
  `Finished partly: ${left} ${left === 1 ? 'item' : 'items'} left`;
