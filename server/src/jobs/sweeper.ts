/**
 * The sweeper (BUILD_SPEC §5.3, §5.4; tasks.md T072).
 *
 * - **Restart sweep,** once at boot before anything else writes (owner
 *   decision 41): open runs stay open, with their claim, workspace and
 *   `run_id`, and each lead's lease runs at least
 *   `DOCKET_RESTART_GRACE_MINUTES` from now. An agent's next call continues;
 *   one that never returns ends by lease expiry. Runs are never shown as
 *   finished unless the agent finished them (FR-016). `service_restart`
 *   remains only in the history of runs ended before decision 41.
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
 * - **The drift check** (owner decision 30; BUILD_SPEC §5.19), at startup and
 *   every `DOCKET_DRIFT_CHECK_INTERVAL`: each push install's location is
 *   read (never written) and compared with its manifest; see
 *   `startDriftCheck` below.
 *
 * Displayed run state (live, reported, stale) is derived on every read from
 * the stored signals, so there is nothing to re-derive here beyond keeping
 * those signals and leases current.
 */
import { readContext } from '../domain/contracts.js';
import { ms } from '../domain/model.js';
import type { RunRow } from '../domain/model.js';
import { orphans, parkInfo } from '../domain/recovery-model.js';
import {
  RADAR_DEBOUNCE_MS,
  RADAR_INTERVAL_MS,
  RADAR_MIN_GAP_MS,
  radarProjects,
  radarTriggers,
} from '../domain/radar.js';
import { classifyLegacyOverlaps } from '../domain/shared-changes.js';
import { checkProjectWorktrees } from '../domain/worktree-check.js';
import { SYSTEM_ACTOR } from '../domain/write.js';
import type { Runtime } from '../runtime.js';

export const SWEEP_MS = 15_000;
export const PING_MS = 60_000;
/** How long a ping may take before it doesn't count. */
export const PING_TIMEOUT_MS = 10_000;

