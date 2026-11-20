import type { ItemSharedResponse, SharedChange } from '@docket/shared';
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

/** "Heading for a conflict with RCP-25 (feat/b): 1 file", from one item's side. */
export function findingText(f: Finding, itemId: string): { other: string; branch: string } {
  const mineA = f.item_a?.id === itemId;
  if (mineA) return { other: f.item_b?.id ?? f.branch_b, branch: f.branch_b };
  return { other: f.item_a?.id ?? f.branch_a, branch: f.branch_a };
}

export const fileCount = (n: number) => `${n} file${n === 1 ? '' : 's'}`;
