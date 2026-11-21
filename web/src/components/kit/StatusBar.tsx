/**
 * The one status bar (B47; UI_SPEC §5): the Map header, epic cards and
 * Settings → Projects all draw it, in the same colours as the status chips.
 * It always carries an accessible label, so status is never colour alone.
 */
import type { Status } from '@docket/shared';

/** A status, or *blocked*: Ready work that can't start yet. */
export type StatusBarSegment = Status | 'blocked';

export const STATUS_BAR_ORDER: readonly StatusBarSegment[] = [
  'done',
  'review',
  'progress',
  'ready',
  'blocked',
  'planning',
  'inbox',
  'canceled',
];

export function StatusBar({
  counts,
  label,
  mini = false,
}: {
  counts: Partial<Record<StatusBarSegment, number>>;
  label: string;
  mini?: boolean;
}) {
  const total = STATUS_BAR_ORDER.reduce((n, s) => n + (counts[s] ?? 0), 0);
  return (
    <span className={mini ? 'pbar mini' : 'pbar'} role="img" aria-label={label}>
      {STATUS_BAR_ORDER.filter((s) => (counts[s] ?? 0) > 0).map((s) => (
        <i key={s} className={`sb-${s}`} style={{ width: `${(counts[s]! / total) * 100}%` }} />
      ))}
    </span>
  );
}
