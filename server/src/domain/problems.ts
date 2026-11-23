/**
 * Problems that say what to do (owner decision 37; BUILD_SPEC §5.22
 * Problems, §5.21 B42; FR-165–FR-172; tasks.md T186–T189).
 *
 * **Explanations.** Every problem says three things in plain words: what's
 * wrong, what fixes it, and who acts (`ProblemExplanation`). The text is
 * written here, once, so the owner's Problems, the item's banner, the
 * agent's `get_context` and the radar's note use the same wording.
 *
 * **Who acts.** Radar findings are agent problems: the leads of the items
 * involved fix them (a rebase, or removing an old branch from the item's
 * branches). They reach the owner's Problems only when nobody leads any of
 * the items, or when they're still open after `DOCKET_AGENT_PROBLEM_GRACE_HOURS`
 * (default 24) from when the radar first found them; until then Needs you
 * lists them under "Agents are handling N problems". Decision 41 adds
 * `parked_too_long` and `unpushed_work`: they go to the item's lead or the
 * run's coordinator first, and reach the owner when neither exists, when the
 * work is canceled or deferred (only the owner can say what happens to it), or
 * after the same grace period, each saying why. Every other kind is the
 * owner's (or the coordinator's, for recovery), and shows at once.
 *
 * **Acknowledging.** The owner acknowledges a problem (`problem_acks`,
 * undoable), and any decision on its proposed resolution counts as one. An
 * acknowledged problem leaves Needs you, and the item's banner says
 * "Acknowledged by you <when>". It comes back when it needs a human step
 * again: a proposed resolution arrives after the acknowledgement, or it
 * materially changes (another kind, a branch or a fact, such as a
 * conflicting file, that the acknowledgement didn't cover).
 *
 * **Proposed resolutions.** An agent proposes how to resolve a problem
 * (`propose_resolution`: split, rescope, reorder or other, a plan in Markdown
 * and a reason). The owner approves it, asks for a different way (with a
 * note) or acknowledges it; each choice is posted to the item as an owner
 * note (the item's lead and the proposer read it there and in
 * `get_context`). A different way keeps the problem open, and the agent may
 * propose again. A newer proposal for the same problem supersedes an open
 * one. Routine fixes need no proposal.
 */
import {
  LIMITS,
  RESOLUTION_KINDS,
  ToolError,
  type OverlapOutcome,
  type OverlapReason,
  type Problem,
  type ProblemAck,
  type ProblemExplanation,
  type RadarFindingRow,
  type ResolutionRow,
} from '@docket/shared';
import type { Db } from '../db/client.js';
import type { ReadContext, ServiceDeps } from './contracts.js';
import { newId } from './ids.js';
import { callerName, leaseExpired, ms, requireItem, type RunRow } from './model.js';
import { OVERLAP_REASON_TEXT } from './overlap-policy.js';
import type { WriteContext } from './write.js';

// ---- Words ----

const fileWord = (n: number) => (n === 1 ? 'file' : 'files');