/** At boot (decision 41): open runs keep their claim, with a lease of at least the grace. */
export function restartSweep(runtime: Runtime): { kept: string[] } {
  return runtime.write.run({ actor: SYSTEM_ACTOR, operation: 'sweeper.restart', args: {} }, (w) =>
    runtime.services.runs.keepOpenRuns(w, { graceMs: runtime.config.restartGraceMs }),
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

// ---- The scheduled drift check (owner decision 30; BUILD_SPEC §5.19; T161) ----

/**
 * One drift check: read every push install's location through B24's guarded
 * reader (outside any transaction; nothing is written there), then record
 * what changed in one write. A check that finds nothing new writes nothing.
 */
export async function driftCheckOnce(runtime: Runtime): Promise<{ drift_ids: string[] }> {
  const read = readContext(runtime.db, SYSTEM_ACTOR, runtime.clock());
  const reports = await runtime.services.drift.checkPushInstalls(read);
  if (reports.length === 0) return { drift_ids: [] };
  return runtime.write.run(
    { actor: SYSTEM_ACTOR, operation: 'drift.check', args: { reports } },
    (w) => runtime.services.drift.recordChecks(w, { reports }),
  ).result;
}

/**
 * Run the drift check at startup and every `DOCKET_DRIFT_CHECK_INTERVAL`
 * (default 15 min); off when the interval is `0` or `off`. Tests pass a
 * shorter `intervalMs`. A check still running when the next is due is
 * skipped, not stacked.
 */
export function startDriftCheck(
  runtime: Runtime,
  opts: { intervalMs?: number | null } = {},
): Sweeper {
  const interval =
    opts.intervalMs === undefined ? runtime.config.driftCheckIntervalMs : opts.intervalMs;
  if (!interval) return { stop() {} };
  let running = false;
  let stopped = false;
  const tick = () => {
    if (running || stopped) return;
    running = true;
    driftCheckOnce(runtime)
      .then(({ drift_ids }) => {
        if (drift_ids.length > 0) {
          runtime.log(`drift check: ${drift_ids.length} agent file change(s) outside Docket`);
        }
      })
      .catch((err: unknown) =>
        runtime.log(`drift check: failed: ${err instanceof Error ? err.message : String(err)}`),
      )
      .finally(() => {
        running = false;
      });
  };
  tick();
  const timer = setInterval(tick, interval);
  timer.unref();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

// ---- The conflict radar (owner decision 36; BUILD_SPEC §5.21; T184) ----

/**
 * One radar run for a project (domain/radar.ts): plan (read the database and
 * trial-merge, outside any transaction), record the findings through the
 * write path, then stamp the run. A run that finds nothing new writes no
 * event. `actor` is the system for scheduled runs.
 */
export function radarRunOnce(runtime: Runtime, project: string, actor = SYSTEM_ACTOR): void {
  const svc = runtime.services.sharedChanges;
  const plan = svc.planRadar(readContext(runtime.db, actor, runtime.clock()), { key: project });
  runtime.write.run({ actor, operation: 'radar.run', args: { key: project } }, (w) =>
    svc.recordRadar(w, plan),
  );
  svc.finishRadar(readContext(runtime.db, actor, runtime.clock()), plan);
}

/**
 * Decision 39, once at startup: open overlap questions from before it get the
 * new rule, so the owner isn't left answering what Docket now handles. A pair
 * the owner decided is untouched. Writes nothing when there are none.
 */
export function classifyLegacyOverlapsOnce(runtime: Runtime): number {
  return runtime.write.run({ actor: SYSTEM_ACTOR, operation: 'overlaps.classify', args: {} }, (w) =>
    classifyLegacyOverlaps(w, runtime.services.links),
  ).result;
}

/**
 * Run the radar for every project with a repository at startup and every
 * 15 minutes (BUILD_SPEC §5.21: at least every 15 minutes), and for a project
 * soon after one of its items reports a branch or a commit (decision 39;
 * debounced, and at most once per `minGapMs`). Tests pass shorter times, or
 * null to turn either off. A failing project is logged and skipped; the
 * others still run.
 */
export function startRadar(
  runtime: Runtime,
  opts: { intervalMs?: number | null; debounceMs?: number | null; minGapMs?: number } = {},
): Sweeper {
  const interval = opts.intervalMs === undefined ? RADAR_INTERVAL_MS : opts.intervalMs;
  const debounce = opts.debounceMs === undefined ? RADAR_DEBOUNCE_MS : opts.debounceMs;
  const minGap = opts.minGapMs ?? RADAR_MIN_GAP_MS;
  if (!interval && !debounce) return { stop() {} };
  let stopped = false;
  const lastRun = new Map<string, number>();
  const pending = new Map<string, NodeJS.Timeout>();
  const runProject = (key: string) => {
    lastRun.set(key, Date.now());
    try {
      radarRunOnce(runtime, key);
    } catch (err) {
      runtime.log(`radar: ${key} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Decision 41: what ended runs really left behind, with the same read-only git.
    try {
      checkProjectWorktrees(runtime.db, runtime.config, key, runtime.clock().toISOString());
    } catch (err) {
      runtime.log(
        `worktree check: ${key} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
  const tick = () => {
    if (stopped) return;
    for (const key of radarProjects(runtime.db)) runProject(key);
  };
  // Decision 39: run soon after a branch or commit is reported, at most once per `minGap`.
  const schedule = (key: string) => {
    if (stopped || pending.has(key)) return;
    const since = Date.now() - (lastRun.get(key) ?? 0);
    const timer = setTimeout(
      () => {
        pending.delete(key);
        if (!stopped) runProject(key);
      },
      Math.max(debounce ?? 0, minGap - since),
    );
    timer.unref();
    pending.set(key, timer);
  };
  const onChange = (seqs: number[]) => {
    if (stopped || !debounce) return;
    try {
      for (const key of radarTriggers(runtime.db, seqs)) schedule(key);
    } catch (err) {
      runtime.log(`radar: trigger failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  if (debounce) runtime.bus.on('change', onChange);
  const first = interval ? setTimeout(tick, 5_000) : null;
  first?.unref();
  const timer = interval ? setInterval(tick, interval) : null;
  timer?.unref();
  return {
    stop() {
      stopped = true;
      if (first) clearTimeout(first);
      if (timer) clearInterval(timer);
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
      runtime.bus.off('change', onChange);
    },
  };
}
