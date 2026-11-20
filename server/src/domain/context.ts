/**
 * The context bundle (BUILD_SPEC §5.15; MCP_SPEC §5.2 `get_context`;
 * FR-040): everything an agent needs to work on an item, in one bounded,
 * read-only response.
 *
 * **Sections, in priority order:**
 * 1. essentials: title, status, outcome, acceptance, the open question and
 *    its answer, and a *count* of unread owner notes (never delivered here:
 *    `get_item` delivers them and marks them read);
 * 2. active decision records in scope, owner records first (decisions.ts
 *    `inScopeOf`, the one scope rule);
 * 3. the epic's outcome, and the briefs of the item's labels;
 * 4. blockers (cleared or what each waits for, from B11's `BlockIndex`)
 *    and dependents. `blocked_by` is a safety fact (MCP_SPEC §3.1: the
 *    text says "none" when it is empty), so unresolved blockers are kept
 *    with the essentials; only cleared ones and dependents can be cut;
 * 4b. the current step (decision 33): the step in state `current`, else the
 *    first `todo`, with its details, cut inline with a marker that points
 *    at `get_step`, or left out with one when nothing of it fits;
 * 4c. shared changes (decision 36): the item's declaration, other in-flight
 *    items' declared changes to its parts, up to 30 other in-flight
 *    declarations, its leases and radar findings (`get_context.shared`);
 *    rendered after the Workflow notes, cut before them;
 * 5. the project's Workflow notes (decision 29; agent-files.ts), the
 *    current non-empty version: placed after sections 1–4, so it is the
 *    first of 1–5 to be cut; a cut is marked inline (`…truncated`), and
 *    notes left out entirely get a `…truncated; workflow notes …` line;
 * 6. Markdown planning documents on the item and its epic, newest version
 *    of each: text until the budget runs out, then names and versions;
 * 7. the latest decided review round: its verdicts and notes.
 *
 * **Budgets:** `small` 1,000, `medium` 3,000, `large` 8,000 tokens, counted
 * as characters ÷ 4 on the compact text (`renderContext`, the exact text
 * block the tool returns). Sections are filled in order, so essentials and
 * decisions are never cut while anything below them is kept. A cut is
 * always marked: a `…` at the cut, and a `…truncated; <what>; <how to read
 * it>` line (a planning document's own line says which version to read).
 *
 * Every fit check renders the bundle with the markers of the sections not
 * yet placed counted as if they were omitted, so the final text can only
 * be smaller than the last check.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderContext, type ContextBundle, type ContextShared, type Status } from '@docket/shared';
import type { ContextService, ReadContext, ServiceDeps } from './contracts.js';
import { currentWorkflow } from './agent-files.js';
import { inScopeOf, labelsOf } from './decisions.js';
import { BlockIndex, currentSteps, requireItem } from './model.js';

/** Approximate tokens per budget (BUILD_SPEC §5.15). */
export const CONTEXT_BUDGETS = { small: 1_000, medium: 3_000, large: 8_000 } as const;

/** The smallest piece of cut text worth showing (shorter, and it is left out). */
const MIN_CUT = 40;

type Bundle = ContextBundle;
type Decision = Bundle['decisions'][number];
type Doc = Bundle['planning_docs'][number];
type Step = NonNullable<Bundle['current_step']>;

/** `text` cut to at most `n` characters, at a word boundary when one is near, ending in `…`. */
export function cutText(text: string, n: number): string {
  if (text.length <= n) return text;
  let head = text.slice(0, Math.max(0, n - 1));
  const space = head.search(/\s\S*$/);
  if (space > n * 0.8) head = head.slice(0, space);
  return `${head.trimEnd()}…`;
}

/**
 * The longest cut of `text` (≥ MIN_CUT characters) for which `fits(cut)`
 * holds, or null when none does. Binary search: fitting is monotonic in length.
 */
