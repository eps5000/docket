/**
 * Queued instead of Blocked (owner decision 57; BUILD_SPEC §5.39). What an open
 * item with an open blocker is doing, in one of three words. The server
 * classifies it once (`server/src/domain/wait-kind.ts`); every view and the
 * agent text show this result. Display only: the stored status stays, claiming
 * is unchanged, and the `blocked` / `blocked_by` safety facts keep their meaning.
 *
 * - **Queued:** every open blocker in its chain is moving: being worked,
 *   Ready, or Queued itself. It waits its turn, so it shows calm and neutral.
 * - **Blocked:** the wait needs attention, for one of `BLOCKED_REASONS`.
 * - **Held:** an active owner decision or a paused project holds it (decisions
 *   48 and 53), so it is neither Queued nor Blocked.
 */
import { z } from 'zod';

export const WAIT_KINDS = ['queued', 'blocked', 'held'] as const;
export type WaitKind = (typeof WAIT_KINDS)[number];

/**
 * Why a wait needs attention, most pressing first. Each reuses a fact Docket
 * already computes:
 * - `canceled`: a blocker in the chain was canceled, so it never clears;
 * - `cycle`: the chain loops back on itself;
 * - `owner_unasked`: a blocker says an owner decision is pending and nobody asked (B54/B58);
 * - `stalled`: a blocker's lead is parked past the stall threshold, not held by a decision;
 * - `no_next_step`: nobody owns a blocker's next step (B54's `wait_no_next_step`).
 */
export const BLOCKED_REASONS = [
  'canceled',
  'cycle',
  'owner_unasked',
  'stalled',
  'no_next_step',
] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];

/** What holds a Held wait: a paused project, or an active owner decision on a parked lead. */
export const HELD_REASONS = ['paused', 'decision'] as const;
export type HeldReason = (typeof HELD_REASONS)[number];

export const itemWaitSchema = z.object({
  kind: z.enum(WAIT_KINDS),
  /** Null when Queued. */
  reason: z.enum([...BLOCKED_REASONS, ...HELD_REASONS]).nullable(),
  /** The nearest open blocker: the one likeliest to clear first. */
  after: z.string(),
  /** Other open blockers of this item. */
  more: z.number().int(),
  /** The item the reason is about; null when Queued. */
  on: z.string().nullable(),
  /** One plain line: "Starts after GF-12 and 2 more", "GF-9 was canceled, so it never clears". */
  text: z.string(),
});
export type ItemWait = z.infer<typeof itemWaitSchema>;

export const WAIT_KIND_LABELS: Record<WaitKind, string> = {
  queued: 'Queued',
  blocked: 'Blocked',
  held: 'Held',
};

/** Short labels for a Blocked reason (tooltips, filters, Help). Always words. */
export const BLOCKED_REASON_LABELS: Record<BlockedReason, string> = {
  canceled: 'Canceled blocker',
  cycle: 'Blocker loop',
  owner_unasked: 'Owner decision not asked',
  stalled: 'Parked too long',
  no_next_step: 'No next step',
};

/** "Starts after GF-12", "Starts after GF-12 and 2 more". */
export function startsAfterText(after: string, more: number): string {
  return more > 0 ? `Starts after ${after} and ${more} more` : `Starts after ${after}`;
}

/** Counts of Queued and Blocked, in the order every view shows them: "Queued 4 · Blocked 1". */
export function waitCountsText(c: { queued: number; blocked: number }): string {
  return `Queued ${c.queued} · Blocked ${c.blocked}`;
}
