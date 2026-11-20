/**
 * The packet screen's decision rules (UI_SPEC §6.4), kept pure so they are
 * unit-tested: what the primary button says, what the callout promises,
 * and the verdicts the API receives.
 */
import type { ReviewKeep, ReviewResponse } from '@docket/shared';

export type VerdictKind = 'approve' | 'changes' | 'defer';

export interface Draft {
  kind?: VerdictKind;
  note: string;
  into: 'checklist' | 'bug';
  follow: 'ticket' | 'none';
  /** Looks good with a note (owner decision 35): this ticket, the epic's future tickets, or the project. */
  keep: ReviewKeep;
}

export const EMPTY_DRAFT: Draft = { note: '', into: 'checklist', follow: 'ticket', keep: 'item' };

export type Drafts = Record<string, Draft>;

/** The agent the packet came from, by client ("codex · orca-w3" → "codex"). */
export const agentOf = (createdBy: string) => createdBy.split(' · ')[0] || 'the agent';

export function tally(items: readonly { hr_item_id: string }[], drafts: Drafts) {
  const kinds = items.map((i) => drafts[i.hr_item_id]?.kind);
  return {
    decided: kinds.filter(Boolean).length,
    total: items.length,
    complete: items.length > 0 && kinds.every(Boolean),
    changes: kinds.filter((k) => k === 'changes').length,
    deferred: kinds.filter((k) => k === 'defer').length,
  };
}

/** The primary button names the outcome (UI_SPEC §6.4 table). */
export function submitLabel(t: ReturnType<typeof tally>, agent: string): string {
  if (!t.complete) return 'Decide every item first';
  if (t.changes > 0) return `Send back to ${agent}`;
  if (t.deferred > 0) return `Close ticket (${t.deferred} deferred)`;
  return 'Approve and close ticket';
}

/** Exactly what will happen ("Approving records your decision on pkt-9c0e and closes RCP-12, which unblocks RCP-22."). */
export function outcomeCallout(
  t: ReturnType<typeof tally>,
  data: Pick<ReviewResponse, 'item' | 'unblocks'> & {
    packet: Pick<ReviewResponse['packet'], 'display_id' | 'round'>;
  },
): string | null {
  if (!t.complete) return null;
  const id = data.item.id;
  if (t.changes > 0) {
    return `Each finding becomes a checklist item or a bug. ${id} goes back to In progress and you’ll get a round ${data.packet.round + 1} packet.${t.deferred > 0 ? ' Deferred items stay deferred.' : ''}`;
  }
  if (t.deferred > 0) {
    return `Closes ${id}. ${t.deferred === 1 ? '1 item is' : `${t.deferred} items are`} recorded as deferred, not verified; nothing is marked approved that you didn’t check.`;
  }
  const unblocks = data.unblocks.length > 0 ? `, which unblocks ${data.unblocks.join(', ')}` : '';
  return `Approving records your decision on ${data.packet.display_id} and closes ${id}${unblocks}.`;
}

/** The first item that needs changes but has no note (the decision is refused without one). */
export function missingNote(
  items: readonly { hr_item_id: string }[],
  drafts: Drafts,
): string | null {
  for (const i of items) {
    const d = drafts[i.hr_item_id];
    if (d?.kind === 'changes' && !d.note.trim()) return i.hr_item_id;
  }
  return null;
}

/** The verdicts as `POST /api/review/:id/decisions` takes them. */
export function verdictsOf(items: readonly { hr_item_id: string }[], drafts: Drafts) {
  return items.map((i) => {
    const d = drafts[i.hr_item_id] ?? EMPTY_DRAFT;
    const note = d.note.trim();
    if (d.kind === 'changes') {
      return { hr_item_id: i.hr_item_id, kind: 'changes' as const, note, into: d.into };
    }
    if (d.kind === 'defer') {
      return {
        hr_item_id: i.hr_item_id,
        kind: 'defer' as const,
        follow: d.follow,
        ...(note ? { note } : {}),
      };
    }
    // A note for later (owner decision 35); `keep` only travels with a note.
    return {
      hr_item_id: i.hr_item_id,
      kind: 'approve' as const,
      ...(note ? { note, keep: d.keep } : {}),
    };
  });
}

/** The success toast after deciding. */
export function decidedMessage(
  res: {
    outcome: 'progress' | 'done';
    unblocked: string[];
    created: { id: string; kind: string }[];
  },
  id: string,
  t: ReturnType<typeof tally>,
  agent: string,
): string {
  if (res.outcome === 'done') {
    const def = t.deferred > 0 ? ` with ${t.deferred} deferred` : '';
    const unblocked = res.unblocked.length > 0 ? ` ${res.unblocked.join(', ')} unblocked.` : '';
    return `${id} closed${def}.${unblocked}`;
  }
  if (t.changes > 0) {
    const bugs = res.created.filter((c) => c.kind === 'bug').map((c) => c.id);
    return `Sent ${id} back to ${agent}${bugs.length ? `; created ${bugs.join(', ')}` : ''}.`;
  }
  return `Round recorded. ${id} stays open: there is more to review.`;
}
