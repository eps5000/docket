/**
 * New work mid-epic, idle tickets and acknowledged problems (owner decision 62;
 * BUILD_SPEC §5.45).
 *
 * - **Added mid-flight:** a ticket that joined an epic (created in it, or moved
 *   into it) after the epic first moved to In progress. New tickets land in
 *   Inbox, so one still in Inbox is *untriaged*: the producer triages a bug
 *   (to Ready here, or to the epic it belongs in) and asks the owner about a
 *   story (add, defer or drop). An epic can't move to Done while it holds an
 *   untriaged ticket added mid-flight.
 * - **Idle:** an In progress ticket with no open, parked or needs-input run and
 *   no activity for `IDLE_AFTER_DAYS` days. It gets one problem for the owner,
 *   and the radar and overlap checks leave its branches alone.
 */
import { z } from 'zod';

/** A ticket In progress with no live run and no activity for this long is idle. */
export const IDLE_AFTER_DAYS = 3;
export const IDLE_AFTER_MS = IDLE_AFTER_DAYS * 24 * 60 * 60 * 1000;

/** What the owner can do with an idle ticket (`POST /api/items/:id/idle`). */
export const IDLE_ACTIONS = ['ready', 'planning', 'inbox', 'cancel', 'clear_branches'] as const;
export type IdleAction = (typeof IDLE_ACTIONS)[number];

/** Why the radar or an overlap check let go of a conflict with an idle ticket. */
export const IDLE_CLEAR_REASON = 'the other ticket is idle';

export const midflightTicketSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.string(),
  status: z.string(),
  /** When it joined the epic (created in it, or moved into it). */
  added_at: z.string(),
  /** Still in Inbox: nobody has triaged it yet. */
  untriaged: z.boolean(),
});
export type MidflightTicket = z.infer<typeof midflightTicketSchema>;

/** An open epic's tickets added after it started; absent when there are none. */
export const epicMidflightSchema = z.object({
  /** When the epic first moved to In progress. */
  started_at: z.string(),
  /** Non-archived, non-canceled tickets that joined after `started_at`, by ID. */
  added: z.array(midflightTicketSchema),
  /** How many of them are still in Inbox. */
  untriaged: z.number().int(),
});
export type EpicMidflight = z.infer<typeof epicMidflightSchema>;

const tickets = (n: number) => `${n} ticket${n === 1 ? '' : 's'}`;

/** "Added since it started: 3 tickets · 2 untriaged". */
export function midflightText(m: Pick<EpicMidflight, 'added' | 'untriaged'>): string {
  const base = `Added since it started: ${tickets(m.added.length)}`;
  return m.untriaged > 0 ? `${base} · ${m.untriaged} untriaged` : base;
}

/** "Added since this epic started: 2 untriaged". */
export const untriagedText = (n: number) => `Added since this epic started: ${n} untriaged`;

/** "Acknowledged by you" lines fold into one: "You acknowledged 2 problems". */
export const acknowledgedText = (n: number) => `You acknowledged ${n} problem${n === 1 ? '' : 's'}`;
