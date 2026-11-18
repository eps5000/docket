import { useMemo } from 'react';
import { diffStats, lineDiff, withContext } from '../../lib/lineDiff';

/**
 * A line diff (UI_SPEC §6.7b *Diff*), computed in the browser from two
 * versions' text. Added and removed lines carry a `+` / `−` marker as well
 * as their colour (never colour alone); long unchanged runs are folded.
 */
export function DiffView({ from, to, label }: { from: string; to: string; label: string }) {
  const lines = useMemo(() => lineDiff(from, to), [from, to]);
  const stats = diffStats(lines);
  const shown = useMemo(() => withContext(lines, 3), [lines]);
  if (stats.added === 0 && stats.removed === 0) {
    return (
      <div className="src afdiff-same" role="status">
        No differences.
      </div>
    );
  }
  return (
    <div className="afdiff" role="region" aria-label={label} tabIndex={0} data-diff="">
      <div className="src afdiff-stats">
        {stats.added} {stats.added === 1 ? 'line' : 'lines'} added, {stats.removed}{' '}
        {stats.removed === 1 ? 'line' : 'lines'} removed
      </div>
      <div className="afdiff-lines">
        {shown.map((l, i) =>
          'fold' in l ? (
            <div key={i} className="dl fold">
              ⋯ {l.fold} unchanged {l.fold === 1 ? 'line' : 'lines'}
            </div>
          ) : (
            <div key={i} className={`dl ${l.op}`} data-op={l.op}>
              <span className="ln" aria-hidden="true">
                {l.a ?? ''}
              </span>
              <span className="ln" aria-hidden="true">
                {l.b ?? ''}
              </span>
              <span className="mk" aria-hidden="true">
                {l.op === 'add' ? '+' : l.op === 'del' ? '−' : ' '}
              </span>
              {l.op !== 'same' && (
                <span className="sr">{l.op === 'add' ? 'Added: ' : 'Removed: '}</span>
              )}
              <span className="tx">{l.text}</span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
