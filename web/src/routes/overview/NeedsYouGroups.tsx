import { needsYouCount, needsYouProblemActor, ownerNeedsYouCount } from '@docket/shared';
import type { NeedsYouResponse, Problem, WorkspaceRow } from '@docket/shared';
import { ProblemRow, workspaceFor } from '../needs-you/ProblemsCard';
import { ownerActionParts } from './overviewWindow';

type Group = { key: string; label: string; rows: Problem[] };

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
  const dispatchParts = {
    retained: dispatch.filter((p) => /\bretained\b/i.test(p.reason)),
    protected: dispatch.filter(
      (p) => !/\bretained\b/i.test(p.reason) && /\bprotected\b/i.test(p.reason),
    ),
    unknown: dispatch.filter((p) => !/\bretained\b|\bprotected\b/i.test(p.reason)),
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
    dispatchParts,
  };
}

function CustodyLabels({ problem }: { problem: Problem }) {
  if (problem.kind !== 'dispatch_resources' && problem.kind !== 'dispatch_custody') return null;
  const unknown = problem.kind === 'dispatch_custody' || /\bunknown\b/i.test(problem.reason);
  const protectedChanges = /\bprotected\b/i.test(problem.reason);
  const retained = /\bretained\b/i.test(problem.reason);
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

function Records({ rows, workspaces }: { rows: Problem[]; workspaces: readonly WorkspaceRow[] }) {
  return (
    <ul className="ny-records" aria-label={`${rows.length} individual warnings`}>
      {rows.map((p, i) => (
        <li key={p.id ?? `${p.kind}:${i}`}>
          <details className="ny-record">
            <summary>
              <span className="ny-record-title">
                {p.item_id ? `${p.item_id} · ` : ''}
                {p.title ?? p.reason}
              </span>
              <CustodyLabels problem={p} />
            </summary>
            <p className="src">
              Who acts:{' '}
              {p.explanation?.who_text ??
                (needsYouProblemActor(p) === 'agent' ? 'Coordinator' : 'You')}
              .
            </p>
            <ProblemRow problem={p} workspace={workspaceFor(p, workspaces)} />
          </details>
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
          <b>{owner} yours to decide</b> + <b>{groups.coordinator.length} coordinators hold</b> ={' '}
          <b>{total} total</b>
        </p>
        <p className="src ny-equation">
          Yours: {parts.reviews} reviews + {parts.questions} questions + {parts.decisions} decisions
          + {groups.drift.length} agent-file alerts + {groups.ownerOther.length} other problems ={' '}
          {owner}. Coordinators: {groups.dispatch.length} dispatch resources +{' '}
          {groups.custody.length} unknown parked custody + {groups.wake.length} missing wake routes
          + {groups.coordinatorOther.length} other holds = {groups.coordinator.length}.
        </p>
      </div>
      <div id="problems" className="ny-problems" tabIndex={-1}>
        {groups.drift.length > 0 && (
          <details className="card ny-owner-group" data-group="agent-files" open>
            <summary>
              Agent files changed outside Docket · {groups.drift.length} · You decide
            </summary>
            <Records rows={groups.drift} workspaces={workspaces} />
          </details>
        )}
        {groups.ownerOther.length > 0 && (
          <details className="card ny-owner-group" data-group="owner-problems" open>
            <summary>Other problems for you · {groups.ownerOther.length}</summary>
            <Records rows={groups.ownerOther} workspaces={workspaces} />
          </details>
        )}
        {groups.coordinator.length > 0 && (
          <section className="card ny-coordinator" aria-labelledby="ny-coordinator-title">
            <h3 id="ny-coordinator-title">Coordinators hold · {groups.coordinator.length}</h3>
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
                      Unknown {groups.dispatch.filter((p) => /\bunknown\b/i.test(p.reason)).length}
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
                rows: groups.coordinatorOther,
              }}
              workspaces={workspaces}
            />
          </section>
        )}
      </div>
    </>
  );
}
