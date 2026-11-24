/**
 * The owner's read models (UI_SPEC §6; BUILD_SPEC §7): the `views` service.
 *
 * US2 (T080) fills `bootstrap`, `needsYou`, `work`, `itemDetail` and
 * `agents`; US7 (T125) fills `labelPage`. US4 (B11) fills `settings`
 * far enough for the project rows and their "Blockers clear when" rule, with
 * connection and health values only where they are true today (config, the
 * `/readyz` checks); US10 completes it (smoke-test status, backups). US4 also
 * adds `outside` cards and cycle links to `work` and `itemDetail`.
 *
 * Every view is a fixed number of bounded queries over the scope, never a
 * query per item (SC-013): items in scope are read once, blocked state comes
 * from one `BlockIndex`, and summaries from one `summarize` call. Derived
 * values reuse B7's model helpers (`displayRunState`, `runView`, `eventRow`),
 * so the owner sees exactly what agents see (Principle II).
 *
 * Owner attention (Principle V): only packets ready and open questions are
 * "for you". Problems never are.
 *
 * The recovery Problems rows (orphaned resources, unpushed work, parked too
 * long, ready to resume unattended) are US11's (T101), from the recovery read
 * model (recovery-model.ts). The timeline section of `work` is US8's
 * (`forecast.timeline`, added by the read route); the date risk rule is
 * shared with it (`dateRiskBlockers` in model.ts).
 */
import { openPartialExit, storedExit } from './exit-reports.js';
import { COMPAT_SURFACES, resultMode } from './compat.js';
import { readdirSync, statfsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  END_REASON_LABELS,
  ToolError,
  OPEN_STATUSES,
  LEGACY_WORK_FILTERS,
  needsYouCount,
  workFilterCounts,
  workFilterFromParams,
  workFilterPasses,
  type ActivityRow,
  type AgentRow,
  type AgentsResponse,
  type BootstrapResponse,
  type DecisionRecord,
  type DeferredRow,
  type EpicCard,
  type EventType,
  type ForYouRow,
  type Item,
  type ItemDetailResponse,
  type ItemSummary,
  type LeadParked,
  type LinkEdge,
  type NeedsYouResponse,
  type PlanVersion,
  type Problem,
  type RunState,
  type SettingsResponse,
  type Status,
  type WaitingOn,
  type WorkCheck,
  type WorkItem,
  finishedPartlyText,
  type WorkResponse,
} from '@docket/shared';
import { migrationStatus, type Db } from '../db/client.js';
import { APP_VERSION } from '../version.js';
import {
  isNotImplemented,
  type BackupTrouble,
  type ReadContext,
  type ServiceDeps,
  type ViewsService,
} from './contracts.js';
import { compareIds, cycleText, cyclesOf } from './links.js';
import { pendingProposalCount } from './agent-proposals.js';
import { CREATED_BY_SQL, onboardingItemIds, readySessions } from './onboarding.js';
import { driftProblems, runInstructions } from './drift.js';
import { readyStates } from './next-work.js';
import { waitKindsOf } from './wait-kind.js';
import { needsYouShared, sharedFlagsOf } from './shared-changes.js';
import {
  ackCovers,
  explain,
  latestResolutions,
  leadingItems,
  loadAcks,
  openResolutions,
  radarProblems,
  recoveryRoute,
  type FoundProblem,
  type RecoveryRoute,
} from './problems.js';
import { agingFrom, decisionHold, heldByOwner } from './decision-hold.js';
import { projectPauses } from './project-pause.js';
import { inScopeOf, ofScope, projectReviews } from './decisions.js';
import { agentsNow, overviewItemsOf, overviewOf } from './overview.js';
import { briefOf } from './brief.js';
import {
  BlockIndex,
  EVENT_COLUMNS,
  dateRiskBlockers,
  EVENT_FROM,
  OPEN_STORED_SQL,
  coordinatorParkOf,
  displayRunState,
  eventRow,
  isRunOpen,
  ms,
  requireItem,
  summarize,
  windowsOf,
  type ItemRow,
  type RunRow,
  type RunWindows,
  type StoredEvent,
} from './model.js';
import { parseQuestionForm } from './question-form.js';
import { epicWaits } from './epic-picks.js';
import { epicReadiness, readinessOf, unshapedByEpic } from './epic-readiness.js';
import { epicReleases, releaseDetails, releaseHoldOf } from './release.js';
import { epicMidflight, midflightByEpic } from './midflight.js';
import { explainIdle, idleDay, idleTickets } from './idle.js';
import { reportedBranches } from './radar.js';
import { producersByItem, storedActivity, storedStatusUpdate } from './run-activity.js';
import { WaitReader, openWaitFlags, waitCoordinator } from './wait.js';
import { UNDO_WINDOW_MS } from './undo.js';
import { allowedOriginsFor } from '../api/guards.js';
import {
  locatorText,
  orphans,
  parkInfo,
  parseJson,
  storedWorkspace,
  coordinatorOf,
  unpushedTruth,
  unpushedRisks,
  type RecoveryConfig,
} from './recovery-model.js';
import { hostGitFactsFor, hostGitState } from './host-git.js';

type Scope = 'all' | string;

const isOpenStatus = (s: string) => (OPEN_STATUSES as readonly string[]).includes(s);

/** Activity rows the item page loads at once ("small enough to load at once"). */
export const ACTIVITY_LIMIT = 200;

/** A review's notes kept as owner decisions (owner decision 35), for the Activity row's links. */
function keptDecisions(kept: string | null): { decision_ids?: string[] } {
  if (!kept) return {};
  try {
    const ids = (JSON.parse(kept) as { decision_id?: unknown }[])
      .map((k) => k.decision_id)
      .filter((id): id is string => typeof id === 'string');
    return ids.length ? { decision_ids: ids } : {};
  } catch {
    return {};
  }
}
/** Ended runs and subagent log entries the Agents table shows, newest first. */
export const AGENTS_ENDED_LIMIT = 50;

