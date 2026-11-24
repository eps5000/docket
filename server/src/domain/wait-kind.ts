/**
 * Queued instead of Blocked (owner decision 57; BUILD_SPEC §5.39): the one
 * classification of an open item with an open blocker. Work, the Map, epic
 * cards, Pick next epic, Overview, the critical path, the item page, the
 * daily brief, `get_digest` and `get_context` all read it from here.
 *
 * - **Held** first: the item's project is paused (decision 53), or nothing
 *   needs attention and an active owner decision holds a parked lead in its
 *   chain (decision 48).
 * - **Blocked** when a blocker anywhere in its chain needs attention, reusing
 *   what Docket already computes: a canceled blocker, a dependency loop, an
 *   owner decision nobody asked for and no next step (B54's conditions, with
 *   or without a parked run), or a lead parked past `DOCKET_PARK_MAX` on
 *   something other than a held owner decision. The nearest such blocker names it.
 * - **Queued** otherwise: every open blocker is being worked, Ready, or Queued.
 *
 * Read-only and derived: nothing is stored, the status stays, and claiming
 * still refuses any item with an open blocker. Each node is read once per
 * instance and every walk is cycle-safe.
 */
import {
  BLOCKED_REASONS,
  queuedText,
  type BlockedReason,
  type ItemWait,
  type Status,
  type WaitKind,
} from '@docket/shared';
import type { Db } from '../db/client.js';
import { agingFrom, decisionHold, heldByOwner } from './decision-hold.js';
import { compareIds } from './links.js';
import { ms, type BlockIndex } from './model.js';
import { projectPause } from './project-pause.js';
import { GRACE_MS, WaitReader, saysOwnerDecisionPending } from './wait.js';

/** Which open blocker is likeliest to clear first: the closer to done, the nearer. */
const NEAREST: Record<Status, number> = {
  done: 0,
  review: 1,
  progress: 2,
  ready: 3,
  planning: 4,
  inbox: 5,
  canceled: 6,
};

const RANK = new Map<BlockedReason, number>(BLOCKED_REASONS.map((r, i) => [r, i]));

interface Attention {
  reason: BlockedReason;
  on: string;
  text: string;
}

interface NodeFact {
  attention: Attention | null;
  /** The title of the active owner decision holding this blocker's parked lead. */
  held: string | null;
}

