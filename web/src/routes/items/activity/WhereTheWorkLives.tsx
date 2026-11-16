import { RESOURCE_KIND_LABELS, type Run } from '@tasklite/shared';
import { Chip } from '../../../components/kit';
import { formatClock, middleTruncate } from '../../../lib/format';

/**
 * "Where the work lives" (owner decision 26; UI_SPEC §6.3.2): one compact
 * block under each run row. An empty shell for US11 to fill:
 * - `branch · worktree path` (middle-truncated, full path in `title`, *Copy*);
 * - last commit and pushed state, `uncommitted changes` when dirty;
 * - the orchestrator's IDs, muted;
 * - the brief link (opens the document viewer);
 * - the resource list, with *Mark released* once the run has ended;
 * - the parked line and the "Ready to resume" chip;
 * - *Copy resume note* on interrupted, stale and parked runs.
 */
export function WhereTheWorkLives({ run }: { run: Run }) {
  const ws = run.workspace;
  return (
    <div
      className="worklives"
      role="group"
      aria-label="Where the work lives"
      data-section="where-the-work-lives"
    >
      {
        <>
          {ws && (
            <div className="row wrap src">
              {ws.branch && <span className="mono">{ws.branch}</span>}
              {ws.path && (
                <span className="mono" title={ws.path}>
                  · {middleTruncate(ws.path)}
                </span>
              )}
            </div>
          )}
          {ws?.head_sha && (
            <div className="src">
              last commit <span className="mono">{ws.head_sha.slice(0, 7)}</span>
              {ws.dirty ? ' · uncommitted changes' : ''}
            </div>
          )}
          {run.orchestrator && (
            <div className="src muted">
              {run.orchestrator.name}
              {run.orchestrator.dispatch_id ? ` · ${run.orchestrator.dispatch_id}` : ''}
            </div>
          )}
          {run.resources.map((r) => (
            <div className="src" key={r.id}>
              {RESOURCE_KIND_LABELS[r.kind]} {r.label} ·{' '}
              {r.released_at ? `released ${formatClock(r.released_at)}` : 'running'}
            </div>
          ))}
          {run.parked && (
            <div className="row wrap src">
              <span>
                Parked · since {formatClock(run.parked.since)} · reason {run.parked.reason}
              </span>
              {run.parked.resume_ready && <Chip kind="ok">Ready to resume</Chip>}
            </div>
          )}
        </>
      }
    </div>
  );
}
