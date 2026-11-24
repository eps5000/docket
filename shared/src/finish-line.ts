/**
 * Open bugs hold back an epic's release (owner decision 64; BUILD_SPEC §5.43).
 *
 * - **The finish line** is the epic's release ticket: a ticket in the epic that
 *   depends on other tickets in it and that no other ticket in it depends on.
 *   Bugs and canceled tickets are never the finish line. With exactly one such
 *   ticket, that's it. With several or none, the producer or the owner marks
 *   one (`update_item finish_line` on the epic); until then the epic shows
 *   "No finish line".
 * - **Every open bug in the epic blocks the finish line,** with no link: it
 *   can't move to Review or Done while any bug in the epic is open (not Done or
 *   canceled). Bugs outside the epic don't count. The refusal (`bugs_open`)
 *   lists them and the three ways forward.
 */
import { z } from 'zod';

export const FINISH_LINE_HOW = ['detected', 'explicit'] as const;
export type FinishLineHow = (typeof FINISH_LINE_HOW)[number];

/** An open bug in the epic. */
export const releaseBugSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['inbox', 'planning', 'ready', 'progress', 'review']),
});
export type ReleaseBug = z.infer<typeof releaseBugSchema>;

/** An epic's finish line and the open bugs that hold it. */
export const finishLineSchema = z.object({
  /** The finish-line ticket; null means "No finish line". */
  id: z.string().nullable(),
  /** Found from the links, or marked by the producer or the owner; null without one. */
  how: z.enum(FINISH_LINE_HOW).nullable(),
  /** Without a finish line: the tickets that could be it (several), or none. */
  candidates: z.array(z.string()),
  /** Every open bug in the epic, by ID. Each holds the finish line. */
  open_bugs: z.array(releaseBugSchema),
});
export type FinishLine = z.infer<typeof finishLineSchema>;

/** On a ticket that is its epic's finish line, while bugs in the epic are open. */
export const releaseHoldSchema = z.object({
  epic: z.string(),
  open_bugs: z.array(releaseBugSchema),
});
export type ReleaseHold = z.infer<typeof releaseHoldSchema>;

export const bugCount = (n: number) => `${n} bug${n === 1 ? '' : 's'}`;

/** "Waiting on 2 bugs", the finish line's badge. */
export const waitingOnBugsText = (n: number) => `Waiting on ${bugCount(n)}`;

export const NO_FINISH_LINE = 'No finish line';

/** The three ways forward a `bugs_open` refusal lists, in order. */
export const RELEASE_WAYS_FORWARD = [
  'fix it (Done)',
  'move it to another epic as a follow-up (update_item epic)',
  'cancel it with a reason (set_status canceled)',
] as const;

/** On epic cards and Pick next epic: the finish line (null: none) and how many bugs are open. */
export const epicReleaseSchema = z.object({
  finish_line: z.string().nullable(),
  open_bugs: z.number().int(),
});
export type EpicRelease = z.infer<typeof epicReleaseSchema>;
