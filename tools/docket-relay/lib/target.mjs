/**
 * Who to tell (owner decision 46, narrowed by B55b): the coordinator, and only
 * the coordinator. One small resolver, so a later reviewed change can add a
 * safe direct address as its first rule.
 *
 * - The relay never sends to a dispatch address. Orca can reopen a one-shot
 *   worker that finished between a liveness check and the send, and a pointer
 *   can't carry source authority.
 * - In order: the dispatch's Orca Run (`run:<id>`, read with `worker-show`), a
 *   stored `run_…` ID, a stored `orca_session_id:…`.
 * - `orchestrator.name` and Docket's `session_id` are not addresses.
 */

const LIVE_RUN_STATES = new Set(['live', 'reported', 'stale', 'needs_input', 'parked']);
const DISPATCH_ID = /^ctx_[A-Za-z0-9_-]{1,96}$/;
const ORCA_RUN_ID = /^run_[A-Za-z0-9_-]{1,96}$/;
const SESSION_ADDRESS = /^orca_session_id:[A-Za-z0-9_-]{1,84}$/;
const RUN_ADDRESS = /^run:run_[A-Za-z0-9_-]{1,96}$/;
const DOCKET_RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The only addresses the relay may send to. `orca.send` refuses everything else. */
export const isCoordinatorAddress = (to) =>
  typeof to === 'string' && (RUN_ADDRESS.test(to) || SESSION_ADDRESS.test(to));

/** The item's lead while it is open, needs input or is parked. */
export function liveLead(runs) {
  if (!Array.isArray(runs)) return null;
  return runs.find((run) => run?.is_lead === true && LIVE_RUN_STATES.has(run.run_state)) ?? null;
}

/**
 * `showDispatch(id)` returns `{ found, runId }` and throws when Orca can't
 * answer, so the caller retries instead of skipping to a lower rule.
 * `implementer` is text for the message, never an address.
 */
export async function resolveCoordinator(run, showDispatch) {
  const stored = run?.orchestrator ?? {};
  const dispatchId = DISPATCH_ID.test(stored.dispatch_id ?? '') ? stored.dispatch_id : null;
  const storedId = stored.run_id ?? '';
  let coordinator = null;

  if (dispatchId) {
    const dispatch = await showDispatch(dispatchId);
    if (dispatch?.found && ORCA_RUN_ID.test(dispatch.runId ?? '')) {
      coordinator = `run:${dispatch.runId}`;
    }
  }
  if (!coordinator && ORCA_RUN_ID.test(storedId)) coordinator = `run:${storedId}`;
  if (!coordinator && SESSION_ADDRESS.test(storedId)) coordinator = storedId;

  const names = [];
  if (DOCKET_RUN_ID.test(run?.run_id ?? '')) names.push(`Docket run ${run.run_id}`);
  if (dispatchId) names.push(`dispatch ${dispatchId}`);
  return {
    coordinator: isCoordinatorAddress(coordinator) ? coordinator : null,
    implementer: names.length > 0 ? names.join(', ') : 'not recorded',
  };
}
