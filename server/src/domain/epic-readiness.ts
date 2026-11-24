/**
 * An epic starts only when its tickets are ready (owner decision 58; BUILD_SPEC
 * §5.41).
 *
 * **Known gaps.** A ticket can carry up to six things implementation will
 * settle (`items.known_gaps`). Moving a Planning ticket with open gaps to Ready
 * needs the owner's approval: an agent's `set_status ready` is refused and
 * Docket asks the owner through the question form ("Approve moving GF-1 to
 * Ready with these gaps?"), and the owner can also approve on the item page.
 * Approval records an owner decision on the ticket listing the gaps and moves
 * it to Ready. Changing a gap, or moving the ticket back to Planning, clears
 * the approval. The implementer reads them in `get_context` and records how
 * each was settled with `update_item known_gaps`.
 *
 * **The epic start check.** Claiming an epic that is Ready or Planning, or
 * moving it to In progress, is refused with `epic_not_ready` while any of its
 * non-archived tickets is in Inbox or Planning. An epic already In progress is
 * never blocked: resuming its claim works, and it shows "Started with N
 * unshaped tickets" instead. Ordinary tickets are unaffected.
 */
import {
  EPIC_WAYS_FORWARD,
  GAP_APPROVE_OPTION,
  GAP_KEEP_OPTION,
  LIMITS,
  QUESTION_FORM,
  ToolError,
  type EpicReadiness,
  type KnownGaps,
  type QuestionForm,
  type Status,
  type UnshapedTicket,
} from '@docket/shared';
import type { Db } from '../db/client.js';
import type { ServiceDeps } from './contracts.js';
import { newId } from './ids.js';
import { activeLead, callerName, ms, type ItemRow } from './model.js';
import { hasDeclared } from './shared-changes.js';
import { clearShaping, needsShapingOf } from './shaping.js';
import type { InverseOp, WriteContext } from './write.js';

// ---- Known gaps: storage ----

export interface StoredGap {
  gap: string;
  settled: string | null;
  settled_by?: string | null;
  settled_at?: string | null;
}

export interface StoredGaps {
  gaps: StoredGap[];
  approved: { decision_id: string; at: string } | null;
}

/** The stored value, from the raw column (JSON text) or an already parsed one. */
export function storedGaps(raw: unknown): StoredGaps | null {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<StoredGaps>;
  if (!Array.isArray(v.gaps) || v.gaps.length === 0) return null;
  return { gaps: v.gaps, approved: v.approved ?? null };
}

export const openGaps = (s: StoredGaps | null): StoredGap[] =>
  s ? s.gaps.filter((g) => !g.settled) : [];

/** What `get_item`, `get_context` and the item page show; undefined when it names none. */
export function knownGapsView(raw: unknown): KnownGaps | undefined {
  const s = storedGaps(raw);
  if (!s) return undefined;
  return {
    gaps: s.gaps.map((g, i) => ({ n: i + 1, gap: g.gap, settled: g.settled ?? null })),
    open: openGaps(s).length,
    approved: s.approved,
  };
}

/** The item's stored gaps, read fresh. */
export function gapsOf(db: Db, id: string): StoredGaps | null {
  const row = db.sqlite.prepare('SELECT known_gaps FROM items WHERE id = ?').get(id) as
    { known_gaps: string | null } | undefined;
  return storedGaps(row?.known_gaps ?? null);
}

/** True when the owner's approval covers every open gap: nothing more to ask. */
export const gapsCleared = (s: StoredGaps | null) =>
  openGaps(s).length === 0 || s?.approved != null;

const sameTexts = (a: readonly { gap: string }[], b: readonly { gap: string }[]) =>
  a.length === b.length && a.every((g, i) => g.gap === b[i]!.gap);

const UNSHAPED_STATUSES: readonly Status[] = ['inbox', 'planning'];

/**
 * `update_item known_gaps`: the new stored value. In Inbox or Planning the list
 * is replaced, and changing a gap clears the owner's approval. Past Planning
 * the gaps are fixed (the owner approved them, or the ticket had none): only
 * each one's `settled` note may change. A `settled` left out keeps its note.
 */
