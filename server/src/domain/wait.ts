/**
 * What a parked run is waiting for (owner decision 45; BUILD_SPEC §5.26).
 *
 * - **The wait card** is derived on read from what Docket already stores: what
 *   each named blocker needs, when this run first parked on it, who can move
 *   it next, and the one sentence that says how the same run resumes.
 * - **Two advisory flags,** evaluated by the two-minute job with no git:
 *   `wait_no_next_step` (nobody owns the blocker's next step) and
 *   `wait_owner_unasked` (it waits on an owner decision nobody has asked for).
 *   Each raises one event and clears when its condition ends. A short resume
 *   and re-park keeps it raised, so it can't flap.
 * - **`run.resume_ready`** is one event when what it waits for clears. Docket
 *   can't push into an agent's session: a coordinator relays it to the dispatch.
 *
 * Nothing here blocks a claim, a status change, a queue or a delivery.
 */
import {
  WAIT_FLAGS,
  WORKFLOW_KEY,
  type OrchestratorRef,
  type Status,
  type WaitCard,
  type WaitFlagKind,
  type WaitingOn,
  type WaitingRun,
} from '@docket/shared';
import type { Db } from '../db/client.js';
import { BlockIndex, actorName, leaseExpired, ms, type RunRow } from './model.js';
import { clearedAt, parkInfo, parseJson, waitLink } from './recovery-model.js';
import { ACTIVITY_EVENTS, projectCoordinators } from './run-activity.js';
import type { WriteContext } from './write.js';

const GRACE_MS = WAIT_FLAGS.grace_minutes * 60_000;
const REPARK_MS = WAIT_FLAGS.repark_minutes * 60_000;

/** Item events that show someone is really on it. Docket's own wait bookkeeping isn't one. */
const REAL_ACTIVITY = [
  ...ACTIVITY_EVENTS,
  'item.created',
  'item.updated',
  'item.status_changed',
  'claim.granted',
  'question.asked',
  'resolution.proposed',
  'design_review.raised',
] as const;

// ---- Does this text say an owner decision is still pending? ----

/** A decision word, singular or plural. */
const DECISION_WORD = '(?:decisions?|rulings?|choices?|sign-?offs?|approvals?)';
/** One short word between "owner" and the decision ("owner scope decision"), never a verb or a negation. */
const QUALIFIER =
  '(?:(?!has\\b|had\\b|made\\b|took\\b|gave\\b|and\\b|or\\b|of\\b|to\\b|the\\b|no\\b|not\\b)[a-z-]{2,12}\\s+)?';
const OWNER_THING = `owner(?:'s|’s)?\\s+(?:calls?|input|${QUALIFIER}${DECISION_WORD})`;
const PENDING_TEXT = [
  // "these options remain a separate owner scope decision and WAIT"
  new RegExp(
    `\\bremains?\\s+(?:an?\\s+|the\\s+)?(?:\\w+\\s+)?${OWNER_THING}\\b[^.;\\n]{0,40}\\b(?:wait|hold)\\b`,
    'i',
  ),
  // "a separate owner decision is still needed"
  new RegExp(
    `\\b${OWNER_THING}\\b[^.;\\n]{0,30}\\b(?:needed|required|pending|outstanding)\\b`,
    'i',
  ),
  // "needs an owner decision", "waiting on the owner's call"
  new RegExp(
    `\\b(?:needs?|needing|requires?|awaiting|waiting\\s+(?:on|for)|blocked\\s+on)\\s+(?:an?\\s+|the\\s+)?(?:\\w+\\s+)?${OWNER_THING}\\b`,
    'i',
  ),
  // "needs a decision from the owner"
  /\b(?:needs?|requires?|awaiting|waiting\s+(?:on|for))\s+(?:an?\s+|the\s+)?(?:decision|call|ruling|sign-?off)\s+(?:from|by)\s+the\s+owner\b/i,
];