/** "a.ts, b.ts and c.ts". */
export function listText(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`;
}

/** "1 file conflicts (a.ts)", "3 files conflict (a, b and c)", "53 files conflict, including a, b and c". */
export function conflictText(files: readonly string[]): string {
  const n = files.length;
  const verb = n === 1 ? 'conflicts' : 'conflict';
  if (n === 0) return 'they conflict';
  if (n <= 3) return `${n} ${fileWord(n)} ${verb} (${listText(files)})`;
  return `${n} ${fileWord(n)} ${verb}, including ${listText(files.slice(0, 3))}`;
}

/** The grace period in words: "a day", "2 days", "an hour", "6 hours". */
export function graceText(graceMs: number): string {
  const hours = Math.round(graceMs / 3_600_000);
  if (hours > 0 && hours % 24 === 0) return hours === 24 ? 'a day' : `${hours / 24} days`;
  if (hours === 1) return 'an hour';
  return `${hours} hours`;
}

const you = (why: string) => ({ who: 'owner' as const, who_text: `You (${why})` });
const YOU_DECIDE = you('a decision');
const RECOVERY = {
  who: 'owner' as const,
  who_text: 'You, or your coordinator (agents can’t restart themselves)',
};

/** "An agent (the lead of GF-228)", "An agent (the leads of GF-217 and GF-235)", "An agent (GF-228 has no lead yet)". */
export function agentWho(items: readonly string[], leading: ReadonlySet<string>) {
  const led = items.filter((id) => leading.has(id));
  let text: string;
  if (led.length === 0) {
    text =
      items.length === 1 ? `${items[0]} has no lead yet` : `${listText(items)} have no lead yet`;
  } else if (led.length === 1) {
    text = `the lead of ${led[0]}`;
  } else {
    text = `the leads of ${listText(led)}`;
  }
  return { who: 'agent' as const, who_text: `An agent (${text})` };
}

/** Who a recovery problem goes to first (decision 41), and why it reached the owner, if it did. */
export interface RecoveryRoute {
  who: 'agent' | 'owner';
  who_text: string;
  reached: string | null;
}

/**
 * Route a recovery problem: to the item's live lead, else the run's
 * coordinator; to the owner at once when there's neither, or once it has been
 * open for the grace period (it stays the agent's, and *Remind the agent* works).
 */
export function recoveryRoute(f: {
  item: string;
  lead: boolean;
  coordinator: string | null;
  since: string;
  now: string;
  graceMs: number;
}): RecoveryRoute {
  if (!f.lead && !f.coordinator) {
    return {
      who: 'owner',
      who_text: 'You (no coordinator or lead is on it)',
      reached: `No coordinator or lead is on ${f.item}`,
    };
  }
  return {
    who: 'agent',
    who_text: f.lead ? `An agent (the lead of ${f.item})` : `Your coordinator (${f.coordinator})`,
    reached:
      ms(f.now) - ms(f.since) >= f.graceMs
        ? `Not handled by an agent for ${graceText(f.graceMs)}`
        : null,
  };
}

// ---- Explanations, one per kind ----

export const explain = {
  stale_run(f: {
    item: string;
    silent: string;
    lease: string;
    /** Decision 41: silent only because Docket restarted; it can still continue. */
    restarted?: boolean;
    /** Decision 44: the coordinator whose time-limited park just ran out. */
    parkEndedBy?: string | undefined;
  }): ProblemExplanation {
    if (f.parkEndedBy) {
      return {
        what: `${f.parkEndedBy}'s park on ${f.item} ran out, and its lead hasn't called since (silent for ${f.silent}). It keeps its claim, and ${f.lease}.`,
        fix: 'Nothing yet. Its next call continues the same run. To give it longer, park it again with update_run_status; if it never returns, the lease ends it.',
        who: 'agent',
        who_text: `Its coordinator (${f.parkEndedBy})`,
      };
    }
    if (f.restarted) {
      return {
        what: `Docket restarted, and ${f.item}'s lead hasn't called since (silent for ${f.silent}). It keeps its claim, and ${f.lease}.`,
        fix: 'Nothing yet. Its next call continues the same run. If it never returns, the lease ends the run and the item goes back to Ready.',
        who: 'agent',
        who_text: `An agent (the lead of ${f.item})`,
      };
    }
    return {
      what: `${f.item}'s lead agent has been silent for ${f.silent} and ${f.lease}. Docket treats the run as unknown, not finished.`,
      fix: `Check whether the agent is still running. If it stopped, release its claim (Activity → Lead and runs) so another agent can pick ${f.item} up.`,
      ...RECOVERY,
    };
  },

  failed_run(f: { item: string; error: string | null }): ProblemExplanation {
    return {
      what: `${f.item}'s lead run failed${f.error ? `: ${f.error}` : '.'} Nothing retries it on its own.`,
      fix: `Read the error in Activity, then start an agent on ${f.item} again, or move it back to Ready for any agent to claim.`,
      ...RECOVERY,
    };
  },

  cycle(f: { path: string; members: string[]; imported: boolean }): ProblemExplanation {
    return {
      what: `${listText(f.members)} wait on each other in a loop${f.imported ? ' (from the import)' : ''}: ${f.path}. None of them can start.`,
      fix: 'Remove one link in the Dependencies tab: the one that is wrong, or the one that matters least.',
      ...YOU_DECIDE,
    };
  },

  date_risk(f: {
    item: string;
    start: string;
    blocker: string;
    blockerEnd: string;
  }): ProblemExplanation {
    return {
      what: `${f.item} is planned to start on ${f.start}, before its blocker ${f.blocker} is planned to finish (${f.blockerEnd}).`,
      fix: `Ask the lead to move ${f.item}'s planned start after ${f.blockerEnd}, or bring ${f.blocker}'s finish forward. Agents set the dates.`,
      ...YOU_DECIDE,
    };
  },

  canceled_blocker(f: { item: string; blocker: string }): ProblemExplanation {
    return {
      what: `${f.item} is blocked by ${f.blocker}, which was canceled. A canceled blocker never clears on its own.`,
      fix: `Remove the link in the Dependencies tab, or reopen ${f.blocker} if it's still needed.`,
      ...YOU_DECIDE,
    };
  },

  deferred_verified_blocker(f: {
    item: string;
    blocker: string;
    deferred: number;
  }): ProblemExplanation {
    const checks = f.deferred === 1 ? '1 of its checks was' : `${f.deferred} of its checks were`;
    return {
      what: `${f.item} waits for ${f.blocker} to be verified, but ${checks} deferred, so ${f.blocker} never counts as verified.`,
      fix: `Finish the deferred ${f.deferred === 1 ? 'check' : 'checks'} (the test ticket), or change the link to wait for Done instead.`,
      ...YOU_DECIDE,
    };
  },

  orphaned_resources(f: {
    item: string;
    what: string;
    after: string;
    n: number;
  }): ProblemExplanation {
    const it = f.n === 1 ? 'it' : 'them';
    return {
      what: `${f.what} ${f.n === 1 ? 'is' : 'are'} still running ${f.after} after ${f.item}'s run ended.`,
      fix: `Stop ${it}, then mark ${it} released.`,
      ...RECOVERY,
    };
  },

  /**
   * Work an ended run left in its worktree (decision 41): commits and
   * uncommitted changes separately, never a commit that's already on main, and
   * "unverified" when git couldn't confirm it. Canceled or deferred work is
   * never something to push: the owner keeps it or lets it go.
   */
  unpushed_work(f: {
    item: string;
    facts: string[];
    path: string | null;
    ended: string;
    onMain: boolean;
    unverified: boolean;
    /** Set when nobody will pick the work up: why, in the item's words. */
    closed: string | null;
    route: RecoveryRoute;
  }): ProblemExplanation {
    const where = f.path ? `, in ${f.path}` : '';
    const unverified = f.unverified
      ? " Docket can't confirm this from the repository, so it's the last reported state (unverified)."
      : '';
    const who = { who: f.route.who, who_text: f.route.who_text };
    if (f.closed) {
      return {
        what: `${f.item} ${f.closed}. Its worktree still has ${listText(f.facts)}${where}.${unverified}`,
        fix: 'Keep them for later, or mark them safe to discard. Docket never deletes a worktree or files itself.',
        ...who,
      };
    }
    return {
      what: `${f.item}'s run ended (${f.ended}).${f.onMain ? ' Its commits are already on main.' : ''} Still in its worktree: ${listText(f.facts)}${where}.${unverified}`,
      fix:
        f.route.who === 'agent'
          ? "Commit and push it from that worktree, or say it can go. Don't prune the worktree until then."
          : 'Ask an agent to commit and push it, or choose Keep for later or Safe to discard. Neither button commits, pushes or deletes anything.',
      ...who,
    };
  },

  parked_too_long(f: {
    item: string;
    since: string;
    waiting: string;
    route: RecoveryRoute;
  }): ProblemExplanation {
    return {
      what: `${f.item}'s lead has been parked since ${f.since}, waiting on ${f.waiting}. It keeps its claim.`,
      fix: `Check that it's still waiting for something real. Resume it, or release its claim so another agent can take ${f.item}.`,
      who: f.route.who,
      who_text: f.route.who_text,
    };
  },

  resume_unattended(f: { item: string; why: string; parked: string }): ProblemExplanation {
    return {
      what: `${f.item} is ready to resume (${f.why}), but nobody has resumed it. It has been parked ${f.parked}.`,
      fix: `Ask your coordinator to resume the parked run, or start an agent on ${f.item}.`,
      ...RECOVERY,
    };
  },

  /** Decision 45: nobody has the next step on what a parked run waits for. */
  wait_no_next_step(f: {
    item: string;
    on: string;
    waited: string;
    step: string;
    route: RecoveryRoute;
  }): ProblemExplanation {
    return {
      what: `${f.item} has waited ${f.waited} on ${f.on}, and nobody has the next step: no live lead, no open question or review, and no recent activity.`,
      fix: `${f.step}. This is advisory: nothing is held by it.`,
      who: f.route.who,
      who_text: f.route.who_text,
    };
  },

  /** Decision 45: a wait on an owner decision that nobody has actually asked for. */
  wait_owner_unasked(f: { item: string; on: string; route: RecoveryRoute }): ProblemExplanation {
    return {
      what: `${f.item} is waiting on an owner decision about ${f.on}, but nobody has asked: there is no question, proposal or review for the owner.`,
      fix:
        f.route.who === 'agent'
          ? `Ask it with ask_owner on ${f.on}. The owner can't answer a question that doesn't exist.`
          : `No agent is there to ask. Record your decision on ${f.on}, or start a coordinator to ask it.`,
      who: f.route.who,
      who_text: f.route.who_text,
    };
  },

  extra_backup_failed(f: { error: string }): ProblemExplanation {
    return {
      what: `The extra backup copy failed: ${f.error}`,
      fix: 'Check the extra backup folder in Settings: it must be mounted and writable. The next nightly backup tries again.',
      ...you('a setting'),
    };
  },

  /** Decision 41: the nightly backup failed or is overdue. It clears on the next success. */
  backup_missed(f: {
    state: 'failed' | 'overdue';
    error: string | null;
    due: string;
    last: string | null;
  }): ProblemExplanation {
    const newest = f.last
      ? `Your newest good backup is from ${f.last}.`
      : 'There is no good backup yet.';
    return {
      what:
        f.state === 'failed'
          ? `The last backup failed: ${f.error ?? 'unknown error'}. ${newest}`
          : `The backup due at ${f.due} hasn't run, and Docket hasn't been able to catch up. ${newest}`,
      fix: 'Check free space on the data volume in Settings, then take one now: docker compose exec docket docket backup now. This clears on the next good backup.',
      ...you('your backups'),
    };
  },

  agent_files_drift(f: { change: string; project: string; where: string }): ProblemExplanation {
    return {
      what: `${f.change} outside Docket (${f.project}, ${f.where}), so agents follow instructions you haven't reviewed.`,
      fix: "Review it in Agent files: adopt it as the project's copy, restore Docket's version, or keep it local.",
      ...YOU_DECIDE,
    };
  },

  /**
   * An overlap (decision 39): an owner question says why it needs the owner
   * and what Docket recommends; an automatic outcome says what Docket did.
   */
  overlap(f: {
    first: string;
    other: string;
    parts: string;
    outcome?: OverlapOutcome | null;
    reason?: OverlapReason | null;
    /** An automatic sequence still unresolved after the grace period. */
    reached?: boolean;
  }): ProblemExplanation {
    const inOrder = `${f.other} waits until ${f.first} is merged`;
    if (f.outcome === 'sequence' && f.reached) {
      return {
        what: `Docket ran ${f.first} and ${f.other} in order on ${f.parts} (${OVERLAP_REASON_TEXT[f.reason ?? 'unclear']}), and it still isn't settled. ${inOrder}.`,
        fix: `Docket recommends keeping this order and checking on ${f.first}. Run them in parallel if ${f.other} shouldn't wait.`,
        ...YOU_DECIDE,
      };
    }
    if (f.outcome === 'parallel') {
      return {
        what: `${f.first} and ${f.other} both touch ${f.parts}, and Docket is running them in parallel: ${OVERLAP_REASON_TEXT[f.reason ?? 'file_only']}.`,
        fix: 'Nothing to do. The radar still checks their real commits. Overrule it from the ticket if you know better.',
        who: 'agent',
        who_text: 'Docket (automatic)',
      };
    }
    if (f.outcome === 'sequence') {
      return {
        what: `${f.first} and ${f.other} both change ${f.parts}, so Docket runs them in order: ${OVERLAP_REASON_TEXT[f.reason ?? 'unclear']}. ${inOrder}.`,
        fix: 'Nothing to do; the waiting agent took other work. Overrule it from the ticket if they can run together.',
        who: 'agent',
        who_text: 'Docket (automatic)',
      };
    }
    if (f.reason === 'blocker_cycle') {
      return {
        what: `${f.first} and ${f.other} both change ${f.parts}, and running them in order would create a dependency cycle.`,
        fix: 'Docket recommends removing the link that matters least in the Dependencies tab, then running them in order. Mark them compatible if their changes don’t collide.',
        ...YOU_DECIDE,
      };
    }
    if (f.reason === 'disputed') {
      return {
        what: `${f.first} and ${f.other} both change ${f.parts}, and the agents disagree about who owns it.`,
        fix: `Docket recommends running them one after the other (${inOrder}), with the owner of the part going first.`,
        ...YOU_DECIDE,
      };
    }
    return {
      what: `${f.first} and ${f.other} both change ${f.parts}. An agent tried to start ${f.other} while ${f.first} is in flight, so it picked other work.`,
      fix: `Run them one after the other (${f.other} waits until ${f.first} is merged), or mark them compatible if their changes don't collide.`,
      ...YOU_DECIDE,
    };
  },

  /** Decision 39: a declared change to an approved design, which pauses that item only. */
  design_review(f: { item: string; notes: string }): ProblemExplanation {
    return {
      what: `${f.item} changes an approved design: ${f.notes}. Its work is paused until you decide; everything else continues.`,
      fix: 'Approve the design change so the agent can go on, or send it back and say what to do instead.',
      ...YOU_DECIDE,
    };
  },

  undeclared_hold(f: { item: string; parts: string; packet: boolean }): ProblemExplanation {
    return {
      what: `${f.item} changed shared parts it didn't declare: ${f.parts}. ${f.packet ? 'Its packet waits until you decide.' : 'It tried to close, and stays open until you decide.'}`,
      fix: 'Add the parts to its declaration if the change is fine, or send it back with a note.',
      ...YOU_DECIDE,
    };
  },

  /**
   * A radar finding: a branch out of date with the main branch, or two items'
   * branches that change the same lines (owner decision 37: one root cause,
   * one problem; pairs explained by either branch's conflict with main are
   * left out by the radar).
   */
  radar(f: RadarFindingRow, leading: ReadonlySet<string>): ProblemExplanation {
    const a = f.item_a?.id ?? f.branch_a;
    if (!f.item_b) {
      const found = f.source_a === 'discovered';
      return {
        what: `${a}'s branch ${f.branch_a}${found ? ' (found by the radar)' : ''} is out of date with ${f.branch_b}: ${conflictText(f.files)}.`,
        fix: found
          ? `Rebase it onto ${f.branch_b}, or split it into short story PRs. If it's an old draft, or not ${a}'s work, report ${a}'s real branch so the radar stops using it.`
          : `Rebase it onto ${f.branch_b}, or split it into short story PRs. If it's an old draft, remove it from ${a}'s branches.`,
        ...agentWho(f.item_a ? [f.item_a.id] : [], leading),
      };
    }
    const b = f.item_b.id;
    // Decision 39: Docket picks the merge order; neither agent stops.
    const later = f.merge_first === b ? a : b;
    return {
      what: `${a}'s branch ${f.branch_a} and ${b}'s branch ${f.branch_b} change the same lines: ${conflictText(f.files)}.`,
      fix: f.merge_first
        ? `Keep working: neither item stops. ${f.merge_first} merges first, then ${later} rebases onto it and resolves the conflict. If that can't be done mechanically, or changes what ${f.merge_first} does, use propose_resolution. If one of them is an old draft, remove it from its item's branches.`
        : "Merge one first, then rebase the other onto main and resolve the conflict. If one of them is an old draft, remove it from its item's branches.",
      ...agentWho(f.item_a ? [f.item_a.id, b] : [b], leading),
    };
  },
};