// ---- Small formatting helpers (server-side text is UTC-free: dates and durations only) ----

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-11-09` → `Nov 9`. */
export function dayLabel(date: string): string {
  const [, m, d] = date.slice(0, 10).split('-');
  return `${MONTHS[Number(m) - 1] ?? m} ${Number(d)}`;
}

/** A duration in words: `40s`, `47m`, `16h`, `3d`. */
export function durationLabel(msValue: number): string {
  const s = Math.max(0, Math.round(msValue / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** One line, ending in a full stop (Problems rows are one truncated line). */
const sentence = (text: string) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return /[.?!]$/.test(line) ? line : `${line}.`;
};

const byPriorityThenId = (a: { priority: number; id: string }, b: typeof a) =>
  a.priority - b.priority || compareIds(a.id, b.id);

const placeholders = (n: number) => `(${Array.from({ length: n }, () => '?').join(', ')})`;

// ---- The scope ----

export interface Scoped {
  db: Db;
  now: string;
  windows: RunWindows;
  index: BlockIndex;
  /** Items in scope (live projects only), by ID. */
  items: Map<string, ItemRow>;
  inScope: (projectKey: string | null | undefined) => boolean;
}

export function scoped(r: ReadContext, windows: RunWindows, scope: Scope): Scoped {
  const sql = r.db.sqlite;
  const rows = (
    scope === 'all'
      ? sql
          .prepare(
            'SELECT i.* FROM items i JOIN projects p ON p.key = i.project_key WHERE p.deleted_at IS NULL',
          )
          .all()
      : sql
          .prepare(
            'SELECT i.* FROM items i JOIN projects p ON p.key = i.project_key WHERE p.deleted_at IS NULL AND i.project_key = ?',
          )
          .all(scope)
  ) as ItemRow[];
  return {
    db: r.db,
    now: r.now,
    windows,
    index: new BlockIndex(r.db),
    items: new Map(rows.map((row) => [row.id, row])),
    inScope: (key) => !!key && (scope === 'all' || key === scope),
  };
}

// ---- Attention: packets and questions ----

export interface OpenPacket {
  id: string;
  item_id: string;
  round: number;
  estimate: string | null;
  built_from_commit: string | null;
  created_at: string;
  stale: boolean;
  /** Decision 48: a split moved acceptance criteria after it was built. */
  criteria_changed: boolean;
  to_verify: number;
}

const sameSha = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

/**
 * Open packets on `itemIds`, with staleness (BUILD_SPEC §5.6: a commit
 * reported after the packet with another SHA; for an epic-level packet, a
 * commit on any child) and how many items it asks you to verify.
 */
export function openPackets(db: Db, itemIds: string[]): Map<string, OpenPacket> {
  const out = new Map<string, OpenPacket>();
  if (itemIds.length === 0) return out;
  const sql = db.sqlite;
  const rows = sql
    .prepare(
      `SELECT id, item_id, round, estimate, built_from_commit, created_at, criteria_changed_at FROM packets
       WHERE state = 'open' AND item_id IN ${placeholders(itemIds.length)}`,
    )
    .all(...itemIds) as (Omit<OpenPacket, 'stale' | 'criteria_changed' | 'to_verify'> & {
    criteria_changed_at: string | null;
  })[];
  if (rows.length === 0) return out;
  const packetItems = rows.map((p) => p.item_id);
  const list = placeholders(packetItems.length);
  const commits = sql
    .prepare(
      `SELECT c.item_id, i.epic_id, c.sha, c.reported_at FROM commits c JOIN items i ON i.id = c.item_id
       WHERE c.item_id IN ${list} OR i.epic_id IN ${list}`,
    )
    .all(...packetItems, ...packetItems) as {
    item_id: string;
    epic_id: string | null;
    sha: string;
    reported_at: string;
  }[];
  const ready = new Map(
    (
      sql
        .prepare(
          `SELECT item_id, count(*) AS n FROM hr_items WHERE state = 'ready' AND item_id IN ${list} GROUP BY item_id`,
        )
        .all(...packetItems) as { item_id: string; n: number }[]
    ).map((x) => [x.item_id, x.n]),
  );
  for (const { criteria_changed_at, ...p } of rows) {
    const built = (p.built_from_commit ?? '').toLowerCase();
    const criteria_changed = criteria_changed_at !== null;
    const stale =
      criteria_changed ||
      commits.some(
        (c) =>
          (c.item_id === p.item_id || c.epic_id === p.item_id) &&
          ms(c.reported_at) > ms(p.created_at) &&
          !sameSha(c.sha.toLowerCase(), built),
      );
    out.set(p.item_id, { ...p, stale, criteria_changed, to_verify: ready.get(p.item_id) ?? 0 });
  }
  return out;
}

interface OpenQuestion {
  id: string;
  item_id: string;
  text: string;
  asked_by: string;
  form: string | null;
  created_at: string;
}

/** Unanswered questions (at most one per item). */
function openQuestions(db: Db, itemIds: string[]): Map<string, OpenQuestion> {
  const out = new Map<string, OpenQuestion>();
  if (itemIds.length === 0) return out;
  for (const q of db.sqlite
    .prepare(
      `SELECT id, item_id, text, asked_by, form, created_at FROM questions
       WHERE answered_at IS NULL AND withdrawn_at IS NULL AND item_id IN ${placeholders(itemIds.length)}`,
    )
    .all(...itemIds) as OpenQuestion[]) {
    out.set(q.item_id, q);
  }
  return out;
}

// ---- Runs ----

/** Open runs (any), and each item's latest lead run, for the items in scope. */
function scopeRuns(s: Scoped) {
  const sql = s.db.sqlite;
  const open = (
    sql.prepare(`SELECT * FROM runs WHERE state IN ${OPEN_STORED_SQL}`).all() as RunRow[]
  ).filter((r) => s.items.has(r.item_id));
  // The latest lead run per item (the failed-run Problem looks at it).
  const latestLead = new Map<string, RunRow>();
  for (const r of sql
    .prepare(
      `SELECT r.* FROM runs r WHERE r.is_lead = 1 AND r.created_at = (
         SELECT max(r2.created_at) FROM runs r2 WHERE r2.item_id = r.item_id AND r2.is_lead = 1)`,
    )
    .all() as RunRow[]) {
    if (s.items.has(r.item_id)) latestLead.set(r.item_id, r);
  }
  return { open, latestLead };
}

/**
 * Decision 61: the partial exits still waiting on their producer among these
 * items, as the card shows them. One query, then the settle check for each hit.
 */
function finishedPartlyOf(
  db: Db,
  ids: readonly string[],
): Map<string, NonNullable<WorkItem['finished_partly']>> {
  const out = new Map<string, NonNullable<WorkItem['finished_partly']>>();
  if (ids.length === 0) return out;
  const hits = db.sqlite
    .prepare(
      `SELECT DISTINCT item_id FROM runs WHERE is_lead = 1 AND item_id IN ${placeholders(ids.length)}
         AND json_extract(exit_report, '$.outcome') = 'partial'`,
    )
    .all(...ids) as { item_id: string }[];
  for (const { item_id } of hits) {
    const open = openPartialExit(db, item_id);
    if (open) {
      out.set(item_id, {
        left: open.exit.left.length,
        reasons: open.exit.left.map((x) => `${x.text}: ${x.why}`),
      });
    }
  }
  return out;
}

/** What a parked run waits on, since when, and whether it can resume (`lead_parked`, B20). */
function parkedOf(db: Db, run: RunRow, now: string, index: BlockIndex): LeadParked {
  return {
    waiting_on: parseJson<WaitingOn>(run.waiting_on) ?? {},
    since: run.parked_at ?? run.updated_at,
    resume_ready: parkInfo(db, run, now, index).resume_ready,
    ...(storedActivity(run)?.flag ? { activity: storedActivity(run)!.flag! } : {}),
  };
}

/**
 * `lead_parked` for the parked leads among `summaries` (B20, UI API only: the
 * run line on cards and the epic's Tickets list), keyed by run id. One query.
 */
function leadParkedOf(
  db: Db,
  summaries: readonly Pick<ItemSummary, 'lead'>[],
  now: string,
  index: BlockIndex,
): (s: Pick<ItemSummary, 'lead'>) => LeadParked | null {
  const ids = summaries.filter((i) => i.lead?.run_state === 'parked').map((i) => i.lead!.run_id);
  const byRun = new Map<string, LeadParked>();
  if (ids.length > 0) {
    for (const run of db.sqlite
      .prepare(`SELECT * FROM runs WHERE state = 'parked' AND id IN ${placeholders(ids.length)}`)
      .all(...ids) as RunRow[]) {
      byRun.set(run.id, parkedOf(db, run, now, index));
    }
  }
  return (i) => (i.lead ? (byRun.get(i.lead.run_id) ?? null) : null);
}

/**
 * A failed lead run that still needs someone: the item is In progress with
 * no active lead and its latest lead run failed (BUILD_SPEC §5.3: "It shows
 * under Problems (failed)"). Returning it to Ready or a new claim clears it.
 */
function failedRuns(s: Scoped, runs: ReturnType<typeof scopeRuns>): RunRow[] {
  const leading = new Set(runs.open.filter((r) => r.is_lead === 1).map((r) => r.item_id));
  return [...runs.latestLead.values()].filter(
    (r) =>
      r.state === 'failed' &&
      s.items.get(r.item_id)?.status === 'progress' &&
      !leading.has(r.item_id),
  );
}

/** Counts per displayed run state: open runs, plus failed runs that still need someone. */
function runCounts(s: Scoped, runs: ReturnType<typeof scopeRuns>) {
  const counts: Partial<Record<RunState, number>> = {};
  for (const r of runs.open) {
    const state = displayRunState(r, s.windows, s.now);
    counts[state] = (counts[state] ?? 0) + 1;
  }
  const failed = failedRuns(s, runs).length;
  if (failed > 0) counts.failed = failed;
  return counts;
}

// ---- Problems (UI_SPEC §6.1; BUILD_SPEC §5.2) ----

interface ProblemsInput {
  s: Scoped;
  runs: ReturnType<typeof scopeRuns>;
  /** Items with a deferred human review item, and how many. */
  deferredCounts: Map<string, number>;
  /** Extra backup copy errors, when the backup service reports them (US10). */
  backupError: string | null;
  /** Decision 41: the nightly backup failed or is overdue. */
  backupTrouble: BackupTrouble | null;
  /** The recovery thresholds (BUILD_SPEC §5.16). */
  config: RecoveryConfig;
  /** Agent files changed outside Docket (decision 30), already scoped. */
  drift: Problem[];
}

/** `RCP-12, RCP-13`, `the coordinator`, `a person`: what a parked run waits on. */
function waitingLine(w: WaitingOn): string {
  const parts: string[] = [];
  if (w.items?.length) parts.push(w.items.join(', '));
  if (w.orchestrator) parts.push('the coordinator');
  if (w.person) parts.push('a person');
  if (w.until) parts.push(`until ${dayLabel(w.until)}`);
  return parts.join(', ') || 'nothing named';
}

/**
 * The recovery Problems (UI_SPEC §6.1; BUILD_SPEC §5.16): orphaned
 * resources, unpushed work that may be lost, runs parked past PARK_MAX, and
 * runs ready to resume but unattended past RESUME_UNATTENDED. None of them
 * releases a claim; they say what the owner (or a coordinator) should do.
 */
function recoveryProblems(
  s: Scoped,
  runs: ReturnType<typeof scopeRuns>,
  config: RecoveryConfig,
  push: (p: Problem) => void,
  base: Pick<Problem, 'related' | 'link_id' | 'run_id' | 'resource_ids'>,
): void {
  const { db, items, now } = s;
  const title = (id: string) => items.get(id)?.title ?? null;

  // Resources left running after their run ended.
  const byRun = new Map<string, ReturnType<typeof orphans>>();
  for (const o of orphans(db, now, config.orphanAfterMs)) {
    if (!items.has(o.run.item_id)) continue;
    byRun.set(o.run.id, [...(byRun.get(o.run.id) ?? []), o]);
  }
  for (const [runId, left] of byRun) {
    const first = left[0]!;
    const what = left
      .map((o) => {
        const where = locatorText(parseJson(o.resource.locator) ?? {});
        return where ? `${o.resource.label} (${where})` : o.resource.label;
      })
      .join(', ');
    const after = durationLabel(ms(now) - ms(first.ended_at));
    push({
      ...base,
      kind: 'orphaned_resources',
      id: `orphaned_resources:${runId}`,
      item_id: first.run.item_id,
      title: title(first.run.item_id),
      // Key fact first (B20): what is still running, then since when, then what to do.
      reason: `${what} still running ${after} after its run ended · stop ${left.length === 1 ? 'it' : 'them'}, then mark ${left.length === 1 ? 'it' : 'them'} released`,
      run_id: runId,
      resource_ids: left.map((o) => o.resource.id),
      explanation: explain.orphaned_resources({
        item: first.run.item_id,
        what,
        after,
        n: left.length,
      }),
    });
  }

  // Ended runs (finished ones too) that left work off the remote. Decision 41: what git
  // last saw when it could read the repository, and only what is really left.
  const ended = (
    db.sqlite
      .prepare(
        "SELECT * FROM runs WHERE state IN ('finished', 'failed', 'interrupted') AND workspace IS NOT NULL AND unpushed_handled_at IS NULL",
      )
      .all() as RunRow[]
  ).filter((r) => items.has(r.item_id));
  const risks = unpushedRisks(db, ended).flatMap((risk) => {
    const truth = unpushedTruth(risk, now);
    return truth ? [{ risk, truth }] : [];
  });
  const leading = leadingItems(db, [...new Set(risks.map((x) => x.risk.run.item_id))], now);
  // B76: whether git facts can come at all, so "unverified" can say what it waits on.
  const helperByProject = new Map<string, boolean>();
  const waitingOnHelper = (project: string) => {
    if (!helperByProject.has(project)) {
      const p = db.sqlite
        .prepare('SELECT key, repo_path, main_branch FROM projects WHERE key = ?')
        .get(project) as { key: string; repo_path: string | null; main_branch: string } | undefined;
      helperByProject.set(
        project,
        !!p?.repo_path && hostGitState(hostGitFactsFor(db, p), now) !== 'fresh',
      );
    }
    return helperByProject.get(project)!;
  };
  for (const { risk, truth } of risks) {
    const id = risk.run.item_id;
    const path = storedWorkspace(risk.run)?.path;
    const work = [
      truth.commits > 0
        ? `${truth.commits} ${truth.commits === 1 ? 'commit' : 'commits'} not pushed`
        : null,
      truth.files !== null && truth.files > 0
        ? `${truth.files} uncommitted ${truth.files === 1 ? 'file' : 'files'}`
        : truth.files === null && truth.dirty
          ? 'uncommitted changes'
          : null,
    ].filter((x): x is string => !!x);
    const closed = closedWords(db, items.get(id));
    const route: RecoveryRoute = closed
      ? {
          who: 'owner',
          who_text: 'You (only you can decide what happens to it)',
          reached: `${id} isn't being worked on, so no agent will pick this up`,
        }
      : recoveryRoute({
          item: id,
          lead: leading.has(id),
          coordinator: coordinatorOf(risk.run),
          since: risk.ended_at,
          now,
          graceMs: config.agentProblemGraceMs,
        });
    // Key fact first (B20): what may be lost, where, then how the run ended.
    const facts = [
      ...work,
      truth.on_main ? 'commits already on main' : null,
      truth.unverified ? 'unverified' : null,
      path ?? null,
      closed ?? `run ended (${END_REASON_LABELS[risk.run.end_reason!]})`,
    ].filter(Boolean);
    push({
      ...base,
      kind: 'unpushed_work',
      id: `unpushed_work:${risk.run.id}`,
      item_id: id,
      title: title(id),
      reason: facts.join(' · '),
      run_id: risk.run.id,
      reached_you: route.reached,
      explanation: explain.unpushed_work({
        item: id,
        facts: work,
        path: path ?? null,
        ended: END_REASON_LABELS[risk.run.end_reason!],
        onMain: truth.on_main,
        unverified: truth.unverified,
        waiting: truth.unverified && waitingOnHelper(items.get(id)!.project_key),
        closed,
        route,
      }),
    });
  }

  // Parked runs: too long, or ready to resume with nobody resuming them.
  for (const run of runs.open.filter((r) => r.state === 'parked')) {
    const since = run.parked_at ?? run.updated_at;
    const waiting = parseJson<WaitingOn>(run.waiting_on) ?? {};
    const info = parkInfo(db, run, now, s.index);
    if (info.resume_ready && ms(now) - ms(info.ready_since!) >= config.resumeUnattendedMs) {
      const items2 = waiting.items ?? [];
      const why =
        items2.length > 0 && items2.every((id) => s.index.status(id) === 'done')
          ? `${items2.join(', ')} ${items2.length === 1 ? 'is' : 'are'} done`
          : items2.length > 0
            ? `${items2.join(', ')} cleared`
            : 'its wait time has passed';
      const parked = durationLabel(ms(now) - ms(since));
      push({
        ...base,
        kind: 'resume_unattended',
        id: `resume_unattended:${run.id}`,
        item_id: run.item_id,
        title: title(run.item_id),
        reason: `Ready to resume: ${why} · parked ${parked}`,
        run_id: run.id,
        explanation: explain.resume_unattended({ item: run.item_id, why, parked }),
      });
    }
    // Decision 48: an owner's decision holds it, and aging restarts when the owner lifts it.
    const hold = decisionHold(db, run);
    const aging = agingFrom(since, hold);
    if (!heldByOwner(hold) && ms(now) - ms(aging) >= config.parkMaxMs) {
      // Decision 41: its coordinator first. Waiting on a person is the owner's at once.
      const route: RecoveryRoute = waiting.person
        ? {
            who: 'owner',
            who_text: 'You (it is waiting on a person)',
            reached: 'It is waiting on a person',
          }
        : recoveryRoute({
            item: run.item_id,
            lead: false,
            coordinator: coordinatorOf(run),
            since: new Date(ms(aging) + config.parkMaxMs).toISOString(),
            now,
            graceMs: config.agentProblemGraceMs,
          });
      push({
        ...base,
        kind: 'parked_too_long',
        id: `parked_too_long:${run.id}`,
        item_id: run.item_id,
        title: title(run.item_id),
        reason: `Parked since ${dayLabel(since)} · waiting on ${waitingLine(waiting)} · keeps its claim`,
        run_id: run.id,
        reached_you: route.reached,
        explanation: explain.parked_too_long({
          item: run.item_id,
          since: dayLabel(since),
          waiting: waitingLine(waiting),
          route,
        }),
      });
    }
    // Decision 45: the flags the two-minute check raised. Agents first, by the same routing.
    if (run.is_lead !== 1) continue;
    // Decision 53: a held run raises nothing, even before the next check clears its flags.
    for (const flag of heldByOwner(hold) ? [] : openWaitFlags(run)) {
      const route = recoveryRoute({
        item: run.item_id,
        lead: false,
        coordinator: waitCoordinator(db, run, items.get(run.item_id)!.project_key),
        since: flag.since,
        now,
        graceMs: config.agentProblemGraceMs,
      });
      const waited = durationLabel(ms(now) - ms(since));
      push({
        ...base,
        kind: flag.kind,
        id: `${flag.kind}:${run.id}:${flag.on}`,
        item_id: run.item_id,
        title: title(run.item_id),
        reason:
          flag.kind === 'wait_no_next_step'
            ? `Waiting on ${flag.on} with no next step · ${flag.step}`
            : `Waiting on an owner decision nobody has asked for · ${flag.step}`,
        related: flag.on === run.item_id ? [] : [flag.on],
        run_id: run.id,
        reached_you: route.reached,
        explanation:
          flag.kind === 'wait_no_next_step'
            ? explain.wait_no_next_step({
                item: run.item_id,
                on: flag.on,
                waited,
                step: flag.step,
                route,
              })
            : explain.wait_owner_unasked({ item: run.item_id, on: flag.on, route }),
      });
    }
  }
}

