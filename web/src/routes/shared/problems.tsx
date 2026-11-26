import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import {
  reminderText,
  type Problem,
  type ProblemAck,
  type ProblemExplanation,
  type ResolutionRow,
} from '@docket/shared';
import { Button, Chip, Icon } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { queryKeys } from '../../lib/api';
import { formatAgo, isoTitle } from '../../lib/format';
import { paths } from '../../lib/paths';
import { runOwnerMutation, showToast } from '../../lib/undo';
import { errorText } from '../agent-files/install-common';
import { Markdown } from './Markdown';

/**
 * What every problem says, and what the owner can do about it (owner
 * decision 37; UI_SPEC §6.1, §6.3): the three lines (what's wrong, what
 * fixes it, who acts), why an agent problem reached the owner, the
 * acknowledgement, and the actions shared by the Problems rows and the
 * item's banner. The server writes every word (domain/problems.ts).
 */

/** A short title for each kind, for the item's banner (decision 37). */
export const PROBLEM_TITLES: Record<Problem['kind'], string> = {
  stale_run: 'Lead agent silent',
  failed_run: 'Lead run failed',
  cycle: 'Dependency cycle',
  date_risk: 'Date conflict',
  canceled_blocker: 'Blocked by a canceled item',
  deferred_verified_blocker: 'Blocker not verified',
  extra_backup_failed: 'Extra backup copy failed',
  backup_missed: 'Backup failed or overdue',
  orphaned_resources: 'Left running after its run ended',
  unpushed_work: 'Work left in a worktree',
  parked_too_long: 'Parked a long time',
  resume_unattended: 'Ready to resume, unattended',
  wait_no_next_step: 'Waiting, with no next step',
  wait_owner_unasked: 'Waiting on a decision nobody asked for',
  wait_missing_wake: 'Waiting without a clear wake',
  dispatch_custody: 'Dispatch needs a custody check',
  dispatch_resources: 'Completed dispatch has resources to reconcile',
  agent_files_drift: 'Agent files changed outside Docket',
  radar_conflict: 'Heading for a merge conflict',
  idle_ticket: 'In progress, but nobody is on it',
};

/** The banner's warning icon: an exclamation with an accessible name (decision 37). */
export function WarningMark({ label }: { label: string }) {
  return (
    <span className="prob-mark" role="img" aria-label={label}>
      <Icon name="warning" />
    </span>
  );
}

/** "Agent" or "You": who acts, in a chip; the whole line is its `title`. */
export function WhoChip({ e }: { e: ProblemExplanation }) {
  return e.who === 'agent' ? (
    <Chip kind="info" title={e.who_text}>
      Agent
    </Chip>
  ) : (
    <Chip kind="warn" title={e.who_text}>
      You
    </Chip>
  );
}

/**
 * The three lines, then why it reached you and the acknowledgement, if any.
 * `compact` (the Problems rows, so Needs you fits one screen): what's wrong
 * on up to two lines, "Fix:" on one (the whole text in `title`), and who acts
 * in the row's chip, with the full line kept for screen readers. The item's
 * banner shows all three in full.
 */
