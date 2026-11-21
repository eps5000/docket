import type {
  ItemSharedResponse,
  OverlapHandling,
  OverlapReason,
  SharedChange,
} from '@docket/shared';
import { Chip, type ChipKind } from '../../components/kit';

/*
 * Shared changes (owner decision 36; UI_SPEC §6.3.6): the bits the item's
 * section, the Needs you cards and Settings → Shared parts share.
 */

/** `model:Token` → `model Token`, the way the cards say a part. */
export function partLabel(key: string): string {
  const colon = key.indexOf(':');
  return colon < 0 ? key : `${key.slice(0, colon)} ${key.slice(colon + 1)}`;
}

/** Up to three parts in words: `model Token, table decks and 1 more`. */
export function partsText(keys: readonly string[]): string {
  const shown = keys.slice(0, 3).map(partLabel);
  if (keys.length > 3) shown.push(`${keys.length - 3} more`);
  return shown.length <= 1
    ? (shown[0] ?? '')
    : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]!}`;
}

const CHANGE_CHIP: Record<SharedChange, { kind: ChipKind; label: string }> = {
  add: { kind: 'ok', label: 'add' },
  change: { kind: 'info', label: 'change' },
  remove: { kind: 'bad', label: 'remove' },
};

export function ChangeChip({ change }: { change: SharedChange }) {
  const c = CHANGE_CHIP[change];
  return <Chip kind={c.kind}>{c.label}</Chip>;
}

type Overlap = ItemSharedResponse['overlaps'][number];

/** An overlap's state in words, for the item's section. */
export const OVERLAP_STATE_TEXT: Record<Overlap['state'], string> = {
  open: 'waiting for you',
  sequenced: 'one after the other',
  compatible: 'compatible',
  resolved: 'resolved',
};

type Finding = ItemSharedResponse['findings'][number];

/**
 * "Heading for a conflict with RCP-25: 1 file · feat/a vs feat/b", from one
 * item's side: the other item (or the main branch), its branch, and this
 * item's own branch (B41: an item may report several).
 */
export function findingText(
  f: Finding,
  itemId: string,
): { other: string; branch: string; own: string } {
  const mineA = f.item_a?.id === itemId;
  if (mineA) return { other: f.item_b?.id ?? f.branch_b, branch: f.branch_b, own: f.branch_a };
  return { other: f.item_a?.id ?? f.branch_a, branch: f.branch_a, own: f.branch_b };
}

export const fileCount = (n: number) => `${n} file${n === 1 ? '' : 's'}`;

/** Why an overlap got its outcome, in the ticket's words (decision 39). */
export const OVERLAP_REASON_WORDS: Record<OverlapReason, string> = {
  file_only: 'They only share files. The radar checks whether the lines collide.',
  different_members: 'They add different members of the same part.',
  same_member: 'They change the same member.',
  change_touches_part: 'One changes or removes something in a part the other uses.',
  bare_part: 'One could touch anything in the part.',
  unclear: 'Docket can’t tell whether they collide, so it runs them in order.',
  changes_approved_design: 'It changes an approved design.',
  blocker_cycle: 'Running them in order would create a dependency cycle.',
  disputed: 'Agents disagree about who owns the part.',
  setting: 'Your Overlap handling setting asks you.',
};

/** An automatic outcome in a few words, for the ticket's chip. */
export function overlapOutcomeText(o: Overlap): string {
  if (o.decided_by === 'owner') return OVERLAP_STATE_TEXT[o.state];
  if (o.outcome === 'parallel') return 'Docket: in parallel';
  if (o.outcome === 'sequence') return 'Docket: in order';
  return OVERLAP_STATE_TEXT[o.state];
}

export const OVERLAP_HANDLING_TEXT: Record<OverlapHandling, { label: string; help: string }> = {
  agents_resolve: {
    label: 'Agents resolve',
    help: 'Docket runs safe overlaps in parallel and sequences the rest. You see only what needs you: a change to an approved design, a dependency cycle, a dispute, or something unresolved after a day.',
  },
  ask_shared_data: {
    label: 'Ask on shared data',
    help: 'As above, and you also decide every overlap on a table, model or endpoint.',
  },
  ask_every: {
    label: 'Ask on every overlap',
    help: 'You decide every overlap, including shared files.',
  },
};
