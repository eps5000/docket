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
 * - **Recovery flags** (BUILD_SPEC §5.16), every `sweepMs`: parked runs
 *   keep their claim, so the lease sweep skips them (their lease is
 *   suspended), and the restart sweep leaves them parked. The sweep then
 *   notes, once each, the parked runs that became ready to resume, went
 *   unattended or were parked too long, and resources that became orphaned,
 *   in the service log. The Problems rows themselves are derived on read,
 *   like *stale*, so the owner and `recovery_report` see them whether or
 *   not a sweep has run.
 *
 * Displayed run state (live, reported, stale) is derived on every read from
 * the stored signals, so there is nothing to re-derive here beyond keeping
 * those signals and leases current.
 */
import { readContext } from '../domain/contracts.js';
import { ms } from '../domain/model.js';
import type { RunRow } from '../domain/model.js';
import { orphans, parkInfo } from '../domain/recovery-model.js';
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

/**
 * The recovery flags raised now (BUILD_SPEC §5.16), as `<kind>:<id>` keys:
 * `resume_ready:<run>`, `resume_unattended:<run>`, `parked_too_long:<run>`,
 * `orphaned:<resource>`. Read-only.
 */
export function recoveryFlags(runtime: Runtime): Map<string, string> {
  const { db, config } = runtime;
  const now = runtime.clock().toISOString();
  const flags = new Map<string, string>();
  for (const run of db.sqlite
    .prepare("SELECT * FROM runs WHERE state = 'parked'")
    .all() as RunRow[]) {
    const since = run.parked_at ?? run.updated_at;
    const info = parkInfo(db, run, now);
    if (info.resume_ready) {
      flags.set(`resume_ready:${run.id}`, `${run.item_id} (${run.id}) is ready to resume`);
      if (ms(now) - ms(info.ready_since!) >= config.resumeUnattendedMs)
        flags.set(
          `resume_unattended:${run.id}`,
          `${run.item_id} (${run.id}) is ready to resume, unattended`,
        );
    }
    if (ms(now) - ms(since) >= config.parkMaxMs)
      flags.set(`parked_too_long:${run.id}`, `${run.item_id} (${run.id}) is parked too long`);
  }
  for (const o of orphans(db, now, config.orphanAfterMs)) {
    flags.set(
      `orphaned:${o.resource.id}`,
      `${o.run.item_id} left ${o.resource.label} (${o.resource.id}) running`,
    );
  }
  return flags;
}

/** Log each recovery flag once, when it is first raised; returns the new ones. */
export function flagOnce(runtime: Runtime, seen: Set<string>): string[] {
  const flags = recoveryFlags(runtime);
  const raised = [...flags.keys()].filter((k) => !seen.has(k));
  for (const k of raised) runtime.log(`sweeper: ${flags.get(k)}`);
  for (const k of [...seen]) if (!flags.has(k)) seen.delete(k);
  for (const k of raised) seen.add(k);
  return raised;
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
  const seen = new Set<string>();
  const sweep = setInterval(() => {
    try {
      const { interrupted } = sweepOnce(runtime);
      if (interrupted.length > 0)
        runtime.log(`sweeper: lease expired for ${interrupted.join(', ')}`);
    } catch (err) {
      report('lease sweep', err);
    }
    try {
      flagOnce(runtime, seen);
    } catch (err) {
      report('recovery flags', err);
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
