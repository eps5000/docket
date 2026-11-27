import { useState } from 'react';
import { needsYouCount, needsYouProblemActor, ownerNeedsYouCount } from '@docket/shared';
import type { NeedsYouResponse, Problem, WorkspaceRow } from '@docket/shared';
import { ProblemRow, workspaceFor } from '../needs-you/ProblemsCard';
import { ownerActionParts } from './overviewWindow';

type Group = { key: string; label: string; rows: Problem[] };

/** These are the server's existing ` · `-separated reason facts, not a new API field. */
function hasReasonFact(problem: Problem, fact: string): boolean {
  return problem.reason.split(' · ').some((part) => part.trim() === fact);
}

function agentRetainedByRequest(problem: Problem): boolean {
  return hasReasonFact(problem, 'agent retained by request');
}

function custodyUnknown(problem: Problem): boolean {
  return (
    problem.kind === 'dispatch_custody' ||
    /\bunknown\b/i.test(problem.reason) ||
    (problem.kind === 'dispatch_resources' && !agentRetainedByRequest(problem))
  );
}

/** The API already says who acts. Group only those rows that reached Needs you. */
export function needsYouProblemGroups(view: NeedsYouResponse) {
  const owner = view.problems.filter((p) => needsYouProblemActor(p) === 'owner');
  const coordinator = view.problems.filter((p) => needsYouProblemActor(p) === 'agent');
  const drift = owner.filter((p) => p.kind === 'agent_files_drift');
  const ownerOther = owner.filter((p) => p.kind !== 'agent_files_drift');
  const dispatch = coordinator.filter((p) => p.kind === 'dispatch_resources');
  const custody = coordinator.filter((p) => p.kind === 'dispatch_custody');
  const wake = coordinator.filter((p) => p.kind === 'wait_missing_wake');
  const coordinatorOther = coordinator.filter(
    (p) => !['dispatch_resources', 'dispatch_custody', 'wait_missing_wake'].includes(p.kind),
  );
  // Some agent-owned problems have explicitly reached the owner for visibility.
  // Keep their actor (and badge partition) intact while exposing the old
  // Problems row and its per-record actions.
  const reached = coordinatorOther.filter((p) => p.reached_you);
  const otherHolds = coordinatorOther.filter((p) => !p.reached_you);
  const heldCount = dispatch.length + custody.length + wake.length + otherHolds.length;
  const dispatchParts = {
    retained: dispatch.filter(agentRetainedByRequest),
    protected: dispatch.filter(
      (p) => !agentRetainedByRequest(p) && /\bprotected\b/i.test(p.reason),
    ),
    unknown: dispatch.filter((p) => !agentRetainedByRequest(p) && !/\bprotected\b/i.test(p.reason)),
  };
  return {
    owner,
    coordinator,
    drift,
    ownerOther,
    dispatch,
    custody,
    wake,
    coordinatorOther,
    reached,
    otherHolds,
    heldCount,
    dispatchParts,
  };
}

function CustodyLabels({ problem }: { problem: Problem }) {
  if (problem.kind !== 'dispatch_resources' && problem.kind !== 'dispatch_custody') return null;
  const unknown = custodyUnknown(problem);
  const protectedChanges = /\bprotected\b/i.test(problem.reason);
  const retained = agentRetainedByRequest(problem);
  return (
    <span className="ny-labels">
      {unknown && <span className="ny-custody-label">Unknown custody</span>}
      {protectedChanges && <span className="ny-custody-label">Protected changes</span>}
      {retained && <span className="ny-custody-label">Retained dispatch</span>}
      {!unknown && !protectedChanges && !retained && (
        <span className="ny-custody-label">Custody to verify</span>
      )}
    </span>
  );
}

function Record({
  problem,
  workspaces,
  initiallyOpen,
}: {
  problem: Problem;
  workspaces: readonly WorkspaceRow[];
  initiallyOpen: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <details
      className="ny-record"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="ny-record-title">
          {problem.item_id ? `${problem.item_id} · ` : ''}
          {problem.title ?? problem.reason}
        </span>
        <CustodyLabels problem={problem} />
      </summary>
      <p className="src">
        Who acts:{' '}
        {problem.explanation?.who_text ??
          (needsYouProblemActor(problem) === 'agent' ? 'Coordinator' : 'You')}
        .
      </p>
      {open && <ProblemRow problem={problem} workspace={workspaceFor(problem, workspaces)} />}
    </details>
  );
}

function Records({
  rows,
  workspaces,
  initiallyOpen = false,
}: {
  rows: Problem[];
  workspaces: readonly WorkspaceRow[];
  initiallyOpen?: boolean;
}) {
  return (
    <ul className="ny-records" aria-label={`${rows.length} individual warnings`}>
      {rows.map((p, i) => (
        <li key={p.id ?? `${p.kind}:${i}`}>
          <Record problem={p} workspaces={workspaces} initiallyOpen={initiallyOpen} />
        </li>
      ))}
    </ul>
  );
}

function WarningGroup({
  group,
  workspaces,
}: {
  group: Group;
  workspaces: readonly WorkspaceRow[];
}) {
  if (!group.rows.length) return null;
  return (
    <details className="ny-warning-group" data-group={group.key} data-count={group.rows.length}>
      <summary>
        {group.label} · {group.rows.length}
      </summary>
      <Records rows={group.rows} workspaces={workspaces} />
    </details>
  );
}