/** A sentence citing a decision already made, or saying none is needed. */
const SETTLED_TEXT = [
  /\bdec_[a-z0-9]+/i,
  /\bdecisions?\s+#?\d+\b/i,
  /\b(?:recorded|confirmed|published|existing|prior|previous|already)\b[^.;\n]{0,30}\bdecisions?\b/i,
  /\bdecisions?\b[^.;\n]{0,30}\b(?:recorded|made|confirmed|published|taken|settled|resolved|answered)\b/i,
  /\bowner\s+(?:has\s+|already\s+)?(?:decided|approved|confirmed|chose|ruled|answered|signed\s+off)\b/i,
  new RegExp(`\\b(?:no|without|not)\\s+(?:an?\\s+)?(?:\\w+\\s+)?${OWNER_THING}`, 'i'),
  new RegExp(
    `${OWNER_THING}\\b[^.;\\n]{0,30}\\b(?:not|no longer)\\s+(?:needed|required|pending)\\b`,
    'i',
  ),
  /\bcode\s+owners?\b/i,
];

/**
 * Whether `text` says an owner decision is still to come. Deliberately narrow,
 * one sentence at a time: a sentence that cites a recorded decision or a choice
 * already made never counts.
 */
export function saysOwnerDecisionPending(text: string | null | undefined): boolean {
  if (!text) return false;
  return text
    .split(/(?<=[.!?;])\s+|\n+/)
    .some((s) => PENDING_TEXT.some((re) => re.test(s)) && !SETTLED_TEXT.some((re) => re.test(s)));
}

// ---- Stored flags (`runs.wait_flags`) ----

export interface StoredWaitFlag {
  kind: WaitFlagKind;
  on: string;
  since: string;
  step: string;
  /** When its run left the park; it clears if the run stays out. */
  left_at?: string;
}

export interface StoredWait {
  flags: Record<string, StoredWaitFlag>;
  /** What the last `run.resume_ready` was about, so each clearing is told once. */
  resume_key?: string;
}

export const storedWait = (run: Pick<RunRow, 'wait_flags'>): StoredWait => {
  const stored = parseJson<StoredWait>(run.wait_flags);
  return { ...stored, flags: stored?.flags ?? {} };
};

/** The raised flags a parked run shows. */
export const openWaitFlags = (run: Pick<RunRow, 'wait_flags'>): StoredWaitFlag[] =>
  Object.values(storedWait(run).flags).filter((f) => !f.left_at);

/** The run's recorded orchestrator in its full shape: what wasn't reported is null. */
function orchestratorOf(run: Pick<RunRow, 'orchestrator'>): OrchestratorRef | null {
  const o = parseJson<Partial<OrchestratorRef>>(run.orchestrator);
  return o?.name
    ? {
        name: o.name,
        dispatch_id: o.dispatch_id ?? null,
        task_id: o.task_id ?? null,
        run_id: o.run_id ?? null,
      }
    : null;
}

/** The coordinator a wait goes to: the run's recorded orchestrator, else a registered one. */
export function waitCoordinator(db: Db, run: RunRow, project: string): string | null {
  return (
    parseJson<OrchestratorRef>(run.orchestrator)?.name ??
    projectCoordinators(db, project)[0] ??
    null
  );
}

// ---- The reader ----

interface Moves {
  id: string;
  cycle: boolean;
}

interface Named {
  id: string;
  status: Status;
  clears_when: 'done' | 'merged' | 'verified';
  cleared: boolean;
  waiting: 'done' | 'merge' | 'verification' | null;
  waited_since: string;
  moves: Moves;
}

interface Condition {
  kind: WaitFlagKind;
  on: string;
  step: string;
}

const CLEARS_WORD = { done: 'done', merged: 'merged', verified: 'verified' } as const;

export class WaitReader {
  readonly index: BlockIndex;
  private readonly leads = new Map<string, RunRow | null>();
  private readonly activity = new Map<string, string>();
  private readonly owner = new Map<string, string | null>();
  private readonly parks = new Map<string, { at: string; run: string; waiting: WaitingOn }[]>();

  constructor(
    readonly db: Db,
    readonly now: string,
    index?: BlockIndex,
  ) {
    this.index = index ?? new BlockIndex(db);
  }

  /** The item's lead, while its claim is live. A parked lead counts. */
  private lead(id: string): RunRow | null {
    if (!this.leads.has(id)) {
      const row = this.db.sqlite
        .prepare(
          "SELECT * FROM runs WHERE item_id = ? AND is_lead = 1 AND state IN ('open', 'needs_input', 'parked')",
        )
        .get(id) as RunRow | undefined;
      this.leads.set(id, row && !leaseExpired(row, this.now) ? row : null);
    }
    return this.leads.get(id)!;
  }

