import type { PlanVersion } from '@docket/shared';
import { Button, Dialog, EmptyState } from '../../components/kit';
import { formatStamp } from '../../lib/format';

/**
 * Checklist history (UI_SPEC §6.9): each plan version with its reason,
 * author and time, and the steps added, removed or changed. US2 opens it
 * from the Work section header.
 */
export function ChecklistHistory({
  itemId,
  versions,
  onClose,
}: {
  itemId: string;
  versions: readonly PlanVersion[];
  onClose: () => void;
}) {
  return (
    <Dialog
      title={`Checklist history · ${itemId}`}
      onClose={onClose}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {versions.length === 0 ? (
        <EmptyState text="No earlier versions." />
      ) : (
        <div className="hv">
          {[...versions].reverse().map((v) => (
            <div className="ver" key={v.version_no}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <b>v{v.version_no}</b>
                <span className="src">
                  {v.created_by} · {formatStamp(v.created_at)}
                </span>
              </div>
              {v.reason && <div className="src">{v.reason}</div>}
              {v.changes.map((c) => (
                <div
                  key={c.step_id}
                  className={c.change === 'added' ? 'add' : c.change === 'removed' ? 'rm' : ''}
                >
                  {c.change === 'added' ? '+ ' : c.change === 'removed' ? '− ' : '~ '}
                  {c.text}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