// ---- Facts an acknowledgement covers ----

interface Facts {
  branches: string[];
  facts: string[];
}

const FACTS = new WeakMap<Problem, Facts>();

/** Record the facts of a problem built here (a radar finding's branches and files). */
function setFacts(p: Problem, f: Facts): Problem {
  FACTS.set(p, f);
  return p;
}

/** What an acknowledgement of `p` covers: its branches, and its files, items or resources. */
export function factsOf(p: Problem): Facts {
  const known = FACTS.get(p);
  if (known) return known;
  const facts = new Set<string>([...p.related, ...p.resource_ids]);
  if (p.item_id) facts.add(p.item_id);
  if (p.link_id) facts.add(p.link_id);
  return { branches: [], facts: [...facts].sort() };
}

// ---- Radar problems and who handles them ----

/** Items whose lead holds a live claim (an open lead run whose lease hasn't run out). */
export function leadingItems(db: Db, ids: readonly string[], now: string): Set<string> {
  const out = new Set<string>();
  if (ids.length === 0) return out;
  const rows = db.sqlite
    .prepare(
      `SELECT * FROM runs WHERE is_lead = 1 AND state IN ('open', 'parked')
       AND item_id IN (${ids.map(() => '?').join(', ')})`,
    )
    .all(...ids) as RunRow[];
  for (const r of rows) if (!leaseExpired(r, now)) out.add(r.item_id);
  return out;
}