  /** The last real activity on an item, never earlier than its creation. */
  private lastActivity(id: string): string {
    const known = this.activity.get(id);
    if (known) return known;
    const sql = this.db.sqlite;
    const event = sql
      .prepare(
        'SELECT max(at) AS at FROM events WHERE item_id = ? AND type IN (SELECT value FROM json_each(?))',
      )
      .get(id, JSON.stringify(REAL_ACTIVITY)) as { at: string | null };
    const created = sql.prepare('SELECT created_at FROM items WHERE id = ?').get(id) as
      { created_at: string } | undefined;
    const at = [event.at, created?.created_at]
      .filter((x): x is string => !!x)
      .sort((a, b) => ms(a) - ms(b))
      .pop()!;
    this.activity.set(id, at);
    return at;
  }

  /** What already waits on the owner for this item, in words; null when nothing does. */
  private ownerAction(id: string): string | null {
    if (this.owner.has(id)) return this.owner.get(id)!;
    const sql = this.db.sqlite;
    const has = (query: string, ...args: string[]) => !!sql.prepare(query).get(...args);
    // A Workflow or agent-file proposal has no item of its own: it's linked by its run.
    const proposal = sql
      .prepare(
        `SELECT p.file_key FROM agent_file_proposals p JOIN runs r ON r.id = p.run_id
         WHERE r.item_id = ? AND p.state = 'pending' ORDER BY p.created_at, p.id LIMIT 1`,
      )
      .get(id) as { file_key: string } | undefined;
    const action = has('SELECT 1 FROM questions WHERE item_id = ? AND answered_at IS NULL', id)
      ? 'an open question to answer'
      : has("SELECT 1 FROM packets WHERE item_id = ? AND state = 'open'", id)
        ? 'a review packet to decide'
        : has("SELECT 1 FROM resolutions WHERE item_id = ? AND state = 'open'", id)
          ? 'a proposed resolution to decide'
          : proposal
            ? proposal.file_key === WORKFLOW_KEY
              ? 'a Workflow notes proposal to approve'
              : 'an agent-file proposal to approve'
            : has("SELECT 1 FROM design_reviews WHERE item_id = ? AND state = 'open'", id)
              ? 'a design review to decide'
              : has("SELECT 1 FROM undeclared_holds WHERE item_id = ? AND state = 'open'", id)
                ? 'a held hand-off to decide'
                : has(
                      "SELECT 1 FROM part_overlaps WHERE state = 'open' AND (item_a = ? OR item_b = ?)",
                      id,
                      id,
                    )
                  ? 'an overlap question to answer'
                  : null;
    this.owner.set(id, action);
    return action;
  }

  /**
   * The owner was asked during this wait: a question or proposal raised or
   * decided since `since`, or a decision recorded on the item. Once answered it
   * isn't "never asked", even when it was raised just before the run parked.
   */
  private askedSince(id: string, since: string): boolean {
    const sql = this.db.sqlite;
    return (
      !!sql
        .prepare(
          'SELECT 1 FROM questions WHERE item_id = ? AND (created_at >= ? OR answered_at >= ?) LIMIT 1',
        )
        .get(id, since, since) ||
      !!sql
        .prepare(
          'SELECT 1 FROM resolutions WHERE item_id = ? AND (created_at >= ? OR decided_at >= ?) LIMIT 1',
        )
        .get(id, since, since) ||
      !!sql
        .prepare(
          `SELECT 1 FROM agent_file_proposals p JOIN runs r ON r.id = p.run_id
           WHERE r.item_id = ? AND (p.created_at >= ? OR p.decided_at >= ?) LIMIT 1`,
        )
        .get(id, since, since) ||
      !!sql
        .prepare(
          `SELECT 1 FROM decision_records WHERE scope_kind = 'item' AND scope_id = ?
           AND status = 'active' AND created_at >= ? LIMIT 1`,
        )
        .get(id, since)
    );
  }

  /** The next step of a wait on a person: what's in front of the owner, or that it was answered. */
  private personStep(id: string, since: string): string {
    const pending = this.ownerAction(id);
    if (pending) return `${id}: the owner has ${pending}`;
    if (this.askedSince(id, since)) return `${id}: the owner has answered; resume it`;
    return `${id}: ask the owner what it waits for`;
  }

