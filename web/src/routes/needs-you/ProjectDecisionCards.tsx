import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import type { DecisionRecord, ProjectDecisionGroup } from '@docket/shared';
import { Button, Card, CardHeader } from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { useBootstrap } from '../../app/useBootstrap';
import { HelpLink } from '../../help/HelpLink';
import { queryKeys } from '../../lib/api';
import { formatDay, isoTitle } from '../../lib/format';
import { paths } from '../../lib/paths';
import { runOwnerMutation, showToast } from '../../lib/undo';
import { errorText } from '../agent-files/install-common';
import { WITHDRAWN_DEFAULT } from '../shared/DecisionsPanel';

/** How many titles a grouped card lists before "and N more". */
const GROUP_SHOWN = 3;

function useRun() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const run = async <T extends { mutation_id: string }>(fn: () => Promise<T>, success: string) => {
    setBusy(true);
    try {
      return await runOwnerMutation(fn, { success, refetch: [queryKeys.all] });
    } catch (err) {
      showToast(errorText(err));
      return null;
    } finally {
      setBusy(false);
      await qc.invalidateQueries({ queryKey: queryKeys.all });
    }
  };
  return { busy, run };
}

/** The project's name for a card, from the shell's project list. */
function useProjectName() {
  const projects = useBootstrap().data?.projects ?? [];
  return (key: string) => projects.find((p) => p.key === key)?.name ?? key;
}

/**
 * Agents' project-wide decisions on Needs you (owner decision 38; UI_SPEC
 * §6.1): a card each, "New project-wide decision by <agent>: <title>", with
 * the text and the reason, *Confirm*, *Withdraw…*, *Acknowledge* (keep it as
 * an agent decision) and *Open* (the project Decisions page, at the record).
 * Records from before decision 38 share one card per project, with *Review*
 * and *Acknowledge all*. Each counts as for you; every action has Undo.
 */
export function ProjectDecisionCards({
  cards,
  groups,
}: {
  cards: readonly DecisionRecord[];
  groups: readonly ProjectDecisionGroup[];
}) {
  if (cards.length === 0 && groups.length === 0) return null;
  return (
    <div className="mb shared-qs" data-card="project-decisions">
      {cards.map((d) => (
        <DecisionCard key={d.id} record={d} />
      ))}
      {groups.map((g) => (
        <GroupCard key={g.project} group={g} />
      ))}
    </div>
  );
}

function DecisionCard({ record: d }: { record: DecisionRecord }) {
  const { busy, run } = useRun();
  const projectName = useProjectName();
  const [withdrawing, setWithdrawing] = useState(false);
  const [reason, setReason] = useState('');
  const ids = { title: useId(), reason: useId() };
  const confirm = () =>
    run(
      () =>
        apiClient['decisions.confirm']({
          params: { id: d.id },
          body: { expected_version: d.version },
        }),
      `Confirmed “${d.title}”. It is now an owner decision.`,
    );
  const withdraw = () => {
    setWithdrawing(false);
    return run(
      () =>
        apiClient['decisions.withdraw']({
          params: { id: d.id },
          body: { reason: reason.trim() || WITHDRAWN_DEFAULT, expected_version: d.version },
        }),
      `Withdrew “${d.title}”.`,
    );
  };
  const acknowledge = () =>
    run(
      () => apiClient['decisions.acknowledge']({ body: { decision_ids: [d.id] } }),
      `Acknowledged “${d.title}”. It stays an agent decision.`,
    );
  return (
    <Card className="sq-card pdec-card" data-project-decision-card={d.id}>
      <CardHeader
        title={
          <span id={ids.title}>
            New project-wide decision by {d.author}: {d.title}
          </span>
        }
        extra={<HelpLink anchor="needs-you.project-decisions" />}
      />
      <div className="pad" style={{ paddingTop: 0 }}>
        <p className="src" style={{ margin: '0 0 6px' }} title={isoTitle(d.created_at)}>
          {projectName(d.project)} · {formatDay(d.created_at)}
        </p>
        <p className="pdec-text">{d.decision_md}</p>
        {d.rationale_md && (
          <p className="src pdec-why">
            <b>Why:</b> {d.rationale_md}
          </p>
        )}
        {withdrawing ? (
          <div className="row wrap" style={{ gap: 6 }}>
            <label className="sr" htmlFor={ids.reason}>
              Reason for withdrawing (optional)
            </label>
            <input
              id={ids.reason}
              className="input grow"
              placeholder="Optional reason"
              maxLength={1000}
              value={reason}
              autoFocus
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void withdraw();
                if (e.key === 'Escape') setWithdrawing(false);
              }}
            />
            <Button size="sm" onClick={() => setWithdrawing(false)}>
              Keep it
            </Button>
            <Button size="sm" variant="danger-text" disabled={busy} onClick={() => void withdraw()}>
              Withdraw
            </Button>
          </div>
        ) : (
          <div className="row wrap" style={{ gap: 6 }}>
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              aria-describedby={ids.title}
              onClick={() => void confirm()}
            >
              Confirm
            </Button>
            <Button
              size="sm"
              variant="danger-text"
              aria-describedby={ids.title}
              onClick={() => setWithdrawing(true)}
            >
              Withdraw…
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              aria-describedby={ids.title}
              onClick={() => void acknowledge()}
            >
              Acknowledge
            </Button>
            <Link
              className="btn sm ghost"
              to={paths.projectDecisions(d.project, { decision: d.id })}
              aria-describedby={ids.title}
            >
              Open
            </Link>
          </div>
        )}
      </div>
    </Card>
  );
}

function GroupCard({ group: g }: { group: ProjectDecisionGroup }) {
  const { busy, run } = useRun();
  const projectName = useProjectName();
  const titleId = useId();
  const n = g.decisions.length;
  const name = projectName(g.project);
  const acknowledgeAll = () =>
    run(
      () =>
        apiClient['decisions.acknowledge']({
          body: { decision_ids: g.decisions.map((d) => d.id) },
        }),
      n === 1
        ? `Acknowledged 1 project-wide decision in ${name}. It stays an agent decision.`
        : `Acknowledged ${n} project-wide decisions in ${name}. They stay agent decisions.`,
    );
  return (
    <Card className="sq-card pdec-card" data-project-decision-group={g.project}>
      <CardHeader
        title={
          <span id={titleId}>
            {n === 1
              ? '1 project-wide decision by agents to review'
              : `${n} project-wide decisions by agents to review`}
          </span>
        }
        extra={<HelpLink anchor="needs-you.project-decisions" />}
      />
      <div className="pad" style={{ paddingTop: 0 }}>
        <p className="src" style={{ margin: '0 0 6px' }}>
          {name}. Agents recorded {n === 1 ? 'it' : 'them'} before Docket asked for your review.
        </p>
        <ul className="pdec-list">
          {g.decisions.slice(0, GROUP_SHOWN).map((d) => (
            <li key={d.id}>
              {d.title} <span className="src">· {d.author}</span>
            </li>
          ))}
          {n > GROUP_SHOWN && <li className="src">and {n - GROUP_SHOWN} more</li>}
        </ul>
        <div className="row wrap" style={{ gap: 6 }}>
          <Link
            className="btn sm primary"
            to={paths.projectDecisions(g.project, { filter: 'review' })}
            aria-describedby={titleId}
          >
            Review
          </Link>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            aria-describedby={titleId}
            onClick={() => void acknowledgeAll()}
          >
            Acknowledge all
          </Button>
        </div>
      </div>
    </Card>
  );
}