export function ProblemLines({
  e,
  reachedYou,
  acknowledged,
  titleText,
  compact = false,
}: {
  e: ProblemExplanation;
  reachedYou?: string | null;
  acknowledged?: ProblemAck | null;
  /** The one-line reason, kept in `title` (the facts the row used to show). */
  titleText?: string;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <dl className="prob-x compact">
        <div className="px-what">
          <dt className="sr">What’s wrong</dt>
          <dd title={titleText}>{e.what}</dd>
        </div>
        <div className="px-fix" title={e.fix}>
          <dt>Fix:</dt> <dd>{e.fix}</dd>
        </div>
        <div className="sr">
          <dt>Who acts</dt>
          <dd>{e.who_text}</dd>
        </div>
        {reachedYou && (
          <div className="prob-why">
            <dt className="sr">Why you see it</dt>
            <dd>{reachedYou}</dd>
          </div>
        )}
        {acknowledged && (
          <div className="prob-ack">
            <dt className="sr">Acknowledged</dt>
            <dd>
              Acknowledged by {acknowledged.by === 'owner' ? 'you' : acknowledged.by}{' '}
              <time dateTime={acknowledged.at} title={isoTitle(acknowledged.at)}>
                {formatAgo(acknowledged.at)}
              </time>
            </dd>
          </div>
        )}
      </dl>
    );
  }
  return (
    <dl className="prob-x">
      <div>
        <dt>What’s wrong</dt>
        <dd title={titleText}>{e.what}</dd>
      </div>
      <div>
        <dt>What fixes it</dt>
        <dd>{e.fix}</dd>
      </div>
      <div>
        <dt>Who acts</dt>
        <dd>{e.who_text}</dd>
      </div>
      {reachedYou && (
        <div className="prob-why">
          <dt>Why you see it</dt>
          <dd>{reachedYou}</dd>
        </div>
      )}
      {acknowledged && (
        <div className="prob-ack">
          <dt>Acknowledged</dt>
          <dd>
            Acknowledged by {acknowledged.by === 'owner' ? 'you' : acknowledged.by}{' '}
            <time dateTime={acknowledged.at} title={isoTitle(acknowledged.at)}>
              {formatAgo(acknowledged.at)}
            </time>
          </dd>
        </div>
      )}
    </dl>
  );
}

const refetch = [
  queryKeys.family('needsYou'),
  queryKeys.family('bootstrap'),
  queryKeys.family('item'),
  queryKeys.family('itemShared'),
];