  /** Every recorded wait of a run, oldest first: its parks and a coordinator's changes. */
  private parksOf(run: RunRow) {
    let all = this.parks.get(run.item_id);
    if (!all) {
      all = (
        this.db.sqlite
          .prepare(
            `SELECT at, data FROM events WHERE item_id = ?
             AND type IN ('run.parked', 'run.status_updated') ORDER BY seq`,
          )
          .all(run.item_id) as { at: string; data: string | null }[]
      ).flatMap((e) => {
        const data = parseJson<{ run_id?: string; waiting_on?: WaitingOn }>(e.data);
        return data?.run_id && data.waiting_on
          ? [{ at: e.at, run: data.run_id, waiting: data.waiting_on }]
          : [];
      });
      this.parks.set(run.item_id, all);
    }
    return all.filter((p) => p.run === run.id);
  }

  /** When this run first parked on each thing it waited on. A re-park never moves it. */
  private firstParked(run: RunRow): Map<string, string> {
    const first = new Map<string, string>();
    const note = (key: string, at: string) => {
      if (!first.has(key)) first.set(key, at);
    };
    for (const p of this.parksOf(run)) {
      for (const id of p.waiting.items ?? []) note(id, p.at);
      if (p.waiting.person) note('person', p.at);
      if (p.waiting.orchestrator) note('coordinator', p.at);
      if (p.waiting.until) note('until', p.at);
    }
    return first;
  }

  /**
   * The item that can actually move for a blocker: follows uncleared blockers,
   * and a parked lead's own wait, bounded and cycle-safe.
   */
  private movesFrom(id: string, seen = new Set<string>(), depth = 0): Moves {
    seen.add(id);
    if (depth >= WAIT_FLAGS.chain_depth) return { id, cycle: false };
    const lead = this.lead(id);
    if (lead && lead.state !== 'parked') return { id, cycle: false };
    let next: string[];
    if (lead) {
      const waiting = parseJson<WaitingOn>(lead.waiting_on) ?? {};
      next = (waiting.items ?? []).filter(
        (x) => !this.index.cleared(waitLink(this.index, lead.item_id, x)),
      );
      if (next.length === 0) return { id, cycle: false };
    } else {
      next = this.index.state(id).blocked_by;
      if (next.length === 0) return { id, cycle: false };
    }
    const fresh = next.filter((x) => !seen.has(x));
    if (fresh.length === 0) return { id, cycle: true };
    return this.movesFrom(fresh[0]!, seen, depth + 1);
  }

  private named(run: RunRow, waiting: WaitingOn, first: Map<string, string>): Named[] {
    const parkedAt = run.parked_at ?? run.updated_at;
    return (waiting.items ?? []).map((id) => {
      const link = waitLink(this.index, run.item_id, id);
      const w = this.index.waitingFor(link);
      return {
        id,
        status: this.index.status(id) ?? 'canceled',
        clears_when: this.index.rule(link),
        cleared: w === null,
        waiting: w,
        waited_since: first.get(id) ?? parkedAt,
        moves: w === null ? { id, cycle: false } : this.movesFrom(id, new Set([run.item_id])),
      };
    });
  }

  /** What moves an item next, in words the coordinator can act on. */
  private stepFor(m: Moves, waiting: Named['waiting']): string {
    const id = m.id;
    if (m.cycle) return `${id}: remove one link of its dependency loop`;
    const pending = this.ownerAction(id);
    if (pending) return `${id}: the owner has ${pending}`;
    const lead = this.lead(id);
    if (lead) {
      return lead.state === 'parked'
        ? `${id}: its lead is parked; see its wait`
        : `${id}: finish it`;
    }
    const status = this.index.status(id);
    if (status === 'ready' || status === 'progress') return `${id}: dispatch it`;
    if (status === 'inbox' || status === 'planning') return `${id}: shape it or assign it`;
    if (status === 'review') return `${id}: get it reviewed`;
    if (status === 'canceled') return `${id}: reopen it or remove the link`;
    if (waiting === 'verification') return `${id}: verify it`;
    return `${id}: merge it`;
  }