/** "5h", "3d": how long a lead has been parked. */
function parkedFor(msValue: number): string {
  const h = Math.max(1, Math.round(msValue / 3_600_000));
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

const heldText = (title: string) => `Held by your decision “${title}”`;

export class WaitKinds {
  readonly reader: WaitReader;
  private readonly memo = new Map<string, ItemWait | null>();
  private readonly facts = new Map<string, NodeFact>();
  private readonly pauses = new Map<string, string | null>();

  constructor(
    readonly db: Db,
    readonly now: string,
    readonly index: BlockIndex,
    /** `DOCKET_PARK_MAX`: the same stall threshold as the `parked_too_long` Problem. */
    readonly parkMaxMs: number,
  ) {
    this.reader = new WaitReader(db, now, index);
  }

  /** The item's wait, or null when it has no open blocker (or isn't open). */
  of(id: string): ItemWait | null {
    if (this.memo.has(id)) return this.memo.get(id)!;
    const wait = this.classify(id);
    this.memo.set(id, wait);
    return wait;
  }

  /** The kind only. */
  kindOf(id: string): WaitKind | null {
    return this.of(id)?.kind ?? null;
  }

  /** How many of these items are Queued, Blocked and Held. */
  counts(ids: Iterable<string>): { queued: number; blocked: number; held: number } {
    const out = { queued: 0, blocked: 0, held: 0 };
    for (const id of ids) {
      const k = this.kindOf(id);
      if (k) out[k] += 1;
    }
    return out;
  }

  private pauseTitle(project: string | undefined): string | null {
    if (!project) return null;
    if (!this.pauses.has(project)) {
      this.pauses.set(project, projectPause(this.db, project)?.title ?? null);
    }
    return this.pauses.get(project)!;
  }

  private nearestFirst(ids: readonly string[]): string[] {
    const rank = (x: string) => NEAREST[this.index.status(x) ?? 'canceled'];
    return [...ids].sort((a, b) => rank(a) - rank(b) || compareIds(a, b));
  }

  private classify(id: string): ItemWait | null {
    const state = this.index.state(id);
    if (!state.blocked) return null;
    const direct = this.nearestFirst(state.blocked_by);
    const after = direct[0]!;
    const more = direct.length - 1;
    const base = { after, more };

    // Decision 53: a paused project holds everything in it, with no alerts.
    const pause = this.pauseTitle(this.index.project(id));
    if (pause !== null) {
      return { ...base, kind: 'held', reason: 'paused', on: null, text: heldText(pause) };
    }

    // The chain, nearest first: every open blocker, and theirs, each once.
    const order: string[] = [];
    const seen = new Set([id]);
    const queue = [...direct];
    while (queue.length > 0) {
      const b = queue.shift()!;
      if (seen.has(b)) continue;
      seen.add(b);
      order.push(b);
      for (const c of this.nearestFirst(this.index.state(b).blocked_by)) {
        if (!seen.has(c)) queue.push(c);
      }
    }

    // The most pressing reason; the nearest blocker with it names it.
    const found = order.map((b) => this.fact(b).attention).filter((a) => a !== null);
    const loop = this.cycleFrom(id);
    if (loop) {
      found.push({
        reason: 'cycle',
        on: loop,
        text: `Its blockers loop back through ${loop}, so none of them can start`,
      });
    }
    const worst = found.reduce<Attention | null>(
      (w, a) => (!w || RANK.get(a.reason)! < RANK.get(w.reason)! ? a : w),
      null,
    );
    if (worst) {
      return { ...base, kind: 'blocked', reason: worst.reason, on: worst.on, text: worst.text };
    }

    // Decision 48: an owner decision holding a parked lead, on the item or in its chain.
    const own = this.ownHeld(id);
    const heldOn = own !== null ? id : order.find((b) => this.fact(b).held !== null);
    if (heldOn !== undefined) {
      const title = own ?? this.fact(heldOn).held!;
      return { ...base, kind: 'held', reason: 'decision', on: heldOn, text: heldText(title) };
    }
    // Decision 67: in the words of the blocker's type, and a Release's finish-wait.
    const text = queuedText({
      type: this.index.type(id),
      status: this.index.status(id),
      after,
      afterType: this.index.type(after),
      more,
    });
    return { ...base, kind: 'queued', reason: null, on: null, text };
  }

  /** The decision title when the item's own parked lead is held by an owner decision. */
  private ownHeld(id: string): string | null {
    const lead = this.reader.lead(id);
    if (lead?.state !== 'parked') return null;
    const hold = decisionHold(this.db, lead);
    return heldByOwner(hold) ? hold.decision!.title : null;
  }

  /** An item on a loop reachable from `id` through open blockers, or null. */
  private cycleFrom(id: string): string | null {
    const color = new Map<string, 1 | 2>();
    const stack: { node: string; next: string[] }[] = [
      { node: id, next: [...this.index.state(id).blocked_by] },
    ];
    color.set(id, 1);
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const n = top.next.shift();
      if (n === undefined) {
        color.set(top.node, 2);
        stack.pop();
        continue;
      }
      const c = color.get(n);
      if (c === 1) return n;
      if (c === 2) continue;
      color.set(n, 1);
      stack.push({ node: n, next: [...this.index.state(n).blocked_by] });
    }
    return null;
  }

  /** What one blocker contributes: why it needs attention, or the decision holding it. */
  private fact(b: string): NodeFact {
    const known = this.facts.get(b);
    if (known) return known;
    const fact = this.readFact(b);
    this.facts.set(b, fact);
    return fact;
  }

  private quiet(b: string): boolean {
    return ms(this.now) - ms(this.reader.lastActivity(b)) >= GRACE_MS;
  }

  private readFact(b: string): NodeFact {
    const status = this.index.status(b) ?? 'canceled';
    if (status === 'canceled') {
      return {
        attention: { reason: 'canceled', on: b, text: `${b} was canceled, so it never clears` },
        held: null,
      };
    }
    const lead = this.reader.lead(b);
    let held: string | null = null;
    let stalled: Attention | null = null;
    if (lead?.state === 'parked') {
      const hold = decisionHold(this.db, lead);
      if (heldByOwner(hold)) held = hold.decision!.title;
      else {
        const waited = ms(this.now) - ms(agingFrom(lead.parked_at ?? lead.updated_at, hold));
        if (waited >= this.parkMaxMs) {
          stalled = {
            reason: 'stalled',
            on: b,
            text: `${b}'s agent has been parked for ${parkedFor(waited)}`,
          };
        }
      }
    }

    // B54/B58: its text says an owner decision is pending, and nobody has asked for it.
    if (held === null) {
      const texts = this.db.sqlite
        .prepare('SELECT description_md, outcome_md, created_at FROM items WHERE id = ?')
        .get(b) as { description_md: string; outcome_md: string; created_at: string } | undefined;
      if (
        texts &&
        (saysOwnerDecisionPending(texts.description_md) ||
          saysOwnerDecisionPending(texts.outcome_md)) &&
        this.quiet(b) &&
        !this.reader.ownerAction(b) &&
        !this.reader.askedSince(b, texts.created_at)
      ) {
        return {
          attention: {
            reason: 'owner_unasked',
            on: b,
            text: `${b} needs an owner decision nobody has asked for`,
          },
          held: null,
        };
      }
    }
    if (stalled) return { attention: stalled, held: null };

    // B54's wait_no_next_step: it could move now, nobody owns that, and nothing has moved on it.
    // A Ready blocker waits its turn, so it never counts.
    const leaf = this.index.state(b).blocked_by.length === 0;
    if (leaf && status !== 'ready' && !lead && !this.reader.ownerAction(b) && this.quiet(b)) {
      return {
        attention: {
          reason: 'no_next_step',
          on: b,
          text: `${b} has no next step: ${this.stepFor(b, status)}`,
        },
        held: null,
      };
    }
    return { attention: null, held };
  }

  private stepFor(b: string, status: Status): string {
    if (status === 'inbox' || status === 'planning') return 'nobody has shaped or assigned it';
    if (status === 'progress') return 'nobody is working on it';
    if (status === 'review') return 'nobody is reviewing it';
    const link = (this.index.dependents.get(b) ?? []).find((l) => this.index.waitingFor(l));
    const w = link ? this.index.waitingFor(link) : null;
    return w === 'verification' ? 'nobody has verified it' : 'nobody has merged it';
  }
}

/** One classifier for a read, from the service config. */
export const waitKindsOf = (
  db: Db,
  now: string,
  index: BlockIndex,
  config: { parkMaxMs: number },
): WaitKinds => new WaitKinds(db, now, index, config.parkMaxMs);
