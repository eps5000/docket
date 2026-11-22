import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { STATUS_LABELS, type DeferredRow } from '@docket/shared';
import { Button, Card, CardHeader, EmptyState } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { queryKeys } from '../../lib/api';
import { paths } from '../../lib/paths';
import { runOwnerMutation, showToast } from '../../lib/undo';

/** Rows shown before *View all N →* (UI_SPEC §6.1). */
export const LOWER_CARD_ROWS = 3;

/**
 * Deferred, not verified · N (UI_SPEC §6.1): item + review text + the test
 * ticket, or "No follow-up ticket" with *Create test ticket* (US3).
 */
export function DeferredCard({ rows }: { rows: readonly DeferredRow[] }) {
  return (
    <Card data-card="deferred">
      <CardHeader title={`Deferred, not verified · ${rows.length}`} />
      {rows.length === 0 ? (
        <EmptyState text="Nothing deferred." />
      ) : (
        rows.slice(0, LOWER_CARD_ROWS).map((r) => (
          <div className="mrow noico" key={r.hr_item_id}>
            <div style={{ minWidth: 0 }}>
              <div className="row" style={{ minWidth: 0 }}>
                <Link to={paths.item(r.item_id)} className="mono">
                  {r.item_id}
                </Link>
                <span className="tt">{r.title}</span>
              </div>
              <div className="src one" title={r.text}>
                {r.text}
              </div>
              <div className="src one">
                {r.follow_up ? (
                  <>
                    Test ticket{' '}
                    <Link to={paths.item(r.follow_up.id)} className="mono">
                      {r.follow_up.id}
                    </Link>{' '}
                    · {STATUS_LABELS[r.follow_up.status].toLowerCase()}
                  </>
                ) : (
                  'No follow-up ticket'
                )}
              </div>
              {!r.follow_up && <CreateTestTicket hrId={r.hr_item_id} />}
            </div>
          </div>
        ))
      )}
      {rows.length > 0 && (
        <div className="cardfoot">
          <span />
          <Link to={paths.work({ has: 'deferred_review', show: 'done' })}>
            View all {rows.length} →
          </Link>
        </div>
      )}
    </Card>
  );
}

/** *Create test ticket*: a Task in Inbox carrying the deferred check (undoable). */
function CreateTestTicket({ hrId }: { hrId: string }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      style={{ marginTop: 4 }}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void runOwnerMutation(() => apiClient['deferred.followUp']({ params: { hrId } }), {
          success: (r) => `Created test ticket ${r.item.id} in Inbox.`,
        })
          .catch((err: unknown) =>
            showToast(err instanceof Error ? err.message : 'Couldn’t create it. Try again.'),
          )
          .finally(() => {
            setBusy(false);
            void queryClient.invalidateQueries({ queryKey: queryKeys.all });
          });
      }}
    >
      Create test ticket
    </Button>
  );
}
