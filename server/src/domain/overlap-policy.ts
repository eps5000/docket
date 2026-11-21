/**
 * Overlaps reach the owner only when they need the owner (owner decision 39;
 * BUILD_SPEC §5.21; FR-177–FR-184; tasks.md T196–T198).
 *
 * For any overlap, Docket asks three questions in order:
 * 1. Can they safely run at the same time? Then they do.
 * 2. If not, or if it's unclear, would running them in order solve it? Then
 *    Docket sequences them, and the waiting agent takes other work.
 * 3. Neither works, or it changes an approved design? Then it reaches the
 *    owner, with the evidence and a recommendation.
 *
 * **Two independent checks, and neither substitutes for the other.** This
 * file answers the *meaning* question from declarations. Whether the actual
 * lines collide is the radar's question (a git trial merge of real commits,
 * radar.ts). "Add-only" doesn't prevent a merge conflict, and a clean trial
 * merge doesn't make work safe: it never overrides a sequence decided here.
 *
 * A declared change to an approved design is not an overlap question: it
 * always goes to the owner through its own review (design-review.ts), which
 * this classifier never reads or clears.
 *
 * `classifyPair` is pure, so every path is unit-tested without a database.
 */
import {
  DEFAULT_OVERLAP_HANDLING,
  OVERLAP_HANDLING,
  type DesignImpact,
  type OverlapEvidence,
  type OverlapHandling,
  type OverlapOutcome,
  type OverlapReason,
  type SharedChange,
  type SharedPartKind,
} from '@docket/shared';
import type { Db } from '../db/client.js';
import { SYSTEM_ACTOR, type Actor, type EventInput, type WriteContext } from './write.js';

/** One declared change, as the classification reads it. */
export interface PolicyChange {
  /** The key as declared: `model:Token.expiresAt`. */
  part: string;
  /** The registered part: `model:Token`. */
  base: string;
  member: string | null;
  kind: SharedPartKind;
  change: SharedChange;
  design_impact: DesignImpact;
  design_note: string | null;
  disputed: boolean;
}

export interface Classification {
  outcome: OverlapOutcome;
  reason: OverlapReason;
  /** The declared keys in collision, on either item. */
  parts: string[];
  evidence: OverlapEvidence;
}

/** Kinds "Ask on shared data" sends to the owner. */
const SHARED_DATA: readonly SharedPartKind[] = ['table', 'model', 'endpoint'];

/** Which reason describes a pair when several parts collide: the most serious first. */
const SEQUENCE_ORDER: readonly OverlapReason[] = [
  'same_member',
  'change_touches_part',
  'bare_part',
  'unclear',
];

/** The answer for one change against another to the same registered part. */
function changePair(x: PolicyChange, y: PolicyChange): OverlapReason {
  // Text collisions in a shared file are the radar's job; the meaning isn't shared.
  if (x.kind === 'file') return 'file_only';
  // An endpoint key names one endpoint, so the same key is the same member.
  if (x.kind === 'endpoint') return 'same_member';
  // An `other` part has no structure to reason about.
  if (x.kind === 'other') return 'unclear';
  if (x.member === null || y.member === null) return 'bare_part';
  if (x.member === y.member) return 'same_member';
  return x.change === 'add' && y.change === 'add' ? 'different_members' : 'change_touches_part';
}

/**
 * Classify two items' declarations. Null when they share no part. The order
 * matters: a dispute always reaches the owner, then the owner's setting
 * applies, and only then the automatic rules.
 */
