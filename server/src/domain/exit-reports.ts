/**
 * Implementers report how they finished (owner decision 61; BUILD_SPEC §5.42).
 *
 * `park_run`, `release_lead` and `finish_run` take an optional `exit`, and
 * closing a ticket as Done records a complete one. A run's exit report lives
 * on the run (`runs.exit_report`), with the seq of the event that recorded it.
 *
 * A **partial** exit waits on the producer until someone acts on the ticket
 * after it. That is derived from the ticket's own record, never stored, so it
 * can't drift: an acceptance edit or a split (`moved`), a new link (`linked`),
 * a new lead (`started`), a question to the owner on the ticket or its epic
 * (`asked`), a note (`noted`), or the ticket closed (`closed`). The run's own
 * later writes don't count.
 *
 * While it waits, `get_digest` lists it as *Finished partly*, the card and
 * the item page say "Finished partly: N items left", and an agent can't
 * close the ticket as Done.
 */
import {
  EXIT_SETTLE_TEXT,
  ToolError,
  finishedPartlyText,
  type ExitLeft,
  type ExitOutcome,
  type ExitReport,
  type ExitSettleKind,
  type ExitVia,
  type ToolInput,
} from '@docket/shared';
import type { Db } from '../db/client.js';
import { actorName, type RunRow } from './model.js';
import type { WriteContext } from './write.js';

/** The summary of a run whose lease ran out, in place of its last "doing" line. */
export const LEASE_EXPIRED_SUMMARY = 'Lease expired: the run stopped reporting';

/** What `runs.exit_report` holds. */
export interface StoredExit {
  outcome: ExitOutcome;
  left: ExitLeft[];
  via: ExitVia;
  at: string;
  /** The seq of the event that recorded it: what happened after it can settle it. */
  seq: number;
}

/** The `exit` argument park_run, release_lead and finish_run take. */
export type ExitInput = NonNullable<ToolInput<'finish_run'>['exit']>;

export function storedExit(row: Pick<RunRow, 'exit_report'>): StoredExit | null {
  if (!row.exit_report) return null;
  try {
    const value = JSON.parse(row.exit_report) as StoredExit;
    return value && (value.outcome === 'complete' || value.outcome === 'partial') ? value : null;
  } catch {
    return null;
  }
}

/** The items left, as stored: `item` is null when no ticket was named. */
export function leftOf(input: ExitInput | undefined): ExitLeft[] {
  return (input?.left ?? []).map((x) => ({
    text: x.text,
    why: x.why,
    needs: x.needs,
    item: x.item ?? null,
  }));
}

/**
 * Check the tickets an exit names exist: a typo there would send the producer
 * to the wrong place.
 */
export function checkExit(db: Db, input: ExitInput | undefined): void {
  for (const [i, x] of (input?.left ?? []).entries()) {
    if (!x.item) continue;
    const found = db.sqlite.prepare('SELECT 1 FROM items WHERE id = ?').get(x.item);
    if (!found) {
      throw new ToolError(
        'not_found',
        `exit.left[${i}].item: no item ${x.item}. Name the ticket that would finish it, or leave item out.`,
        { details: { fields: { [`exit.left.${i}.item`]: 'no such item' } } },
      );
    }
  }
}

/**
 * Record a run's exit after the event that ended or parked it. A partial exit
 * also appends `run.finished_partly`, which the relay mails to the producer.
 */
export function recordExit(
  w: WriteContext,
  run: RunRow,
  item: { id: string; project_key: string },
  input: { outcome: ExitOutcome; left: ExitLeft[] },
  via: ExitVia,
  seq: number,
): StoredExit {
  let at = seq;
  if (input.outcome === 'partial') {
    const who = actorName({ kind: 'agent', client: run.client, label: run.label });
    at = w.event({
      type: 'run.finished_partly',
      summary: `${who} ${finishedPartlyText(input.left.length).replace('Finished', 'finished')} on ${item.id}: ${input.left.map((x) => x.text).join('; ')}`,
      item_id: item.id,
      project_key: item.project_key,
      data: {
        run_id: run.id,
        via,
        left: input.left,
        ...(run.producer ? { producer: run.producer } : {}),
      },
      objects: [
        { kind: 'run', id: run.id },
        ...[...new Set(input.left.flatMap((x) => (x.item ? [x.item] : [])))].map((id) => ({
          kind: 'item' as const,
          id,
        })),
      ],
    });
  }
  const stored: StoredExit = { outcome: input.outcome, left: input.left, via, at: w.now, seq: at };
  w.update('runs', run.id, { exit_report: stored });
  return stored;
}

/** Just enough of an exit to word a summary. */
export type ExitShape = { outcome: ExitOutcome; left: readonly unknown[] };

/** "Finished partly: 2 items left · Parked: <reason>", the line a parked run shows. */
export function parkedSummary(reason: string, exit: ExitShape | null) {
  const parked = `Parked: ${reason}`;
  return exit?.outcome === 'partial'
    ? `${finishedPartlyText(exit.left.length)} · ${parked}`
    : parked;
}

/** A partial exit's lead line in front of an ending's own words. */
export function endedSummary(text: string, exit: ExitShape | null) {
  return exit?.outcome === 'partial' ? `${finishedPartlyText(exit.left.length)} · ${text}` : text;
}

interface SettleRow {
  seq: number;
  at: string;
  type: string;
  item_id: string;
  actor_kind: string;
  client: string | null;
  label: string | null;
  run_id: string | null;
  acceptance: number;
  new_status: string | null;
}