/** "Heading for a conflict with RCP-18: 3 files · a.ts, b.ts (feat/a vs feat/b)": the one-line reason. */
export function radarReason(f: RadarFindingRow): string {
  const other = f.item_b ? f.item_b.id : f.branch_b;
  const n = f.files.length;
  const shown = f.files.slice(0, 3).join(', ');
  return `Heading for a conflict with ${other}: ${n} ${fileWord(n)}${shown ? ` · ${shown}${n > 3 ? ', …' : ''}` : ''} (${f.branch_a} vs ${f.branch_b})`;
}

/**
 * The radar's open findings as Problems rows (`radar_conflict`), each with
 * its explanation and, once it reaches the owner, why ("Not fixed by an
 * agent for a day", "Nobody is working on GF-228"). Findings within the
 * grace period whose items have a lead have `reached_you: null`.
 */
export function radarProblems(
  db: Db,
  findings: readonly RadarFindingRow[],
  now: string,
  graceMs: number,
): Problem[] {
  const ids = [
    ...new Set(
      findings.flatMap((f) => [f.item_a?.id, f.item_b?.id].filter((x): x is string => !!x)),
    ),
  ];
  const leading = leadingItems(db, ids, now);
  const created = new Map<string, string>();
  if (findings.length > 0) {
    for (const r of db.sqlite
      .prepare(
        `SELECT id, created_at FROM radar_findings WHERE id IN (${findings.map(() => '?').join(', ')})`,
      )
      .all(...findings.map((f) => f.id)) as { id: string; created_at: string }[]) {
      created.set(r.id, r.created_at);
    }
  }
  const reported = new Map<string, Set<string>>();
  const reportedOf = (item: string) => {
    let set = reported.get(item);
    if (!set) {
      const row = db.sqlite.prepare('SELECT branches FROM items WHERE id = ?').get(item) as
        { branches: string | null } | undefined;
      const list = row?.branches
        ? (JSON.parse(row.branches) as { name: string; removed?: boolean }[])
        : [];
      set = new Set(list.filter((b) => !b.removed).map((b) => b.name));
      reported.set(item, set);
    }
    return set;
  };
  const out: Problem[] = [];
  for (const f of findings) {
    if (!f.item_a) continue;
    const items = [f.item_a.id, ...(f.item_b ? [f.item_b.id] : [])];
    let reached: string | null = null;
    if (!items.some((id) => leading.has(id))) {
      reached = `Nobody is working on ${items.length === 1 ? items[0] : listText(items).replace(' and ', ' or ')}`;
    } else if (ms(now) - ms(created.get(f.id) ?? f.seen_at) >= graceMs) {
      reached = `Not fixed by an agent for ${graceText(graceMs)}`;
    }
    const branches: { item_id: string; branch: string }[] = [];
    if (f.source_a === 'reported' && reportedOf(f.item_a.id).has(f.branch_a)) {
      branches.push({ item_id: f.item_a.id, branch: f.branch_a });
    }
    if (f.item_b && f.source_b === 'reported' && reportedOf(f.item_b.id).has(f.branch_b)) {
      branches.push({ item_id: f.item_b.id, branch: f.branch_b });
    }
    out.push(
      setFacts(
        {
          kind: 'radar_conflict',
          id: f.id,
          item_id: f.item_a.id,
          title: f.item_a.title,
          reason: radarReason(f),
          related: f.item_b ? [f.item_b.id] : [],
          link_id: null,
          run_id: null,
          resource_ids: [],
          explanation: explain.radar(f, leading),
          reached_you: reached,
          branches,
        },
        { branches: [f.branch_a, f.branch_b].sort(), facts: [...f.files].sort() },
      ),
    );
  }
  return out;
}

