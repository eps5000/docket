import { Link } from 'react-router';
import type { PROBLEM_KINDS, Problem } from '@tasklite/shared';
import { Button, Card, CardHeader, EmptyState, Icon, type IconName } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { queryKeys } from '../../lib/api';
import { paths, type ItemTab } from '../../lib/paths';
import { runOwnerMutation, showToast } from '../../lib/undo';

type ProblemKind = (typeof PROBLEM_KINDS)[number];

/** The most rows shown before "N more" (UI_SPEC §6.1). */
export const MAX_PROBLEMS = 5;

type Action =
  | { label: string; kind: 'link'; to: (p: Problem) => string }
  | { label: string; kind: 'release' }
  | { label: string; kind: 'handled' };

const itemTab = (tab: ItemTab) => (p: Problem) => (p.item_id ? paths.item(p.item_id, tab) : '/');

/**
 * Every Problems row kind, its icon and its actions (UI_SPEC §6.1 table),
 * including the recovery rows (owner decision 26).
 */
export const PROBLEM_ROWS: Record<
  ProblemKind,
  { icon: IconName; tone: 'gray' | 'bad' | 'warn'; actions: Action[] }
> = {
  stale_run: {
    icon: 'stale',
    tone: 'gray',
    actions: [{ label: 'Inspect', kind: 'link', to: itemTab('activity') }],
  },
  failed_run: {
    icon: 'failed',
    tone: 'bad',
    actions: [{ label: 'Inspect', kind: 'link', to: itemTab('activity') }],
  },
  cycle: {
    icon: 'cycle',
    tone: 'bad',
    actions: [{ label: 'Fix', kind: 'link', to: itemTab('deps') }],
  },
  date_risk: {
    icon: 'date',
    tone: 'bad',
    actions: [{ label: 'Timeline', kind: 'link', to: () => paths.work({ layout: 'timeline' }) }],
  },
  canceled_blocker: {
    icon: 'x',
    tone: 'bad',
    actions: [{ label: 'Fix', kind: 'link', to: itemTab('deps') }],
  },
  deferred_verified_blocker: {
    icon: 'pause',
    tone: 'warn',
    actions: [{ label: 'Open', kind: 'link', to: itemTab('deps') }],
  },
  orphaned_resources: {
    icon: 'server',
    tone: 'warn',
    actions: [
      { label: 'Mark released', kind: 'release' },
      { label: 'Open', kind: 'link', to: itemTab('activity') },
    ],
  },
  unpushed_work: {
    icon: 'upload',
    tone: 'warn',
    actions: [
      { label: 'Handled', kind: 'handled' },
      { label: 'Open', kind: 'link', to: itemTab('activity') },
    ],
  },
  parked_too_long: {
    icon: 'pause',
    tone: 'gray',
    actions: [{ label: 'Open', kind: 'link', to: itemTab('activity') }],
  },
  resume_unattended: {
    icon: 'clock',
    tone: 'warn',
    actions: [{ label: 'Open', kind: 'link', to: itemTab('activity') }],
  },
  extra_backup_failed: {
    icon: 'server',
    tone: 'bad',
    actions: [{ label: 'Open', kind: 'link', to: () => paths.settings() }],
  },
};

const refetch = [
  queryKeys.family('needsYou'),
  queryKeys.family('bootstrap'),
  queryKeys.family('workspaces'),
];

async function act(p: Problem, kind: 'release' | 'handled') {
  try {
    if (kind === 'release') {
      for (const id of p.resource_ids) {
        await runOwnerMutation(() => apiClient['resources.release']({ params: { id }, body: {} }), {
          success: 'Marked released.',
          refetch,
        });
      }
    } else if (p.run_id) {
      const runId = p.run_id;
      await runOwnerMutation(() => apiClient['runs.unpushedHandled']({ params: { runId } }), {
        success: 'Marked handled.',
        refetch,
      });
    }
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'That didn’t work. Try again.');
  }
}

/** Problems · N: at most 5 rows, then "N more" (UI_SPEC §6.1). US2 and US11 fill the rows. */
export function ProblemsCard({ problems }: { problems: readonly Problem[] }) {
  const shown = problems.slice(0, MAX_PROBLEMS);
  return (
    <Card data-card="problems">
      <CardHeader title={`Problems · ${problems.length}`} />
      {problems.length === 0 ? (
        <EmptyState text="No stale or failed runs, cycles or date conflicts." />
      ) : (
        shown.map((p, i) => <ProblemRow key={`${p.kind}:${p.item_id ?? ''}:${i}`} problem={p} />)
      )}
      {problems.length > MAX_PROBLEMS && (
        <div className="cardfoot">
          <span>{problems.length - MAX_PROBLEMS} more</span>
        </div>
      )}
    </Card>
  );
}

export function ProblemRow({ problem }: { problem: Problem }) {
  const m = PROBLEM_ROWS[problem.kind];
  return (
    <div className="mrow" data-problem={problem.kind}>
      <div className={`ico sm ico-${m.tone}`} aria-hidden="true">
        <Icon name={m.icon} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="row" style={{ minWidth: 0 }}>
          {problem.item_id && (
            <Link to={paths.item(problem.item_id)} className="mono">
              {problem.item_id}
            </Link>
          )}
          {problem.title && <span className="tt">{problem.title}</span>}
        </div>
        <div className="src one" title={problem.reason}>
          {problem.reason}
        </div>
      </div>
      <div className="row" style={{ gap: 6 }}>
        {m.actions.map((a) =>
          a.kind === 'link' ? (
            <Link key={a.label} className="btn sm" to={a.to(problem)}>
              {a.label}
            </Link>
          ) : (
            <Button key={a.label} size="sm" onClick={() => void act(problem, a.kind)}>
              {a.label}
            </Button>
          ),
        )}
      </div>
    </div>
  );
}