  /** The wait card of a parked lead (BUILD_SPEC §5.26). */
  card(run: RunRow): WaitCard {
    const waiting = parseJson<WaitingOn>(run.waiting_on) ?? {};
    const first = this.firstParked(run);
    const parkedAt = run.parked_at ?? run.updated_at;
    const named = this.named(run, waiting, first);
    const open = named.filter((b) => !b.cleared);
    const project = this.index.project(run.item_id) ?? '';
    const orchestrator = orchestratorOf(run);
    const info = parkInfo(this.db, run, this.now, this.index);

    const since = [
      ...(open.length > 0 ? open : named).map((b) => b.waited_since),
      ...(waiting.person ? [first.get('person') ?? parkedAt] : []),
      ...(waiting.orchestrator ? [first.get('coordinator') ?? parkedAt] : []),
      ...(waiting.until ? [first.get('until') ?? parkedAt] : []),
    ].sort((a, b) => ms(a) - ms(b))[0];

    // Who moves it: the blocker's live lead, the recorded orchestrator, a coordinator, the owner.
    const blocker = open[0];
    const live = blocker ? this.lead(blocker.moves.id) : null;
    const registered = projectCoordinators(this.db, project)[0];
    const who: Pick<WaitCard['next_owner'], 'kind' | 'name'> =
      live && live.state !== 'parked'
        ? {
            kind: 'lead',
            name: actorName({ kind: 'agent', client: live.client, label: live.label }),
          }
        : orchestrator?.name
          ? { kind: 'orchestrator', name: orchestrator.name }
          : registered
            ? { kind: 'coordinator', name: registered }
            : { kind: 'owner', name: 'the owner' };
    const step = info.resume_ready
      ? `tell run ${run.id} to continue`
      : blocker
        ? this.stepFor(blocker.moves, blocker.waiting)
        : waiting.person
          ? this.personStep(run.item_id, first.get('person') ?? parkedAt)
          : waiting.orchestrator
            ? `${run.item_id}: send it more work or resume it`
            : waiting.until
              ? `${run.item_id}: it can resume at ${waiting.until}`
              : `${run.item_id}: resume it or say what it waits for`;

    const flagsNow = openWaitFlags(run).map((f) => ({
      kind: f.kind,
      on: f.on,
      since: f.since,
      step: f.step,
    }));
    const listed = [...open, ...named.filter((b) => b.cleared)];
    return {
      run_id: run.id,
      item_id: run.item_id,
      label: run.label,
      client: run.client,
      orchestrator,
      blockers: listed.slice(0, WAIT_FLAGS.card_blockers).map((b) => ({
        id: b.id,
        status: b.status,
        clears_when: b.clears_when,
        cleared: b.cleared,
        waited_since: b.waited_since,
        lead: (() => {
          const l = this.lead(b.id);
          return l ? actorName({ kind: 'agent', client: l.client, label: l.label }) : null;
        })(),
        moves: !b.cleared && b.moves.id !== b.id ? b.moves.id : null,
      })),
      more_blockers: Math.max(0, listed.length - WAIT_FLAGS.card_blockers),
      person: waiting.person === true,
      coordinator: waiting.orchestrator === true,
      until: waiting.until ?? null,
      waited_since: since ?? parkedAt,
      next_owner: { ...who, item_id: blocker?.moves.id ?? null, step },
      resumes_when: resumeSentence(run, open, waiting, orchestrator, info.resume_ready),
      resume_ready: info.resume_ready,
      flags: flagsNow,
      ...this.scopeHint(run, open),
    };
  }

  /**
   * A blocker linked after this run claimed the item often means scope was added.
   * Only a prompt to check: it is no link type, flag, event or gate.
   */
  private scopeHint(run: RunRow, open: readonly Named[]): { scope_hint?: string } {
    const linked = this.db.sqlite.prepare(
      "SELECT created_at FROM links WHERE from_id = ? AND to_id = ? AND type = 'blocks'",
    );
    const late = open
      .filter((b) => {
        const link = linked.get(b.id, run.item_id) as { created_at: string } | undefined;
        return !!link && ms(link.created_at) > ms(run.created_at);
      })
      .map((b) => b.id);
    if (late.length === 0) return {};
    const shown = late.slice(0, WAIT_FLAGS.card_blockers).join(', ');
    const names = late.length > WAIT_FLAGS.card_blockers ? `${shown} and others` : shown;
    return {
      scope_hint: `${names} ${late.length === 1 ? 'was' : 'were'} added after work started: confirm ${late.length === 1 ? 'it holds' : 'they hold'} the whole story. If only part is held, split that part out and let the rest proceed.`,
    };
  }

