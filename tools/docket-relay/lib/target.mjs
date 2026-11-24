/**
 * Who to tell (owner decision 46, narrowed by B55b): the Run Orca reports for
 * the lead's recorded dispatch, and nobody else. One small resolver, so a later
 * reviewed change can add a safe address as a new rule.
 *
 * The relay never sends to a dispatch address, because Orca can reopen a
 * one-shot worker that finished between a check and the send. It never uses a
 * stored ID either: only `worker-show` says whose Run a dispatch belongs to.
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
 * Decision 61 (B78): the lead run that finished partly, newest first. It may
 * have ended, so its recorded dispatch is the only way back to its producer.
 */
export function partialLead(runs) {
  if (!Array.isArray(runs)) return null;
  const partial = runs.filter((run) => run?.is_lead === true && run?.exit?.outcome === 'partial');
  partial.sort((a, b) => String(b.exit.at ?? '').localeCompare(String(a.exit.at ?? '')));
  return partial[0] ?? null;
}

/**
 * `showDispatch(id)` returns `{ found, runId }` and throws when Orca can't
 * answer, so the caller retries. `implementer` is text for the message, never
 * an address.
 */
export async function resolveCoordinator(run, showDispatch) {
  const stored = run?.orchestrator?.dispatch_id ?? '';
  const dispatchId = DISPATCH_ID.test(stored) ? stored : null;
  let coordinator = null;
  if (dispatchId) {
    const dispatch = await showDispatch(dispatchId);
    if (dispatch?.found && ORCA_RUN_ID.test(dispatch.runId ?? '')) {
      coordinator = `run:${dispatch.runId}`;
    }
  }
  const names = [];
  if (DOCKET_RUN_ID.test(run?.run_id ?? '')) names.push(`Docket run ${run.run_id}`);
  if (dispatchId) names.push(`dispatch ${dispatchId}`);
  return { coordinator, implementer: names.length > 0 ? names.join(', ') : 'not recorded' };
}