// ---- Acknowledgements ----

interface AckRow {
  id: string;
  problem_id: string;
  kind: string;
  branches: string;
  facts: string;
  acked_by: string;
  created_at: string;
}

/** The newest acknowledgement of each problem. One query. */
export function loadAcks(db: Db): Map<string, AckRow> {
  const out = new Map<string, AckRow>();
  for (const row of db.sqlite
    .prepare('SELECT * FROM problem_acks ORDER BY created_at, id')
    .all() as AckRow[]) {
    out.set(row.problem_id, row);
  }
  return out;
}

const covers = (outer: readonly string[], inner: readonly string[]) => {
  const set = new Set(outer);
  return inner.every((x) => set.has(x));
};

/**
 * Whether the acknowledgement still covers the problem: the same kind, no
 * branch or fact it didn't cover, and no proposed resolution since.
 */
export function ackCovers(
  ack: AckRow | undefined,
  p: Problem,
  resolution: ResolutionRow | null | undefined,
): ProblemAck | null {
  if (!ack || ack.kind !== p.kind) return null;
  const f = factsOf(p);
  if (!covers(JSON.parse(ack.branches) as string[], f.branches)) return null;
  if (!covers(JSON.parse(ack.facts) as string[], f.facts)) return null;
  if (resolution && resolution.state === 'open' && resolution.created_at > ack.created_at) {
    return null;
  }
  return { by: ack.acked_by, at: ack.created_at };
}

