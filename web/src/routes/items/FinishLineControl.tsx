import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import type { ItemDetailResponse } from '@docket/shared';
import { Button } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { queryKeys } from '../../lib/api';
import { runOwnerMutation, showToast } from '../../lib/undo';

/**
 * Decision 64 (UI_SPEC §6.3): mark an epic's finish line when its links don't
 * settle it (several tickets are last, or none), or clear a mark. The choices
 * are the tickets that could be it, else every ticket that isn't a bug or
 * canceled. Toasts with Undo, and Activity records it.
 */
export function FinishLineControl({ data }: { data: ItemDetailResponse }) {
  const line = data.finish_line;
  const { item } = data;
  const queryClient = useQueryClient();
  const selectId = useId();
  const choices = (() => {
    if (!line) return [];
    const kids = data.children.filter((c) => c.type !== 'Bug' && c.status !== 'canceled');
    const listed = line.candidates.length > 0 ? new Set(line.candidates) : null;
    return kids.filter((c) => (listed ? listed.has(c.id) : true));
  })();
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  if (!line || (line.id !== null && line.how !== 'explicit')) return null;
  if (line.id === null && choices.length === 0) return null;

  const save = async (finish_line: string | null) => {
    setBusy(true);
    try {
      const res = await runOwnerMutation(
        () =>
          apiClient['items.patch']({
            params: { id: item.id },
            body: { expected_version: item.version, finish_line },
          }),
        {
          success: finish_line
            ? `Marked ${finish_line} as ${item.id}’s finish line.`
            : `Cleared ${item.id}’s finish line mark.`,
          refetch: [queryKeys.item(item.id)],
        },
      );
      if (res) await queryClient.invalidateQueries({ queryKey: queryKeys.all });
      setPick('');
    } catch (err) {
      showToast(err instanceof Error && err.message ? err.message : 'That didn’t work. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (line.id !== null) {
    return (
      <div className="row wrap finishctl" data-finish-control="marked">
        <Button size="sm" disabled={busy} onClick={() => void save(null)}>
          Clear finish line mark
        </Button>
        <span className="src">Docket then finds it from the links again.</span>
      </div>
    );
  }
  return (
    <div className="row wrap finishctl" data-finish-control="none">
      <label htmlFor={selectId} className="src">
        {line.candidates.length > 1
          ? `${line.candidates.length} tickets could be the release. Mark one:`
          : 'Mark the release ticket:'}
      </label>
      <select
        id={selectId}
        className="input"
        value={pick}
        onChange={(e) => setPick(e.target.value)}
      >
        <option value="">Choose a ticket…</option>
        {choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.id} · {c.title.length > 60 ? `${c.title.slice(0, 59)}…` : c.title}
          </option>
        ))}
      </select>
      <Button size="sm" disabled={busy || pick === ''} onClick={() => void save(pick)}>
        Mark as finish line
      </Button>
    </div>
  );
}
