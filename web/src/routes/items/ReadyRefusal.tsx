/**
 * The owner's Move to Ready never dead-ends (owner decision 65; UI_SPEC
 * §6.3). When the Ready gate refuses a ticket, this panel says exactly what
 * it lacks and offers the ways forward: *Ask a planner to shape this* (marks
 * it Needs shaping with your note, for the producer's digest), and *It changes
 * no shared part* (declares none, as the Shared changes section does).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import {
  ASK_PLANNER_LABEL,
  SHAPING_NOTE_MAX,
  SHAPING_PARTS,
  type ItemDetailResponse,
  type ShapingPart,
} from '@docket/shared';
import { Button } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { queryKeys } from '../../lib/api';
import { runOwnerMutation, showToast } from '../../lib/undo';

/** What the refusal lists, in words. */
export const MISSING_LABELS: Record<ShapingPart, string> = {
  outcome: 'An outcome',
  acceptance: 'Acceptance criteria',
  shared_changes: 'Its shared changes declared, or "none" (needed for Ready)',
};

/** The parts a `not_declared` refusal names, from its details; null when it names none. */
export function refusedMissing(details: Record<string, unknown> | undefined): ShapingPart[] | null {
  const raw = details?.missing;
  if (!Array.isArray(raw)) return null;
  const parts = SHAPING_PARTS.filter((p) => raw.includes(p));
  return parts.length > 0 ? parts : null;
}

export function ReadyRefusal({
  item,
  missing,
  onClose,
}: {
  item: ItemDetailResponse['item'];
  missing: ShapingPart[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const noteId = useId();
  const headId = useId();
  const box = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const asked = item.needs_shaping?.asked_by === 'owner';

  // Take focus, so a keyboard user lands on the ways forward.
  useEffect(() => {
    box.current?.focus();
  }, []);

  const run = async <T extends { mutation_id: string; warnings?: string[] }>(
    fn: () => Promise<T>,
    success: string,
    refetch: readonly (readonly unknown[])[],
  ) => {
    setBusy(true);
    try {
      const res = await runOwnerMutation(fn, { success, refetch: [...refetch] });
      if (res) {
        await qc.invalidateQueries({ queryKey: queryKeys.all });
        onClose();
      }
    } catch (err) {
      showToast(err instanceof Error && err.message ? err.message : 'That didn’t work. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const askPlanner = () =>
    run(
      () =>
        apiClient['items.patch']({
          params: { id: item.id },
          body: {
            expected_version: item.version,
            request_shaping: note.trim() ? { note: note.trim() } : {},
          },
        }),
      `Asked a planner to shape ${item.id}. It’s in the producer’s digest as Needs shaping.`,
      [queryKeys.item(item.id)],
    );
  const declareNone = () =>
    run(
      () => apiClient['itemShared.put']({ params: { id: item.id }, body: { none: true } }),
      `Declared no shared changes on ${item.id}.`,
      [queryKeys.item(item.id), queryKeys.itemShared(item.id)],
    );

  return (
    <div
      ref={box}
      tabIndex={-1}
      className="callout warn readyrefusal"
      role="group"
      aria-labelledby={headId}
      data-ready-refusal=""
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div id={headId}>
        <b>{item.id} can’t move to Ready yet.</b> It needs:
      </div>
      <ul className="missinglist">
        {missing.map((m) => (
          <li key={m} data-missing={m}>
            {MISSING_LABELS[m]}
          </li>
        ))}
      </ul>
      {asked ? (
        <div data-planner-asked="">
          You’ve asked a planner to shape it. It moves to Ready once it’s shaped.
        </div>
      ) : (
        <>
          <label htmlFor={noteId}>Note for the planner (optional)</label>
          <input
            id={noteId}
            className="input"
            value={note}
            maxLength={SHAPING_NOTE_MAX}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Check it against the export story"
            autoComplete="off"
          />
        </>
      )}
      <div className="row wrap">
        {!asked && (
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void askPlanner()}>
            {ASK_PLANNER_LABEL}
          </Button>
        )}
        {missing.includes('shared_changes') && (
          <Button size="sm" disabled={busy} onClick={() => void declareNone()}>
            It changes no shared part
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}