export function classifyPair(
  aId: string,
  a: readonly PolicyChange[],
  bId: string,
  b: readonly PolicyChange[],
  mode: OverlapHandling,
): Classification | null {
  const inB = new Set(b.map((c) => c.base));
  const shared = new Set(a.filter((c) => inB.has(c.base)).map((c) => c.base));
  if (shared.size === 0) return null;
  const mine = a.filter((c) => shared.has(c.base));
  const theirs = b.filter((c) => shared.has(c.base));
  const parts = [...new Set([...mine, ...theirs].map((c) => c.part))].sort();
  const designed = [...mine, ...theirs].filter((c) => c.design_impact !== 'none');
  const evidence: OverlapEvidence = {
    changes: [
      ...mine.map((c) => ({ item: aId, part: c.part, change: c.change })),
      ...theirs.map((c) => ({ item: bId, part: c.part, change: c.change })),
    ],
    design_note: designed[0]?.design_note ?? null,
    text_conflict: [],
  };
  const done = (outcome: OverlapOutcome, reason: OverlapReason): Classification => ({
    outcome,
    reason,
    parts,
    evidence,
  });

  if ([...mine, ...theirs].some((c) => c.disputed)) return done('owner', 'disputed');
  if (mode === 'ask_every') return done('owner', 'setting');
  if (mode === 'ask_shared_data' && mine.some((c) => SHARED_DATA.includes(c.kind))) {
    return done('owner', 'setting');
  }

  const reasons = new Set<OverlapReason>();
  for (const x of mine) {
    for (const y of theirs) if (x.base === y.base) reasons.add(changePair(x, y));
  }
  const blocking = SEQUENCE_ORDER.find((r) => reasons.has(r));
  if (blocking) return done('sequence', blocking);
  return done('parallel', reasons.has('different_members') ? 'different_members' : 'file_only');
}

// ---- The setting ----

const SETTING_KEY = 'overlap_handling';

const isMode = (v: unknown): v is OverlapHandling =>
  (OVERLAP_HANDLING as readonly unknown[]).includes(v);

/** The global default; the built-in one until the owner picks another. */
export function defaultHandling(db: Db): OverlapHandling {
  const row = db.sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(SETTING_KEY) as
    { value: string | null } | undefined;
  if (!row?.value) return DEFAULT_OVERLAP_HANDLING;
  try {
    const parsed: unknown = JSON.parse(row.value);
    return isMode(parsed) ? parsed : DEFAULT_OVERLAP_HANDLING;
  } catch {
    return DEFAULT_OVERLAP_HANDLING;
  }
}

/** The project's override, else the global default. */
export function overlapHandling(db: Db, project: string): OverlapHandling {
  const row = db.sqlite
    .prepare('SELECT overlap_handling FROM projects WHERE key = ?')
    .get(project) as { overlap_handling: string | null } | undefined;
  return isMode(row?.overlap_handling) ? row.overlap_handling : defaultHandling(db);
}

/** Store the global default (`settings` holds JSON). */
export function writeDefaultHandling(db: Db, mode: OverlapHandling, now: string): void {
  db.sqlite
    .prepare(
      `INSERT INTO settings (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(SETTING_KEY, JSON.stringify(mode), now, now);
}

// ---- Attribution ----

/** The actor an automatic outcome is recorded as: Docket, never the owner or the agent. */
export const DOCKET_ACTOR: Actor = Object.freeze({
  kind: SYSTEM_ACTOR.kind,
  client: null,
  label: 'Docket',
});

/**
 * The same write, recorded as Docket: its events carry `decided_by: docket`.
 * Inside an owner's undoable change, undo.ts lets these events be reversed
 * with it, because each carries its inverse.
 */
export function asDocket(w: WriteContext): WriteContext {
  const docket = Object.create(w, {
    actor: { value: DOCKET_ACTOR },
    event: {
      value: (input: EventInput) =>
        w.event.call(docket, {
          ...input,
          data: { ...(input.data ?? {}), decided_by: 'docket' },
        }),
    },
  }) as WriteContext;
  return docket;
}

// ---- Words ----

/** Why, in a clause both tickets and the agents' notes can use. */
export const OVERLAP_REASON_TEXT: Record<OverlapReason, string> = {
  file_only: 'they only share files, so git and the radar check the lines',
  different_members: 'they add different members',
  same_member: 'they change the same member',
  change_touches_part: 'one changes or removes something in a part the other uses',
  bare_part: 'one could touch anything in the part',
  unclear: 'Docket can’t tell whether they collide',
  blocker_cycle: 'running them in order would create a dependency cycle',
  disputed: 'agents disagree about who owns the part',
  setting: 'your Overlap handling setting asks you',
};