/** Insert an acknowledgement of `p` (undoable: the inverse deletes it). */
function insertAck(w: WriteContext, p: Problem, project: string | null) {
  const f = factsOf(p);
  const id = newId('pak', ms(w.now));
  const inverse = w.insert('problem_acks', {
    id,
    problem_id: p.id!,
    project_key: project,
    item_id: p.item_id,
    kind: p.kind,
    branches: f.branches,
    facts: f.facts,
    acked_by: w.actor.kind === 'owner' ? 'owner' : callerName(w.db, w.actor),
  });
  return { id, inverse };
}

// ---- Proposed resolutions ----

interface ResolutionDbRow {
  id: string;
  item_id: string;
  problem_id: string | null;
  problem_kind: string | null;
  kind: ResolutionRow['kind'];
  plan_md: string;
  reason: string;
  proposed_by: string;
  run_id: string | null;
  state: ResolutionRow['state'];
  note: string | null;
  decided_by: string | null;
  decided_at: string | null;
  version: number;
  created_at: string;
}

export function resolutionRow(r: ResolutionDbRow): ResolutionRow {
  return {
    id: r.id,
    item_id: r.item_id,
    problem_id: r.problem_id,
    problem_kind: r.problem_kind,
    kind: r.kind,
    plan_md: r.plan_md,
    reason: r.reason,
    proposed_by: r.proposed_by,
    state: r.state,
    note: r.note,
    decided_by: r.decided_by,
    decided_at: r.decided_at,
    created_at: r.created_at,
    version: r.version,
  };
}

