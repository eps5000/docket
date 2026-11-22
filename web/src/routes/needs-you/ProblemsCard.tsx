import { Fragment, useId, useState } from 'react';
import { Link } from 'react-router';
import type { PROBLEM_KINDS, Problem, UnpushedOutcome, WorkspaceRow } from '@docket/shared';
import {
  Button,
  Card,
  CardHeader,
  Dialog,
  DialogCancel,
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
import { plural } from '../../lib/format';
import { ProblemActions, ProblemLines, WhoChip } from '../shared/problems';

type ProblemKind = (typeof PROBLEM_KINDS)[number];

/** The most rows shown before "N more" (UI_SPEC §6.1). */
export const MAX_PROBLEMS = 5;

type Action =
  | {
      label: string;
      kind: 'link';
      to: (p: Problem) => string;
      /** Decision 37: it lands on the item's problem banner (left out on the banner itself). */
      banner?: true;
    }
  | { label: string; kind: 'release' };

const itemTab = (tab: ItemTab) => (p: Problem) => (p.item_id ? paths.item(p.item_id, tab) : '/');
/** Decision 37: *Open* lands on the item's banner, on the tab it opened before, focused on the problem. */
const onBanner = (tab: ItemTab) => (p: Problem) =>
  p.item_id ? paths.item(p.item_id, tab, undefined, p.id) : '/';

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
    actions: [{ label: 'Open', kind: 'link', to: onBanner('deps'), banner: true }],
  },
  orphaned_resources: {
    help: 'problems.orphaned_resources',
    icon: 'server',
    tone: 'warn',
    actions: [
      { label: 'Mark released', kind: 'release' },
      { label: 'Open', kind: 'link', to: onBanner('activity'), banner: true },
    ],
  },
  unpushed_work: {
    help: 'problems.unpushed_work',
    icon: 'upload',
    tone: 'warn',
    // Decision 41: *Keep for later* and *Safe to discard* (UnpushedOutcomes), then Open.
    actions: [{ label: 'Open', kind: 'link', to: onBanner('activity'), banner: true }],
  },
  parked_too_long: {
    help: 'problems.parked_too_long',
    icon: 'pause',
    tone: 'gray',
    actions: [{ label: 'Open', kind: 'link', to: onBanner('activity'), banner: true }],
  },
  resume_unattended: {
    help: 'problems.resume_unattended',
    icon: 'clock',
    tone: 'warn',
    actions: [{ label: 'Open', kind: 'link', to: onBanner('activity'), banner: true }],
  },
  extra_backup_failed: {
    help: 'problems.extra_backup_failed',
    icon: 'server',
    tone: 'bad',
    actions: [{ label: 'Open', kind: 'link', to: () => paths.settings() }],
  },
  // Decision 41: the nightly backup failed or is overdue; Settings shows each location.
  backup_missed: {
    help: 'problems.backup_missed',
    icon: 'server',
    tone: 'bad',
    actions: [{ label: 'Open', kind: 'link', to: () => paths.settings() }],
  },
  // Decision 30 (UI_SPEC §6.7b-1): → that record in the Agent files page's "Changed
  // outside Docket" (the page follows the project switcher, like Needs you).
  // Decision 36 (UI_SPEC §6.3.6): two in-flight branches heading for a merge conflict.
  // Decision 37: an agent problem; its actions are *Remind the agent*, *Open the item* and
  // *Not an active branch* (ProblemActions).
  radar_conflict: {
    help: 'problems.radar_conflict',
    icon: 'git',
    tone: 'warn',
    actions: [],
  },
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

async function release(p: Problem) {
  try {
    for (const id of p.resource_ids) {
      await runOwnerMutation(() => apiClient['resources.release']({ params: { id }, body: {} }), {
        success: 'Marked released.',
        refetch,
      });
    }
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'That didn’t work. Try again.');
  }
}

