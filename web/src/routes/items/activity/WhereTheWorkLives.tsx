import { useState } from 'react';
import { RESOURCE_KIND_LABELS, type ItemDetailResponse, type Run } from '@tasklite/shared';
import { Button, Chip, IconButton, WorkspaceStateChip } from '../../../components/kit';
import { apiClient } from '../../../app/queryClient';
import { queryKeys } from '../../../lib/api';
import { formatClock, isoTitle, middleTruncate } from '../../../lib/format';
import { runOwnerMutation, showToast } from '../../../lib/undo';
import { DocumentViewer } from '../../dialogs/DocumentViewer';
import { copyText } from './copy';
import { CopyResumeNoteButton, canCopyResumeNote } from './leadActions';
import { parkedDetail, unpushedCommits } from './resumeNote';

const ENDED: readonly Run['run_state'][] = ['finished', 'failed', 'interrupted'];

/** How to find a resource again: `pid 4242, port 5173`. */
function locatorText(l: Run['resources'][number]['locator']): string {
  return [
    l.host && `host ${l.host}`,
    l.pid !== undefined && `pid ${l.pid}`,
    l.port !== undefined && `port ${l.port}`,
    l.session_id && `session ${l.session_id}`,
    l.container && `container ${l.container}`,
    l.path && `path ${l.path}`,
  ]
    .filter(Boolean)
    .join(', ');
}

export { copyText } from './copy';

async function markReleased(id: string): Promise<void> {
  try {
    await runOwnerMutation(() => apiClient['resources.release']({ params: { id }, body: {} }), {
      success: 'Marked released.',
      refetch: [
        queryKeys.family('item'),
        queryKeys.family('needsYou'),
        queryKeys.family('bootstrap'),
        queryKeys.family('workspaces'),
      ],
    });
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'That didn’t work. Try again.');
  }
}

/**
 * "Where the work lives" (owner decision 26; UI_SPEC §6.3.2): one compact
 * block under each run row, from what the agent reported (Task Lite never
 * looks at the host):
 * - `branch · worktree path` (middle-truncated, full path in `title`, *Copy*)
 *   and the worktree's state;
 * - last commit and pushed state, `uncommitted changes` when dirty;
 * - the orchestrator's IDs, muted;
 * - the brief (opens the document viewer);
 * - the resource list, with *Mark released* once the run has ended;
 * - the parked line and the "Ready to resume" chip;
 * - *Copy resume note* on interrupted, stale and parked runs.
 */
export function WhereTheWorkLives({ run, data }: { run: Run; data: ItemDetailResponse }) {
  const [viewer, setViewer] = useState(false);
  const ws = run.workspace;
  const ended = ENDED.includes(run.run_state);
  const n = unpushedCommits(run, data.item.commits);
  const dv = run.brief_document_version_id;
  const orch = run.orchestrator;
  const orchIds = orch ? [orch.dispatch_id, orch.task_id, orch.run_id].filter(Boolean) : [];
  const resumable = canCopyResumeNote(run);
  return (
    <div
      className="worklives"
      role="group"
      aria-label="Where the work lives"
      data-section="where-the-work-lives"
    >
      {ws && (ws.branch || ws.path) && (
        <div className="row wrap src" data-ws="path">
          {ws.branch && <span className="mono">{ws.branch}</span>}
          {ws.branch && ws.path && <span aria-hidden="true">·</span>}
          {ws.path && (
            <>
              <span className="mono" title={ws.path}>
                {middleTruncate(ws.path)}
              </span>
              <IconButton
                icon="copy"
                bare
                aria-label={`Copy worktree path ${ws.path}`}
                onClick={() => copyText(ws.path!, 'the worktree path')}
              />
            </>
          )}
          <WorkspaceStateChip state={ws.state} />
        </div>
      )}
      {ws && (ws.head_sha || ws.dirty) && (
        <div className="row wrap src" data-ws="push">
          {ws.head_sha && (
            <span>
              last commit <span className="mono">{ws.head_sha.slice(0, 7)}</span>
              {n === 0 && ' · pushed ✓'}
            </span>
          )}
          {n !== null && n > 0 && (
            <Chip kind="warn" icon="upload">
              {n} {n === 1 ? 'commit' : 'commits'} not pushed
            </Chip>
          )}
          {ws.dirty && <Chip kind="warn">uncommitted changes</Chip>}
        </div>
      )}
      {orch && (
        <div className="src muted" data-ws="orchestrator" title={orchIds.join(' · ')}>
          {orch.name}
          {orchIds.length > 0 && ` · ${orchIds.map((id) => middleTruncate(id!, 18)).join(' · ')}`}
        </div>
      )}
      {dv && (
        <div className="row wrap src" data-ws="brief">
          <Button size="sm" variant="ghost" icon="doc" onClick={() => setViewer(true)}>
            Brief
          </Button>
          <span className="mono muted">{dv}</span>
        </div>
      )}
      {run.resources.map((r) => (
        <div className="row wrap src" key={r.id} data-resource={r.id}>
          <span
            title={`${RESOURCE_KIND_LABELS[r.kind]}${locatorText(r.locator) ? ` · ${locatorText(r.locator)}` : ''}`}
          >
            {r.label} ·{' '}
            {r.released_at ? (
              <span title={isoTitle(r.released_at)}>released {formatClock(r.released_at)}</span>
            ) : (
              'running'
            )}
          </span>
          {ended && !r.released_at && (
            <Button size="sm" onClick={() => void markReleased(r.id)}>
              Mark released
            </Button>
          )}
        </div>
      ))}
      {run.parked && (
        <div className="row wrap src" data-ws="parked">
          <span>
            Parked{parkedDetail(run.parked) ? ` · ${parkedDetail(run.parked)}` : ''} · since{' '}
            <span title={isoTitle(run.parked.since)}>{formatClock(run.parked.since)}</span> · reason{' '}
            {run.parked.reason}
          </span>
          {run.parked.resume_ready && <Chip kind="ok">Ready to resume</Chip>}
        </div>
      )}
      {resumable && (
        <div className="row">
          <CopyResumeNoteButton data={data} run={run} />
        </div>
      )}
      {viewer && dv && (
        <DocumentViewer
          doc={{
            versionId: dv,
            name: `brief-${run.run_id}.md`,
            by: run.label ? `${run.client} · ${run.label}` : run.client,
            at: run.started_at,
          }}
          onClose={() => setViewer(false)}
        />
      )}
    </div>
  );
}
