/**
 * Who to tell (owner decision 46, narrowed by B55b): a coordinator that Orca
 * itself proves. One small resolver, so a later reviewed change can add a safe
 * direct address as its first rule.
 *
 * - The relay never sends to a dispatch address. Orca can reopen a one-shot
 *   worker that finished between a liveness check and the send, and a pointer
 *   can't carry source authority.
 * - It never sends to a stored session address either: a session may be a
 *   one-shot implementer, and nothing here can prove otherwise.
 * - The only candidates are the Run `worker-show` reports for the recorded
 *   dispatch and, when Orca doesn't know that dispatch, a stored `run_…` ID.
 *   Either way `run-show` must confirm the Run before it is used.
 * - `orchestrator.name` and Docket's `session_id` are not addresses.
 */

const LIVE_RUN_STATES = new Set(['live', 'reported', 'stale', 'needs_input', 'parked']);
const DISPATCH_ID = /^ctx_[A-Za-z0-9_-]{1,96}$/;
const ORCA_RUN_ID = /^run_[A-Za-z0-9_-]{1,96}$/;
const RUN_ADDRESS = /^run:run_[A-Za-z0-9_-]{1,96}$/;
const DOCKET_RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The only addresses the relay may send to. `orca.send` refuses everything else. */
export const isCoordinatorAddress = (to) => typeof to === 'string' && RUN_ADDRESS.test(to);

/** The item's lead while it is open, needs input or is parked. */
export function liveLead(runs) {
  if (!Array.isArray(runs)) return null;
  return runs.find((run) => run?.is_lead === true && LIVE_RUN_STATES.has(run.run_state)) ?? null;
}

/**
 * `showDispatch(id)` returns `{ found, runId }` and `showRun(id)` returns
 * `{ found, active }`. Both throw when Orca can't answer, so the caller retries
 * instead of treating that as "not proven". `implementer` is text for the
 * message, never an address.
 */
export async function resolveCoordinator(run, { showDispatch, showRun }) {
  const stored = run?.orchestrator ?? {};
  const dispatchId = DISPATCH_ID.test(stored.dispatch_id ?? '') ? stored.dispatch_id : null;
  let candidate = null;

  if (dispatchId) {
    const dispatch = await showDispatch(dispatchId);
    if (dispatch?.found && ORCA_RUN_ID.test(dispatch.runId ?? '')) candidate = dispatch.runId;
  }
  // A Run Orca reports for the dispatch is the only candidate, even if it fails the check below.
  if (!candidate && ORCA_RUN_ID.test(stored.run_id ?? '')) candidate = stored.run_id;

  let coordinator = null;
  if (candidate) {
    const confirmed = await showRun(candidate);
    if (confirmed?.found && confirmed.active) coordinator = `run:${candidate}`;
  }

  const names = [];
  if (DOCKET_RUN_ID.test(run?.run_id ?? '')) names.push(`Docket run ${run.run_id}`);
  if (dispatchId) names.push(`dispatch ${dispatchId}`);
  return {
    coordinator: isCoordinatorAddress(coordinator) ? coordinator : null,
    implementer: names.length > 0 ? names.join(', ') : 'not recorded',
  };
}
