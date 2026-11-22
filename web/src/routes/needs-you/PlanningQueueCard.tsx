import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import type { ItemSummary } from '@docket/shared';
import { Button, Card, CardHeader, EmptyState } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { queryKeys } from '../../lib/api';
import { paths } from '../../lib/paths';
import { runOwnerMutation, showToast } from '../../lib/undo';
import { LOWER_CARD_ROWS } from './DeferredCard';

/**
 * Your Planning queue · N (UI_SPEC §6.1): item + type and epic, with *Move to
 * Ready* (US7, T126: with Undo).
 */
export function PlanningQueueCard({ items }: { items: readonly ItemSummary[] }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const toReady = async (i: ItemSummary) => {
    setBusy(i.id);
    try {
      const res = await runOwnerMutation(
        () =>
          apiClient['items.patch']({
            params: { id: i.id },
            body: { expected_version: i.version, status: 'ready' },
          }),
        { success: `Moved ${i.id} to Ready.` },
      );
      if (res) await queryClient.invalidateQueries({ queryKey: queryKeys.all });
    } catch (err) {
      showToast(err instanceof Error && err.message ? err.message : 'That didn’t work. Try again.');
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card data-card="planning-queue">
      <CardHeader title={`Your Planning queue · ${items.length}`} />
      {items.length === 0 ? (
        <EmptyState text="Nothing in Planning." />
      ) : (
        items.slice(0, LOWER_CARD_ROWS).map((i) => (
          <div className="mrow noico" key={i.id}>
            <div style={{ minWidth: 0 }}>
              <div className="row" style={{ minWidth: 0 }}>
                <Link to={paths.item(i.id)} className="mono">
                  {i.id}
                </Link>
                <span className="tt">{i.title}</span>
              </div>
              <div className="src one">
                {i.type}
                {i.epic_title ? ` · ◆ ${i.epic_title}` : ''}
              </div>
            </div>
            <Button
              size="sm"
              icon="promote"
              disabled={busy !== null}
              onClick={() => void toReady(i)}
            >
              Move to Ready<span className="sr"> ({i.id})</span>
            </Button>
          </div>
        ))
      )}
      {items.length > 0 && (
        <div className="cardfoot">
          <span />
          <Link to={paths.work({ has: 'planning' })}>View all {items.length} →</Link>
        </div>
      )}
    </Card>
  );
}