/** Decision 45: the item page's wait card, and the parked runs waiting on this item. */
function waitOf(r: ReadContext, id: string, index: BlockIndex) {
  const reader = new WaitReader(r.db, r.now, index);
  const lead = r.db.sqlite
    .prepare("SELECT * FROM runs WHERE item_id = ? AND is_lead = 1 AND state = 'parked'")
    .get(id) as RunRow | undefined;
  const waiting = reader.waitersOn(id);
  return {
    wait: lead ? reader.card(lead) : null,
    ...(waiting.total > 0 ? { waiting_runs: waiting } : {}),
  };
}

/**
 * Words for an item nobody will pick up again (decision 41): "was canceled by
 * your decision", "was canceled", "is deferred (in Planning)". Null for an item
 * still in play. "Your decision" means the owner canceled it, or an active owner
 * decision is scoped to it or names it.
 */
function closedWords(db: Db, item: ItemRow | undefined): string | null {
  if (!item) return null;
  if (item.status === 'inbox' || item.status === 'planning') {
    return `is deferred (in ${item.status === 'inbox' ? 'Inbox' : 'Planning'})`;
  }
  if (item.status !== 'canceled') return null;
  const canceledBy = db.sqlite
    .prepare(
      `SELECT actor_kind FROM events WHERE item_id = ? AND type = 'item.status_changed'
       AND json_extract(data, '$.status.new') = 'canceled' ORDER BY seq DESC LIMIT 1`,
    )
    .get(item.id) as { actor_kind: string } | undefined;
  if (canceledBy?.actor_kind === 'owner') return 'was canceled by your decision';
  const named = new RegExp(`(?<![A-Za-z0-9-])${item.id}(?![A-Za-z0-9])`);
  const decisions = db.sqlite
    .prepare(
      `SELECT scope_kind, scope_id, title, decision_md FROM decision_records
       WHERE project_key = ? AND authority = 'owner' AND status = 'active'`,
    )
    .all(item.project_key) as {
    scope_kind: string;
    scope_id: string | null;
    title: string;
    decision_md: string;
  }[];
  const byDecision = decisions.some(
    (d) =>
      ((d.scope_kind === 'item' || d.scope_kind === 'epic') && d.scope_id === item.id) ||
      named.test(d.title) ||
      named.test(d.decision_md),
  );
  return byDecision ? 'was canceled by your decision' : 'was canceled';
}

/** "Nov 21, 3:00 AM", in the service's time zone (the one backups are scheduled in). */
const STAMP: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
};