/** Run an owner mutation from a problem's action, with its toast and Undo. */
function useAct() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const run = async <T extends { mutation_id: string }>(fn: () => Promise<T>, success: string) => {
    setBusy(true);
    try {
      const out = await runOwnerMutation(fn, { success, refetch });
      await qc.invalidateQueries({ queryKey: queryKeys.all });
      return out;
    } catch (err) {
      showToast(errorText(err));
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

/** Where *Open* lands: the item's banner, focused on this problem. */
export const problemHref = (p: Problem) =>
  p.item_id ? paths.item(p.item_id, 'details', undefined, p.id) : '/';

/**
 * The decision-37 actions on a problem: for an agent problem, *Remind the
 * agent*, *Open the item* (Problems rows only) and *Not an active branch*
 * for each reported branch of a radar finding; *Acknowledge* on every
 * problem not already acknowledged. The kind's own actions stay with the row.
 */
export function ProblemActions({
  problem: p,
  place,
}: {
  problem: Problem;
  place: 'row' | 'banner';
}) {
  const { busy, run } = useAct();
  const e = p.explanation;
  const agent = e?.who === 'agent';
  const remind = () => {
    if (!p.item_id || !e) return;
    void run(
      () =>
        apiClient['items.addNote']({
          params: { id: p.item_id! },
          body: { text: reminderText(e) },
        }),
      `Reminded ${p.item_id}’s agent.`,
    );
  };
  const notActive = (item: string, branch: string) =>
    void run(
      () =>
        apiClient['itemShared.branches']({
          params: { id: item },
          body: { op: 'remove', branch, not_active: true },
        }),
      `Removed ${branch} from ${item}’s branches; the radar stops checking it.`,
    );
  const acknowledge = () =>
    p.id &&
    void run(
      () => apiClient['problems.acknowledge']({ body: { problem_id: p.id! } }),
      'Acknowledged. It leaves Needs you until it needs you again.',
    );
  const branches = p.branches ?? [];
  return (
    <>
      {agent && p.item_id && (
        <Button size="sm" disabled={busy} onClick={remind}>
          Remind the agent
        </Button>
      )}
      {agent && place === 'row' && p.item_id && (
        <Link className="btn sm" to={problemHref(p)}>
          Open the item
        </Link>
      )}
      {branches.map((b) => (
        <Button
          key={`${b.item_id}:${b.branch}`}
          size="sm"
          variant="ghost"
          disabled={busy}
          // One branch: the name joins the visible label; two: the label names it.
          aria-label={branches.length > 1 ? undefined : `Not an active branch: ${b.branch}`}
          title={`Remove ${b.branch} from ${b.item_id}’s branches`}
          onClick={() => notActive(b.item_id, b.branch)}
        >
          {branches.length > 1 ? `Not active: ${b.branch}` : 'Not an active branch'}
        </Button>
      ))}
      {/* Decision 41: unpushed work has its own outcomes, which say what happens to it. */}
      {p.id && !p.acknowledged && p.kind !== 'unpushed_work' && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={acknowledge}>
          Acknowledge
        </Button>
      )}
    </>
  );
}

const KIND_TEXT: Record<ResolutionRow['kind'], string> = {
  split: 'Split the work',
  rescope: 'Change the scope',
  reorder: 'Change the order of work',
  other: 'Another way',
};

const STATE_TEXT: Record<ResolutionRow['state'], string> = {
  open: 'Waiting for you',
  approved: 'Approved',
  different: 'You asked for a different way',
  acknowledged: 'Acknowledged: fine, proceed',
  superseded: 'Replaced by a newer proposal',
};

/**
 * A proposed resolution (decision 37): what kind, the plan, the reason and
 * who proposed it; while open, *Approve*, *Go a different way* (a note is
 * required) and *Acknowledge*. Each choice reaches the item's agent as an
 * owner note and counts as acknowledging the problem.
 */
export function ResolutionView({ resolution: r }: { resolution: ResolutionRow }) {
  const { busy, run } = useAct();
  const [different, setDifferent] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ids = { title: useId(), note: useId(), error: useId() };
  const decide = (decision: 'approve' | 'different' | 'acknowledge') => {
    if (decision === 'different' && !note.trim()) {
      setError('Say which way to go instead.');
      return;
    }
    setError(null);
    void run(
      () =>
        apiClient['resolutions.decide']({
          params: { id: r.id },
          body: decision === 'different' ? { decision, note: note.trim() } : { decision },
        }),
      decision === 'approve'
        ? `Approved. ${r.proposed_by} reads it on its next call.`
        : decision === 'different'
          ? `Sent your note to ${r.proposed_by}. The problem stays open.`
          : 'Acknowledged: fine, proceed.',
    );
  };
  return (
    <div className="prob-res" data-resolution={r.id} data-resolution-state={r.state}>
      <div className="row wrap" style={{ gap: 6 }}>
        <b id={ids.title}>Proposed: {KIND_TEXT[r.kind]}</b>
        <span className="src">by {r.proposed_by}</span>
        <Chip kind={r.state === 'open' ? 'warn' : r.state === 'different' ? 'neutral' : 'ok'}>
          {STATE_TEXT[r.state]}
        </Chip>
      </div>
      <p className="prob-res-reason">{r.reason}</p>
      <Markdown text={r.plan_md} label={`Plan: ${KIND_TEXT[r.kind]}`} />
      {r.note && r.state !== 'open' && (
        <p className="src">
          Your note: <q>{r.note}</q>
        </p>
      )}
      {r.state === 'open' && (
        <>
          {different && (
            <div className="sq-note">
              <label className="f" htmlFor={ids.note}>
                Which way instead (required)
              </label>
              <textarea
                id={ids.note}
                className="input"
                rows={2}
                maxLength={1000}
                // The button that opened it stays mounted; the note takes focus (B34).
                autoFocus
                value={note}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? ids.error : undefined}
                onChange={(ev) => setNote(ev.target.value)}
              />
              {error && (
                <p id={ids.error} className="bad-text" role="alert">
                  {error}
                </p>
              )}
            </div>
          )}
          <div className="row wrap" style={{ gap: 6 }}>
            {different ? (
              <Button
                size="sm"
                disabled={busy}
                aria-describedby={ids.title}
                onClick={() => decide('different')}
              >
                Send: go a different way
              </Button>
            ) : (
              <Button size="sm" aria-describedby={ids.title} onClick={() => setDifferent(true)}>
                Go a different way
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              aria-describedby={ids.title}
              onClick={() => decide('acknowledge')}
            >
              Acknowledge
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              aria-describedby={ids.title}
              onClick={() => decide('approve')}
            >
              Approve
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