/** The newest proposed resolution of each problem (superseded ones left out). One query. */
export function latestResolutions(db: Db): Map<string, ResolutionRow> {
  const out = new Map<string, ResolutionRow>();
  for (const row of db.sqlite
    .prepare(
      `SELECT * FROM resolutions WHERE problem_id IS NOT NULL AND state <> 'superseded'
       ORDER BY created_at, id`,
    )
    .all() as ResolutionDbRow[]) {
    out.set(row.problem_id!, resolutionRow(row));
  }
  return out;
}

/** Open proposed resolutions, oldest first; with `items`, only theirs. */
export function openResolutions(db: Db, items?: ReadonlySet<string>): ResolutionRow[] {
  return (
    db.sqlite
      .prepare("SELECT * FROM resolutions WHERE state = 'open' ORDER BY created_at, id")
      .all() as ResolutionDbRow[]
  )
    .filter((r) => !items || items.has(r.item_id))
    .map(resolutionRow);
}

/** The newest proposed resolutions for an item, for get_context (decision 37). */
export function contextResolutions(db: Db, itemId: string) {
  return (
    db.sqlite
      .prepare(
        `SELECT id, problem_id, kind, state, note FROM resolutions WHERE item_id = ?
         AND state <> 'superseded' ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(itemId, LIMITS.context_resolutions_max) as {
      id: string;
      problem_id: string | null;
      kind: ResolutionRow['kind'];
      state: ResolutionRow['state'];
      note: string | null;
    }[]
  ).map((r) => ({ ...r }));
}

/** A problem as the service finds it, with its project. */
export interface FoundProblem {
  problem: Problem;
  project: string | null;
}

const KIND_WORDS: Record<ResolutionRow['kind'], string> = {
  split: 'split the work',
  rescope: 'change the scope',
  reorder: 'change the order of work',
  other: 'resolve it another way',
};

const DECISION_WORDS = {
  approve: 'approved',
  different: 'asked for a different way on',
  acknowledge: 'acknowledged',
} as const;

/**
 * The `problems` service (decision 37): acknowledging problems, agents'
 * proposed resolutions, and the owner's choice on them. Problems themselves
 * are computed on read by the views service (views.ts `findProblem`).
 */
export function createProblemsService(deps: ServiceDeps) {
  const find = (r: ReadContext, id: string): FoundProblem | null =>
    deps.services().views.findProblem(r, id);

  return {
    acknowledge(w: WriteContext, input: { problem_id: string }) {
      const found = find(w, input.problem_id);
      if (!found) {
        throw new ToolError(
          'not_found',
          `No open problem ${input.problem_id}. It may have cleared; reload Needs you.`,
        );
      }
      const { problem: p, project } = found;
      const { id, inverse } = insertAck(w, p, project);
      w.event({
        type: 'problem.acknowledged',
        summary: `You acknowledged: ${p.explanation?.what ?? p.reason}`,
        item_id: p.item_id,
        project_key: project,
        data: { problem_id: p.id, kind: p.kind, ack_id: id },
        objects: [{ kind: 'problem_ack', id }],
        inverse: [inverse],
      });
      return { problem_id: p.id!, acknowledged: { by: 'owner', at: w.now } };
    },

    propose(
      w: WriteContext,
      input: {
        problem?: string;
        id?: string;
        kind: ResolutionRow['kind'];
        plan_md: string;
        reason: string;
      },
    ) {
      if (!(RESOLUTION_KINDS as readonly string[]).includes(input.kind)) {
        throw new ToolError('validation', `kind must be one of ${RESOLUTION_KINDS.join(', ')}.`);
      }
      let itemId: string;
      let problem: Problem | null = null;
      if (input.problem !== undefined) {
        const found = find(w, input.problem);
        if (!found) {
          throw new ToolError(
            'not_found',
            `No open problem ${input.problem}. It may have cleared; read get_context for the item's problems.`,
          );
        }
        problem = found.problem;
        const own = problem.item_id ?? input.id;
        if (!own) {
          throw new ToolError(
            'validation',
            `${input.problem} isn't about an item. Pass id for the item your proposal is about.`,
            { details: { fields: { id: 'required for this problem' } } },
          );
        }
        if (
          input.id !== undefined &&
          input.id !== problem.item_id &&
          !problem.related.includes(input.id)
        ) {
          throw new ToolError(
            'validation',
            `${input.problem} isn't about ${input.id}. Leave id out, or name one of its items.`,
            { details: { fields: { id: `not an item of ${input.problem}` } } },
          );
        }
        itemId = input.id ?? own;
      } else {
        itemId = input.id!;
      }
      const item = requireItem(w.db, itemId);
      const by = callerName(w.db, w.actor);
      // A newer proposal for the same problem (or the item, with none) replaces an open one.
      const open = w.db.sqlite
        .prepare(
          `SELECT id FROM resolutions WHERE item_id = ? AND state = 'open'
           AND ((problem_id IS NULL AND ? IS NULL) OR problem_id = ?)`,
        )
        .all(item.id, problem?.id ?? null, problem?.id ?? null) as { id: string }[];
      for (const o of open) w.update('resolutions', o.id, { state: 'superseded' });
      const id = newId('prs', ms(w.now));
      w.insert('resolutions', {
        id,
        item_id: item.id,
        problem_id: problem?.id ?? null,
        problem_kind: problem?.kind ?? null,
        kind: input.kind,
        plan_md: input.plan_md,
        reason: input.reason,
        proposed_by: by,
        run_id: w.actor.run_id ?? null,
        state: 'open',
        note: null,
        decided_by: null,
        decided_at: null,
      });
      w.event({
        type: 'resolution.proposed',
        summary: `${by} proposed to ${KIND_WORDS[input.kind]}${problem ? ` for ${problem.explanation?.what ?? problem.reason}` : ` on ${item.id}`}: ${input.reason}`,
        item_id: item.id,
        project_key: item.project_key,
        data: {
          resolution_id: id,
          problem_id: problem?.id ?? null,
          kind: input.kind,
          superseded: open.map((o) => o.id),
        },
        objects: [{ kind: 'resolution', id }],
      });
      return {
        resolution: {
          id,
          item_id: item.id,
          problem_id: problem?.id ?? null,
          kind: input.kind,
          state: 'open' as const,
          created_at: w.now,
        },
        superseded: open.map((o) => o.id),
      };
    },

    decide(
      w: WriteContext,
      input: { id: string; decision: 'approve' | 'different' | 'acknowledge'; note?: string },
    ): ResolutionRow {
      const row = w.get('resolutions', input.id) as unknown as ResolutionDbRow | undefined;
      if (!row) throw new ToolError('not_found', `No proposed resolution ${input.id}.`);
      if (row.state !== 'open') {
        throw new ToolError(
          'conflict',
          `That proposal was already ${row.state === 'superseded' ? 'replaced by a newer one' : 'decided'}. Reload to see the current one.`,
          { current: resolutionRow(row) },
        );
      }
      if (input.decision === 'different' && !input.note?.trim()) {
        throw new ToolError('validation', 'Say which way to go instead.', {
          details: { fields: { note: 'required for a different way' } },
        });
      }
      const item = requireItem(w.db, row.item_id);
      const state =
        input.decision === 'approve'
          ? 'approved'
          : input.decision === 'different'
            ? 'different'
            : 'acknowledged';
      const note = input.note?.trim() || null;
      const inverses = [
        w.update('resolutions', row.id, {
          state,
          note,
          decided_by: 'owner',
          decided_at: w.now,
        }),
      ];
      // The choice reaches the proposer and the item's lead as an owner note.
      const text =
        input.decision === 'approve'
          ? `Approved your proposal to ${KIND_WORDS[row.kind]} (${row.id}). Go ahead.${note ? ` ${note}` : ''}`
          : input.decision === 'different'
            ? `Not this way (${row.id}): ${note}. Keep the problem open and propose again if you need to.`
            : `Acknowledged your proposal to ${KIND_WORDS[row.kind]} (${row.id}): fine, proceed.${note ? ` ${note}` : ''}`;
      const noteId = newId('note', ms(w.now));
      inverses.push(w.insert('owner_notes', { id: noteId, item_id: item.id, text }));
      // A decision counts as acknowledging the problem while it is open.
      const found = row.problem_id ? find(w, row.problem_id) : null;
      if (found) inverses.push(insertAck(w, found.problem, found.project).inverse);
      w.event({
        type: 'resolution.decided',
        summary: `You ${DECISION_WORDS[input.decision]} ${row.proposed_by}'s proposal to ${KIND_WORDS[row.kind]} on ${item.id}${note ? `: ${note}` : ''}`,
        item_id: item.id,
        project_key: item.project_key,
        data: {
          resolution_id: row.id,
          problem_id: row.problem_id,
          decision: input.decision,
          note,
          note_id: noteId,
        },
        objects: [{ kind: 'resolution', id: row.id }],
        inverse: inverses,
      });
      return resolutionRow(w.get('resolutions', row.id) as unknown as ResolutionDbRow);
    },
  };
}

export type ProblemsService = ReturnType<typeof createProblemsService>;
