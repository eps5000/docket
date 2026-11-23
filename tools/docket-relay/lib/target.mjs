/**
 * Who to tell (owner decision 46). One small resolver, so an explicit stored
 * session address can later be added as the first rule.
 *
 * - `orchestrator.dispatch_id`, when Orca confirms that dispatch is still live,
 *   is the implementer. A finished one must not be mailed: Orca would reopen it
 *   as a follow-up task.
 * - The dispatch's Orca Run is its coordinator's mailbox.
 * - `orchestrator.run_id` never proves an implementer. A `run_…` value is an
 *   Orca Run, so a coordinator. An `orca_session_id:…` value may be either, so
 *   it only ever gets the coordinator wording.
 * - `orchestrator.name` and Docket's `session_id` are not addresses.
 */

const LIVE_RUN_STATES = new Set(['live', 'reported', 'stale', 'needs_input', 'parked']);
const DISPATCH_ID = /^ctx_[A-Za-z0-9_-]{1,96}$/;
const ORCA_RUN_ID = /^run_[A-Za-z0-9_-]{1,96}$/;
const SESSION_ADDRESS = /^orca_session_id:[A-Za-z0-9_-]{1,84}$/;
const DOCKET_RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The item's lead while it is open, needs input or is parked. */
export function liveLead(runs) {
  if (!Array.isArray(runs)) return null;
  return runs.find((run) => run?.is_lead === true && LIVE_RUN_STATES.has(run.run_state)) ?? null;
}

/**
 * `showDispatch(id)` returns `{ found, live, runId }` and throws when Orca
 * can't answer, so the caller retries instead of treating it as closed.
 */
export async function resolveTarget(run, showDispatch) {
  const stored = run?.orchestrator ?? {};
  const dispatchId = DISPATCH_ID.test(stored.dispatch_id ?? '') ? stored.dispatch_id : null;
  let implementer = null;
  let coordinator = null;

  if (dispatchId) {
    const dispatch = await showDispatch(dispatchId);
    if (dispatch?.found && dispatch.live) implementer = `dispatch:${dispatchId}`;
    if (dispatch?.found && ORCA_RUN_ID.test(dispatch.runId ?? '')) {
      coordinator = `run:${dispatch.runId}`;
    }
  }
  const runId = stored.run_id ?? '';
  if (!coordinator && ORCA_RUN_ID.test(runId)) coordinator = `run:${runId}`;
  if (!coordinator && SESSION_ADDRESS.test(runId)) coordinator = runId;

  const name = dispatchId
    ? `dispatch ${dispatchId}`
    : DOCKET_RUN_ID.test(run?.run_id ?? '')
      ? `Docket run ${run.run_id}`
      : 'its lead run';
  return { implementer, coordinator, implementerName: name };
}