/** The first thing someone did on the ticket after a partial exit, or null while it waits. */
export function settledOf(
  db: Db,
  run: Pick<RunRow, 'id' | 'item_id'>,
  exit: StoredExit,
): ExitReport['settled'] {
  if (exit.outcome !== 'partial') return null;
  const epic = (
    db.sqlite.prepare('SELECT epic_id FROM items WHERE id = ?').get(run.item_id) as
      { epic_id: string | null } | undefined
  )?.epic_id;
  const rows = db.sqlite
    .prepare(
      `SELECT seq, at, type, item_id, actor_kind, client, label, run_id,
              json_extract(data, '$.changed.acceptance') IS NOT NULL AS acceptance,
              json_extract(data, '$.status.new') AS new_status
       FROM events
       WHERE seq > @seq AND (item_id = @item OR (item_id = @epic AND type = 'question.asked'))
         AND type IN ('item.updated', 'item.split', 'link.added', 'claim.granted', 'question.asked',
                      'note.added', 'owner_note.added', 'item.status_changed')
         AND (run_id IS NULL OR run_id <> @run)
       ORDER BY seq`,
    )
    .all({ seq: exit.seq, item: run.item_id, epic: epic ?? '', run: run.id }) as SettleRow[];
  for (const e of rows) {
    const how = settleKind(e);
    if (!how) continue;
    return {
      how,
      at: e.at,
      by: actorName({
        kind: e.actor_kind as 'owner' | 'agent' | 'system',
        client: e.client,
        label: e.label,
      }),
    };
  }
  return null;
}

function settleKind(e: SettleRow): ExitSettleKind | null {
  switch (e.type) {
    case 'item.updated':
      return e.acceptance ? 'moved' : null;
    case 'item.split':
      return 'moved';
    case 'link.added':
      return 'linked';
    case 'claim.granted':
      return 'started';
    case 'question.asked':
      return 'asked';
    case 'note.added':
    case 'owner_note.added':
      return 'noted';
    case 'item.status_changed':
      return e.new_status === 'done' || e.new_status === 'canceled' ? 'closed' : null;
    default:
      return null;
  }
}

/** A run's exit report as agents and the UI see it; undefined when it has none. */
export function exitReportOf(db: Db, run: RunRow): ExitReport | undefined {
  const exit = storedExit(run);
  if (!exit) return undefined;
  return {
    outcome: exit.outcome,
    left: exit.left,
    via: exit.via,
    at: exit.at,
    settled: settledOf(db, run, exit),
  };
}

/** A lead's partial exit still waiting on the producer, with the run it came from. */
export interface OpenPartialExit {
  run: RunRow;
  exit: StoredExit;
}

/**
 * The ticket's latest lead run with an exit, when that exit is partial, the
 * run is parked or ended, and nobody has acted on it since.
 */
export function openPartialExit(db: Db, itemId: string): OpenPartialExit | null {
  const run = db.sqlite
    .prepare(
      `SELECT * FROM runs WHERE item_id = ? AND is_lead = 1 AND exit_report IS NOT NULL
       ORDER BY json_extract(exit_report, '$.seq') DESC LIMIT 1`,
    )
    .get(itemId) as RunRow | undefined;
  if (!run || run.state === 'open' || run.state === 'needs_input') return null;
  const exit = storedExit(run);
  if (!exit || exit.outcome !== 'partial') return null;
  return settledOf(db, run, exit) ? null : { run, exit };
}

/** Every open partial exit in a project, newest first (the digest's Finished partly). */
export function openPartialExits(db: Db, project: string): OpenPartialExit[] {
  const items = db.sqlite
    .prepare(
      `SELECT DISTINCT r.item_id FROM runs r JOIN items i ON i.id = r.item_id
       WHERE i.project_key = ? AND r.is_lead = 1
         AND json_extract(r.exit_report, '$.outcome') = 'partial'`,
    )
    .all(project) as { item_id: string }[];
  return items
    .map((x) => openPartialExit(db, x.item_id))
    .filter((x): x is OpenPartialExit => x !== null)
    .sort((a, b) => b.exit.seq - a.exit.seq);
}

/**
 * Decision 61: an agent can't close a ticket as Done while a partial exit's
 * items are left. The refusal names them and the ways forward.
 */
export function assertNoItemsLeft(db: Db, item: { id: string }, callerRunId?: string | null): void {
  const open = openPartialExit(db, item.id);
  // The run that reported them closing the ticket itself says they are done after all.
  if (!open || open.run.id === callerRunId) return;
  const n = open.exit.left.length;
  throw new ToolError(
    'validation',
    `Can't close ${item.id} as Done: ${finishedPartlyText(n).toLowerCase()} by ${actorName({ kind: 'agent', client: open.run.client, label: open.run.label })} (${open.exit.left.map((x) => x.text).join('; ')}). Remove ${n === 1 ? 'it' : 'them'} from the acceptance criteria with update_item and add_note saying which and why, or move ${n === 1 ? 'it' : 'them'} to the ticket that can do ${n === 1 ? 'it' : 'them'} (split, or link that ticket); then close.`,
    {
      details: {
        reason: 'items_left',
        run_id: open.run.id,
        left: open.exit.left,
        ways_forward: ['remove_with_note', 'move', 'link', 'ask_owner'],
      },
    },
  );
}

/** "Settled: the items were moved (claude · producer)". */
export function settledText(settled: NonNullable<ExitReport['settled']>): string {
  return `Settled: ${EXIT_SETTLE_TEXT[settled.how]} (${settled.by})`;
}