export function editGaps(
  w: WriteContext,
  item: Pick<ItemRow, 'id' | 'status'>,
  input: readonly { gap: string; settled?: string | undefined }[],
): { value: StoredGaps | null; changed: boolean } {
  const before = gapsOf(w.db, item.id);
  const current = before?.gaps ?? [];
  const who = callerName(w.db, w.actor);
  const shaping = UNSHAPED_STATUSES.includes(item.status);
  if (!shaping && !sameTexts(current, input)) {
    throw new ToolError(
      'validation',
      current.length === 0
        ? `${item.id} is ${item.status}, so it has no known gaps to add. To name gaps, move it back to Planning; moving it to Ready again then needs the owner's approval.`
        : `${item.id} is ${item.status}: the owner approved its known gaps, so you can only record how each was settled. Send the same ${current.length} gaps in order, each with settled.`,
      { details: { status: item.status, known_gaps: current.map((g) => g.gap) } },
    );
  }
  const gaps = input.map((g): StoredGap => {
    const old = current.find((c) => c.gap === g.gap);
    const settled = g.settled ?? old?.settled ?? null;
    const same = settled === (old?.settled ?? null);
    return {
      gap: g.gap,
      settled,
      settled_by: same ? (old?.settled_by ?? null) : settled ? who : null,
      settled_at: same ? (old?.settled_at ?? null) : settled ? w.now : null,
    };
  });
  const textsKept = sameTexts(current, gaps);
  const value: StoredGaps | null =
    gaps.length === 0 ? null : { gaps, approved: textsKept ? (before?.approved ?? null) : null };
  const changed = JSON.stringify(value) !== JSON.stringify(before);
  return { value, changed };
}

