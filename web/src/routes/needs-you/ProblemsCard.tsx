import { Fragment } from 'react';
import { Link } from 'react-router';
import type { PROBLEM_KINDS, Problem, WorkspaceRow } from '@tasklite/shared';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  Icon,
  WorkspaceStateChip,
  type IconName,
} from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import type { HelpAnchor } from '../../help/anchors';
import { HelpLink } from '../../help/HelpLink';
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
  {
    /** The "?" on the row (UI_SPEC §6.7c): the article that explains this problem. */
    help: HelpAnchor;
    icon: IconName;
    tone: 'gray' | 'bad' | 'warn';
    actions: Action[];
  }
> = {
  stale_run: {
    help: 'problems.stale_run',
    icon: 'stale',
    tone: 'gray',
    actions: [{ label: 'Inspect', kind: 'link', to: itemTab('activity') }],
  },
  failed_run: {
    help: 'problems.failed_run',
    icon: 'failed',
    tone: 'bad',
    actions: [{ label: 'Inspect', kind: 'link', to: itemTab('activity') }],
  },
  cycle: {
    help: 'problems.cycle',
    icon: 'cycle',
    tone: 'bad',
    actions: [{ label: 'Fix', kind: 'link', to: itemTab('deps') }],
  },
  date_risk: {
    help: 'problems.date_risk',
    icon: 'date',
    tone: 'bad',
    actions: [{ label: 'Timeline', kind: 'link', to: () => paths.work({ layout: 'timeline' }) }],
  },
  canceled_blocker: {
    help: 'problems.canceled_blocker',
    icon: 'x',
    tone: 'bad',
    actions: [{ label: 'Fix', kind: 'link', to: itemTab('deps') }],
  },
  deferred_verified_blocker: {
    help: 'problems.deferred_verified_blocker',
    icon: 'pause',
    tone: 'warn',
    actions: [{ label: 'Open', kind: 'link', to: itemTab('deps') }],
  },
  orphaned_resources: {
    help: 'problems.orphaned_resources',
    icon: 'server',
    tone: 'warn',
    actions: [
      { label: 'Mark released', kind: 'release' },
      { label: 'Open', kind: 'link', to: itemTab('activity') },
    ],
  },
  unpushed_work: {
    help: 'problems.unpushed_work',
    icon: 'upload',
    tone: 'warn',
    actions: [
      { label: 'Handled', kind: 'handled' },
      { label: 'Open', kind: 'link', to: itemTab('activity') },
    ],
  },
  parked_too_long: {
    help: 'problems.parked_too_long',
    icon: 'pause',
    tone: 'gray',
    actions: [{ label: 'Open', kind: 'link', to: itemTab('activity') }],
  },
  resume_unattended: {
    help: 'problems.resume_unattended',
    icon: 'clock',
    tone: 'warn',
    actions: [{ label: 'Open', kind: 'link', to: itemTab('activity') }],
  },
  extra_backup_failed: {
    help: 'problems.extra_backup_failed',
    icon: 'server',
    tone: 'bad',
    actions: [{ label: 'Open', kind: 'link', to: () => paths.settings() }],
  },
  // Decision 30 (UI_SPEC §6.7b-1): → that record in the Agent files page's "Changed
  // outside Task Lite" (the page follows the project switcher, like Needs you).
  agent_files_drift: {
    help: 'problems.agent_files_drift',
    icon: 'doc',
    tone: 'warn',
    actions: [
      {
        label: 'Review',
        kind: 'link',
        to: (p) => `${paths.agentFiles()}#${p.drift_id ? `drift-${p.drift_id}` : 'drift'}`,
      },
    ],
  },
};

/** The recovery rows, which show the worktree's state chip (B20). */
export const RECOVERY_KINDS: readonly ProblemKind[] = [
  'orphaned_resources',
  'unpushed_work',
  'parked_too_long',
  'resume_unattended',
];

/**
 * The worktree a recovery row is about: the one whose latest run is the
 * row's run, else the item's only recorded worktree.
 */
export function workspaceFor(
  p: Problem,
  workspaces: readonly WorkspaceRow[],
): WorkspaceRow | undefined {
  if (!RECOVERY_KINDS.includes(p.kind)) return undefined;
  const byRun = p.run_id ? workspaces.find((w) => w.run_id === p.run_id) : undefined;
  if (byRun) return byRun;
  const forItem = workspaces.filter((w) => w.item_id === p.item_id);
  return forItem.length === 1 ? forItem[0] : undefined;
}

/**
 * A reason's facts, key fact first (the server writes them joined by " · ").
 * Each fact is kept whole: the line wraps between facts, never inside one,
 * and never starts with "·".
 */
export function reasonFacts(reason: string): string[] {
  return reason
    .split(' · ')
    .map((f) => f.trim())
    .filter(Boolean);
}

/** " ·" with a no-break space, so it stays with the fact before it. */
const FACT_SEP = `${String.fromCharCode(0xa0)}·`;

function Reason({ text }: { text: string }) {
  const facts = reasonFacts(text);
  if (facts.length <= 1)
    return (
      <div className="src reason" title={text}>
        {text}
      </div>
    );
  return (
    <div className="src reason facts" title={text}>
      {facts.map((f, i) => (
        <Fragment key={i}>
          {i > 0 && ' '}
          <span className="fact">
            {f}
            {i < facts.length - 1 && FACT_SEP}
          </span>
        </Fragment>
      ))}
    </div>
  );
}

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

/**
 * Problems · N: at most 5 rows, then "N more" (UI_SPEC §6.1). US2 and US11 fill the rows.
 * Each reason takes up to two lines, key fact first (B20); recovery rows show
 * their worktree's state chip, from `/api/workspaces`.
 */
export function ProblemsCard({
  problems,
  workspaces = [],
}: {
  problems: readonly Problem[];
  workspaces?: readonly WorkspaceRow[];
}) {
  const shown = problems.slice(0, MAX_PROBLEMS);
  return (
    <Card data-card="problems">
      <CardHeader title={`Problems · ${problems.length}`} />
      {problems.length === 0 ? (
        <EmptyState text="No stale or failed runs, cycles or date conflicts." />
      ) : (
        shown.map((p, i) => (
          <ProblemRow
            key={`${p.kind}:${p.item_id ?? ''}:${i}`}
            problem={p}
            workspace={workspaceFor(p, workspaces)}
          />
        ))
      )}
      {problems.length > MAX_PROBLEMS && (
        <div className="cardfoot">
          <span>{problems.length - MAX_PROBLEMS} more</span>
        </div>
      )}
    </Card>
  );
}

export function ProblemRow({ problem, workspace }: { problem: Problem; workspace?: WorkspaceRow }) {
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
          {workspace && <WorkspaceStateChip state={workspace.state} />}
        </div>
        <Reason text={problem.reason} />
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
        <HelpLink anchor={m.help} />
      </div>
    </div>
  );
}