  /** The flag conditions true for a parked lead right now. */
  conditions(run: RunRow): Map<string, Condition> {
    const out = new Map<string, Condition>();
    const waiting = parseJson<WaitingOn>(run.waiting_on) ?? {};
    const first = this.firstParked(run);
    const parkedAt = run.parked_at ?? run.updated_at;
    const open = this.named(run, waiting, first).filter((b) => !b.cleared);
    const nowMs = ms(this.now);
    const quiet = (at: string) => nowMs - ms(at) >= GRACE_MS;

    // wait_no_next_step: nobody owns the blocker's next step, and nothing has moved on it.
    for (const b of open) {
      const m = b.moves;
      // A dependency loop is its own owner Problem (`cycle`), with its own fix.
      if (m.cycle || this.lead(m.id) || this.ownerAction(m.id)) continue;
      if (!quiet(this.lastActivity(m.id))) continue;
      out.set(`wait_no_next_step:${b.id}`, {
        kind: 'wait_no_next_step',
        on: b.id,
        step: this.stepFor(m, m.id === b.id ? b.waiting : null),
      });
    }

    // wait_owner_unasked: an owner decision is pending and nobody has asked for it.
    const unasked = (on: string, since: string, others: readonly string[]) => {
      const places = [on, ...others];
      if (places.some((id) => this.ownerAction(id) || this.askedSince(id, since))) return;
      out.set(`wait_owner_unasked:${on}`, {
        kind: 'wait_owner_unasked',
        on,
        step: `${on}: ask the owner for the decision (ask_owner)`,
      });
    };
    const texts = this.db.sqlite.prepare(
      'SELECT description_md, outcome_md FROM items WHERE id = ?',
    );
    for (const b of open) {
      const t = texts.get(b.id) as { description_md: string; outcome_md: string } | undefined;
      if (!saysOwnerDecisionPending(t?.description_md) && !saysOwnerDecisionPending(t?.outcome_md))
        continue;
      if (quiet(this.lastActivity(b.id))) unasked(b.id, b.waited_since, [run.item_id]);
    }
    if (waiting.person || saysOwnerDecisionPending(run.parked_reason)) {
      const since = waiting.person ? (first.get('person') ?? parkedAt) : parkedAt;
      const latest =
        ms(this.lastActivity(run.item_id)) > ms(since) ? this.lastActivity(run.item_id) : since;
      if (quiet(latest)) {
        unasked(
          run.item_id,
          since,
          open.map((b) => b.id),
        );
      }
    }
    return out;
  }

  /** Parked leads this item would free, directly or further down their chain. */
  waitersOn(id: string): { total: number; rows: WaitingRun[] } {
    const rows: WaitingRun[] = [];
    for (const run of this.db.sqlite
      .prepare("SELECT * FROM runs WHERE is_lead = 1 AND state = 'parked' ORDER BY parked_at, id")
      .all() as RunRow[]) {
      if (run.item_id === id) continue;
      const waiting = parseJson<WaitingOn>(run.waiting_on) ?? {};
      if (!waiting.items?.length) continue;
      const open = this.named(run, waiting, this.firstParked(run)).filter((b) => !b.cleared);
      const hit = open.find((b) => b.id === id) ?? open.find((b) => b.moves.id === id);
      if (!hit) continue;
      rows.push({
        item_id: run.item_id,
        run_id: run.id,
        label: run.label,
        waited_since: hit.waited_since,
        via: hit.id === id ? null : hit.id,
      });
    }
    return { total: rows.length, rows: rows.slice(0, WAIT_FLAGS.context_waiters) };
  }
}

/** Who tells the run, in words that never imply Docket delivered it. */
function relayText(run: RunRow, orchestrator: OrchestratorRef | null): string {
  const holder = actorName({ kind: 'agent', client: run.client, label: run.label });
  const same = `the same run ${run.id} (${holder})`;
  if (!orchestrator?.name) return `a coordinator or the owner tells ${same} to continue`;
  return orchestrator.dispatch_id
    ? `${orchestrator.name} relays it to dispatch ${orchestrator.dispatch_id}, ${same}`
    : `${orchestrator.name} tells ${same} to continue`;
}

