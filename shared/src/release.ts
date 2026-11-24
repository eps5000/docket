/**
 * Every epic has one Release (owner decision 67; BUILD_SPEC §5.46). It replaces
 * decision 64's finish line, and keeps its bug rules.
 *
 * - **Exactly one per epic, created with it:** "Release <epic title>". It can be
 *   renamed, but not canceled, archived, moved out or retyped while the epic is
 *   open. An epic can't start without one.
 * - **It depends on everything else in the epic, automatically:** every other
 *   ticket in the epic that isn't canceled, bugs included, with no link. A
 *   ticket added mid-epic is covered the moment it lands. To ship without one,
 *   move it out of the epic or cancel it with a reason.
 * - **Gates before Review or Done** (`release_gates`): every other ticket Done,
 *   canceled or moved out; no open bugs; no unsettled known gaps or partial
 *   exits; its own checklist done.
 * - **The epic closes when its Release is done.**
 */
import { z } from 'zod';
import { TEXT_LIMITS } from './mcp/limits.js';

const openStatus = z.enum(['inbox', 'planning', 'ready', 'progress', 'review']);

/** An open bug in the epic. */
export const releaseBugSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: openStatus,
});
export type ReleaseBug = z.infer<typeof releaseBugSchema>;

/** On epic cards and Pick next epic: the Release, how many tickets it waits for, open bugs. */
export const epicReleaseSchema = z.object({
  /** The Release ticket; null only for an epic with none (closed before decision 67). */
  id: z.string().nullable(),
  /** Other tickets in the epic not yet Done or canceled, bugs included. */
  left: z.number().int(),
  open_bugs: z.number().int(),
});
export type EpicRelease = z.infer<typeof epicReleaseSchema>;

/** On the epic page: the Release, and what still holds it. */
export const releaseDetailSchema = z.object({
  id: z.string().nullable(),
  title: z.string().nullable(),
  status: z
    .enum(['inbox', 'planning', 'ready', 'progress', 'review', 'done', 'canceled'])
    .nullable(),
  /** Other open tickets in the epic, by ID (bugs included). */
  left: z.array(z.string()),
  open_bugs: z.array(releaseBugSchema),
});
export type ReleaseDetail = z.infer<typeof releaseDetailSchema>;

/** At most this many of the tickets a Release waits for are named; the rest are counted. */
export const RELEASE_NAMED_MAX = 10;

/** On a Release ticket while other tickets in its epic are open. */
export const releaseHoldSchema = z.object({
  epic: z.string(),
  /** How many other tickets in the epic are open. */
  left: z.number().int(),
  /** The first of them (at most `RELEASE_NAMED_MAX`), nearest to done first. */
  waiting_on: z.array(z.string()),
  open_bugs: z.array(releaseBugSchema),
});
export type ReleaseHold = z.infer<typeof releaseHoldSchema>;

/** The gates a Release passes before Review or Done, in the order a refusal lists them. */
export const RELEASE_GATES = ['open_tickets', 'open_bugs', 'unsettled', 'checklist'] as const;
export type ReleaseGate = (typeof RELEASE_GATES)[number];

export const RELEASE_GATE_LABELS: Record<ReleaseGate, string> = {
  open_tickets: 'Every other ticket Done, canceled or moved out',
  open_bugs: 'No open bugs',
  unsettled: 'No unsettled known gaps or partial exits',
  checklist: 'Its own checklist done',
};

export const bugCount = (n: number) => `${n} bug${n === 1 ? '' : 's'}`;
export const ticketCount = (n: number) => `${n} ticket${n === 1 ? '' : 's'}`;

/** "Waiting on 2 bugs", the Release's badge. */
export const waitingOnBugsText = (n: number) => `Waiting on ${bugCount(n)}`;

/**
 * The finish-wait wording (decision 67): a Release waits for the rest of its
 * epic to finish. "Waits for GF-3 and 4 more to finish".
 */
export function releaseWaitText(after: string, more: number): string {
  return more > 0
    ? `Waits for ${after} and ${more} more to finish`
    : `Waits for ${after} to finish`;
}

/** The ways forward for a ticket that holds a Release, in order. */
export const RELEASE_WAYS_FORWARD = [
  'finish it (Done)',
  'move it to another epic as a follow-up (update_item epic)',
  'cancel it with a reason (set_status canceled)',
] as const;

/** The Release Docket creates with an epic: "Release <epic title>", within the title limit. */
export function releaseTitle(epicTitle: string): string {
  const title = `Release ${epicTitle.trim()}`;
  return title.length <= TEXT_LIMITS.title ? title : `${title.slice(0, TEXT_LIMITS.title - 1)}…`;
}

/** A title that names a release: "Release", "Release v2", "release: QA". */
export const RELEASE_TITLE_RE = /^\s*release\b/i;

/** The Map's last column (decision 67): the Release alone, after everything else. */
export const RELEASE_COLUMN = { title: 'Release', sub: 'after everything else' } as const;

/**
 * What migrating an existing epic did (decision 67): its obvious release
 * ticket became the Release, a Release was generated, or one was generated
 * and marked Needs shaping for the producer to choose between candidates.
 */
export const RELEASE_MIGRATION_OUTCOMES = ['converted', 'generated', 'ambiguous'] as const;
export type ReleaseMigrationOutcome = (typeof RELEASE_MIGRATION_OUTCOMES)[number];