/** What each outcome on unpushed work does, and doesn't do (owner decision 41). */
export const UNPUSHED_OUTCOME_TEXT: Record<
  UnpushedOutcome,
  { label: string; title: string; does: string; toast: string }
> = {
  keep: {
    label: 'Keep for later',
    title: 'Keep this work for later?',
    does: 'Docket records that you want this work kept and takes it off Needs you. The worktree stays At risk, so it won’t count as safe to prune.',
    toast: 'Kept for later. The worktree stays At risk.',
  },
  discard: {
    label: 'Safe to discard',
    title: 'Mark this work safe to discard?',
    does: 'Docket records that you’re fine losing this work and takes it off Needs you. The worktree can then count as Safe to prune, so a coordinator may delete it and the work with it.',
    toast: 'Marked safe to discard. The worktree can count as Safe to prune.',
  },
};

/**
 * *Keep for later* and *Safe to discard* on unpushed work (decision 41): each
 * says what it does and doesn't do before it's confirmed, and can be undone.
 */
function UnpushedOutcomes({ problem }: { problem: Problem }) {
  const [open, setOpen] = useState<UnpushedOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const runId = problem.run_id;
  if (!runId) return null;
  const text = open ? UNPUSHED_OUTCOME_TEXT[open] : null;
  const confirm = async (outcome: UnpushedOutcome) => {
    setBusy(true);
    try {
      await runOwnerMutation(
        () => apiClient['runs.unpushedHandled']({ params: { runId }, body: { outcome } }),
        { success: UNPUSHED_OUTCOME_TEXT[outcome].toast, refetch },
      );
      setOpen(null);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'That didn’t work. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {(['keep', 'discard'] as const).map((o) => (
        <Button key={o} size="sm" title={UNPUSHED_OUTCOME_TEXT[o].does} onClick={() => setOpen(o)}>
          {UNPUSHED_OUTCOME_TEXT[o].label}
        </Button>
      ))}
      {open && text && (
        <Dialog
          title={text.title}
          onClose={() => setOpen(null)}
          destructive={open === 'discard'}
          footer={
            <>
              <DialogCancel onClick={() => setOpen(null)}>Cancel</DialogCancel>
              <Button
                variant="primary"
                aria-disabled={busy || undefined}
                onClick={() => {
                  if (!busy) void confirm(open);
                }}
              >
                {text.label}
              </Button>
            </>
          }
        >
          <p>{text.does}</p>
          <p>
            <b>It doesn’t commit, push, save or delete anything.</b> Docket never removes a worktree
            or files itself. You can undo this choice.
          </p>
        </Dialog>
      )}
    </>
  );
}

/**
 * Problems · N: at most 5 rows, then "N more" (UI_SPEC §6.1). US2 and US11 fill the rows.
 * Recovery rows show their worktree's state chip, from `/api/workspaces`.
 *
 * Decision 37: each row says what's wrong, what fixes it and who acts. Agent
 * problems the agents are still handling, and problems you acknowledged,
 * aren't counted; the "Agents are handling N problems" and "You acknowledged
 * N" lines open them, so nothing is hidden.
 */
export function ProblemsCard({
  problems,
  workspaces = [],
  agentProblems = [],
  acknowledged = [],
}: {
  problems: readonly Problem[];
  workspaces?: readonly WorkspaceRow[];
  agentProblems?: readonly Problem[];
  acknowledged?: readonly Problem[];
}) {
  // Decision 41: every counted row can be reached, so the badge is never more than you can open.
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? problems : problems.slice(0, MAX_PROBLEMS);
  return (
    <Card data-card="problems">
      <CardHeader title={`Problems · ${problems.length}`} />
      {problems.length === 0 ? (
        <EmptyState text="No stale or failed runs, cycles or date conflicts." />
      ) : (
        shown.map((p, i) => (
          <ProblemRow
            key={p.id ?? `${p.kind}:${p.item_id ?? ''}:${i}`}
            problem={p}
            workspace={workspaceFor(p, workspaces)}
          />
        ))
      )}
      {problems.length > MAX_PROBLEMS && (
        <div className="cardfoot">
          <button
            type="button"
            className="linkbtn"
            aria-expanded={showAll}
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? 'Show fewer' : `${problems.length - MAX_PROBLEMS} more`}
          </button>
        </div>
      )}
      <MoreProblems
        kind="agents"
        label={`Agents are handling ${plural(agentProblems.length, 'problem')}`}
        problems={agentProblems}
        workspaces={workspaces}
      />
      <MoreProblems
        kind="acknowledged"
        label={`You acknowledged ${plural(acknowledged.length, 'problem')}`}
        problems={acknowledged}
        workspaces={workspaces}
      />
    </Card>
  );
}