/** The exact sentence: what clears it, and who continues under which run. */
function resumeSentence(
  run: RunRow,
  open: readonly Named[],
  waiting: WaitingOn,
  orchestrator: OrchestratorRef | null,
  ready: boolean,
): string {
  const relay = relayText(run, orchestrator);
  if (ready) return `Ready to resume: ${relay}.`;
  const items = open
    .slice(0, WAIT_FLAGS.card_blockers)
    .map((b) => `${b.id} is ${CLEARS_WORD[b.clears_when]}`);
  if (open.length > WAIT_FLAGS.card_blockers) {
    items.push(`${open.length - WAIT_FLAGS.card_blockers} more clear`);
  }
  const parts = [
    items.length > 0 ? items.join(' and ') : null,
    waiting.person ? 'a person answers' : null,
    waiting.orchestrator ? 'the coordinator resumes it' : null,
    waiting.until ? `it is ${waiting.until}` : null,
  ].filter(Boolean);
  return `Resumes when ${parts.join(', or ') || 'someone resumes it'}: ${relay}.`;
}

/** What the coordinator should send, in the event and the digest. */
export function resumeInstruction(runId: string): string {
  return `Continue under run ${runId}: call heartbeat with it first, then get_context. Don't claim.`;
}

/** The digest's short form of a card. */
export function digestWait(card: WaitCard) {
  const dispatch = card.orchestrator?.dispatch_id;
  return {
    since: card.waited_since,
    next: `${card.next_owner.name}: ${card.next_owner.step}`,
    flags: card.flags.map((f) => f.kind),
    ...(card.resume_ready
      ? { relay: `run ${card.run_id}${dispatch ? ` via dispatch ${dispatch}` : ''}` }
      : {}),
  };
}

// ---- The two-minute check ----

export interface WaitChange {
  run: RunRow;
  project: string;
  next: StoredWait | null;
  raised: StoredWaitFlag[];
  cleared: StoredWaitFlag[];
  resume: { key: string; items: string[] } | null;
}

/** What the current key of a ready run is: the items and when the last one cleared. */
function resumeKey(db: Db, run: RunRow, index: BlockIndex, waiting: WaitingOn): string | null {
  const items = [...(waiting.items ?? [])].sort();
  if (items.length > 0 && items.every((id) => index.cleared(waitLink(index, run.item_id, id)))) {
    const last = items
      .map((id) => clearedAt(db, id, index.rule(waitLink(index, run.item_id, id))) ?? '')
      .sort()
      .pop();
    return `${items.join(',')}@${last}`;
  }
  return waiting.until ? `until:${waiting.until}` : null;
}

/** Read-only: every flag to raise or clear, and every run newly able to resume. */
export function planWaitCheck(db: Db, now: string): WaitChange[] {
  const rows = db.sqlite
    .prepare(
      `SELECT r.*, i.project_key AS project_key FROM runs r
       JOIN items i ON i.id = r.item_id JOIN projects p ON p.key = i.project_key
       WHERE r.is_lead = 1 AND p.deleted_at IS NULL AND (r.state = 'parked' OR r.wait_flags IS NOT NULL)
       ORDER BY r.created_at, r.id`,
    )
    .all() as (RunRow & { project_key: string })[];
  if (rows.length === 0) return [];
  const reader = new WaitReader(db, now);
  const out: WaitChange[] = [];
  for (const run of rows) {
    const stored = storedWait(run);
    const flags: Record<string, StoredWaitFlag> = {};
    const raised: StoredWaitFlag[] = [];
    const cleared: StoredWaitFlag[] = [];
    let resume: WaitChange['resume'] = null;
    let resumeAt = stored.resume_key;

    if (run.state === 'parked') {
      const conditions = reader.conditions(run);
      for (const [key, c] of conditions) {
        const had = stored.flags[key];
        if (had) flags[key] = { kind: had.kind, on: had.on, since: had.since, step: c.step };
        else {
          flags[key] = { kind: c.kind, on: c.on, since: now, step: c.step };
          raised.push(flags[key]!);
        }
      }
      for (const [key, f] of Object.entries(stored.flags)) if (!flags[key]) cleared.push(f);
      if (parkInfo(db, run, now, reader.index).resume_ready) {
        const waiting = parseJson<WaitingOn>(run.waiting_on) ?? {};
        const key = resumeKey(db, run, reader.index, waiting);
        if (key && key !== stored.resume_key) {
          resume = { key, items: waiting.items ?? [] };
          resumeAt = key;
        }
      }
    } else if (run.state === 'open' || run.state === 'needs_input') {
      // Out of its park: the flag waits a little, in case this is a short resume and re-park.
      for (const [key, f] of Object.entries(stored.flags)) {
        const left = f.left_at ?? now;
        if (ms(now) - ms(left) >= REPARK_MS) cleared.push(f);
        else flags[key] = { ...f, left_at: left };
      }
    } else {
      cleared.push(...Object.values(stored.flags));
      resumeAt = undefined;
    }

    const hasFlags = Object.keys(flags).length > 0;
    const next: StoredWait | null =
      hasFlags || resumeAt ? { flags, ...(resumeAt ? { resume_key: resumeAt } : {}) } : null;
    const same =
      JSON.stringify(next) ===
      JSON.stringify(run.wait_flags === null ? null : parseJson<StoredWait>(run.wait_flags));
    if (same && raised.length === 0 && cleared.length === 0 && !resume) continue;
    out.push({ run, project: run.project_key, next, raised, cleared, resume });
  }
  return out;
}