function problemsOf({
  s,
  runs,
  deferredCounts,
  backupError,
  backupTrouble,
  config,
  drift,
}: ProblemsInput): Problem[] {
  const { index, items, now } = s;
  const base = { related: [] as string[], link_id: null, run_id: null, resource_ids: [] };
  const list: { p: Problem; holds: number }[] = [];
  const holds = (id: string | null) => (id ? index.unblocks(id).length : 0);
  const push = (p: Problem) => list.push({ p, holds: holds(p.item_id) });
  const title = (id: string) => items.get(id)?.title ?? null;
  const sql = s.db.sqlite;

  // Stale lead runs: unknown, never finished (Principle III).
  const staleRuns = runs.open.filter(
    (r) => r.is_lead === 1 && displayRunState(r, s.windows, now) === 'stale',
  );
  const rejected = new Map<string, string>();
  if (staleRuns.length > 0) {
    const ids = staleRuns.map((r) => r.item_id);
    for (const e of sql
      .prepare(
        `SELECT item_id, max(at) AS at FROM events WHERE type = 'claim.rejected' AND item_id IN ${placeholders(ids.length)} GROUP BY item_id`,
      )
      .all(...ids) as { item_id: string; at: string }[]) {
      rejected.set(e.item_id, e.at);
    }
  }
  // Decision 41: a run silent only because Docket restarted is its agent's, within the grace.
  const restart = staleRuns.length
    ? (sql.prepare("SELECT max(at) AS at FROM events WHERE type = 'service.restarted'").get() as {
        at: string | null;
      })
    : null;
  const inRestartGrace = (r: RunRow) =>
    !!restart?.at &&
    ms(r.last_signal_at) < ms(restart.at) &&
    ms(now) < ms(restart.at) + config.restartGraceMs &&
    !!r.lease_expires_at &&
    ms(r.lease_expires_at) > ms(now);
  for (const r of staleRuns) {
    const silent = durationLabel(ms(now) - ms(r.last_signal_at));
    const lease = r.lease_expires_at
      ? ms(r.lease_expires_at) > ms(now)
        ? `the lease expires in ${durationLabel(ms(r.lease_expires_at) - ms(now))}`
        : 'the lease has run out'
      : 'it holds no lease';
    const rej = rejected.get(r.item_id);
    const claim =
      rej && ms(rej) >= ms(r.created_at)
        ? ` · another agent's claim was rejected ${durationLabel(ms(now) - ms(rej))} ago`
        : '';
    push({
      ...base,
      kind: 'stale_run',
      id: `stale_run:${r.id}`,
      item_id: r.item_id,
      title: title(r.item_id),
      reason: `Lead silent for ${silent} · ${lease} · treated as unknown, not finished${claim}`,
      run_id: r.id,
      explanation: explain.stale_run({
        item: r.item_id,
        silent,
        lease,
        restarted: inRestartGrace(r),
        // Decision 44: silent because a coordinator parked it; its short lease decides.
        parkEndedBy:
          r.lease_expires_at && ms(r.lease_expires_at) > ms(now) && coordinatorParkOf(r)?.ended_at
            ? coordinatorParkOf(r)!.by
            : undefined,
      }),
    });
  }

  // Failed lead runs nobody has picked up.
  for (const r of failedRuns(s, runs)) {
    push({
      ...base,
      kind: 'failed_run',
      id: `failed_run:${r.id}`,
      item_id: r.item_id,
      title: title(r.item_id),
      reason: `${r.error ? `Run failed: ${sentence(r.error)}` : 'Run failed.'} Nothing retries automatically.`,
      run_id: r.id,
      explanation: explain.failed_run({
        item: r.item_id,
        error: r.error ? sentence(r.error) : null,
      }),
    });
  }

  // Work that may be lost or left running ranks before date and link problems.
  recoveryProblems(s, runs, config, push, base);
  // Instructions changed outside Docket: every later agent follows them (decision 30).
  for (const p of drift) push(p);

  for (const item of items.values()) {
    if (!isOpenStatus(item.status)) continue;

    // Date risk: planned to start before an unresolved blocker is planned to finish.
    const risky = dateRiskBlockers(index, item, (b) => plannedEnd(s, b));
    if (risky.length > 0) {
      const b = risky[0]!;
      push({
        ...base,
        kind: 'date_risk',
        id: `date_risk:${item.id}`,
        item_id: item.id,
        title: item.title,
        reason: `Planned start ${dayLabel(item.planned_start!)} is before its blocker ${b} is planned to finish (${dayLabel(plannedEnd(s, b)!)}).`,
        related: risky,
        explanation: explain.date_risk({
          item: item.id,
          start: dayLabel(item.planned_start!),
          blocker: b,
          blockerEnd: dayLabel(plannedEnd(s, b)!),
        }),
      });
    }

    for (const link of index.blockers.get(item.id) ?? []) {
      const blocker = link.from_id;
      // A canceled blocker never clears (§5.2): the owner removes the link.
      if (index.status(blocker) === 'canceled') {
        push({
          ...base,
          kind: 'canceled_blocker',
          id: `canceled_blocker:${link.id}`,
          item_id: item.id,
          title: item.title,
          reason: `Blocked by canceled ${blocker}. Remove the link, or reopen ${blocker}.`,
          related: [blocker],
          link_id: link.id,
          explanation: explain.canceled_blocker({ item: item.id, blocker }),
        });
        continue;
      }
      // A verified blocker that closed with deferred checks stays unresolved (§5.2).
      const deferred = deferredCounts.get(blocker) ?? 0;
      if (index.waitingFor(link) === 'verification' && deferred > 0) {
        push({
          ...base,
          kind: 'deferred_verified_blocker',
          id: `deferred_verified_blocker:${link.id}`,
          item_id: item.id,
          title: item.title,
          reason: `${item.id} needs ${blocker} verified, but ${deferred} ${deferred === 1 ? 'check was' : 'checks were'} deferred.`,
          related: [blocker],
          link_id: link.id,
          explanation: explain.deferred_verified_blocker({ item: item.id, blocker, deferred }),
        });
      }
    }
  }

  // Cycles (imported data can hold them; `link_items` refuses new ones).
  for (const cycle of cyclesOf(index, [...items.keys()])) {
    const members = cycle.filter((id) => items.has(id));
    if (members.length === 0 || !members.some((id) => isOpenStatus(items.get(id)!.status))) {
      continue;
    }
    const imported = cycle.every((id) => {
      const row = items.get(id) as (ItemRow & { imported?: number }) | undefined;
      return !!row?.imported;
    });
    const path = cycleText(index, cycle);
    const sorted = [...cycle].sort(compareIds);
    push({
      ...base,
      kind: 'cycle',
      id: `cycle:${sorted.join('+')}`,
      item_id: members[0]!,
      title: title(members[0]!),
      reason: `Dependency cycle${imported ? ' in imported data' : ''}: ${path}. None of them can start until one link is removed.`,
      related: cycle,
      explanation: explain.cycle({ path, members: sorted, imported }),
    });
  }

  // Decision 62: an In progress ticket nobody has worked on for days, one problem each.
  const inScope = [...items.values()].filter((i) => i.status === 'progress' && i.type !== 'Epic');
  if (inScope.length > 0) {
    const idle = idleTickets(s.db, now, { ids: inScope.map((i) => i.id) });
    for (const item of inScope) {
      const t = idle.get(item.id);
      if (!t) continue;
      push({
        ...base,
        kind: 'idle_ticket',
        id: `idle_ticket:${item.id}`,
        item_id: item.id,
        title: item.title,
        reason: `${item.id} is In progress but nobody has worked on it since ${idleDay(t.since)}`,
        explanation: explainIdle({
          item: item.id,
          since: t.since,
          branches: reportedBranches(s.db, item.id).length,
        }),
      });
    }
  }

  if (backupError) {
    push({
      ...base,
      kind: 'extra_backup_failed',
      id: 'extra_backup_failed',
      item_id: null,
      title: null,
      reason: `Extra backup copy failed: ${sentence(backupError)}`,
      explanation: explain.extra_backup_failed({ error: sentence(backupError) }),
    });
  }

  if (backupTrouble) {
    const t = backupTrouble;
    const when = (at: string) => new Date(at).toLocaleString('en-US', STAMP);
    const last = t.last_success_at ? when(t.last_success_at) : null;
    push({
      ...base,
      kind: 'backup_missed',
      // One per scheduled time, so acknowledging tonight's doesn't hide tomorrow's.
      id: `backup_missed:${t.due_at}`,
      item_id: null,
      title: null,
      reason:
        t.state === 'failed'
          ? `Last backup failed: ${sentence(t.error ?? 'unknown error')}`
          : `The backup due at ${when(t.due_at)} hasn't run`,
      explanation: explain.backup_missed({
        state: t.state,
        error: t.error ? sentence(t.error) : null,
        due: when(t.due_at),
        last,
      }),
    });
  }

  // What holds up the most work first; otherwise in the order found.
  return list
    .map((x, i) => ({ ...x, i }))
    .sort((a, b) => b.holds - a.holds || a.i - b.i)
    .map((x) => x.p);
}

/**
 * An item's problems (decision 37; the banner): those about it, plus the
 * radar findings and cycles it is part of.
 */
export function itemProblemsOf(all: readonly Problem[], id: string): Problem[] {
  return all.filter(
    (p) =>
      p.item_id === id ||
      ((p.kind === 'radar_conflict' || p.kind === 'cycle') && p.related.includes(id)),
  );
}

function plannedEnd(s: Scoped, id: string): string | null {
  const row = s.items.get(id);
  if (row) return row.planned_end;
  // A blocker in another project (blocking crosses projects).
  const other = s.db.sqlite.prepare('SELECT planned_end FROM items WHERE id = ?').get(id) as
    { planned_end: string | null } | undefined;
  return other?.planned_end ?? null;
}

// ---- Deferred, not verified (BUILD_SPEC §5.6) ----

export interface DeferredInfo {
  rows: DeferredRow[];
  /** Deferred items per item, for the Problems row about verified blockers. */
  counts: Map<string, number>;
  /** Items with at least one deferred item that isn't verified yet (the Work filter). */
  unverified: Set<string>;
}

/**
 * Deferred human review items whose follow-up isn't done with its own review
 * approved, or that have no follow-up. Newest first.
 */
export function deferredOf(s: Scoped): DeferredInfo {
  const rows = (
    s.db.sqlite
      .prepare(
        `SELECT h.id, h.item_id, h.text, h.last_decision, h.follow_up_item_id, h.updated_at,
                f.status AS follow_status,
                (SELECT count(*) FROM hr_items fh WHERE fh.item_id = f.id AND fh.state <> 'approved') AS follow_open
         FROM hr_items h LEFT JOIN items f ON f.id = h.follow_up_item_id
         WHERE h.state = 'deferred'`,
      )
      .all() as {
      id: string;
      item_id: string;
      text: string;
      last_decision: string | null;
      follow_up_item_id: string | null;
      updated_at: string;
      follow_status: Status | null;
      follow_open: number | null;
    }[]
  ).filter((h) => s.items.has(h.item_id));
  const counts = new Map<string, number>();
  const unverified = new Set<string>();
  const out: DeferredRow[] = [];
  for (const h of rows) {
    counts.set(h.item_id, (counts.get(h.item_id) ?? 0) + 1);
    const verified = h.follow_status === 'done' && (h.follow_open ?? 0) === 0;
    if (verified) continue;
    unverified.add(h.item_id);
    let last: { note?: string | null; at?: string } = {};
    try {
      last = h.last_decision ? (JSON.parse(h.last_decision) as typeof last) : {};
    } catch {
      last = {};
    }
    out.push({
      item_id: h.item_id,
      title: s.items.get(h.item_id)!.title,
      hr_item_id: h.id,
      text: h.text,
      note: last.note ?? null,
      deferred_at: last.at ?? h.updated_at,
      follow_up:
        h.follow_up_item_id && h.follow_status
          ? { id: h.follow_up_item_id, status: h.follow_status }
          : null,
    });
  }
  out.sort(
    (a, b) => b.deferred_at.localeCompare(a.deferred_at) || compareIds(a.item_id, b.item_id),
  );
  return { rows: out, counts, unverified };
}

// ---- Links ----

function linkEdges(db: Db, index: BlockIndex, ids: Set<string>, mode: 'among' | 'touching') {
  if (ids.size === 0) return [];
  const list = [...ids];
  const rows = db.sqlite
    .prepare(
      `SELECT id, from_id, to_id, type, satisfied_when FROM links
       WHERE from_id IN ${placeholders(list.length)} OR to_id IN ${placeholders(list.length)}
       ORDER BY from_id, to_id, id`,
    )
    .all(...list, ...list) as {
    id: string;
    from_id: string;
    to_id: string;
    type: 'blocks' | 'relates';
    satisfied_when: 'done' | 'merged' | 'verified' | null;
  }[];
  const edges: LinkEdge[] = [];
  for (const l of rows) {
    if (mode === 'among' && !(ids.has(l.from_id) && ids.has(l.to_id))) continue;
    edges.push({
      link_id: l.id,
      from: l.from_id,
      to: l.to_id,
      type: l.type,
      satisfied_when: l.type === 'blocks' ? index.rule(l) : null,
      cleared: l.type === 'blocks' ? index.cleared(l) : null,
    });
  }
  return edges;
}