/** A line that opens the problems it counts, in place (decision 37). */
function MoreProblems({
  kind,
  label,
  problems,
  workspaces,
}: {
  kind: 'agents' | 'acknowledged';
  label: string;
  problems: readonly Problem[];
  workspaces: readonly WorkspaceRow[];
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (problems.length === 0) return null;
  return (
    <div className="prob-more" data-more-problems={kind}>
      <div className="row" style={{ gap: 6 }}>
        <button
          type="button"
          className="linkbtn"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((o) => !o)}
        >
          {label}
        </button>
        {kind === 'agents' && <HelpLink anchor="needs-you.agent-problems" />}
      </div>
      <div id={listId} hidden={!open}>
        {open &&
          problems.map((p, i) => (
            <ProblemRow
              key={p.id ?? `${p.kind}:${i}`}
              problem={p}
              workspace={workspaceFor(p, workspaces)}
            />
          ))}
      </div>
    </div>
  );
}

/**
 * The kind's own actions (UI_SPEC §6.1 table). On the item's banner, an
 * *Open* that would land on the banner itself is left out.
 */
export function KindActions({ problem, place }: { problem: Problem; place: 'row' | 'banner' }) {
  const m = PROBLEM_ROWS[problem.kind];
  return (
    <>
      {problem.kind === 'unpushed_work' && <UnpushedOutcomes problem={problem} />}
      {m.actions.map((a) =>
        a.kind === 'link' ? (
          place === 'banner' && a.banner ? null : (
            <Link key={a.label} className="btn sm" to={a.to(problem)}>
              {a.label}
            </Link>
          )
        ) : (
          <Button key={a.label} size="sm" onClick={() => void release(problem)}>
            {a.label}
          </Button>
        ),
      )}
    </>
  );
}

export function ProblemRow({ problem, workspace }: { problem: Problem; workspace?: WorkspaceRow }) {
  const m = PROBLEM_ROWS[problem.kind];
  const e = problem.explanation;
  return (
    <div
      className="mrow prob-row"
      data-problem={problem.kind}
      data-problem-id={problem.id}
      data-who={e?.who}
    >
      <div className={`ico sm ico-${m.tone}`} aria-hidden="true">
        <Icon name={m.icon} />
      </div>
      <div style={{ minWidth: 0 }}>
        {/* One line: the item, who acts, then the actions (they wrap below when they don't fit). */}
        <div className="prob-head">
          <div className="row prob-id">
            {problem.item_id && (
              <Link to={paths.item(problem.item_id)} className="mono">
                {problem.item_id}
              </Link>
            )}
            {e && <WhoChip e={e} />}
            {workspace && <WorkspaceStateChip state={workspace.state} />}
            {problem.title && <span className="tt">{problem.title}</span>}
          </div>
          <div className="row prob-acts">
            <KindActions problem={problem} place="row" />
            <ProblemActions problem={problem} place="row" />
            <HelpLink anchor={m.help} />
          </div>
        </div>
        {e ? (
          <ProblemLines
            e={e}
            reachedYou={problem.reached_you}
            acknowledged={problem.acknowledged}
            titleText={problem.reason}
            compact
          />
        ) : (
          <Reason text={problem.reason} />
        )}
      </div>
    </div>
  );
}
