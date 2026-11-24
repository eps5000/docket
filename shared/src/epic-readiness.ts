/**
 * An epic starts only when its tickets are ready (owner decision 58; BUILD_SPEC
 * §5.41). Inbox is an idea nobody is ready to plan; Planning still has
 * structural or definition-of-done gaps. So an epic may start only when every
 * one of its tickets is at least Ready (Queued, In progress, Review and Done
 * count; canceled tickets don't matter).
 *
 * - **Known gaps:** a ticket can name a few things that will be settled during
 *   implementation. Moving a Planning ticket with open gaps to Ready needs the
 *   owner's approval, recorded as an owner decision on the ticket. The
 *   implementer records how each gap was settled.
 * - **Readiness:** an epic not yet started with Inbox or Planning tickets is
 *   *not ready*; one already In progress or in Review with them *started
 *   unshaped*, a quiet flag that never stops it.
 */
import { z } from 'zod';

/** At most this many gaps, each this long; a settled note this long. */
export const KNOWN_GAPS = { max: 6, gap: 200, settled: 500 } as const;

export const knownGapSchema = z.object({
  /** 1-based, in the order the ticket lists them. */
  n: z.number().int(),
  gap: z.string(),
  /** How the implementer settled it; null while open. */
  settled: z.string().nullable(),
});
export type KnownGap = z.infer<typeof knownGapSchema>;

/** A ticket's known gaps, and the owner's approval when one covers them. */
export const knownGapsSchema = z.object({
  gaps: z.array(knownGapSchema),
  /** Open gaps: those with no settled note. */
  open: z.number().int(),
  /** The owner approved moving it to Ready with these gaps; null until then. */
  approved: z.object({ decision_id: z.string(), at: z.string() }).nullable(),
});
export type KnownGaps = z.infer<typeof knownGapsSchema>;

/** The two options of the question Docket asks the owner for a ticket with open gaps. */
export const GAP_APPROVE_OPTION = 'Approve with these gaps';
export const GAP_KEEP_OPTION = 'Keep it in Planning';

export const EPIC_READINESS_STATES = ['not_ready', 'started_unshaped'] as const;
export type EpicReadinessState = (typeof EPIC_READINESS_STATES)[number];

export const unshapedTicketSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['inbox', 'planning']),
  /** Decision 65: it needs shaping, so it waits for a planner, not the owner. */
  needs_shaping: z.literal(true).optional(),
});
export type UnshapedTicket = z.infer<typeof unshapedTicketSchema>;

/**
 * An epic with Inbox or Planning tickets: `not_ready` before it starts (it
 * can't start yet), `started_unshaped` once In progress or in Review. Absent
 * when every ticket is at least Ready.
 */
export const epicReadinessSchema = z.object({
  state: z.enum(EPIC_READINESS_STATES),
  /** Non-archived tickets in Inbox or Planning, by ID. */
  unshaped: z.array(unshapedTicketSchema),
});
export type EpicReadiness = z.infer<typeof epicReadinessSchema>;

const tickets = (n: number) => `${n} unshaped ticket${n === 1 ? '' : 's'}`;

/** "Not ready to start: 2 unshaped tickets" or "Started with 1 unshaped ticket". */
export function epicReadinessText(r: Pick<EpicReadiness, 'state' | 'unshaped'>): string {
  const n = r.unshaped.length;
  const text =
    r.state === 'not_ready' ? `Not ready to start: ${tickets(n)}` : `Started with ${tickets(n)}`;
  // Decision 65: how many of them wait for a planner.
  const shaping = r.unshaped.filter((t) => t.needs_shaping).length;
  return shaping > 0 ? `${text} · Needs shaping: ${shaping}` : text;
}

/** The four ways forward an `epic_not_ready` refusal lists, in order. */
export const EPIC_WAYS_FORWARD = [
  'finish shaping it and move it to Ready',
  "propose its known gaps for the owner's approval (update_item known_gaps, then set_status ready)",
  'move it to the epic it belongs in (update_item epic)',
  'take it out of this epic (update_item epic: null)',
] as const;