/** Whether a planned change records an event, and so goes through the write path. */
export const hasWaitEvent = (c: WaitChange) =>
  c.raised.length > 0 || c.cleared.length > 0 || c.resume !== null;

/** Changes with no event (a new step, a run leaving its park). No version, no feed entry. */
export function storeWaitBookkeeping(db: Db, changes: readonly WaitChange[]): void {
  if (changes.length === 0) return;
  const store = db.sqlite.prepare('UPDATE runs SET wait_flags = ? WHERE id = ?');
  db.sqlite
    .transaction(() => {
      for (const c of changes) store.run(c.next ? JSON.stringify(c.next) : null, c.run.id);
    })
    .immediate();
}

const FLAG_WORDS: Record<WaitFlagKind, string> = {
  wait_no_next_step: 'has no next step',
  wait_owner_unasked: 'needs an owner decision nobody has asked for',
};

/** Store the plan: one event per flag raised or cleared, and one per run able to resume. */
export function applyWaitCheck(
  w: WriteContext,
  changes: readonly WaitChange[],
): { raised: string[]; cleared: string[]; resumable: string[] } {
  const store = w.db.sqlite.prepare('UPDATE runs SET wait_flags = ? WHERE id = ?');
  const out = { raised: [] as string[], cleared: [] as string[], resumable: [] as string[] };
  for (const c of changes) {
    const { run } = c;
    store.run(c.next ? JSON.stringify(c.next) : null, run.id);
    const orchestrator = orchestratorOf(run);
    const who = {
      run_id: run.id,
      label: run.label,
      client: run.client,
      orchestrator,
    };
    const coordinator = waitCoordinator(w.db, run, c.project);
    for (const f of c.raised) {
      w.event({
        type: 'run.wait_flagged',
        summary:
          f.on === run.item_id
            ? `${run.item_id} ${FLAG_WORDS[f.kind]}. Next: ${f.step}`
            : `${run.item_id} waits on ${f.on}, which ${FLAG_WORDS[f.kind]}. Next: ${f.step}`,
        item_id: run.item_id,
        project_key: c.project,
        data: { ...who, kind: f.kind, on: f.on, step: f.step, coordinator },
        objects: [{ kind: 'run', id: run.id }],
      });
      out.raised.push(`${f.kind}:${run.item_id}`);
    }
    for (const f of c.cleared) {
      w.event({
        type: 'run.wait_cleared',
        summary: `${run.item_id}: no longer flagged on ${f.on} (${f.kind})`,
        item_id: run.item_id,
        project_key: c.project,
        data: { ...who, kind: f.kind, on: f.on, raised_at: f.since },
        objects: [{ kind: 'run', id: run.id }],
      });
      out.cleared.push(`${f.kind}:${run.item_id}`);
    }
    if (c.resume) {
      const what =
        c.resume.items.length > 0 ? `${c.resume.items.join(', ')} cleared` : 'its wait time passed';
      w.event({
        type: 'run.resume_ready',
        summary: `${run.item_id} can resume: ${what}. ${relayText(run, orchestrator)}. Docket can't message a session`,
        item_id: run.item_id,
        project_key: c.project,
        data: {
          ...who,
          dispatch_id: orchestrator?.dispatch_id ?? null,
          items: c.resume.items,
          instruction: resumeInstruction(run.id),
        },
        objects: [{ kind: 'run', id: run.id }],
      });
      out.resumable.push(run.item_id);
    }
  }
  return out;
}
