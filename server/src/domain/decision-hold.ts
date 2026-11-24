/**
 * Which recorded decision holds a parked run (owner decision 48; BUILD_SPEC
 * §5.26). Derived on read from the run's park reason and `decision_records`:
 * nothing is stored, and `waiting_on` is untouched.
 *
 * - A reason citing an **active** decision (`dec_…`) that applies to the item
 *   at any scope is settled: it is never an owner decision nobody asked for.
 * - Only **owner authority** stops a parked run escalating. An agent's own
 *   record can't silence an alert.
 * - When the owner withdraws or supersedes a cited decision, aging restarts
 *   from that moment, so lifting a pause doesn't raise a wall of alerts.
 * - **A paused project** (decision 53) holds every parked run in it, whether or
 *   not the reason cites the pause, and lifting it restarts their aging too.
 */
import type { DecisionRecord } from '@docket/shared';
import type { Db } from '../db/client.js';
import { inScopeOf, labelsOf, type ScopeSubject } from './decisions.js';
import { ms, type RunRow } from './model.js';
import { pauseLiftedAt, projectPause } from './project-pause.js';

const CITED = /\bdec_[a-z0-9]+/gi;

export interface DecisionHold {
  /** The active decision the reason cites that applies here, owner records first. */
  decision: Pick<DecisionRecord, 'id' | 'title' | 'authority'> | null;
  /** When the owner last lifted a decision this wait cites; null if none was. */
  lifted_at: string | null;
}

const NOT_HELD: DecisionHold = { decision: null, lifted_at: null };

/** The decision holding this run, if its park reason cites one that applies to its item. */
export function decisionHold(
  db: Db,
  run: Pick<RunRow, 'item_id'> & { parked_reason?: string | null },
): DecisionHold {
  const item = db.sqlite
    .prepare('SELECT id, project_key, type, epic_id FROM items WHERE id = ?')
    .get(run.item_id) as Omit<ScopeSubject, 'labels'> | undefined;
  if (!item) return NOT_HELD;
  // Decision 53: a paused project holds every parked run in it.
  const pause = projectPause(db, item.project_key);
  if (pause) {
    return {
      decision: { id: pause.decision_id, title: pause.title, authority: 'owner' },
      lifted_at: null,
    };
  }
  const pauseLifted = pauseLiftedAt(db, item.project_key);
  const cited = new Set((run.parked_reason?.match(CITED) ?? []).map((id) => id.toLowerCase()));
  if (cited.size === 0) return pauseLifted ? { decision: null, lifted_at: pauseLifted } : NOT_HELD;
  const records = inScopeOf(
    db,
    { ...item, labels: labelsOf(db, item.id) },
    { includeInactive: true },
  ).filter((d) => cited.has(d.id.toLowerCase()));
  // `inScopeOf` lists owner records first, so this prefers an owner's decision.
  const active = records.find((d) => d.status === 'active');
  const decision = active
    ? { id: active.id, title: active.title, authority: active.authority }
    : null;
  if (decision?.authority === 'owner') return { decision, lifted_at: null };
  const lifted = records.filter((d) => d.status !== 'active' && d.authority === 'owner');
  if (lifted.length === 0) return { decision, lifted_at: pauseLifted };
  const row = db.sqlite
    .prepare(
      `SELECT max(at) AS at FROM events WHERE project_key = ?
       AND type IN ('decision.withdrawn', 'decision.superseded')
       AND json_extract(data, '$.decision_id') IN (SELECT value FROM json_each(?))`,
    )
    .get(item.project_key, JSON.stringify(lifted.map((d) => d.id))) as { at: string | null };
  const latest =
    row.at && pauseLifted
      ? ms(row.at) > ms(pauseLifted)
        ? row.at
        : pauseLifted
      : (row.at ?? pauseLifted);
  return { decision, lifted_at: latest };
}

export const heldByOwner = (hold: DecisionHold) => hold.decision?.authority === 'owner';

/** When a wait's clock runs from: `since`, or the moment the owner lifted its decision. */
export const agingFrom = (since: string, hold: DecisionHold): string =>
  hold.lifted_at && ms(hold.lifted_at) > ms(since) ? hold.lifted_at : since;
