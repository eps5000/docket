/**
 * Giving existing epics their Release (owner decision 67; BUILD_SPEC §5.46).
 * Runs at every start, after the migrations and the sample seed, and is
 * idempotent: it only touches open epics (not Done, canceled or archived) that
 * have no Release yet. Each gets one of three outcomes:
 *
 * - **converted:** its obvious release ticket becomes the Release: the ticket
 *   marked as decision 64's finish line, or else the one open ticket titled
 *   "Release …". Links between it and its own epic go (the dependency is now
 *   automatic), and the epic's finish-line mark is cleared.
 * - **generated:** no candidate at all, so Docket creates "Release <title>".
 * - **ambiguous:** several tickets titled "Release …", or only a finish line
 *   guessed from the links (decision 64) that isn't titled as one. Docket
 *   creates the Release and marks it Needs shaping (decision 65), naming the
 *   candidates, so the producer chooses: keep it, or make a candidate the
 *   Release with `update_item type`, which replaces the generated one.
 *
 * Bugs, canceled and Done tickets are never converted. Everything is written
 * as Docket, in Activity.
 */
import {
  OPEN_STATUSES,
  RELEASE_TITLE_RE,
  SHAPING_NOTE_MAX,
  type ReleaseMigrationOutcome,
  type Status,
} from '@docket/shared';
import type { Db } from '../db/client.js';
import type { ItemRow } from './model.js';
import { compareKeys, createReleaseFor, dropEpicLinks } from './release.js';
import { typeInfoOf, type TypeInfo } from './ticket-types.js';
import type { StoredShaping } from './shaping.js';
import { SYSTEM_ACTOR, type Actor, type WriteContext, type WritePath } from './write.js';

/** Docket itself, as the actor of the migration's writes. */
export const DOCKET_ACTOR: Actor = { ...SYSTEM_ACTOR, label: 'Docket' };

const OPEN: ReadonlySet<Status> = new Set(OPEN_STATUSES);

interface TicketRow {
  id: string;
  title: string;
  status: Status;
  type: ItemRow['type'];
  type_info: string | null;
}

export interface Classified {
  outcome: ReleaseMigrationOutcome;
  /** converted: the ticket that becomes the Release. */
  convert?: string;
  /** ambiguous: the tickets that could be it. */
  candidates: string[];
  /** Why, in words, for Activity and the Needs shaping note. */
  why: string;
}

/** May become the Release: an open ticket that isn't a bug. */
const convertible = (t: TicketRow) => t.type !== 'Bug' && OPEN.has(t.status);

/** Decide what an epic gets (read-only). */
export function classifyEpic(db: Db, epic: Pick<ItemRow, 'id' | 'finish_line'>): Classified {
  const tickets = (
    db.sqlite
      .prepare(
        `SELECT id, title, status, type, type_info FROM items
         WHERE epic_id = ? AND archived_at IS NULL AND type NOT IN ('Epic', 'Release')`,
      )
      .all(epic.id) as TicketRow[]
  ).sort((a, b) => compareKeys(a.id, b.id));

  const mark = epic.finish_line ? tickets.find((t) => t.id === epic.finish_line) : undefined;
  if (mark && convertible(mark)) {
    return {
      outcome: 'converted',
      convert: mark.id,
      candidates: [],
      why: 'it was marked as the finish line',
    };
  }
  const titled = tickets.filter((t) => convertible(t) && RELEASE_TITLE_RE.test(t.title));
  if (mark) {
    // Marked, but Done or a bug now: the producer decides.
    const candidates = [...new Set([mark.id, ...titled.map((t) => t.id)])].sort(compareKeys);
    return {
      outcome: 'ambiguous',
      candidates,
      why: `the finish line it was marked with, ${mark.id}, is ${mark.status === 'done' ? 'already Done' : 'a bug'}`,
    };
  }
  if (titled.length === 1) {
    return {
      outcome: 'converted',
      convert: titled[0]!.id,
      candidates: [],
      why: 'it is titled as the release',
    };
  }
  if (titled.length > 1) {
    return {
      outcome: 'ambiguous',
      candidates: titled.map((t) => t.id),
      why: 'several tickets are titled as a release',
    };
  }
  const guessed = guessedFinishLines(db, tickets);
  if (guessed.length > 0) {
    return {
      outcome: 'ambiguous',
      candidates: guessed,
      why: `${guessed.length === 1 ? 'the finish line Docket guessed from the links isn’t' : 'the finish lines Docket guessed from the links aren’t'} titled as a release`,
    };
  }
  return { outcome: 'generated', candidates: [], why: 'it had no release ticket' };
}

/**
 * Decision 64's guess: an open, non-bug ticket that depends on another ticket
 * in the epic and that no other non-bug ticket in it depends on (canceled
 * tickets ignored on either end).
 */