function longestFit(text: string, fits: (cut: string) => boolean): string | null {
  let lo = MIN_CUT;
  let hi = text.length - 1;
  let best: string | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cut = cutText(text, mid);
    if (fits(cut)) {
      best = cut;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

const firstLine = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0) ?? '';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function createContextService(deps: ServiceDeps): ContextService {
  return {
    getContext(r, input) {
      return assemble(r, deps, input.id, input.budget ?? 'medium');
    },
  };
}

/** Everything the bundle could hold, before the budget is applied. */
interface Full {
  item: Bundle['item'];
  decisions: Decision[];
  epic: Bundle['epic'];
  labels: Bundle['labels'];
  blockers: Bundle['blockers'];
  dependents: Bundle['dependents'];
  step: Step | null;
  workflow: Bundle['workflow'];
  shared: ContextShared;
  docs: (Doc & { full: string | null })[];
  last_review: Bundle['last_review'];
}

function gather(r: ReadContext, deps: ServiceDeps, id: string): Full {
  const { db } = r;
  const sql = db.sqlite;
  const row = requireItem(db, id);
  const labels = labelsOf(db, row.id);

  const question = sql
    .prepare(
      `SELECT id, text, created_at, answer, answered_at FROM questions
       WHERE item_id = ? AND (answered_at IS NULL OR read_by_agent_at IS NULL)
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(row.id) as
    | {
        id: string;
        text: string;
        created_at: string;
        answer: string | null;
        answered_at: string | null;
      }
    | undefined;
  // Counted, never delivered (§5.15): `get_item` marks them read.
  const notes = sql
    .prepare('SELECT count(*) AS n FROM owner_notes WHERE item_id = ? AND read_by_agent_at IS NULL')
    .get(row.id) as { n: number };
  const acceptance = (
    sql
      .prepare('SELECT text FROM acceptance_criteria WHERE item_id = ? ORDER BY position, id')
      .all(row.id) as { text: string }[]
  ).map((a) => a.text);

  const epicRow = row.epic_id
    ? (sql.prepare('SELECT id, title, outcome_md FROM items WHERE id = ?').get(row.epic_id) as
        { id: string; title: string; outcome_md: string } | undefined)
    : undefined;

  const labelRows = sql
    .prepare(
      `SELECT name, brief_md FROM labels WHERE project_key = ? AND name IN (SELECT value FROM json_each(?)) ORDER BY name`,
    )
    .all(row.project_key, JSON.stringify(labels)) as { name: string; brief_md: string }[];

  // Blockers and dependents, judged by the one evaluator (B11's BlockIndex).
  const index = new BlockIndex(db);
  const core = (otherId: string) =>
    sql.prepare('SELECT id, title, status, outcome_md FROM items WHERE id = ?').get(otherId) as {
      id: string;
      title: string;
      status: Status;
      outcome_md: string;
    };
  const blockers = (index.blockers.get(row.id) ?? []).map((link) => {
    const b = core(link.from_id);
    const waiting = index.waitingFor(link);
    return {
      id: b.id,
      title: b.title,
      status: b.status,
      cleared: waiting === null,
      waiting_for: waiting,
      outcome_first_line: firstLine(b.outcome_md),
    };
  });
  const dependents = (index.dependents.get(row.id) ?? []).map((link) => {
    const d = core(link.to_id);
    return { id: d.id, title: d.title, status: d.status };
  });

  // The step to work on (decision 33): the one in state `current`, else the first `todo`.
  const steps = currentSteps(db, row.id);
  const open = steps.find((s) => s.state === 'current') ?? steps.find((s) => s.state === 'todo');
  const step: Step | null = open
    ? {
        id: open.id,
        text: open.text,
        state: open.state,
        source: open.source,
        details_md: open.details_md,
        details_version: open.details_version,
        truncated: false,
      }
    : null;

  // Markdown planning documents on the item, then its epic: the newest version of each.
  const docRows = sql
    .prepare(
      `SELECT d.item_id, d.name, v.version_no, v.mime, v.path
       FROM documents d JOIN document_versions v ON v.document_id = d.id
       WHERE d.item_id IN (SELECT value FROM json_each(?)) AND d.kind = 'planning'
         AND v.version_no = (SELECT max(version_no) FROM document_versions WHERE document_id = d.id)
       ORDER BY CASE WHEN d.item_id = ? THEN 0 ELSE 1 END, d.name`,
    )
    .all(JSON.stringify([row.id, row.epic_id].filter(Boolean)), row.id) as {
    item_id: string;
    name: string;
    version_no: number;
    mime: string;
    path: string;
  }[];
  const docs = docRows
    .filter((d) => d.mime === 'text/markdown' || /\.(md|markdown)$/i.test(d.name))
    .map((d) => {
      let full: string | null = null;
      try {
        full = readFileSync(join(deps.config.paths.docs, d.path), 'utf8').trim();
      } catch {
        full = null; // Missing on disk: name and version only, marked.
      }
      return { name: d.name, version_no: d.version_no, content_md: null, truncated: true, full };
    });

  // The latest decided review round on the item.
  const packet = sql
    .prepare(
      `SELECT id, round FROM packets WHERE item_id = ? AND state = 'decided' ORDER BY round DESC LIMIT 1`,
    )
    .get(row.id) as { id: string; round: number } | undefined;
  const last_review = packet
    ? {
        round: packet.round,
        items: (
          sql
            .prepare(
              `SELECT h.text, rd.kind, rd.note FROM review_decisions rd JOIN hr_items h ON h.id = rd.hr_item_id
               WHERE rd.packet_id = ? ORDER BY h.position, h.id`,
            )
            .all(packet.id) as {
            text: string;
            kind: 'approve' | 'changes' | 'defer';
            note: string | null;
          }[]
        ).map((x) => ({ text: x.text, kind: x.kind, note: x.note })),
      }
    : null;

  return {
    item: {
      id: row.id,
      title: row.title,
      type: row.type,
      status: row.status,
      priority: row.priority,
      outcome_md: row.outcome_md,
      acceptance,
      open_question: question
        ? {
            id: question.id,
            text: question.text,
            asked_at: question.created_at,
            answer: question.answer,
            answered_at: question.answered_at,
          }
        : null,
      version: row.version,
      unread_owner_notes: notes.n,
    },
    decisions: inScopeOf(db, { ...row, labels }),
    epic: epicRow ? { id: epicRow.id, title: epicRow.title, outcome_md: epicRow.outcome_md } : null,
    labels: labelRows.map((l) => ({ name: l.name, brief_md: l.brief_md })),
    blockers,
    dependents,
    step,
    workflow: (() => {
      const wf = currentWorkflow(db, row.project_key);
      return wf ? { ...wf, truncated: false } : null;
    })(),
    shared: deps.services().sharedChanges.contextFor(r, { item_id: id, max_chars: Infinity }),
    docs,
    last_review: last_review && last_review.items.length > 0 ? last_review : null,
  };
}

/** Apply the budget: fill the sections in priority order, marking every cut. */
export function assemble(
  r: ReadContext,
  deps: ServiceDeps,
  id: string,
  budget: Bundle['budget'],
): Bundle {
  const full = gather(r, deps, id);
  const now = new Date(r.now);
  const maxChars = CONTEXT_BUDGETS[budget] * 4;
  // `blocked_by` is a safety fact (MCP_SPEC §3.1): the text says "none" when the list is
  // empty, so unresolved blockers travel with the essentials and are never cut. Only
  // cleared blockers and dependents are section 4's to cut.
  const unresolved = full.blockers.filter((x) => !x.cleared);
  const cleared = full.blockers.filter((x) => x.cleared);
  const b: Bundle = {
    item: full.item,
    decisions: [],
    epic: null,
    labels: [],
    blockers: [...unresolved],
    dependents: [],
    current_step: null,
    workflow: null,
    planning_docs: [],
    last_review: null,
    budget,
    truncated_sections: [],
  };
  const larger = budget === 'large' ? ' left out' : '; ask get_context with a larger budget';

  // Markers for the sections not placed yet, as if each were left out entirely.
  const pending = new Map<string, string>();
  if (full.decisions.length > 0)
    pending.set(
      'decisions',
      `${plural(full.decisions.length, 'decision')} in scope; read them with list_decisions in_scope_of ${id}`,
    );
  if (full.epic)
    pending.set('epic', `epic ${full.epic.id} outcome; read it with get_item ${full.epic.id}`);
  if (full.labels.length > 0)
    pending.set('labels', `briefs of ${full.labels.map((l) => l.name).join(', ')}${larger}`);
  const linksLeft = (blockers: number, dependents: number) =>
    `${[
      blockers > 0 ? plural(blockers, 'cleared blocker') : null,
      dependents > 0 ? plural(dependents, 'dependent') : null,
    ]
      .filter(Boolean)
      .join(' and ')}; read them with get_item ${id}`;
  if (cleared.length + full.dependents.length > 0)
    pending.set('links', linksLeft(cleared.length, full.dependents.length));
  const stepMarker = (st: Step) =>
    `current step ${st.id}${st.details_md ? ` and its details` : ''}; read it with get_step ${id} ${st.id}`;
  if (full.step) pending.set('step', stepMarker(full.step));
  const sharedMarker = `shared changes; read them with list_shared_parts ${id.split('-')[0]!}`;
  pending.set('shared', sharedMarker);
  if (full.workflow)
    pending.set(
      'workflow',
      `workflow notes ${full.workflow.project} v${full.workflow.version_no}${larger}`,
    );
  if (full.docs.length > 0)
    pending.set(
      'docs',
      `${plural(full.docs.length, 'planning doc')} (${full.docs.map((d) => `${d.name} v${d.version_no}`).join(', ')}); read them with get_item`,
    );
  if (full.last_review)
    pending.set(
      'review',
      `last review round ${full.last_review.round}; read it with get_review ${id}`,
    );

  const placed: string[] = [];
  const size = (extra: string[] = []) =>
    renderContext({ ...b, truncated_sections: [...placed, ...extra, ...pending.values()] }, { now })
      .length;
  const fits = (extra: string[] = []) => size(extra) <= maxChars;
  // Once a section is cut, every lower one is left out (and marked): a
  // higher section is never cut while a lower one is kept.
  let room = true;
  const done = (section: string, marker?: string) => {
    pending.delete(section);
    if (marker) placed.push(marker);
    room = false;
  };

  // 1. Essentials: cut last, and only when they alone exceed the budget.
  if (!fits()) {
    const marker = `outcome and acceptance cut; read ${id} with get_item`;
    const item = b.item;
    while (item.acceptance.length > 0 && !fits([marker])) {
      item.acceptance = item.acceptance.slice(0, -1);
    }
    if (!fits([marker])) {
      const outcome = item.outcome_md;
      item.outcome_md =
        longestFit(outcome, (cut) => {
          item.outcome_md = cut;
          return fits([marker]);
        }) ?? '';
    }
    placed.push(marker);
    room = false;
  }

  // 2. Decisions, owner first: whole records while they fit, then one cut, then a count.
  if (room) pending.delete('decisions');
  for (let i = 0; room && i < full.decisions.length; i++) {
    const d = full.decisions[i]!;
    b.decisions.push(d);
    const rest = full.decisions.length - i - 1;
    const restMarker = (shown: number, cutId?: string) =>
      `${shown} of ${plural(full.decisions.length, 'decision')} shown${cutId ? ` (${cutId} cut)` : ''}; read them with list_decisions in_scope_of ${id}`;
    if (fits(rest > 0 ? [restMarker(i + 1)] : [])) continue;
    b.decisions.pop();
    const marker = restMarker(i + 1, d.id);
    const slim: Decision = { ...d, rationale_md: null };
    b.decisions.push(slim);
    const cut = longestFit(d.decision_md, (text) => {
      slim.decision_md = text;
      return fits([marker]);
    });
    if (cut) {
      slim.decision_md = cut;
      done('decisions', marker);
    } else {
      b.decisions.pop();
      done('decisions', restMarker(i));
    }
    break;
  }

  // 3a. The epic's outcome.
  if (room && full.epic) {
    pending.delete('epic');
    const epic = { ...full.epic };
    b.epic = epic;
    if (!fits()) {
      const marker = `epic ${epic.id} outcome cut; read it with get_item ${epic.id}`;
      const cut = longestFit(full.epic.outcome_md, (text) => {
        epic.outcome_md = text;
        return fits([marker]);
      });
      if (cut !== null) {
        epic.outcome_md = cut;
        done('epic', marker);
      } else {
        b.epic = null;
        done('epic', `epic ${full.epic.id} outcome; read it with get_item ${full.epic.id}`);
      }
    }
  }

  // 3b. Label briefs, in name order.
  if (room && full.labels.length > 0) {
    pending.delete('labels');
    const left = (from: number) =>
      `briefs of ${full.labels
        .slice(from)
        .map((l) => l.name)
        .join(', ')}${larger}`;
    for (let i = 0; i < full.labels.length; i++) {
      const label = { ...full.labels[i]! };
      b.labels.push(label);
      const after = i + 1 < full.labels.length ? [left(i + 1)] : [];
      if (fits(after)) continue;
      const marker = left(i);
      const cut = longestFit(full.labels[i]!.brief_md, (text) => {
        label.brief_md = text;
        return fits([marker]);
      });
      if (cut !== null) label.brief_md = cut;
      else b.labels.pop();
      done('labels', marker);
      break;
    }
  }

  // 4. Cleared blockers (unresolved ones are already in), then dependents.
  if (room && cleared.length + full.dependents.length > 0) {
    pending.delete('links');
    let cut = false;
    for (let i = 0; i < cleared.length; i++) {
      b.blockers.push(cleared[i]!);
      const restB = cleared.length - i - 1;
      const restD = full.dependents.length;
      if (fits(restB + restD > 0 ? [linksLeft(restB, restD)] : [])) continue;
      b.blockers.pop();
      done('links', linksLeft(cleared.length - i, full.dependents.length));
      cut = true;
      break;
    }
    if (!cut && full.dependents.length > 0) {
      b.dependents = full.dependents;
      if (!fits()) {
        b.dependents = [];
        done('links', linksLeft(0, full.dependents.length));
      }
    }
  }

  // 4b. The current step: whole while it fits, else its details cut inline (the renderer
  // marks the cut and points at get_step), else left out with a marker.
  if (room && full.step) {
    pending.delete('step');
    const source = full.step;
    const st = { ...source };
    b.current_step = st;
    if (!fits()) {
      // The details cut inline; failing that, the header line with the marker; failing that,
      // left out with a marker. Either way, every lower section is left out.
      if (source.details_md !== null) {
        st.truncated = true;
        st.details_md =
          longestFit(source.details_md, (text) => {
            st.details_md = text;
            return fits();
          }) ?? null;
      }
      if (fits()) room = false;
      else {
        b.current_step = null;
        done('step', stepMarker(source));
      }
    }
  }

  // 4c. Shared changes (decision 36; BUILD_SPEC §5.21 Context): the declaration, the other
  // in-flight items' changes to its parts, other in-flight declarations, leases and radar
  // findings. When it doesn't fit, other in-flight declarations go first, then overlapping
  // ones (marked `truncated`); failing that, it's left out with a marker.
  if (room) {
    pending.delete('shared');
    const src = full.shared;
    const sh: ContextShared = {
      ...src,
      overlapping: [...src.overlapping],
      in_flight: [...src.in_flight],
    };
    b.shared = sh;
    if (!fits()) {
      sh.truncated = true;
      while (sh.in_flight.length > 0 && !fits()) sh.in_flight.pop();
      while (sh.overlapping.length > 0 && !fits()) sh.overlapping.pop();
      if (fits()) room = false;
      else {
        delete b.shared;
        done('shared', sharedMarker);
      }
    }
  }

  // 5. The project's Workflow notes: whole while they fit, else cut inline (the renderer
  // marks it), else left out with a marker. Cut before anything in sections 1–4.
  if (room && full.workflow) {
    pending.delete('workflow');
    const source = full.workflow;
    const wf = { ...source };
    b.workflow = wf;
    if (!fits()) {
      wf.truncated = true;
      const cut = longestFit(source.content_md, (text) => {
        wf.content_md = text;
        return fits();
      });
      if (cut !== null) {
        wf.content_md = cut;
        room = false;
      } else {
        b.workflow = null;
        done('workflow', `workflow notes ${source.project} v${source.version_no}${larger}`);
      }
    }
  }

  // 6. Planning documents: names and versions first, then text until the budget runs out.
  if (room && full.docs.length > 0) {
    pending.delete('docs');
    const names = (from: number) =>
      `${plural(full.docs.length - from, 'more planning doc')}; read them with get_item`;
    const docs: Doc[] = [];
    b.planning_docs = docs;
    for (let i = 0; i < full.docs.length; i++) {
      const d = full.docs[i]!;
      docs.push({ name: d.name, version_no: d.version_no, content_md: null, truncated: true });
      if (fits(i + 1 < full.docs.length ? [names(i + 1)] : [])) continue;
      docs.pop();
      done('docs', names(i));
      break;
    }
    for (let i = 0; room && i < docs.length; i++) {
      const text = full.docs[i]!.full;
      const doc = docs[i]!;
      if (text === null) continue; // Unreadable: name and version, marked.
      doc.content_md = text;
      doc.truncated = false;
      if (fits()) continue;
      doc.truncated = true;
      const cut = longestFit(text, (t) => {
        doc.content_md = t;
        return fits();
      });
      doc.content_md = cut;
      room = false;
      break; // The budget ran out: the rest stay names and versions.
    }
  }

  // 7. The last review round.
  if (room && full.last_review) {
    pending.delete('review');
    const review = full.last_review;
    const items: NonNullable<Bundle['last_review']>['items'] = [];
    b.last_review = { round: review.round, items };
    const left = (n: number) =>
      `${plural(n, 'more review verdict')} from round ${review.round}; read them with get_review ${id}`;
    for (let i = 0; i < review.items.length; i++) {
      items.push(review.items[i]!);
      const rest = review.items.length - i - 1;
      if (fits(rest > 0 ? [left(rest)] : [])) continue;
      items.pop();
      if (items.length === 0) {
        b.last_review = null;
        done('review', `last review round ${review.round}; read it with get_review ${id}`);
      } else {
        done('review', left(review.items.length - i));
      }
      break;
    }
  }

  b.truncated_sections = [...placed, ...pending.values()];
  return b;
}