export function NeedsYouGroups({
  data,
  workspaces,
}: {
  data: NeedsYouResponse;
  workspaces: readonly WorkspaceRow[];
}) {
  const groups = needsYouProblemGroups(data);
  const parts = ownerActionParts(data);
  const owner = ownerNeedsYouCount(data);
  const total = needsYouCount(data);
  const dispatch = groups.dispatchParts;
  return (
    <>
      <div className="card pad ny-ledger" data-needs-you-total={total}>
        <h3>All attention · {total}</h3>
        <p>
          <b>{owner} yours to decide</b> +{' '}
          {groups.reached.length > 0 && (
            <>
              <b>
                {groups.reached.length} agent-owned{' '}
                {groups.reached.length === 1 ? 'problem' : 'problems'} reached you
              </b>{' '}
              +{' '}
            </>
          )}
          <b>{groups.heldCount} coordinators hold</b> = <b>{total} total</b>
        </p>
        <p className="src ny-equation">
          Yours: {parts.reviews} reviews + {parts.questions} questions + {parts.decisions} decisions
          + {groups.drift.length} agent-file alerts + {groups.ownerOther.length} other problems ={' '}
          {owner}. Coordinators: {groups.dispatch.length} dispatch resources +{' '}
          {groups.custody.length} unknown parked custody + {groups.wake.length} missing wake routes
          + {groups.otherHolds.length} other holds = {groups.heldCount}.
          {groups.reached.length > 0 && (
            <> Agent-owned problems that reached you: {groups.reached.length}.</>
          )}
        </p>
      </div>
      <div id="problems" className="ny-problems" tabIndex={-1}>
        {groups.owner.length + groups.reached.length > 0 && (
          <section
            className="ny-owner-problems"
            data-card="problems"
            aria-label="Problems for your attention"
          >
            <h3>Problems · {groups.owner.length + groups.reached.length}</h3>
            {groups.drift.length > 0 && (
              <details className="card ny-owner-group" data-group="agent-files" open>
                <summary>
                  Agent files changed outside Docket · {groups.drift.length} · You decide
                </summary>
                <Records rows={groups.drift} workspaces={workspaces} initiallyOpen />
              </details>
            )}
            {groups.ownerOther.length > 0 && (
              <details className="card ny-owner-group" data-group="owner-problems" open>
                <summary>Other problems for you · {groups.ownerOther.length}</summary>
                <Records rows={groups.ownerOther} workspaces={workspaces} initiallyOpen />
              </details>
            )}
            {groups.reached.length > 0 && (
              <details className="card ny-owner-group" data-group="reached-problems" open>
                <summary>Agent problems that reached you · {groups.reached.length}</summary>
                <Records rows={groups.reached} workspaces={workspaces} initiallyOpen />
              </details>
            )}
          </section>
        )}
        {groups.heldCount > 0 && (
          <section className="card ny-coordinator" aria-labelledby="ny-coordinator-title">
            <h3 id="ny-coordinator-title">Coordinators hold · {groups.heldCount}</h3>
            <p className="src">
              Nothing here is asked of you. A completed Docket run does not prove its resources are
              safe to stop, release or delete.
            </p>
            {groups.dispatch.length > 0 && (
              <details
                className="ny-warning-group"
                data-group="dispatch-resources"
                data-count={groups.dispatch.length}
              >
                <summary>
                  Completed dispatches with resources to reconcile · {groups.dispatch.length}{' '}
                  <span className="ny-labels">
                    <span className="ny-custody-label">
                      Unknown {groups.dispatch.filter(custodyUnknown).length}
                    </span>
                    <span className="ny-custody-label">
                      Protected{' '}
                      {groups.dispatch.filter((p) => /\bprotected\b/i.test(p.reason)).length}
                    </span>
                    <span className="ny-custody-label">Retained {dispatch.retained.length}</span>
                  </span>
                </summary>
                <p className="src">
                  The following custody groups are disjoint: {dispatch.unknown.length} +{' '}
                  {dispatch.protected.length} + {dispatch.retained.length} ={' '}
                  {groups.dispatch.length} records. Labels can overlap.
                </p>
                <WarningGroup
                  group={{
                    key: 'dispatch-unknown',
                    label: 'Custody unknown',
                    rows: dispatch.unknown,
                  }}
                  workspaces={workspaces}
                />
                <WarningGroup
                  group={{
                    key: 'dispatch-protected',
                    label: 'Custody unknown, changes protected',
                    rows: dispatch.protected,
                  }}
                  workspaces={workspaces}
                />
                <WarningGroup
                  group={{
                    key: 'dispatch-retained',
                    label: 'Dispatch retained',
                    rows: dispatch.retained,
                  }}
                  workspaces={workspaces}
                />
              </details>
            )}
            <WarningGroup
              group={{
                key: 'dispatch-custody',
                label: 'Parked work with unknown dispatch custody',
                rows: groups.custody,
              }}
              workspaces={workspaces}
            />
            <WarningGroup
              group={{
                key: 'wait-missing-wake',
                label: 'Parked work with no wake route',
                rows: groups.wake,
              }}
              workspaces={workspaces}
            />
            <WarningGroup
              group={{
                key: 'other-holds',
                label: 'Other coordinator holds',
                rows: groups.otherHolds,
              }}
              workspaces={workspaces}
            />
          </section>
        )}
      </div>
    </>
  );
}