function guessedFinishLines(db: Db, tickets: readonly TicketRow[]): string[] {
  if (tickets.length === 0) return [];
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const links = db.sqlite
    .prepare(
      `SELECT from_id, to_id FROM links WHERE type = 'blocks'
       AND from_id IN (SELECT value FROM json_each(?)) AND to_id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify([...byId.keys()]), JSON.stringify([...byId.keys()])) as {
    from_id: string;
    to_id: string;
  }[];
  const dependsOnSome = new Set<string>();
  const dependedOn = new Set<string>();
  for (const l of links) {
    const from = byId.get(l.from_id)!;
    const to = byId.get(l.to_id)!;
    if (from.status === 'canceled' || to.status === 'canceled') continue;
    dependsOnSome.add(to.id);
    if (to.type !== 'Bug') dependedOn.add(from.id);
  }
  return tickets
    .filter((t) => convertible(t) && dependsOnSome.has(t.id) && !dependedOn.has(t.id))
    .map((t) => t.id);
}

/** Turn `ticketId` into its epic's Release, in this write. */
export function convertToRelease(
  w: WriteContext,
  epic: Pick<ItemRow, 'id' | 'project_key' | 'finish_line'>,
  ticketId: string,
  why: string,
): void {
  const row = w.require('items', ticketId) as unknown as ItemRow;
  const before = typeInfoOf(row.type_info);
  const info: TypeInfo = { original: before?.original ?? row.type };
  w.update('items', ticketId, { type: 'Release', type_info: info, rollout: false });
  // Links with its own epic go: the dependency on every other ticket is automatic now.
  dropEpicLinks(w, { id: ticketId, project_key: epic.project_key }, epic.id);
  if (epic.finish_line) w.update('items', epic.id, { finish_line: null });
  w.event({
    type: 'item.updated',
    summary: `Docket made ${ticketId} the Release of epic ${epic.id}: ${why}`,
    item_id: ticketId,
    project_key: epic.project_key,
    data: { changed: { type: { old: row.type, new: 'Release' } }, release_of: epic.id },
    objects: [{ kind: 'item', id: epic.id }],
  });
}

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** Give each open epic without a Release its Release. Returns the epic IDs by outcome. */
export function ensureReleases(
  w: WriteContext,
  epicIds?: readonly string[],
): Record<ReleaseMigrationOutcome, string[]> {
  const out: Record<ReleaseMigrationOutcome, string[]> = {
    converted: [],
    generated: [],
    ambiguous: [],
  };
  const epics = w.db.sqlite
    .prepare(
      `SELECT e.* FROM items e JOIN projects p ON p.key = e.project_key
       WHERE e.type = 'Epic' AND e.archived_at IS NULL AND p.deleted_at IS NULL
         AND e.status NOT IN ('done', 'canceled')
         ${epicIds ? 'AND e.id IN (SELECT value FROM json_each(?))' : ''}
         AND NOT EXISTS (SELECT 1 FROM items r WHERE r.epic_id = e.id AND r.type = 'Release'
                         AND r.archived_at IS NULL)
       ORDER BY e.project_key, CAST(substr(e.id, instr(e.id, '-') + 1) AS INTEGER)`,
    )
    .all(...(epicIds ? [JSON.stringify(epicIds)] : [])) as ItemRow[];
  for (const epic of epics) {
    const c = classifyEpic(w.db, epic);
    if (c.outcome === 'converted') {
      convertToRelease(w, epic, c.convert!, c.why);
    } else if (c.outcome === 'generated') {
      createReleaseFor(w, epic);
    } else {
      const note = clip(
        `Choose this epic's Release: ${c.why} (${c.candidates.join(', ')}). Keep this one and fold their checks into its checklist, or make one of them the Release with update_item type Release, which replaces this one.`,
        SHAPING_NOTE_MAX,
      );
      const shaping: StoredShaping = { asked_by: 'agent', by: 'Docket', at: w.now, note };
      const id = createReleaseFor(w, epic, { shaping });
      w.event({
        type: 'item.updated',
        summary: `Docket couldn't tell which ticket is epic ${epic.id}'s release (${c.candidates.join(', ')}), so ${id} Needs shaping for the producer to choose`,
        item_id: epic.id,
        project_key: epic.project_key,
        data: { release: id, candidates: c.candidates },
        objects: [{ kind: 'item', id }],
      });
    }
    out[c.outcome].push(epic.id);
  }
  return out;
}

/** At start, after the migrations (and the sample seed): one write, logged when it did anything. */
export function ensureReleasesAtStart(
  write: WritePath,
  log: (line: string) => void,
): Record<ReleaseMigrationOutcome, string[]> {
  const { result } = write.run(
    { actor: DOCKET_ACTOR, operation: 'release_migration', args: {}, idempotencyKey: null },
    (w) => ensureReleases(w),
  );
  const n = result.converted.length + result.generated.length + result.ambiguous.length;
  if (n > 0) {
    log(
      `Gave ${n} open epic${n === 1 ? '' : 's'} a Release (decision 67): ${result.converted.length} converted, ${result.generated.length} generated, ${result.ambiguous.length} to choose (Needs shaping).`,
    );
  }
  return result;
}
