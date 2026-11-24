import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import {
  ROLLOUT_HELP,
  TYPE_MEANINGS,
  type ItemDetailResponse,
  type ItemType,
} from '@docket/shared';
import { Button, RolloutMark, TypeBadge } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { queryKeys } from '../../lib/api';
import { runOwnerMutation, showToast } from '../../lib/undo';

/** The types a ticket can take (an Epic stays an Epic; a Release is made with its epic). */
const TICKET_TYPES = ['Exploration', 'Design', 'Implementation', 'Bug'] as const;

/**
 * Decision 67 (UI_SPEC §6.3): the item's type, and changing it. An inferred
 * type (from Story or Task) says so, with *Confirm type*; choosing a type
 * clears the mark. An Implementation ticket can be marked as a rollout. Each
 * change toasts with Undo, and Activity records it. A Release keeps its type
 * while its epic is open, so it only shows the badge.
 */
export function TypeControl({ data }: { data: ItemDetailResponse }) {
  const { item } = data;
  const queryClient = useQueryClient();
  const selectId = useId();
  const [busy, setBusy] = useState(false);
  const open = !['done', 'canceled'].includes(item.status);
  const editable = open && item.type !== 'Epic' && item.type !== 'Release';

  const save = async (body: { type?: ItemType; rollout?: boolean }, success: string) => {
    setBusy(true);
    try {
      const res = await runOwnerMutation(
        () =>
          apiClient['items.patch']({
            params: { id: item.id },
            body: { expected_version: item.version, ...body },
          }),
        { success, refetch: [queryKeys.item(item.id)] },
      );
      if (res) await queryClient.invalidateQueries({ queryKey: queryKeys.all });
    } catch (err) {
      showToast(err instanceof Error && err.message ? err.message : 'That didn’t work. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="row wrap typectl" data-type={item.type}>
      <span title={TYPE_MEANINGS[item.type].use}>
        <TypeBadge
          type={item.type}
          inferred={item.type_inferred === true}
          original={item.type_original}
        />
      </span>
      {item.rollout && <RolloutMark />}
      {editable && (
        <>
          <label htmlFor={selectId} className="sr">
            Type
          </label>
          <select
            id={selectId}
            className="input sm"
            value=""
            disabled={busy}
            onChange={(e) => {
              const type = e.target.value as ItemType;
              if (type) void save({ type }, `${item.id} is now ${type}.`);
            }}
          >
            <option value="">Change type…</option>
            {TICKET_TYPES.filter((t) => t !== item.type).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          {item.type_inferred && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void save({ type: item.type }, `Confirmed ${item.id} as ${item.type}.`)
              }
              title="Docket inferred this type from Story or Task. Confirm it, or change it."
            >
              Confirm type
            </Button>
          )}
          {item.type === 'Implementation' && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void save(
                  { rollout: !item.rollout },
                  item.rollout ? `${item.id} is no longer a rollout.` : `${item.id} is a rollout.`,
                )
              }
              title={ROLLOUT_HELP}
            >
              {item.rollout ? 'Not a rollout' : 'Mark as rollout'}
            </Button>
          )}
        </>
      )}
    </span>
  );
}