/** Live item rows by ID (any project), sorted by priority then ID. */
function rowsById(db: Db, ids: Iterable<string>): ItemRow[] {
  const list = [...new Set(ids)];
  if (list.length === 0) return [];
  return (
    db.sqlite
      .prepare(
        `SELECT i.* FROM items i JOIN projects p ON p.key = i.project_key
         WHERE p.deleted_at IS NULL AND i.id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(list)) as ItemRow[]
  ).sort(byPriorityThenId);
}

/**
 * Every `blocks` link inside a cycle that touches `ids` (BUILD_SPEC §5.2):
 * the Dependencies tab offers *Remove "A blocks B"* for each one, including
 * links that don't touch the item itself.
 */
function cycleEdges(index: BlockIndex, ids: Set<string>): LinkEdge[] {
  const edges: LinkEdge[] = [];
  for (const component of cyclesOf(index, [...ids])) {
    if (!component.some((id) => ids.has(id))) continue;
    const members = new Set(component);
    for (const id of component) {
      for (const l of index.dependents.get(id) ?? []) {
        if (!members.has(l.to_id)) continue;
        edges.push({
          link_id: l.id,
          from: l.from_id,
          to: l.to_id,
          type: 'blocks',
          satisfied_when: index.rule(l),
          cleared: index.cleared(l),
        });
      }
    }
  }
  return edges;
}

/** `a` plus the edges of `b` it doesn't have yet (by link ID). */
function mergeEdges(a: LinkEdge[], b: LinkEdge[]): LinkEdge[] {
  const seen = new Set(a.map((e) => e.link_id));
  return [...a, ...b.filter((e) => !seen.has(e.link_id) && seen.add(e.link_id))];
}

/** Bytes under `dir` (documents), or null when it can't be read. */
function dirBytes(dir: string): number | null {
  try {
    let total = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (entry.isFile()) total += statSync(join(entry.parentPath, entry.name)).size;
    }
    return total;
  } catch {
    return null;
  }
}

const fileBytes = (path: string): number | null => {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
};
/** The sum of the sizes that exist; null when none does. */
const sumBytes = (sizes: (number | null)[]): number | null =>
  sizes.some((n) => n !== null) ? sizes.reduce<number>((a, n) => a + (n ?? 0), 0) : null;

// ---- Health (`/readyz` checks, for the sidebar health line) ----

let migrationsCurrent: boolean | null = null;

function healthOf(r: ReadContext, deps: ServiceDeps): BootstrapResponse['health'] {
  const checks: Record<string, string> = {};
  const dir = (path: string) => {
    try {
      return statSync(path).isDirectory() ? 'ok' : 'missing';
    } catch (err) {
      return (err as NodeJS.ErrnoException).code ?? 'error';
    }
  };
  checks.data_dir = dir(deps.config.dataDir);
  checks.docs_dir = dir(deps.config.paths.docs);
  try {
    r.db.sqlite.prepare('SELECT 1').get();
    checks.database = 'ok';
  } catch (err) {
    checks.database = (err as { code?: string }).code ?? 'error';
  }
  try {
    // Migrations only change with a new build, so read the files once.
    migrationsCurrent ??= migrationStatus(r.db).current;
    checks.migrations = migrationsCurrent ? 'ok' : 'pending';
  } catch {
    checks.migrations = 'error';
  }
  const status = Object.values(checks).every((v) => v === 'ok') ? 'ready' : 'not_ready';
  // Agent clients with a signal in the last 24 hours ("Healthy · 3 clients").
  const clients = (
    r.db.sqlite
      .prepare('SELECT count(DISTINCT client) AS n FROM runs WHERE last_signal_at >= ?')
      .get(new Date(ms(r.now) - 86_400_000).toISOString()) as { n: number }
  ).n;
  if (clients > 0) checks.clients = String(clients);
  return { status, checks };
}

// ---- The service ----

export function createViewsService(deps: ServiceDeps): ViewsService {
  const windows = () => windowsOf(deps.config);

  /** The extra backup copy's last error, once the backup service exists (US10). */
  function backupError(r: ReadContext): string | null {
    try {
      const extra = deps
        .services()
        .backup.status(r)
        .find((b) => b.location === 'extra');
      return extra?.last_error ?? null;
    } catch (err) {
      if (isNotImplemented(err)) return null;
      throw err;
    }
  }

  /** Decision 41: the nightly backup failed or is overdue. */
  function backupTroubleOf(r: ReadContext): BackupTrouble | null {
    try {
      return deps.services().backup.trouble(r);
    } catch (err) {
      if (isNotImplemented(err)) return null;
      throw err;
    }
  }

  /** Decision 43: the newest successful backup at any location. */
  function lastBackupAt(r: ReadContext): string | null {
    try {
      const times = deps
        .services()
        .backup.status(r)
        .map((b) => b.last_success_at)
        .filter((t): t is string => t !== null)
        .sort();
      return times.at(-1) ?? null;
    } catch (err) {
      if (isNotImplemented(err)) return null;
      throw err;
    }
  }

  function attention(s: Scoped) {
    const ids = [...s.items.keys()];
    return { packets: openPackets(s.db, ids), questions: openQuestions(s.db, ids) };
  }

  function forYouRows(s: Scoped, att: ReturnType<typeof attention>): ForYouRow[] {
    const packets: ForYouRow[] = [...att.packets.values()]
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((p) => ({
        kind: 'packet',
        item_id: p.item_id,
        title: s.items.get(p.item_id)!.title,
        project: s.items.get(p.item_id)!.project_key,
        packet_id: p.id,
        round: p.round,
        to_verify: p.to_verify,
        estimate: p.estimate ?? '10 min',
        stale: p.stale,
        built_from_commit: p.built_from_commit ?? '',
        submitted_at: p.created_at,
      }));
    const questions: ForYouRow[] = [...att.questions.values()]
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((q) => ({
        kind: 'question',
        item_id: q.item_id,
        title: s.items.get(q.item_id)!.title,
        project: s.items.get(q.item_id)!.project_key,
        question_id: q.id,
        asked_by: q.asked_by,
        text: q.text,
        asked_at: q.created_at,
        form: parseQuestionForm(q.form),
      }));
    return [...packets, ...questions];
  }

  /**
   * Every open problem in scope (decision 37): the radar's first (unattended
   * branches keep moving toward the conflict), then the rest, each with its
   * newest proposed resolution and whether an acknowledgement still covers it.
   */
  function problemSet(r: ReadContext, scope: Scope, inScope?: Scoped) {
    const s = inScope ?? scoped(r, windows(), scope);
    const runs = scopeRuns(s);
    const deferred = deferredOf(s);
    // Decision 36: overlap questions and undeclared-parts holds are owner questions (a card
    // each, counted as for you); radar findings are Problems ("Heading for a conflict").
    const shared = needsYouShared(r.db, scope, r.now, deps.config.overlapGraceMs);
    const own = problemsOf({
      s,
      runs,
      deferredCounts: deferred.counts,
      backupError: backupError(r),
      backupTrouble: backupTroubleOf(r),
      config: deps.config,
      drift: driftProblems(r.db, s.inScope, scope === 'all'),
    });
    const radar = radarProblems(
      r.db,
      shared.radar_findings,
      r.now,
      deps.config.agentProblemGraceMs,
    );
    const all = [...radar, ...own];
    const acks = loadAcks(r.db);
    const latest = latestResolutions(r.db);
    for (const p of all) {
      const resolution = p.id ? (latest.get(p.id) ?? null) : null;
      p.resolution = resolution;
      p.acknowledged = p.id ? ackCovers(acks.get(p.id), p, resolution) : null;
      p.reached_you ??= null;
    }
    return { s, runs, deferred, shared, all };
  }

  /** Agent problems agents are still handling: in their grace period, with a lead (decision 37). */
  const handledByAgents = (p: Problem) => p.explanation?.who === 'agent' && !p.reached_you;

  function needsYou(r: ReadContext, scope: Scope): NeedsYouResponse {
    const { s, runs, deferred, shared, all } = problemSet(r, scope);
    const att = attention(s);
    const planning = [...s.items.values()]
      .filter((i) => i.status === 'planning' && i.archived_at === null)
      .sort(byPriorityThenId);
    // Decision 37: acknowledged problems leave Needs you; agent problems wait for the agents.
    const problems = all.filter((p) => !p.acknowledged && !handledByAgents(p));
    const open = new Set(all.map((p) => p.id));
    const resolutions = openResolutions(r.db, new Set(s.items.keys())).filter(
      (x) => x.problem_id === null || open.has(x.problem_id),
    );
    // Decision 38: agents' project-wide decisions wait for the owner's review.
    const reviews = projectReviews(r.db, scope);
    return {
      for_you_now: forYouRows(s, att),
      problems,
      agent_problems: all.filter((p) => !p.acknowledged && handledByAgents(p)),
      acknowledged: all.filter((p) => p.acknowledged),
      resolutions,
      deferred: deferred.rows,
      planning_queue: summarize(
        { db: s.db, windows: s.windows, now: s.now, index: s.index },
        planning,
      ),
      agent_counts: runCounts(s, runs),
      agents_now: agentsNow(s),
      agent_file_proposals: pendingProposalCount(r.db, scope),
      // Decision 31: each onboarding ready for review is one card (and counts as for you).
      onboarding_reviews: readySessions(r.db, scope),
      overlaps: shared.overlaps,
      overlaps_handled: shared.overlaps_handled,
      design_reviews: shared.design_reviews,
      undeclared_holds: shared.undeclared_holds,
      radar_findings: shared.radar_findings,
      project_decisions: reviews.cards,
      project_decision_groups: reviews.groups,
    };
  }

  return {
    bootstrap(r) {
      const sql = r.db.sqlite;
      const config = deps.config;
      // Decision 53: a paused project says so, wherever projects are picked.
      const pauses = projectPauses(r.db);
      const projects = (
        sql
          .prepare(
            `SELECT key, name, short_name, color, default_satisfied_when, version, ${CREATED_BY_SQL('projects')} AS created_by FROM projects WHERE deleted_at IS NULL ORDER BY key`,
          )
          .all() as BootstrapResponse['projects']
      ).map((p) => {
        const paused = pauses.get(p.key);
        return paused ? { ...p, paused } : p;
      });
      const labels = (
        sql
          .prepare(
            `SELECT l.project_key, l.name, l.brief_md, l.brief_by, l.brief_at FROM labels l
             JOIN projects p ON p.key = l.project_key WHERE p.deleted_at IS NULL ORDER BY l.project_key, l.name`,
          )
          .all() as {
          project_key: string;
          name: string;
          brief_md: string;
          brief_by: string | null;
          brief_at: string | null;
        }[]
      ).map((l) => ({
        project: l.project_key,
        name: l.name,
        brief_md: l.brief_md === '' ? null : l.brief_md,
        brief_by: l.brief_by,
        brief_at: l.brief_at,
      }));
      const view = needsYou(r, 'all');
      return {
        server_version: APP_VERSION,
        server_time: r.now,
        projects,
        labels,
        counts: {
          // Cards only; Problems are counted next to it. The badge uses needsYouCount (decision 41).
          for_you: needsYouCount(view) - view.problems.length,
          problems: view.problems.length,
          planning: view.planning_queue.length,
          runs: view.agent_counts,
        },
        settings: {
          live_window_s: Math.round(config.liveWindowMs / 1000),
          stale_after_s: Math.round(config.staleAfterMs / 1000),
          lease_s: Math.round(config.leaseMs / 1000),
          undo_window_s: Math.round(UNDO_WINDOW_MS / 1000),
        },
        health: healthOf(r, deps),
      };
    },

    needsYou(r, input) {
      return needsYou(r, input.scope);
    },

    overview(r, input) {
      return overviewOf(scoped(r, windows(), input.scope), input.window, {
        tz: deps.config.tz,
        lastBackupAt: lastBackupAt(r),
        parkMaxMs: deps.config.parkMaxMs,
      });
    },

    overviewItems(r, input) {
      return overviewItemsOf(
        scoped(r, windows(), input.scope),
        input.metric,
        input.window,
        deps.config,
      );
    },

    brief(r, input) {
      return briefOf(
        scoped(r, windows(), input.scope),
        input,
        deps.config.tz,
        deps.config.parkMaxMs,
      );
    },

    findProblem(r, id): FoundProblem | null {
      const { s, all } = problemSet(r, 'all');
      const problem = all.find((p) => p.id === id);
      if (!problem) return null;
      const project = problem.item_id
        ? (s.items.get(problem.item_id)?.project_key ?? null)
        : problem.kind === 'agent_files_drift' && problem.drift_id
          ? ((
              r.db.sqlite
                .prepare('SELECT project_key FROM drift WHERE id = ?')
                .get(problem.drift_id) as { project_key: string | null } | undefined
            )?.project_key ?? null)
          : null;
      return { problem, project };
    },

    itemProblems(r, id): Problem[] {
      const row = requireItem(r.db, id);
      return itemProblemsOf(problemSet(r, row.project_key).all, row.id);
    },

    work(r, input): WorkResponse {
      const s = scoped(r, windows(), input.scope);
      const att = attention(s);
      const deferred = deferredOf(s);
      const ctx = { db: s.db, windows: s.windows, now: s.now, index: s.index };

      // Board, list and map: tickets, never epics. Canceled items show only under Shows canceled (B43).
      // The onboarding review card's links (decision 31; B30): only what the session created or enriched.
      const onboarded = input.onboarding
        ? onboardingItemIds(r.db, input.onboarding, input.onboarding_change)
        : null;
      const base = [...s.items.values()].filter(
        (i) =>
          i.type !== 'Epic' &&
          (!input.epic || i.epic_id === input.epic) &&
          (!onboarded || onboarded.has(i.id)),
      );
      let summaries = summarize(ctx, base.sort(byPriorityThenId));
      if (input.label) summaries = summaries.filter((i) => i.labels.includes(input.label!));

      const lastActivity = new Map<string, string>();
      if (summaries.length > 0) {
        const ids = summaries.map((i) => i.id);
        for (const e of r.db.sqlite
          .prepare(
            `SELECT item_id, max(at) AS at FROM events WHERE item_id IN ${placeholders(ids.length)} GROUP BY item_id`,
          )
          .all(...ids) as { item_id: string; at: string }[]) {
          lastActivity.set(e.item_id, e.at);
        }
      }
      const parked = leadParkedOf(s.db, summaries, s.now, s.index);
      const partly = finishedPartlyOf(
        s.db,
        summaries.map((i) => i.id),
      );
      const sharedFlags = sharedFlagsOf(r.db);
      const producers = producersByItem(r.db);
      // Decision 57: an open blocker is Queued, Blocked or Held, by the one classification.
      const kinds = waitKindsOf(r.db, s.now, s.index, deps.config);
      // Decision 48: Ready, split into what can start and what waits, and on what.
      const ready = readyStates(
        r.db,
        s.index,
        summaries.filter((i) => i.status === 'ready').map((i) => i.id),
      );
      // Decision 62: the map marks tickets that joined their epic after it started.
      const addedMidflight = new Set(
        [
          ...midflightByEpic(
            r.db,
            [...s.items.values()].filter((i) => i.type === 'Epic').map((i) => i.id),
          ).values(),
        ].flatMap((m) => m.added.map((t) => t.id)),
      );
      const rows: WorkItem[] = summaries.map((i) => {
        const packet_ready = att.packets.has(i.id);
        const flags = sharedFlags.get(i.id);
        const producer = producers.get(i.id);
        const ready_state = ready.get(i.id);
        const wait = kinds.of(i.id);
        return {
          ...i,
          lead_parked: parked(i),
          ...(partly.has(i.id) ? { finished_partly: partly.get(i.id)! } : {}),
          ...(ready_state ? { ready_state } : {}),
          ...(wait ? { wait } : {}),
          ...(producer ? { producer } : {}),
          packet_ready,
          for_you: packet_ready || att.questions.has(i.id),
          last_activity_at: lastActivity.get(i.id) ?? i.updated_at,
          ...(flags ? { shared_flags: flags } : {}),
          ...(addedMidflight.has(i.id) ? { added_midflight: true as const } : {}),
        };
      });

      // B43 (UI_SPEC §6.2): a quick filter, checks that narrow, and shows that add done or
      // canceled items back. Without the new parameters, the old `filter` (default All) maps on.
      const filter =
        workFilterFromParams(input)?.filter ?? LEGACY_WORK_FILTERS[input.filter ?? 'all']!;
      const withProblems = new Set<string>();
      for (const p of problemSet(r, input.scope, s).all) {
        // Decision 62: an acknowledged problem isn't open.
        if (p.acknowledged) continue;
        if (p.item_id) withProblems.add(p.item_id);
        if (p.kind === 'radar_conflict' || p.kind === 'cycle') {
          for (const id of p.related) withProblems.add(id);
        }
      }
      const checks: Record<WorkCheck, (i: WorkItem) => boolean> = {
        for_you: (i) => i.for_you,
        human_review_later: (i) =>
          isOpenStatus(i.status) && !i.packet_ready && i.human_review.declared > 0,
        deferred_review: (i) => deferred.unverified.has(i.id),
        live_run: (i) => i.lead?.run_state === 'live',
        has_problem: (i) => withProblems.has(i.id),
        archived: (i) => i.archived,
        planning: (i) => i.status === 'planning',
        ready_to_start: (i) => i.ready_state?.startable === true,
        // Decision 67.
        inferred_type: (i) => i.type_inferred === true,
        rollout: (i) => i.rollout === true,
      };
      const facts = rows.map((i) => ({
        status: i.status,
        type: i.type,
        wait: i.wait?.kind ?? null,
        archived: i.archived,
        check: (k: WorkCheck) => checks[k](i),
      }));
      const filter_counts = workFilterCounts(filter, facts);
      const items = rows.filter((_, k) => workFilterPasses(filter, facts[k]!));

      // The map: links among the items, plus blockers from outside the view (UI_SPEC §6.3.4).
      const shown = new Set(items.map((i) => i.id));
      const outsideIds = new Set<string>();
      for (const id of shown) {
        for (const l of s.index.blockers.get(id) ?? []) {
          if (!shown.has(l.from_id)) outsideIds.add(l.from_id);
        }
      }
      const outside = summarize(ctx, rowsById(r.db, outsideIds));
      const links = linkEdges(r.db, s.index, shown, 'touching').filter(
        (e) =>
          (shown.has(e.from) && shown.has(e.to)) ||
          (e.type === 'blocks' && shown.has(e.to) && outsideIds.has(e.from)),
      );

      // The Epics row: non-archived epics in scope, with their children's progress.
      const epicRows = [...s.items.values()]
        .filter(
          (i) =>
            i.type === 'Epic' &&
            i.archived_at === null &&
            i.status !== 'canceled' &&
            (!onboarded || onboarded.has(i.id)),
        )
        .sort(byPriorityThenId);
      const children = new Map<string, ItemRow[]>();
      for (const i of s.items.values()) {
        if (i.epic_id && i.status !== 'canceled') {
          children.set(i.epic_id, [...(children.get(i.epic_id) ?? []), i]);
        }
      }
      const waitCounts = (kids: readonly ItemRow[]) => {
        const c = kinds.counts(kids.filter((k) => k.archived_at === null).map((k) => k.id));
        return { queued: c.queued, blocked: c.blocked };
      };
      const waits = epicWaits(
        r.db,
        s.index,
        epicRows.map((e) => e.id),
      );
      // Decision 58: Not ready to start, or Started with N unshaped tickets.
      const unshaped = unshapedByEpic(
        r.db,
        epicRows.map((e) => e.id),
      );
      // Decision 62: tickets added after the epic started, and how many are untriaged.
      const midflight = midflightByEpic(
        r.db,
        epicRows.map((e) => e.id),
      );
      // Decision 67: each open epic's Release, the tickets it waits for and open bugs.
      const releases = epicReleases(
        r.db,
        epicRows.filter((e) => e.status !== 'done' && e.status !== 'canceled').map((e) => e.id),
      );
      const epics: EpicCard[] = summarize(ctx, epicRows).map((e) => {
        const kids = children.get(e.id) ?? [];
        const readiness = readinessOf(e, unshaped.get(e.id));
        const added = midflight.get(e.id);
        const release = releases.get(e.id);
        const by_status: EpicCard['children']['by_status'] = {};
        for (const k of kids) by_status[k.status] = (by_status[k.status] ?? 0) + 1;
        return {
          ...e,
          children: {
            total: kids.length,
            done: kids.filter((k) => k.status === 'done').length,
            by_status,
            for_you: kids.filter((k) => att.packets.has(k.id) || att.questions.has(k.id)).length,
            ...waitCounts(kids),
          },
          ...(waits.has(e.id) ? { waits_on: waits.get(e.id)! } : {}),
          ...(readiness ? { readiness } : {}),
          ...(added ? { midflight: added } : {}),
          ...(release ? { release } : {}),
        };
      });

      return {
        layout: input.layout,
        items,
        epics,
        filter_counts,
        links,
        outside,
        timeline: null,
      };
    },

    itemDetail(r, input): ItemDetailResponse {
      const sql = r.db.sqlite;
      const row = requireItem(r.db, input.id);
      // The same item agents read (view `full`); the owner reading it delivers nothing (§5.7).
      const item = deps.services().items.get(r, { id: row.id, view: 'full' }).item as Item;
      const index = new BlockIndex(r.db);

      const childRows =
        row.type === 'Epic'
          ? (sql.prepare('SELECT * FROM items WHERE epic_id = ?').all(row.id) as ItemRow[]).sort(
              byPriorityThenId,
            )
          : [];
      const childIds = childRows.map((c) => c.id);
      const childPackets = openPackets(r.db, childIds);
      const childQuestions = openQuestions(r.db, childIds);
      const childSummaries = summarize(
        { db: r.db, windows: windows(), now: r.now, index },
        childRows,
      );
      const childParked = leadParkedOf(r.db, childSummaries, r.now, index);
      const kinds = waitKindsOf(r.db, r.now, index, deps.config);
      const children = childSummaries.map((c: ItemSummary) => {
        const wait = kinds.of(c.id);
        return {
          ...c,
          for_you: childPackets.has(c.id) || childQuestions.has(c.id),
          lead_parked: childParked(c),
          ...(wait ? { wait } : {}),
        };
      });
      const itemWait = kinds.of(row.id);

      // Decision records (§6.3.5), every status (the section can show inactive ones):
      // everything that applies (decisions.ts, the one scope rule). Decision 38: the page
      // lists the item's, its epic's (an epic's own) and its labels'; project records are
      // one "also apply" line, so they come too.
      const decisions: DecisionRecord[] = inScopeOf(
        r.db,
        { ...row, labels: item.labels },
        { includeInactive: true },
      );

      // Checklist history: each plan version, with the step changes its event recorded.
      const versions = sql
        .prepare(
          'SELECT version_no, reason, created_by, created_at FROM plan_versions WHERE item_id = ? ORDER BY version_no',
        )
        .all(row.id) as Omit<PlanVersion, 'changes'>[];
      const planEvents = new Map<number, Record<string, unknown>>();
      for (const e of sql
        .prepare("SELECT data FROM events WHERE item_id = ? AND type = 'plan.updated' ORDER BY seq")
        .all(row.id) as { data: string | null }[]) {
        try {
          const data = e.data ? (JSON.parse(e.data) as Record<string, unknown>) : null;
          const v = (data?.plan_version as { new?: number } | undefined)?.new;
          if (data && typeof v === 'number') planEvents.set(v, data);
        } catch {
          // A malformed event carries no step changes.
        }
      }
      const stepText = new Map(
        (
          sql
            .prepare('SELECT id, text, was_text FROM work_steps WHERE item_id = ?')
            .all(row.id) as {
            id: string;
            text: string;
            was_text: string | null;
          }[]
        ).map((st) => [st.id, st]),
      );
      const plan_history: PlanVersion[] = versions.map((v) => {
        const data = planEvents.get(v.version_no);
        const changes: PlanVersion['changes'] = [];
        if (data) {
          for (const id of (data.added as string[] | undefined) ?? []) {
            changes.push({
              step_id: id,
              text: stepText.get(id)?.text ?? '',
              change: 'added',
              was_text: null,
            });
          }
          for (const id of (data.removed as string[] | undefined) ?? []) {
            changes.push({
              step_id: id,
              text: stepText.get(id)?.text ?? '',
              change: 'removed',
              was_text: null,
            });
          }
          for (const [id, c] of Object.entries(
            (data.changed as Record<string, { text?: string; was_text?: string | null }>) ?? {},
          )) {
            if (c.text === undefined) continue;
            changes.push({
              step_id: id,
              text: c.text,
              change: 'changed',
              was_text: c.was_text ?? stepText.get(id)?.was_text ?? null,
            });
          }
        }
        return { ...v, changes };
      });

      const activity: ActivityRow[] = (
        sql
          .prepare(
            `SELECT ${EVENT_COLUMNS}, e.project_key, json_extract(e.data, '$.kept') AS kept FROM ${EVENT_FROM} WHERE e.item_id = ? ORDER BY e.seq DESC LIMIT ?`,
          )
          .all(row.id, ACTIVITY_LIMIT) as (StoredEvent & {
          project_key: string | null;
          kept: string | null;
        })[]
      ).map((e) => ({
        ...eventRow(e),
        type: e.type as EventType,
        actor_kind: e.actor_kind,
        project: e.project_key,
        ...keptDecisions(e.kept),
      }));

      const packet = item.packets.find((p) => p.state === 'open');
      const open_packet = packet
        ? {
            packet_id: packet.packet_id,
            round: packet.round,
            stale: packet.stale,
            criteria_changed: openPackets(r.db, [row.id]).get(row.id)?.criteria_changed ?? false,
            to_verify: item.checklist.human_review.filter((h) => h.state === 'ready').length,
            estimate:
              (
                sql.prepare('SELECT estimate FROM packets WHERE id = ?').get(packet.packet_id) as
                  { estimate: string | null } | undefined
              )?.estimate ?? null,
          }
        : null;

      const fromReviewRaw = (
        sql.prepare('SELECT from_review FROM items WHERE id = ?').get(row.id) as {
          from_review: string | null;
        }
      ).from_review;
      const fr = fromReviewRaw
        ? (JSON.parse(fromReviewRaw) as { item_id?: string; round?: number; hr_item_id?: string })
        : null;
      const from_review =
        fr?.item_id && fr.hr_item_id && typeof fr.round === 'number'
          ? {
              item_id: fr.item_id,
              round: fr.round,
              hr_item_id: fr.hr_item_id,
              text:
                (
                  sql.prepare('SELECT text FROM hr_items WHERE id = ?').get(fr.hr_item_id) as
                    { text: string } | undefined
                )?.text ?? null,
            }
          : null;

      const question = sql
        .prepare(
          'SELECT answered_at, read_by_agent_at, form FROM questions WHERE item_id = ? AND withdrawn_at IS NULL ORDER BY created_at DESC LIMIT 1',
        )
        .get(row.id) as
        | { answered_at: string | null; read_by_agent_at: string | null; form: string | null }
        | undefined;
      const notes = sql
        .prepare(
          'SELECT count(*) AS n FROM owner_notes WHERE item_id = ? AND read_by_agent_at IS NULL',
        )
        .get(row.id) as { n: number };

      const label_briefs = (
        sql
          .prepare(
            `SELECT name, brief_md FROM labels WHERE project_key = ? AND brief_md <> ''
             AND name IN (SELECT value FROM json_each(?)) ORDER BY name`,
          )
          .all(row.project_key, JSON.stringify(item.labels)) as { name: string; brief_md: string }[]
      ).map((l) => ({ name: l.name, brief_md: l.brief_md }));

      // Links touching the item (or the epic's children), and every link of a cycle they are in;
      // `outside` holds the cards for the other ends (1-hop nodes, "Outside this epic").
      const own = new Set([row.id, ...childIds]);
      const links = mergeEdges(linkEdges(r.db, index, own, 'touching'), cycleEdges(index, own));
      const outside = summarize(
        { db: r.db, windows: windows(), now: r.now, index },
        rowsById(
          r.db,
          links.flatMap((e) => [e.from, e.to]).filter((id) => !own.has(id)),
        ),
      );

      const epicWait =
        row.type === 'Epic' ? epicWaits(r.db, index, [row.id]).get(row.id) : undefined;
      const epicReady = epicReadiness(r.db, row);
      const epicAdded = epicMidflight(r.db, row);
      // Decision 67: an epic's Release and what holds it, or what holds a Release.
      const release = row.type === 'Epic' ? releaseDetails(r.db, [row.id]).get(row.id) : undefined;
      const releaseHold = releaseHoldOf(r.db, row);
      return {
        item,
        children,
        decisions,
        plan_history,
        activity,
        open_packet,
        from_review,
        answer_unread: !!question?.answered_at && question.read_by_agent_at === null,
        question_form: question && !question.answered_at ? parseQuestionForm(question.form) : null,
        notes_unread: notes.n,
        label_briefs,
        links,
        outside,
        run_instructions: runInstructions(r.db, row.id),
        // Decision 37: the item's open problems for its banner, and proposals about the item.
        problems: itemProblemsOf(problemSet(r, row.project_key).all, row.id),
        resolutions: openResolutions(r.db, new Set([row.id])).filter((x) => x.problem_id === null),
        // Decision 45: what its parked lead waits for, and the parked runs it would free.
        ...waitOf(r, row.id, index),
        ...(epicWait ? { epic_waits: epicWait } : {}),
        ...(itemWait ? { item_wait: itemWait } : {}),
        ...(epicReady ? { epic_readiness: epicReady } : {}),
        ...(epicAdded ? { epic_midflight: epicAdded } : {}),
        ...(release ? { release } : {}),
        ...(releaseHold ? { release_hold: releaseHold } : {}),
      };
    },

    agents(r, input): AgentsResponse {
      const sql = r.db.sqlite;
      const s = scoped(r, windows(), input.scope);
      const w = s.windows;
      const runs = (
        sql
          .prepare(
            `SELECT * FROM runs WHERE state IN ${OPEN_STORED_SQL}
             UNION ALL
             SELECT * FROM (SELECT * FROM runs WHERE state NOT IN ${OPEN_STORED_SQL} ORDER BY updated_at DESC, id LIMIT ?)`,
          )
          .all(AGENTS_ENDED_LIMIT * 4) as RunRow[]
      ).filter((x) => s.items.has(x.item_id));
      const logs = (
        sql
          .prepare(
            `SELECT l.id, l.item_id, l.name, l.outcome, l.provenance, l.child_run_id, l.created_at
             FROM subagent_logs l ORDER BY l.created_at DESC, l.id LIMIT ?`,
          )
          .all(AGENTS_ENDED_LIMIT * 4) as {
          id: string;
          item_id: string;
          name: string;
          outcome: string;
          provenance: 'observed' | 'relayed';
          child_run_id: string | null;
          created_at: string;
        }[]
      ).filter((l) => s.items.has(l.item_id));

      // Current step text and position, for "work item 2 of 4: …": the step the run named in
      // a heartbeat, else the lead's plan step marked current (update_step).
      type StepInfo = {
        id: string;
        item_id: string;
        text: string;
        position: number;
        total: number;
      };
      const stepIds = runs.map((x) => x.current_step_id).filter((x): x is string => !!x);
      const leadItems = runs
        .filter((x) => x.is_lead === 1 && isRunOpen(x.state))
        .map((x) => x.item_id);
      const steps = new Map<string, StepInfo>();
      const currentByItem = new Map<string, StepInfo>();
      if (stepIds.length + leadItems.length > 0) {
        for (const st of sql
          .prepare(
            `SELECT ws.id, ws.item_id, ws.text, ws.position, ws.state,
                    (SELECT count(*) FROM work_steps o WHERE o.item_id = ws.item_id AND o.plan_version_no = ws.plan_version_no) AS total
             FROM work_steps ws
             WHERE ws.id IN ${placeholders(stepIds.length)}
                OR (ws.state = 'current' AND ws.item_id IN ${placeholders(leadItems.length)}
                    AND ws.plan_version_no = (SELECT max(version_no) FROM plan_versions pv WHERE pv.item_id = ws.item_id))
             ORDER BY ws.position`,
          )
          .all(...stepIds, ...leadItems) as (StepInfo & { state: string })[]) {
          steps.set(st.id, st);
          if (st.state === 'current' && !currentByItem.has(st.item_id))
            currentByItem.set(st.item_id, st);
        }
      }

      const ORDER: Partial<Record<RunState, number>> = {
        needs_input: 0,
        stale: 1,
        failed: 2,
        live: 3,
        reported: 4,
        parked: 5,
      };
      const ranked: { row: AgentRow; rank: number }[] = [];
      for (const x of runs) {
        const state = displayRunState(x, w, s.now);
        const open = isRunOpen(x.state);
        const step =
          (x.current_step_id ? steps.get(x.current_step_id) : undefined) ??
          (x.is_lead === 1 && isRunOpen(x.state) ? currentByItem.get(x.item_id) : undefined);
        const stepLine = step
          ? `work item ${step.position + 1} of ${step.total}: ${step.text}`
          : null;
        const role = x.is_lead === 1 ? 'Lead' : 'Child run';
        let doing: string | null;
        if (state === 'needs_input') doing = 'Waiting on your answer';
        else if (state === 'failed') doing = x.error ?? x.summary;
        else if (state === 'stale') doing = x.summary ? `Last said: “${x.summary}”` : stepLine;
        else if (state === 'parked') {
          // Decision 61: a park that finished partly says so first.
          const exit = storedExit(x);
          const partly = exit?.outcome === 'partial' ? finishedPartlyText(exit.left.length) : null;
          doing = [partly, x.parked_reason ? `Parked · ${x.parked_reason}` : 'Parked']
            .filter(Boolean)
            .join(' · ');
        } else if (open) doing = [role, x.summary ?? stepLine].filter(Boolean).join(' · ');
        else doing = [role, x.summary].filter(Boolean).join(' · ');
        const provenance: AgentRow['provenance'] =
          x.parent_run_id !== null
            ? x.last_signal_kind === 'relayed'
              ? 'relayed'
              : 'observed'
            : x.last_signal_kind === 'report'
              ? 'agent'
              : x.last_signal_kind === 'relayed'
                ? 'relayed'
                : null;
        const lease: AgentRow['lease'] =
          x.is_lead !== 1
            ? 'none'
            : x.state === 'parked' || x.state === 'needs_input'
              ? 'paused'
              : !open
                ? 'released'
                : state === 'stale' ||
                    (x.lease_expires_at !== null && ms(x.lease_expires_at) <= ms(s.now))
                  ? 'expired'
                  : 'held';
        ranked.push({
          rank: ORDER[state] ?? 9,
          row: {
            row_kind: 'run',
            run_id: x.id,
            run_state: state,
            client: x.client,
            label: x.label,
            item_id: x.item_id,
            item_title: s.items.get(x.item_id)!.title,
            project: s.items.get(x.item_id)!.project_key,
            doing,
            last_signal_at: x.last_signal_at,
            last_signal_kind: x.last_signal_kind,
            lease_expires_at: x.lease_expires_at,
            lease,
            provenance,
            lead_parked: x.state === 'parked' ? parkedOf(r.db, x, s.now, s.index) : null,
            ...(x.producer ? { producer: x.producer } : {}),
            ...(open && storedActivity(x)?.flag ? { activity: storedActivity(x)!.flag! } : {}),
            ...(open && storedStatusUpdate(x) ? { updated_by: storedStatusUpdate(x)!.by } : {}),
            ...(open && coordinatorParkOf(x) ? { coordinator_park: coordinatorParkOf(x)! } : {}),
            at: open ? x.last_signal_at : x.updated_at,
          },
        });
      }
      for (const l of logs) {
        ranked.push({
          rank: 9,
          row: {
            row_kind: 'subagent_log',
            run_id: l.child_run_id,
            run_state: null,
            client: l.name,
            label: null,
            item_id: l.item_id,
            item_title: s.items.get(l.item_id)!.title,
            project: s.items.get(l.item_id)!.project_key,
            doing: `Subagent log · ${l.outcome}`,
            last_signal_at: null,
            last_signal_kind: null,
            lease_expires_at: null,
            lease: 'none',
            provenance: l.provenance,
            at: l.created_at,
          },
        });
      }
      ranked.sort((a, b) => a.rank - b.rank || b.row.at.localeCompare(a.row.at));
      // Every open run, then the newest ended runs and log entries.
      const active = ranked.filter((x) => x.rank < 9);
      const ended = ranked.filter((x) => !active.includes(x)).slice(0, AGENTS_ENDED_LIMIT);
      return { rows: [...active, ...ended].map((x) => x.row) };
    },

    /**
     * The label page (UI_SPEC §6.5; US7): the label and its brief, counts,
     * its items grouped by epic, and the label's decision records. Archived
     * items stay (it's a progress view); canceled ones don't.
     */
    labelPage(r, input) {
      const sql = r.db.sqlite;
      const label = sql
        .prepare(
          `SELECT l.id, l.project_key, l.name, l.brief_md, l.brief_by, l.brief_at
           FROM labels l JOIN projects p ON p.key = l.project_key
           WHERE l.project_key = ? AND l.name = ? AND p.deleted_at IS NULL`,
        )
        .get(input.project, input.name) as
        | {
            id: string;
            project_key: string;
            name: string;
            brief_md: string | null;
            brief_by: string | null;
            brief_at: string | null;
          }
        | undefined;
      if (!label) {
        throw new ToolError(
          'not_found',
          `No label #${input.name} in ${input.project}. Check the name in search.`,
        );
      }
      const rows = (
        sql
          .prepare(
            `SELECT i.* FROM items i JOIN item_labels il ON il.item_id = i.id
             WHERE il.label_id = ? AND i.status != 'canceled'`,
          )
          .all(label.id) as ItemRow[]
      ).sort((a, b) => compareIds(a.id, b.id));
      const summaries = summarize(
        { db: r.db, windows: windows(), now: r.now, index: new BlockIndex(r.db) },
        rows,
      );
      const epicIds = [...new Set(rows.map((i) => i.epic_id ?? (i.type === 'Epic' ? i.id : null)))];
      const epicTitles = new Map(
        rowsById(
          r.db,
          epicIds.filter((x): x is string => x !== null),
        ).map((e) => [e.id, e.title]),
      );
      const groups = new Map<string | null, ItemSummary[]>();
      summaries.forEach((s, i) => {
        const row = rows[i]!;
        const key = row.epic_id ?? (row.type === 'Epic' ? row.id : null);
        groups.set(key, [...(groups.get(key) ?? []), s]);
      });
      const keys = [...groups.keys()].sort((a, b) =>
        a === null ? 1 : b === null ? -1 : compareIds(a, b),
      );
      return {
        label: {
          project: label.project_key,
          name: label.name,
          brief_md: label.brief_md || null,
          brief_by: label.brief_md ? label.brief_by : null,
          brief_at: label.brief_md ? label.brief_at : null,
        },
        counts: {
          total: rows.length,
          done: rows.filter((i) => i.status === 'done').length,
          planning: rows.filter((i) => i.status === 'planning' && i.archived_at === null).length,
        },
        by_epic: keys.map((key) => {
          const items = groups.get(key)!;
          return {
            epic: key ? { id: key, title: epicTitles.get(key) ?? key } : null,
            done: items.filter((i) => i.status === 'done').length,
            total: items.length,
            items,
          };
        }),
        decisions: ofScope(
          r.db,
          label.project_key,
          { kind: 'label', id: label.name },
          {
            includeInactive: true,
          },
        ),
      };
    },
    settings(r): SettingsResponse {
      const sql = r.db.sqlite;
      const config = deps.config;
      const s = scoped(r, windows(), 'all');
      const att = attention(s);
      const pauses = projectPauses(r.db);
      const projects = (
        sql
          .prepare(
            `SELECT key, name, short_name, color, default_satisfied_when, version, ${CREATED_BY_SQL('projects')} AS created_by FROM projects WHERE deleted_at IS NULL ORDER BY key`,
          )
          .all() as SettingsResponse['projects'][number][]
      ).map((p) => {
        const rows = [...s.items.values()].filter((i) => i.project_key === p.key);
        const work = rows.filter((i) => i.type !== 'Epic');
        const count = (st: Status) => work.filter((i) => i.status === st).length;
        const n = (q: string) => (sql.prepare(q).get(p.key) as { n: number }).n;
        return {
          key: p.key,
          name: p.name,
          short_name: p.short_name,
          color: p.color,
          default_satisfied_when: p.default_satisfied_when,
          version: p.version,
          created_by: p.created_by ?? null,
          ...(pauses.has(p.key) ? { paused: pauses.get(p.key)! } : {}),
          counts: {
            epics: rows.filter((i) => i.type === 'Epic').length,
            items: rows.length,
            documents: n('SELECT count(*) AS n FROM documents WHERE project_key = ?'),
            for_you: rows.filter((i) => att.packets.has(i.id) || att.questions.has(i.id)).length,
            done: count('done'),
            active: count('progress'),
            review: count('review'),
            planning: count('planning'),
            // "n decisions" opens the project-wide Decisions section (UI_SPEC §6.7, §6.3.5).
            decisions: n(
              "SELECT count(*) AS n FROM decision_records WHERE project_key = ? AND scope_kind = 'project' AND status = 'active'",
            ),
          },
          labels: (
            sql
              .prepare('SELECT name FROM labels WHERE project_key = ? ORDER BY name')
              .all(p.key) as {
              name: string;
            }[]
          ).map((l) => l.name),
        };
      });

      // The supported surfaces (compat.ts), each with when it was last seen on a run;
      // then any other client that has connected. None is verified until the smoke test is
      // recorded (T146).
      const seen = sql
        .prepare(
          `SELECT client, label LIKE 'orca%' AS orca, max(last_signal_at) AS last_seen_at
           FROM runs GROUP BY client, label LIKE 'orca%'`,
        )
        .all() as { client: string; orca: number; last_seen_at: string | null }[];
      const lastSeen = (client: string, orca: boolean) =>
        seen.find((x) => x.client === client && Boolean(x.orca) === orca)?.last_seen_at ?? null;
      const clients: SettingsResponse['connections']['clients'] = COMPAT_SURFACES.map((c) => ({
        client: c.name,
        transport: c.transport,
        last_seen_at: c.client ? lastSeen(c.client, c.orca) : null,
        status: c.verified ? 'verified' : c.offByDefault ? 'not_configured' : 'not_verified',
        result_mode: resultMode(c.clientInfoName, deps.config.textOnlyClients),
        notes: c.verified ? `Smoke test passed ${c.verified.on} · ${c.verified.notes}` : c.notes,
      }));
      const known = new Set(COMPAT_SURFACES.map((c) => c.client));
      for (const client of [...new Set(seen.map((x) => x.client))].sort()) {
        if (known.has(client)) continue;
        clients.push({
          client,
          transport: 'Streamable HTTP',
          last_seen_at: seen
            .filter((x) => x.client === client)
            .map((x) => x.last_seen_at)
            .reduce<string | null>((a, b) => (a && (!b || a > b) ? a : b), null),
          status: 'not_verified',
          // Another client's normalised name is its own `clientInfo.name` (BUILD_SPEC §3).
          result_mode: resultMode(client, deps.config.textOnlyClients),
          notes: 'Not a supported client; not smoke-tested.',
        });
      }

      const health = healthOf(r, deps).checks;
      let volumeFree: number | null = null;
      try {
        const fs = statfsSync(config.dataDir);
        volumeFree = fs.bavail * fs.bsize;
      } catch {
        volumeFree = null;
      }
      let backups: SettingsResponse['health']['backups'] = [];
      try {
        backups = deps.services().backup.status(r);
      } catch (err) {
        if (!isNotImplemented(err)) throw err;
      }
      // The process start: the last time the service (re)started.
      const restartedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
      // Decision 41: how many open runs the last restart kept, from its one event.
      const restartEvent = sql
        .prepare(
          "SELECT json_extract(data, '$.runs_kept') AS n FROM events WHERE type = 'service.restarted' AND at >= ? ORDER BY seq DESC LIMIT 1",
        )
        .get(new Date(ms(restartedAt) - 60_000).toISOString()) as { n: number } | undefined;
      const host = config.allowedHosts[0]!;
      return {
        projects,
        connections: {
          clients,
          // Decision 32: local trust (no unlock, no agent token) unless DOCKET_PROTECTED_MODE is on.
          protected_mode: config.protectedMode,
          endpoint: {
            mcp_url: `http://${host}/mcp`,
            web_url: `http://${host}/`,
            bind: 'loopback',
            auth: config.protectedMode ? 'bearer' : 'none',
            origins: allowedOriginsFor(config.allowedHosts),
          },
        },
        health: {
          database: {
            state: health.database ?? 'error',
            // With WAL, recent writes live in the -wal file until a checkpoint.
            bytes: sumBytes([fileBytes(config.paths.db), fileBytes(`${config.paths.db}-wal`)]),
          },
          documents: { state: health.docs_dir ?? 'error', bytes: dirBytes(config.paths.docs) },
          volume_free_bytes: volumeFree,
          volume: { name: config.dataVolume, legacy_db_file: config.legacyDbFile },
          backups,
          extra_backup_configured: config.backupExtraDir !== null,
          restarted_at: restartedAt,
          runs_kept_at_restart: restartEvent?.n ?? 0,
        },
      };
    },
  };
}