// ---- Known gaps: asking the owner ----

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** The question Docket asks for a Planning ticket with open gaps (decision 47's form). */
export function gapsQuestion(
  item: Pick<ItemRow, 'id' | 'title'>,
  gaps: readonly string[],
  who: string,
): { text: string; form: QuestionForm } {
  const list = gaps.map((g, i) => `${i + 1}) ${g}`).join('; ');
  return {
    text: `Approve moving ${item.id} to Ready with these gaps?`,
    form: {
      context: clip(
        `${who} shaped ${item.id} “${item.title}” but left ${gaps.length === 1 ? 'one thing' : `${gaps.length} things`} to settle during implementation: ${list}.`,
        QUESTION_FORM.context,
      ),
      why_it_matters:
        'A ticket in Planning still has gaps, and its epic can’t start until every ticket is Ready. Approving lets this one count as Ready now, and the implementer settles each gap and records how.',
      options: [
        {
          label: GAP_APPROVE_OPTION,
          description: `Move ${item.id} to Ready now, with these gaps recorded as your decision on it.`,
          consequences:
            'Its epic can start. The implementer shapes each gap during the work and records how it was settled.',
          recommended: true,
        },
        {
          label: GAP_KEEP_OPTION,
          description: `Leave ${item.id} in Planning until someone shapes these gaps.`,
          consequences: 'Its epic can’t start until this ticket is Ready.',
        },
      ],
      recommendation_reason:
        'The agent that shaped it judged these gaps safe to settle during implementation.',
      details: null,
      ready_with_gaps: { gaps: [...gaps] },
    },
  };
}

interface OpenQuestion {
  id: string;
  form: string | null;
}

/** The item's open question, and whether it is the known-gaps one. */
function questionState(db: Db, id: string) {
  const open = db.sqlite
    .prepare(
      'SELECT id, form FROM questions WHERE item_id = ? AND answered_at IS NULL AND withdrawn_at IS NULL ORDER BY created_at DESC LIMIT 1',
    )
    .get(id) as OpenQuestion | undefined;
  const unread = db.sqlite
    .prepare(
      'SELECT id FROM questions WHERE item_id = ? AND answered_at IS NOT NULL AND read_by_agent_at IS NULL LIMIT 1',
    )
    .get(id) as { id: string } | undefined;
  const isGaps = (q: OpenQuestion) => !!q.form && q.form.includes('"ready_with_gaps"');
  return { open, gapsAsked: !!open && isGaps(open), unread: !!unread };
}

/**
 * The refusal of an agent's `set_status ready` on a Planning ticket with open,
 * unapproved gaps. The move rolls back, so the adapter writes
 * `recordRejection`: the question to the owner, unless one is already open.
 */
export class GapsRefusal extends ToolError {
  readonly recordRejection: (w: WriteContext) => void;
  constructor(db: Db, item: Pick<ItemRow, 'id' | 'title' | 'project_key'>, gaps: StoredGaps) {
    const open = openGaps(gaps).map((g) => g.gap);
    const state = questionState(db, item.id);
    const n = `${open.length} open known gap${open.length === 1 ? '' : 's'}`;
    const asks = !state.open && !state.unread;
    const tail = state.gapsAsked
      ? `Docket already asked the owner to approve them; the answer arrives in get_item. Leave ${item.id} in Planning until then.`
      : state.unread
        ? `Read the owner's latest answer with get_item first, then try again.`
        : state.open
          ? `${item.id} has another open question; once the owner answers it, try again and Docket will ask about the gaps.`
          : `Docket asked the owner: “Approve moving ${item.id} to Ready with these gaps?” The answer arrives in get_item, and if they approve, ${item.id} moves to Ready. Until then leave it in Planning, or settle the gaps (update_item known_gaps) and try again.`;
    super(
      'forbidden',
      `${item.id} has ${n}, so moving it to Ready needs the owner's approval. ${tail}`,
      {
        details: {
          known_gaps: open,
          asked: asks || state.gapsAsked,
          ...(state.open ? { question_id: state.open.id } : {}),
          ask: 'the owner',
        },
      },
    );
    this.name = 'GapsRefusal';
    this.recordRejection = (w) => {
      if (!asks) return;
      askAboutGaps(w, item, open);
    };
  }
}

/** Insert Docket's question for the gaps, as `ask_owner` would, for the caller. */
function askAboutGaps(
  w: WriteContext,
  item: Pick<ItemRow, 'id' | 'title' | 'project_key'>,
  gaps: readonly string[],
): void {
  const state = questionState(w.db, item.id);
  if (state.open || state.unread) return;
  const who = callerName(w.db, w.actor);
  const { text, form } = gapsQuestion(item, gaps, who);
  // The asking run: the caller's own lead here, if it has one (a planner usually doesn't).
  const lead = activeLead(w.db, item.id);
  const runId = lead && w.actor.kind === 'agent' && lead.client === w.actor.client ? lead.id : null;
  const id = newId('q', ms(w.now));
  w.insert('questions', {
    id,
    item_id: item.id,
    run_id: runId,
    text,
    asked_by: who,
    answer: null,
    answered_at: null,
    read_by_agent_at: null,
    form: JSON.stringify(form),
    answer_choice: null,
  });
  if (runId && lead?.state === 'open') w.update('runs', runId, { state: 'needs_input' });
  w.event({
    type: 'question.asked',
    summary: `${who} asks: “${text}”`,
    item_id: item.id,
    project_key: item.project_key,
    data: { question_id: id, run_id: runId, known_gaps: gaps },
    objects: [{ kind: 'question', id }, ...(runId ? [{ kind: 'run' as const, id: runId }] : [])],
  });
}

/** Throw `GapsRefusal` when an agent's Planning → Ready move still needs the owner. */
export function assertGapsApproved(w: WriteContext, item: ItemRow): void {
  const gaps = gapsOf(w.db, item.id);
  if (!gaps || gapsCleared(gaps)) return;
  throw new GapsRefusal(w.db, item, gaps);
}

// ---- Known gaps: the owner's approval ----

/**
 * The owner approves a ticket's open gaps: an owner decision on the ticket
 * listing them, and `approved` on the stored value. With `move`, a Planning
 * ticket whose shared changes are declared also moves to Ready (the question);
 * on the item page the owner's status move does it. Every write carries
 * its inverse, so the owner's action is one undo.
 */
export function approveGaps(
  w: WriteContext,
  deps: ServiceDeps,
  item: ItemRow,
  opts: { via: 'question' | 'item_page'; note?: string | null; move: boolean },
): { decision_id: string; moved: boolean } {
  if (w.actor.kind !== 'owner') {
    throw new ToolError(
      'forbidden',
      'Only the owner can approve known gaps. To ask, use set_status ready.',
    );
  }
  const gaps = gapsOf(w.db, item.id);
  const open = openGaps(gaps);
  if (!gaps || open.length === 0) {
    throw new ToolError('validation', `${item.id} has no open known gaps to approve.`, {
      details: { known_gaps: [] },
    });
  }
  if (item.status !== 'planning') {
    throw new ToolError(
      'validation',
      `${item.id} is ${item.status}; known gaps are approved when a Planning ticket moves to Ready.`,
      { details: { status: item.status } },
    );
  }
  const record = deps.services().decisions.publish(w, {
    project: item.project_key,
    scope: { kind: 'item', id: item.id },
    title: clip(`Ready with known gaps: ${item.id}`, LIMITS.decision_title),
    decision: clip(
      `Move ${item.id} to Ready with these known gaps, settled during implementation:\n${open.map((g) => `- ${g.gap}`).join('\n')}`,
      LIMITS.decision_md,
    ),
    ...(opts.note ? { rationale: clip(opts.note, LIMITS.rationale_md) } : {}),
  });
  const approved = { decision_id: record.id, at: w.now };
  const moved = opts.move && hasDeclared(w.db, item.id);
  const set: Record<string, unknown> = { known_gaps: { ...gaps, approved } };
  if (moved) Object.assign(set, { status: 'ready' }, clearShaping(w.db, item.id));
  const inverse: InverseOp[] = [w.update('items', item.id, set)];
  const how = opts.via === 'question' ? 'in your answer' : 'on the item page';
  w.event({
    type: moved ? 'item.status_changed' : 'item.updated',
    summary: moved
      ? `You approved ${item.id}'s ${open.length} known gap${open.length === 1 ? '' : 's'} ${how} and moved it from planning to ready`
      : `You approved ${item.id}'s ${open.length} known gap${open.length === 1 ? '' : 's'} ${how}`,
    item_id: item.id,
    project_key: item.project_key,
    data: {
      ...(moved ? { status: { old: 'planning', new: 'ready' } } : { fields: ['known_gaps'] }),
      known_gaps: { approved: record.id, gaps: open.map((g) => g.gap) },
    },
    inverse,
    objects: [{ kind: 'decision', id: record.id }],
  });
  if (opts.via === 'item_page') answerGapsQuestion(w, item);
  return { decision_id: record.id, moved };
}

/** Approving on the item page answers Docket's open question about the gaps, so it leaves Needs you. */
function answerGapsQuestion(w: WriteContext, item: ItemRow): void {
  const state = questionState(w.db, item.id);
  if (!state.open || !state.gapsAsked) return;
  const choice = {
    option: GAP_APPROVE_OPTION,
    recommended: true,
    note: 'Approved on the item page.',
  };
  const inverse = w.update('questions', state.open.id, {
    answer: `Chose: ${GAP_APPROVE_OPTION} (the recommended option). Note: Approved on the item page.`,
    answer_choice: JSON.stringify(choice),
    answered_at: w.now,
  });
  w.event({
    type: 'question.answered',
    summary: `You answered: “${GAP_APPROVE_OPTION}” on the item page`,
    item_id: item.id,
    project_key: item.project_key,
    data: { question_id: state.open.id },
    objects: [{ kind: 'question', id: state.open.id }],
    inverse: [inverse],
  });
}

/**
 * The answer hook: picking "Approve with these gaps" on Docket's question
 * approves them, when the ticket is still in Planning with the same open gaps.
 * Otherwise the answer is just delivered, and the agent asks again.
 */
export function onGapsAnswer(
  w: WriteContext,
  deps: ServiceDeps,
  itemId: string,
  form: QuestionForm | null,
  choice: { option: string; note: string | null } | null,
): void {
  if (!form?.ready_with_gaps || choice?.option !== GAP_APPROVE_OPTION) return;
  const item = w.require('items', itemId) as unknown as ItemRow;
  const gaps = gapsOf(w.db, item.id);
  const open = openGaps(gaps).map((g) => g.gap);
  const asked = form.ready_with_gaps.gaps;
  if (item.status !== 'planning' || open.length === 0 || gaps?.approved) return;
  if (open.length !== asked.length || open.some((g, i) => g !== asked[i])) return;
  approveGaps(w, deps, item, { via: 'question', note: choice.note, move: true });
}

/** Moving back to Planning clears the approval: the next Ready needs it again. */
export function clearApproval(db: Db, id: string): Record<string, unknown> {
  const gaps = gapsOf(db, id);
  return gaps?.approved ? { known_gaps: { ...gaps, approved: null } } : {};
}

// ---- The epic start check ----

/** Each epic's non-archived Inbox and Planning tickets, by ID. */
export function unshapedByEpic(db: Db, epicIds?: readonly string[]): Map<string, UnshapedTicket[]> {
  const rows = db.sqlite
    .prepare(
      `SELECT id, title, status, epic_id, type, archived_at, shaping FROM items
       WHERE epic_id IS NOT NULL AND archived_at IS NULL AND status IN ('inbox', 'planning')
         AND type <> 'Epic'
         ${epicIds ? 'AND epic_id IN (SELECT value FROM json_each(?))' : ''}`,
    )
    .all(...(epicIds ? [JSON.stringify(epicIds)] : [])) as (UnshapedTicket & {
    epic_id: string;
    type: ItemRow['type'];
    archived_at: string | null;
    shaping: string | null;
  })[];
  // Decision 65: the ones waiting for a planner are marked.
  const shaping = needsShapingOf(db, rows);
  const out = new Map<string, UnshapedTicket[]>();
  for (const r of rows) {
    const list = out.get(r.epic_id) ?? [];
    list.push({
      id: r.id,
      title: r.title,
      status: r.status,
      ...(shaping.has(r.id) ? { needs_shaping: true as const } : {}),
    });
    out.set(r.epic_id, list);
  }
  for (const list of out.values()) list.sort((a, b) => compareKeys(a.id, b.id));
  return out;
}

/** GF-2 before GF-10. */
function compareKeys(a: string, b: string): number {
  const [pa, na] = splitKey(a);
  const [pb, nb] = splitKey(b);
  return pa.localeCompare(pb) || na - nb || a.localeCompare(b);
}
function splitKey(id: string): [string, number] {
  const m = /^(.*?)-(\d+)$/.exec(id);
  return m ? [m[1]!, Number(m[2])] : [id, 0];
}

const NOT_STARTED: readonly Status[] = ['inbox', 'planning', 'ready'];
const STARTED: readonly Status[] = ['progress', 'review'];

/** Not ready (before it starts) or started unshaped; null when every ticket is at least Ready. */
export function readinessOf(
  epic: { status: Status },
  unshaped: readonly UnshapedTicket[] | undefined,
): EpicReadiness | null {
  if (!unshaped || unshaped.length === 0) return null;
  if (NOT_STARTED.includes(epic.status)) return { state: 'not_ready', unshaped: [...unshaped] };
  if (STARTED.includes(epic.status)) return { state: 'started_unshaped', unshaped: [...unshaped] };
  return null;
}

/** One epic's readiness. */
export function epicReadiness(db: Db, epic: Pick<ItemRow, 'id' | 'type' | 'status'>) {
  if (epic.type !== 'Epic') return null;
  return readinessOf(epic, unshapedByEpic(db, [epic.id]).get(epic.id));
}

const STATUS_WORD: Record<UnshapedTicket['status'], string> = {
  inbox: 'Inbox',
  planning: 'Planning',
};

/** The `epic_not_ready` refusal: which tickets, and the four ways forward. */
export function epicNotReady(epic: Pick<ItemRow, 'id'>, unshaped: readonly UnshapedTicket[]) {
  const n = unshaped.length;
  const shown = unshaped
    .slice(0, 5)
    .map((t) => `${t.id} (${STATUS_WORD[t.status]})`)
    .join(', ');
  const more = n > 5 ? ` and ${n - 5} more` : '';
  return new ToolError(
    'epic_not_ready',
    `Epic ${epic.id} can't start: ${n} of its tickets ${n === 1 ? "isn't" : "aren't"} Ready yet: ${shown}${more}. Every ticket must be at least Ready before an epic starts. For each one: ${EPIC_WAYS_FORWARD.join('; or ')}.`,
    {
      details: {
        epic: epic.id,
        unshaped: unshaped.map((t) => ({ id: t.id, title: t.title, status: t.status })),
        ways_forward: ['shape', 'known_gaps', 'move', 'remove'],
      },
    },
  );
}

/**
 * Throw `epic_not_ready` when starting this epic: its lead claim while it is
 * Ready or Planning, or moving it to In progress. An epic already In progress
 * (or anything that isn't an epic) passes.
 */
export function assertEpicReady(db: Db, item: Pick<ItemRow, 'id' | 'type' | 'status'>): void {
  if (item.type !== 'Epic' || (item.status !== 'ready' && item.status !== 'planning')) return;
  const unshaped = unshapedByEpic(db, [item.id]).get(item.id);
  if (unshaped && unshaped.length > 0) throw epicNotReady(item, unshaped);
}
