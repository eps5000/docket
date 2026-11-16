/**
 * The sweeper (BUILD_SPEC §5.3, §5.4; tasks.md T072).
 *
 * - **Restart sweep,** once at boot before anything else writes: every open
 *   run becomes `interrupted` (`end_reason: service_restart`). Runs are
 *   never shown as finished unless the agent finished them (FR-016).
 * - **Lease expiry,** every `sweepMs`: an expired lead run is `interrupted`
 *   (`lease_expired`) and its item goes back to Ready with its plan kept.
 * - **Pings,** every `pingMs` (60 s): each open run whose MCP session has
 *   an open `GET` stream is pinged; an answered ping is a *session* signal.
 *   A session without a stream can't be pinged, so its run can only show
 *   *reported* (BUILD_SPEC §5.4; verification V1).
 *
 * Displayed run state (live, reported, stale) is derived on every read from
 * the stored signals, so there is nothing to re-derive here beyond keeping
 * those signals and leases current.
 */
import { readContext } from '../domain/contracts.js';
import { SYSTEM_ACTOR } from '../domain/write.js';
import type { Runtime } from '../runtime.js';

export const SWEEP_MS = 15_000;
export const PING_MS = 60_000;
/** How long a ping may take before it doesn't count. */
export const PING_TIMEOUT_MS = 10_000;

/** At boot: every open run → interrupted (service restarted). */
export function restartSweep(runtime: Runtime): { interrupted: string[] } {
  return runtime.write.run({ actor: SYSTEM_ACTOR, operation: 'sweeper.restart', args: {} }, (w) =>
    runtime.services.runs.interruptOpenRuns(w, { reason: 'service restarted' }),
  ).result;
}

/** One lease sweep. A sweep with nothing to expire writes nothing. */
export function sweepOnce(runtime: Runtime): { interrupted: string[] } {
  return runtime.write.run({ actor: SYSTEM_ACTOR, operation: 'sweeper.leases', args: {} }, (w) =>
    runtime.services.runs.expireLeases(w),
  ).result;
}

/** Ping the open runs' sessions; each answered ping is a session signal. Returns the runs signalled. */
export async function pingOnce(runtime: Runtime, timeoutMs = PING_TIMEOUT_MS): Promise<string[]> {
  const sessions = runtime.services.runs.openRunSessions(
    readContext(runtime.db, SYSTEM_ACTOR, runtime.clock()),
  );
  const bySession = new Map<string, string[]>();
  for (const s of sessions)
    bySession.set(s.session_id, [...(bySession.get(s.session_id) ?? []), s.run_id]);
  const signalled: string[] = [];
  await Promise.all(
    [...bySession].map(async ([sessionId, runIds]) => {
      if (!runtime.mcp.hasStream(sessionId)) return;
      const answered = await runtime.mcp.ping(sessionId, timeoutMs);
      if (!answered) return;
      const read = readContext(runtime.db, SYSTEM_ACTOR, runtime.clock());
      for (const run_id of runIds) {
        runtime.services.runs.recordSignal(read, {
          run_id,
          kind: 'session',
          session_id: sessionId,
        });
        signalled.push(run_id);
      }
    }),
  );
  return signalled;
}

export interface Sweeper {
  stop(): void;
}

/** Start the periodic lease sweep and pings. The restart sweep is separate (`restartSweep`, at boot). */
export function startSweeper(
  runtime: Runtime,
  opts: { sweepMs?: number; pingMs?: number } = {},
): Sweeper {
  const report = (what: string, err: unknown) =>
    runtime.log(`sweeper: ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
  const sweep = setInterval(() => {
    try {
      const { interrupted } = sweepOnce(runtime);
      if (interrupted.length > 0)
        runtime.log(`sweeper: lease expired for ${interrupted.join(', ')}`);
    } catch (err) {
      report('lease sweep', err);
    }
  }, opts.sweepMs ?? SWEEP_MS);
  let pinging = false;
  const ping = setInterval(() => {
    if (pinging) return;
    pinging = true;
    pingOnce(runtime)
      .catch((err: unknown) => report('ping', err))
      .finally(() => {
        pinging = false;
      });
  }, opts.pingMs ?? PING_MS);
  sweep.unref();
  ping.unref();
  return {
    stop() {
      clearInterval(sweep);
      clearInterval(ping);
    },
  };
}
