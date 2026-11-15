/**
 * Compact text renderers (MCP_SPEC §3.1): the complete text rendering of
 * every tool result, for the model. Pure functions over the output types;
 * the text block is never a JSON dump and never just a summary.
 *
 * Rules (§3.1): the ID first on every line that names an object, then the
 * title, then facts separated by ` · `; bare words for flags; nested facts
 * indented two spaces; one line per list entry; checklist markers
 * `[ ] [>] [x] [!] [-]`; checks `[pass] [fail] [todo] [skip]`; empty
 * sections omitted except the safety facts (`blocked_by`, `question`,
 * `notes_unread`), shown as `none`; times `HH:MMZ` today (UTC), `MM-DD`
 * otherwise; long text in lists cut at 200 characters with `…`; mutations
 * one line; warnings as `! …` lines at the end.
 *
 * Shared contract file (tasks.md, Slice rules).
 */
import { EFFORT_UNIT, OPEN_RUN_STATES, type CheckState, type WorkStepState } from './enums.js';
import type { ToolErrorShape } from './errors.js';
import { fillSummary, TOOL_SUMMARIES } from './mcp-copy.js';
import { LIMITS } from './mcp/limits.js';
import type { ToolName, ToolOutput } from './mcp/tools.js';
import type {
  Check,
  ContextBundle,
  DecisionRecord,
  EventRow,
  HumanReviewItem,
  ItemResume,
  ItemSummaryView,
  ItemView,
  LinkRef,
  Resource,
  Run,
  WaitingOn,
  WorkStep,
  Workspace,
} from './mcp/types.js';
import type { RecoveryWorkspace } from './mcp/recovery.js';

export interface RenderOptions {
  /** "Now", for HH:MMZ vs MM-DD. Defaults to the current time. */
  now?: Date;
}

export interface ResultRenderOptions extends RenderOptions {
  /** The call's arguments, for mutation lines that name what the result doesn't (e.g. the item ID). */
  args?: Record<string, unknown>;
}

const SEP = ' · ';
const I1 = '  ';
const I3 = '      ';

// ---- Primitives ----

/** `HH:MMZ` when `iso` falls on today's UTC date, `MM-DD` otherwise. */
export function formatTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  if (d.toISOString().slice(0, 10) === now.toISOString().slice(0, 10)) {
    return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}Z`;
  }
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** One line, at most `max` characters, ending in `…` when cut. */
export function truncate(text: string, max: number = LIMITS.list_text): string {
  const flat = text.replace(/\s*\n\s*/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

const join = (parts: (string | null | undefined | false)[]) =>
  parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(SEP);

const shortSha = (sha: string) => sha.slice(0, 7);

/** Multi-line text as `label: first line` plus indented continuation lines. */
function block(label: string, text: string, indent = I1): string[] {
  const lines = text.trim().split(/\r?\n/);
  return [`${indent}${label}: ${lines[0] ?? ''}`, ...lines.slice(1).map((l) => `${indent}  ${l}`)];
}

function withExtras(text: string, result: { replayed?: boolean; warnings?: string[] }): string {
  let out = result.replayed ? `${text}${SEP}replayed` : text;
  for (const w of result.warnings ?? []) out += `\n! ${w}`;
  return out;
}

// ---- Markers ----

const STEP_MARKERS: Record<WorkStepState, string> = {
  todo: '[ ]',
  current: '[>]',
  done: '[x]',
  blocked: '[!]',
  skipped: '[-]',
};

const CHECK_MARKERS: Record<CheckState, string> = {
  pass: '[pass]',
  fail: '[fail]',
  todo: '[todo]',
  skipped: '[skip]',
};

// ---- Items ----

type AnyItem = ItemView & Partial<ItemSummaryView>;

function leadName(lead: { client: string; label: string | null }): string {
  return lead.label ? `${lead.client}·${lead.label}` : lead.client;
}

function factsLine(item: AnyItem): string {
  const planned =
    item.planned_start || item.planned_end
      ? `planned ${item.planned_start ?? '…'}→${item.planned_end ?? '…'}${item.dates_set_by ? ` (${item.dates_set_by})` : ''}`
      : null;
  return join([
    item.type?.toLowerCase(),
    item.priority !== undefined ? `P${item.priority}` : null,
    item.status,
    item.archived ? 'archived' : null,
    item.epic ? `epic ${item.epic}${item.epic_title ? ` ${item.epic_title}` : ''}` : null,
    item.labels && item.labels.length > 0 ? `labels ${item.labels.join(', ')}` : null,
    planned,
    item.effort !== undefined && item.effort !== null
      ? `effort ${item.effort} ${EFFORT_UNIT}`
      : null,
    item.jira_key ? `jira ${item.jira_key}` : null,
    item.closed_by ? `closed by ${item.closed_by}` : null,
    `v${item.version}`,
  ]);
}

function leadLine(item: AnyItem, now: Date): string | null {
  if (!item.lead) return null;
  const lead = item.lead;
  const run = item.runs?.find((r) => r.run_id === lead.run_id);
  const line = `${I1}${join([
    `lead ${leadName(lead)} ${lead.run_state}`,
    `run ${lead.run_id}`,
    run?.lease_expires_at && lead.run_state !== 'parked'
      ? `lease until ${formatTime(run.lease_expires_at, now)}`
      : null,
  ])}`;
  return run ? [line, ...runRecoveryLines(run, now, `${I1}  `)].join('\n') : line;
}

// ---- Recovery: parking, workspaces, briefs, resources (MCP_SPEC §3, §5.4, §5.9) ----

/** `waiting on RCP-12, the coordinator, a person, until 11:00Z`, or null when nothing is named. */
export function waitingOnText(w: WaitingOn, now: Date): string | null {
  const parts = [
    ...(w.items ?? []),
    w.orchestrator ? 'the coordinator' : null,
    w.person ? 'a person' : null,
    w.until ? `until ${formatTime(w.until, now)}` : null,
  ].filter((p): p is string => !!p);
  return parts.length > 0 ? `waiting on ${parts.join(', ')}` : null;
}

/** `@ 4be1c09 (pushed)`, `@ 77aa001, pushed 6f00e12`, or `@ 77aa001, not pushed` (§7.13). */
function shaFacts(head: string | null, pushed: string | null): string | null {
  if (head && pushed && head === pushed) return `@ ${shortSha(head)} (pushed)`;
  if (head) return `@ ${shortSha(head)}, ${pushed ? `pushed ${shortSha(pushed)}` : 'not pushed'}`;
  return pushed ? `pushed ${shortSha(pushed)}` : null;
}

/** The workspace line: `ws <path> on <branch> @ <sha> (pushed) · dirty · at_risk`. */
export function workspaceText(
  ws: Workspace | RecoveryWorkspace,
  opts: { state?: boolean } = {},
): string {
  const where = ws.path ? `ws ${ws.path}` : 'ws (no path)';
  return join([
    [where, ws.branch ? `on ${ws.branch}` : null, shaFacts(ws.head_sha, ws.pushed_sha)]
      .filter(Boolean)
      .join(' '),
    ws.dirty === true ? 'dirty' : ws.dirty === false ? 'clean' : null,
    opts.state === false ? null : ws.state,
  ]);
}

/** One resource: `rsc_1 dev server :5173 · port 5173 · running` or `released 03:20`. */
export function resourceText(r: Resource, now: Date): string {
  const l = r.locator;
  const where = [
    l.port !== undefined ? `port ${l.port}` : null,
    l.pid !== undefined ? `pid ${l.pid}` : null,
    l.session_id ? `session ${l.session_id}` : null,
    l.container ? `container ${l.container}` : null,
    l.path ? `path ${l.path}` : null,
    l.host ? `host ${l.host}` : null,
  ];
  return join([
    `${r.id} ${truncate(r.label, 120)}`,
    r.kind,
    ...where,
    r.released_at
      ? `released ${formatTime(r.released_at, now)}${r.release_note ? ` "${truncate(r.release_note)}"` : ''}`
      : 'running',
  ]);
}

/** The recovery facts under a run: parked, end reason, workspace, orchestrator, brief, resources. */
function runRecoveryLines(run: Run, now: Date, indent: string): string[] {
  const out: string[] = [];
  if (run.parked) {
    out.push(
      `${indent}${join([
        'parked',
        waitingOnText(run.parked.waiting_on, now),
        `since ${formatTime(run.parked.since, now)}`,
        run.parked.resume_ready ? 'ready to resume' : null,
        `reason: ${truncate(run.parked.reason)}`,
      ])}`,
    );
  }
  if (run.end_reason && run.end_reason !== run.run_state)
    out.push(`${indent}ended: ${run.end_reason}`);
  if (run.workspace) out.push(`${indent}${workspaceText(run.workspace)}`);
  const refs = join([
    run.orchestrator
      ? `orchestrator ${[run.orchestrator.name, run.orchestrator.dispatch_id, run.orchestrator.task_id, run.orchestrator.run_id].filter(Boolean).join(' ')}`
      : null,
    run.brief_document_version_id ? `brief ${run.brief_document_version_id}` : null,
  ]);
  if (refs) out.push(`${indent}${refs}`);
  if (run.resources.length > 0) {
    out.push(
      `${indent}resources:`,
      ...run.resources.map((r) => `${indent}- ${resourceText(r, now)}`),
    );
  }
  if (run.external !== undefined && Object.keys(run.external).length > 0) {
    out.push(`${indent}external: ${JSON.stringify(run.external)}`);
  }
  return out;
}

/** `Item.resume`: where to pick the work up. */
function resumeLine(resume: ItemResume): string {
  return `${I1}${join([
    'resume:',
    resume.workspace ? workspaceText(resume.workspace) : 'no workspace recorded',
    resume.last_pushed_sha ? `last pushed ${shortSha(resume.last_pushed_sha)}` : null,
    resume.last_end_reason ? `last run ${resume.last_end_reason}` : null,
    resume.brief_document_version_id ? `brief ${resume.brief_document_version_id}` : null,
    resume.unreleased_resources > 0
      ? `${resume.unreleased_resources} unreleased resource${resume.unreleased_resources === 1 ? '' : 's'}`
      : null,
  ]).replace('resume: · ', 'resume: ')}`;
}

const blockerRef = (l: LinkRef) =>
  `${l.id} ${l.status}${l.waiting_for ? ` waiting for ${l.waiting_for}` : ''}`;

function linksLine(item: AnyItem): string | null {
  const hasLinks = item.links !== undefined;
  if (!hasLinks && item.blocked_by === undefined) return null;
  const blockers = hasLinks
    ? item.links!.blocked_by.filter((l) => l.cleared !== true).map(blockerRef)
    : (item.blocked_by ?? []);
  const parts = [`blocked_by: ${blockers.length > 0 ? blockers.join(', ') : 'none'}`];
  if (hasLinks) {
    if (item.links!.blocks.length > 0) {
      parts.push(`blocks: ${item.links!.blocks.map((l) => `${l.id} ${l.status}`).join(', ')}`);
    }
    if (item.links!.relates.length > 0) {
      parts.push(`relates: ${item.links!.relates.map((l) => l.id).join(', ')}`);
    }
  } else if (item.unblocks) {
    parts.push(`unblocks ${item.unblocks}`);
  }
  return `${I1}${parts.join(SEP)}`;
}

function stepLines(step: WorkStep): string[] {
  const head = join([
    `${I1}- ${STEP_MARKERS[step.state]} ${step.id} ${step.text}`,
    step.was_text ? `was: ${step.was_text}` : null,
    step.change_reason ? `why: ${step.change_reason}` : null,
    step.from_review ? `from review round ${step.from_review.round}` : null,
    step.added_by === 'owner' ? 'by owner' : null,
  ]);
  const subs = step.subagents.map(
    (s) => `${I3}${s.provenance} ${s.name}: ${s.outcome}${s.evidence ? `${SEP}${s.evidence}` : ''}`,
  );
  return [head, ...subs];
}

function checkLine(check: Check): string {
  return join([
    `${I1}- ${CHECK_MARKERS[check.state]} ${check.id} ${check.text}`,
    check.provenance !== 'agent' ? check.provenance : null,
    check.evidence,
    check.added_by === 'owner' ? 'by owner' : null,
  ]);
}

function humanReviewLine(hr: HumanReviewItem, now: Date): string {
  const last = hr.last_decision;
  return join([
    `${I1}- [${hr.state}] ${hr.id} ${hr.text}`,
    `by ${hr.added_by === 'owner' ? 'owner' : (hr.added_by_client ?? 'agent')}`,
    hr.locked ? 'locked' : null,
    last
      ? `last: ${last.kind} round ${last.round} ${formatTime(last.at, now)}${last.note ? ` "${truncate(last.note)}"` : ''}`
      : null,
    hr.follow_up_item_id ? `follow-up ${hr.follow_up_item_id}` : null,
  ]);
}

function runLine(run: Run, now: Date): string {
  const head = join([
    `${I1}- ${run.run_id} ${leadName(run)} ${run.run_state}`,
    run.is_lead ? 'lead' : null,
    run.parent_run_id ? `child of ${run.parent_run_id}` : null,
    run.lease_expires_at && !['finished', 'failed', 'interrupted', 'parked'].includes(run.run_state)
      ? `lease until ${formatTime(run.lease_expires_at, now)}`
      : null,
    run.summary ? truncate(run.summary) : null,
    run.error ? `error: ${truncate(run.error)}` : null,
  ]);
  return [head, ...runRecoveryLines(run, now, `${I1}    `)].join('\n');
}

const isOpenRun = (state: string) => (OPEN_RUN_STATES as readonly string[]).includes(state);

function questionLines(item: AnyItem, now: Date): string[] {
  const out: string[] = [];
  // Summary view: say whether they exist, without delivering them.
  if (item.has_open_question !== undefined || item.unread_owner_notes_count !== undefined) {
    const q = item.has_open_question ? 'open, read it with get_item' : 'none';
    const n = item.unread_owner_notes_count ? String(item.unread_owner_notes_count) : 'none';
    return [`${I1}question: ${q}${SEP}notes_unread: ${n}`];
  }
  const hasQ = item.open_question !== undefined;
  const hasN = item.unread_owner_notes !== undefined;
  if (!hasQ && !hasN) return out;
  const q = item.open_question ?? null;
  const notes = item.unread_owner_notes ?? [];
  if (!q && notes.length === 0) {
    return [`${I1}${join([hasQ ? 'question: none' : null, hasN ? 'notes_unread: none' : null])}`];
  }
  if (hasQ) {
    if (q) {
      out.push(`${I1}question: ${q.id} ${q.text}${SEP}asked ${formatTime(q.asked_at, now)}`);
      if (q.answer !== null) {
        out.push(
          `${I1}  answer: ${q.answer}${q.answered_at ? `${SEP}${formatTime(q.answered_at, now)}` : ''}`,
        );
      }
    } else {
      out.push(`${I1}question: none`);
    }
  }
  if (hasN) {
    if (notes.length === 0) out.push(`${I1}notes_unread: none`);
    else {
      out.push(`${I1}notes_unread:`);
      for (const n of notes) out.push(`${I1}- ${formatTime(n.at, now)} ${n.text}`);
    }
  }
  return out;
}

/**
 * An item, as `get_item` returns it. Works for every view and for
 * `fields`-trimmed items: each section appears only when its fields are present.
 */
export function renderItem(
  item: AnyItem,
  opts: RenderOptions & { view?: 'summary' | 'standard' | 'full' } = {},
): string {
  const now = opts.now ?? new Date();
  const view = opts.view ?? 'standard';
  const lines: string[] = [item.title !== undefined ? `${item.id} ${item.title}` : item.id];
  lines.push(`${I1}${factsLine(item)}`);
  const lead = leadLine(item, now);
  if (lead) lines.push(lead);
  const links = linksLine(item);
  if (links) lines.push(links);

  if (item.description_md) lines.push(...block('description', item.description_md));
  if (item.outcome_md) lines.push(...block('outcome', item.outcome_md));
  if (item.acceptance && item.acceptance.length > 0) {
    lines.push(`${I1}acceptance:`, ...item.acceptance.map((a) => `${I1}- ${a}`));
  }

  if (item.counts) {
    const c = item.counts;
    const hr = item.human_review
      ? Object.entries(item.human_review)
          .filter(([, n]) => n > 0)
          .map(([state, n]) => `${state} ${n}`)
          .join(' ')
      : '';
    lines.push(
      `${I1}${join([
        `work ${c.work_done}/${c.work_total} done`,
        `checks ${c.checks_pass}/${c.checks_total} pass`,
        hr ? `human_review ${hr}` : null,
      ])}`,
    );
  }

  const cl = item.checklist;
  if (cl) {
    if (cl.work.length > 0) {
      const done = cl.work.filter((s) => s.state === 'done').length;
      lines.push(`${I1}work (plan v${cl.plan_version}${SEP}${done}/${cl.work.length} done):`);
      for (const s of cl.work) lines.push(...stepLines(s));
    }
    if (cl.checks.length > 0) {
      const pass = cl.checks.filter((c) => c.state === 'pass').length;
      lines.push(`${I1}checks (${pass}/${cl.checks.length} pass):`);
      for (const c of cl.checks) lines.push(checkLine(c));
    }
    if (cl.human_review.length > 0) {
      lines.push(`${I1}human_review:`);
      for (const h of cl.human_review) lines.push(humanReviewLine(h, now));
    } else if (cl.reviewed_with_epic) {
      lines.push(`${I1}human_review: reviewed with epic ${cl.reviewed_with_epic}`);
    }
  }

  if (item.decisions && item.decisions.length > 0) {
    const ref = (d: { id: string; title: string; authority: string }) =>
      `${d.id} ${d.title} (${d.authority})`;
    if (item.decisions.length === 1) lines.push(`${I1}decisions: ${ref(item.decisions[0]!)}`);
    else lines.push(`${I1}decisions:`, ...item.decisions.map((d) => `${I1}- ${ref(d)}`));
  }

  lines.push(...questionLines(item, now));
  if (item.resume) lines.push(resumeLine(item.resume));

  if (item.documents && item.documents.length > 0) {
    lines.push(
      `${I1}docs: ${item.documents.map((d) => `${d.name} v${d.latest.version_no}`).join(', ')}`,
    );
  }

  if (item.runs) {
    const leadId = item.lead?.run_id;
    const others = item.runs.filter(
      (r) => r.run_id !== leadId && (view === 'full' || isOpenRun(r.run_state)),
    );
    if (others.length > 0) lines.push(`${I1}runs:`, ...others.map((r) => runLine(r, now)));
  }
  if (item.packets && item.packets.length > 0) {
    lines.push(
      `${I1}packets: ${item.packets
        .map(
          (p) =>
            `${p.packet_id} round ${p.round} ${p.state}${p.stale ? ' stale' : ''} built ${shortSha(p.built_from_commit)}`,
        )
        .join(', ')}`,
    );
  }
  if (item.commits && item.commits.length > 0) {
    lines.push(
      `${I1}commits: ${item.commits
        .map((c) => [shortSha(c.sha), c.branch, formatTime(c.at, now)].filter(Boolean).join(' '))
        .join(', ')}`,
    );
  }
  if (item.artifacts && item.artifacts.length > 0) {
    lines.push(`${I1}artifacts:`);
    for (const a of item.artifacts)
      lines.push(`${I1}- ${join([`${a.kind} ${a.label}`, a.state, a.url])}`);
  }
  if (item.recent_events && item.recent_events.length > 0) {
    lines.push(`${I1}activity:`);
    for (const e of item.recent_events) {
      lines.push(`${I1}- ${formatTime(e.at, now)} ${e.actor} ${e.type} ${truncate(e.summary)}`);
    }
  }
  return lines.join('\n');
}

/** One `search_items` row (§3.1 "Search results"). */
export function renderItemRow(item: ItemSummaryView, _opts: RenderOptions = {}): string {
  return join([
    item.title !== undefined ? `${item.id} ${truncate(item.title)}` : item.id,
    item.type?.toLowerCase(),
    item.priority !== undefined ? `P${item.priority}` : null,
    item.status,
    item.blocked && item.blocked_by && item.blocked_by.length > 0
      ? `blocked by ${item.blocked_by.join(', ')}`
      : item.blocked
        ? 'blocked'
        : null,
    item.lead ? `lead ${leadName(item.lead)} ${item.lead.run_state}` : null,
    item.archived ? 'archived' : null,
    item.unblocks ? `unblocks ${item.unblocks}` : null,
    `v${item.version}`,
  ]);
}

// ---- Decisions, context, events ----

function decisionRow(d: DecisionRecord): string {
  const scope =
    d.scope.kind === 'project' ? 'project' : `${d.scope.kind} ${d.scope.id ?? ''}`.trim();
  return join([
    `${d.id} ${d.title} (${d.authority})`,
    d.status !== 'active' ? d.status : null,
    scope,
  ]);
}

function eventRow(e: EventRow, now: Date): string {
  return [e.cursor, formatTime(e.at, now), e.actor, e.item_id, e.type, truncate(e.summary)]
    .filter(Boolean)
    .join(' ');
}

/** A context bundle, in the BUILD_SPEC §5.15 priority order. */
export function renderContext(ctx: ContextBundle, opts: RenderOptions = {}): string {
  const now = opts.now ?? new Date();
  const it = ctx.item;
  const lines = [
    fillSummary(TOOL_SUMMARIES.get_context, { id: it.id, title: it.title, budget: ctx.budget }),
    `${I1}${join([it.type.toLowerCase(), `P${it.priority}`, it.status, `v${it.version}`])}`,
  ];
  if (it.outcome_md) lines.push(...block('outcome', it.outcome_md));
  if (it.acceptance.length > 0)
    lines.push(`${I1}acceptance:`, ...it.acceptance.map((a) => `${I1}- ${a}`));
  const q = it.open_question;
  if (q) {
    lines.push(`${I1}question: ${q.id} ${q.text}${SEP}asked ${formatTime(q.asked_at, now)}`);
    if (q.answer !== null) lines.push(`${I1}  answer: ${q.answer}`);
    lines.push(`${I1}notes_unread: ${it.unread_owner_notes || 'none'}`);
  } else {
    lines.push(`${I1}question: none${SEP}notes_unread: ${it.unread_owner_notes || 'none'}`);
  }
  if (ctx.decisions.length > 0) {
    lines.push('decisions:');
    for (const d of ctx.decisions) {
      lines.push(`${I1}- ${decisionRow(d)}`);
      lines.push(
        ...d.decision_md
          .trim()
          .split(/\r?\n/)
          .map((l) => `${I1}    ${l}`),
      );
      if (d.rationale_md) lines.push(...block('why', d.rationale_md, `${I1}    `));
    }
  }
  if (ctx.epic) {
    lines.push(`epic ${ctx.epic.id} ${ctx.epic.title}`);
    if (ctx.epic.outcome_md) lines.push(...block('outcome', ctx.epic.outcome_md));
  }
  if (ctx.labels.length > 0) {
    lines.push('labels:');
    for (const l of ctx.labels) lines.push(...block(`- ${l.name}`, l.brief_md || '(no brief)'));
  }
  lines.push(ctx.blockers.length > 0 ? 'blocked_by:' : 'blocked_by: none');
  for (const b of ctx.blockers) {
    lines.push(
      `${I1}- ${join([
        `${b.id} ${b.title}`,
        b.status,
        b.cleared ? 'cleared' : b.waiting_for ? `waiting for ${b.waiting_for}` : null,
        b.outcome_first_line ? truncate(b.outcome_first_line) : null,
      ])}`,
    );
  }
  if (ctx.dependents.length > 0) {
    lines.push(`blocks: ${ctx.dependents.map((d) => `${d.id} ${d.status}`).join(', ')}`);
  }
  if (ctx.planning_docs.length > 0) {
    lines.push('planning_docs:');
    for (const d of ctx.planning_docs) {
      lines.push(`${I1}- ${d.name} v${d.version_no}`);
      if (d.content_md)
        lines.push(
          ...d.content_md
            .trimEnd()
            .split(/\r?\n/)
            .map((l) => `${I1}    ${l}`),
        );
      if (d.truncated)
        lines.push(`${I1}    …truncated; read ${d.name} v${d.version_no} with get_item`);
    }
  }
  if (ctx.last_review) {
    lines.push(`last_review round ${ctx.last_review.round}:`);
    for (const r of ctx.last_review.items) {
      lines.push(`${I1}- ${r.kind} ${r.text}${r.note ? `${SEP}${r.note}` : ''}`);
    }
  }
  for (const s of ctx.truncated_sections) lines.push(`…truncated; ${s}`);
  return lines.join('\n');
}

/** A ToolError: `code: message`, then field problems and the current state. */
export function renderError(err: ToolErrorShape): string {
  const lines = [`${err.code}: ${err.message}`];
  const details = err.details ?? {};
  const fields = details.fields;
  if (fields && typeof fields === 'object') {
    // Field problems the message doesn't already state (it lists at most six).
    for (const [k, v] of Object.entries(fields as Record<string, unknown>)) {
      const problem = String(v);
      if (!err.message.includes(problem)) lines.push(`${I1}${k}: ${problem}`);
    }
  }
  for (const [k, v] of Object.entries(details)) {
    // `unknown` restates unknown fields, which the message already names.
    if (k === 'fields' || k === 'unknown') continue;
    lines.push(
      `${I1}${k}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v)}`,
    );
  }
  if (err.current !== undefined) lines.push(`${I1}current: ${JSON.stringify(err.current)}`);
  return lines.join('\n');
}

// ---- Tool results ----

type Renderer<N extends ToolName> = (
  result: ToolOutput<N>,
  args: Record<string, unknown>,
  now: Date,
) => string;

const s = (name: ToolName, values: Record<string, unknown>) =>
  fillSummary(TOOL_SUMMARIES[name], values);

const more = (next: string | null) => (next ? `${SEP}next_cursor ${next}` : '');
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const title80 = (t: string) => truncate(t, 80);

const MUTATION_ARG_KEYS = new Set(['id', 'expected_version', 'run_id', 'idempotency_key']);

const RENDERERS: { [N in ToolName]: Renderer<N> } = {
  whoami: (r, _a, now) =>
    [
      s('whoami', { ...r, server_time: formatTime(r.server_time, now) }),
      `${I1}limits: page_max ${r.limits.page_max}${SEP}changes_max ${r.limits.changes_max}${SEP}document_mcp_bytes ${r.limits.document_mcp_bytes}`,
      `${I1}text_limits: ${Object.entries(r.limits.text_limits)
        .map(([k, v]) => `${k} ${v}`)
        .join(SEP)}`,
      `${I1}live_window_s ${r.live_window_s}${SEP}stale_after_s ${r.stale_after_s}${SEP}lease_s ${r.lease_s}`,
    ].join('\n'),
  list_projects: (r) =>
    [
      s('list_projects', { count: r.projects.length }),
      ...r.projects.map((p) =>
        join([
          `${p.key} ${p.name}`,
          `open ${p.counts.open}`,
          `ready_to_start ${p.counts.ready_to_start}`,
          `in_progress ${p.counts.in_progress}`,
          `review ${p.counts.review}`,
          `blocked ${p.counts.blocked}`,
        ]),
      ),
    ].join('\n'),
  search_items: (r, _a, now) =>
    [
      s('search_items', { count: r.items.length, more: more(r.next_cursor) }),
      ...r.items.map((i) => renderItemRow(i, { now })),
    ].join('\n'),
  get_item: (r, a, now) =>
    renderItem(r.item, {
      now,
      view: a.view === 'summary' || a.view === 'full' ? a.view : 'standard',
    }),
  get_context: (r, _a, now) => renderContext(r.context, { now }),
  dependency_subgraph: (r, a) => {
    const lines = [
      s('dependency_subgraph', {
        id: str(a.id) ?? r.nodes[0]?.id,
        nodes: r.nodes.length,
        edges: r.edges.length,
      }),
    ];
    for (const n of r.nodes) {
      lines.push(
        join([
          `${n.id} ${truncate(n.title)}`,
          n.status,
          n.blocked ? 'blocked' : null,
          n.date_source === 'none'
            ? 'no dates'
            : `${n.planned_start ?? '…'}→${n.planned_end ?? '…'}`,
          n.effort !== null ? `effort ${n.effort} ${EFFORT_UNIT}` : null,
        ]),
      );
    }
    for (const e of r.edges) lines.push(`${e.from} ${e.type} ${e.to}`);
    for (const c of r.cycles) lines.push(`cycle: ${c.join(' → ')}`);
    for (const x of r.at_risk) lines.push(`${x.id} at risk: ${x.reason}`);
    return lines.join('\n');
  },
  deferred_reviews: (r, _a, now) =>
    [
      s('deferred_reviews', { count: r.items.length, more: more(r.next_cursor) }),
      ...r.items.map((d) =>
        join([
          `${d.item_id} ${d.hr_item_id} ${truncate(d.text)}`,
          `deferred ${formatTime(d.deferred_at, now)}`,
          d.note ? `note: ${truncate(d.note)}` : null,
          d.follow_up ? `follow-up ${d.follow_up.id} ${d.follow_up.status}` : null,
        ]),
      ),
    ].join('\n'),
  get_changes: (r, _a, now) =>
    [
      s('get_changes', { count: r.events.length, next_cursor: r.next_cursor ?? 'none' }),
      ...r.events.map((e) => eventRow(e, now)),
    ].join('\n'),
  create_item: (r) => s('create_item', { ...r.item, title: title80(r.item.title) }),
  update_item: (r, a) =>
    s('update_item', {
      id: r.item.id,
      version: r.item.version,
      changed:
        Object.keys(a)
          .filter((k) => !MUTATION_ARG_KEYS.has(k))
          .join(', ') || 'nothing',
    }),
  set_status: (r) => s('set_status', r.item),
  link_items: (r) =>
    s('link_items', {
      ...r,
      verb: r.updated ? 'Updated' : 'Linked',
      rule: r.satisfied_when ? `${SEP}clears when ${r.satisfied_when}` : '',
    }),
  unlink_items: (_r, a) =>
    s('unlink_items', { link: str(a.link_id) ?? `${str(a.from)} ${str(a.type)} ${str(a.to)}` }),
  upsert_label: (r) => s('upsert_label', r),
  claim_lead: (r, _a, now) =>
    s('claim_lead', {
      id: r.item.id,
      run_id: r.run_id,
      lease: formatTime(r.lease_expires_at, now),
      version: r.item.version,
    }),
  release_lead: (r) => s('release_lead', r.item),
  start_run: (r, a) => s('start_run', { run_id: r.run_id, id: str(a.id) }),
  heartbeat: (r, a, now) =>
    s('heartbeat', {
      run_id: str(a.run_id),
      run_state: r.run_state,
      lease: r.lease_expires_at ? formatTime(r.lease_expires_at, now) : 'none',
      resources:
        r.resources.length > 0
          ? `${SEP}resources: ${r.resources.map((x) => `${x.id} ${truncate(x.label, 120)}`).join(', ')}`
          : '',
    }),
  finish_run: (r, a) => s('finish_run', { run_id: str(a.run_id), run_state: r.run_state }),
  park_run: (r, a, now) => {
    const waiting = a.waiting_on ? waitingOnText(a.waiting_on as WaitingOn, now) : null;
    return s('park_run', {
      run_id: str(a.run_id),
      waiting: waiting ? `${SEP}${waiting}` : '',
      ready: r.resume_ready ? 'ready to resume' : 'resume_ready false',
    });
  },
  set_plan: (r, a) =>
    s('set_plan', {
      id: str(a.id),
      plan_version: r.plan_version,
      done: r.work.filter((w) => w.state === 'done').length,
      total: r.work.length,
    }),
  update_step: (r, a) =>
    s('update_step', { step_id: r.step.id, state: r.step.state, id: str(a.id) }),
  log_subagent: (_r, a) =>
    s('log_subagent', {
      provenance: str(a.provenance),
      name: str(a.name),
      target: str(a.step_id) ?? str(a.id),
    }),
  set_checks: (r, a) =>
    s('set_checks', {
      id: str(a.id),
      pass: r.checks.filter((c) => c.state === 'pass').length,
      total: r.checks.length,
    }),
  update_check: (r, a) =>
    s('update_check', { check_id: r.check.id, state: r.check.state, id: str(a.id) }),
  declare_human_review: (r, a) =>
    s('declare_human_review', { id: str(a.id), count: r.human_review.length }),
  update_human_review: (r, a) =>
    s('update_human_review', { id: str(a.id), count: r.human_review.length }),
  add_note: (r, a, now) =>
    s('add_note', { id: r.event.item_id ?? str(a.id), at: formatTime(r.event.at, now) }),
  put_document: (r, a) => s('put_document', { ...r, name: str(a.name) ?? r.document_id }),
  link_artifact: (r, a) =>
    s('link_artifact', { kind: r.artifact.kind, label: r.artifact.label, id: str(a.id) }),
  report_commit: (r, a) =>
    s('report_commit', {
      sha: shortSha(str(a.sha) ?? ''),
      id: str(a.id),
      pushed: a.pushed === true ? `${SEP}pushed` : '',
      stale:
        r.stale_packets.length > 0
          ? `${SEP}out of date: ${r.stale_packets.map((p) => `${p.item_id} round ${p.round}`).join(', ')}`
          : '',
    }),
  submit_packet: (r) =>
    s('submit_packet', {
      display_id: r.display_id,
      round: r.round,
      id: r.item.id,
      status: r.item.status,
      version: r.item.version,
    }),
  get_review: (r, a, now) => {
    const lines = [s('get_review', { id: str(a.id), count: r.rounds.length })];
    for (const round of r.rounds) {
      lines.push(
        join([
          `${round.packet_id} round ${round.round}`,
          round.state,
          round.stale ? 'stale' : null,
          `built ${shortSha(round.built_from_commit)}`,
          `submitted ${formatTime(round.submitted_at, now)}`,
          round.decided_at ? `decided ${formatTime(round.decided_at, now)}` : null,
        ]),
      );
      for (const i of round.items) {
        const d = i.decision;
        lines.push(
          join([
            `${I1}- ${i.hr_item_id} ${truncate(i.text)}`,
            d ? `${d.kind}${d.note ? `: ${d.note}` : ''}` : 'undecided',
            d?.into ? `into ${d.into}` : null,
            d?.follow ? `follow ${d.follow}` : null,
            d?.result_ref ? `→ ${d.result_ref}` : null,
          ]),
        );
      }
    }
    return lines.join('\n');
  },
  ask_owner: (r, a) => s('ask_owner', { id: str(a.id), question_id: r.question_id }),
  publish_decision: (r) =>
    s('publish_decision', {
      decision_id: r.decision.id,
      title: title80(r.decision.title),
      authority: r.decision.authority,
    }),
  list_decisions: (r) =>
    [
      s('list_decisions', { count: r.items.length, more: more(r.next_cursor) }),
      ...r.items.flatMap((d) => [decisionRow(d), `${I1}${truncate(d.decision_md)}`]),
    ].join('\n'),
  withdraw_decision: (r) =>
    s('withdraw_decision', { decision_id: r.decision.id, title: title80(r.decision.title) }),
  recovery_report: (r, _a, now) => {
    const lines = [
      s('recovery_report', {
        interrupted: r.interrupted.length,
        stale: r.stale.length,
        parked: r.parked.length,
        workspaces: r.workspaces.length,
        orphaned: r.orphaned_resources.length,
        more: more(r.next_cursor),
      }),
    ];
    const wsOf = (run: Run) =>
      run.workspace ? workspaceText(run.workspace, { state: false }) : 'no workspace recorded';
    const runRef = (run: Run) =>
      join([
        `run ${run.run_id} ${leadName(run)}`,
        run.orchestrator
          ? `orchestrator ${[run.orchestrator.name, run.orchestrator.dispatch_id, run.orchestrator.task_id].filter(Boolean).join(' ')}`
          : null,
      ]);
    if (r.interrupted.length > 0) {
      lines.push('interrupted:');
      for (const e of r.interrupted) {
        lines.push(
          `${I1}${join([
            `${e.item.id} ${truncate(e.item.title, 80)}`,
            `interrupted (${e.end_reason})`,
            `${e.checklist.done}/${e.checklist.total} done`,
            wsOf(e.run),
            e.run.brief_document_version_id
              ? `brief ${e.run.brief_document_version_id}`
              : 'no brief',
          ])}`,
          `${I1}  ${runRef(e.run)}`,
        );
        if (e.run.resources.some((x) => !x.released_at)) {
          lines.push(
            `${I1}  resources: ${e.run.resources
              .filter((x) => !x.released_at)
              .map((x) => resourceText(x, now))
              .join('; ')}`,
          );
        }
        if (e.run.external !== undefined && Object.keys(e.run.external).length > 0) {
          lines.push(`${I1}  external: ${JSON.stringify(e.run.external)}`);
        }
        if (e.open_question) {
          lines.push(`${I1}  question: ${e.open_question.id} ${truncate(e.open_question.text)}`);
        }
        if (e.brief !== undefined) lines.push(...block('brief', e.brief, `${I1}  `));
      }
    }
    if (r.stale.length > 0) {
      lines.push('stale:');
      for (const e of r.stale) {
        lines.push(
          `${I1}${join([
            `${e.item.id} ${truncate(e.item.title, 80)}`,
            'stale',
            `last signal ${formatTime(e.run.last_signal_at, now)}`,
            wsOf(e.run),
          ])}`,
          `${I1}  ${runRef(e.run)}`,
        );
      }
    }
    if (r.parked.length > 0) {
      lines.push('parked:');
      for (const e of r.parked) {
        const p = e.run.parked;
        lines.push(
          `${I1}${join([
            `${e.item.id} ${truncate(e.item.title, 80)}`,
            p ? waitingOnText(p.waiting_on, now) : null,
            `resume_ready ${e.resume_ready}`,
            p ? `since ${formatTime(p.since, now)}` : null,
            wsOf(e.run),
          ])}`,
          `${I1}  ${runRef(e.run)}${p ? `${SEP}reason: ${truncate(p.reason)}` : ''}`,
        );
      }
    }
    if (r.workspaces.length > 0) {
      lines.push('workspaces:');
      for (const w of r.workspaces) {
        lines.push(
          `${I1}${join([
            w.state,
            workspaceText(w, { state: false }),
            w.item_id,
            `run ${w.run_id}`,
            w.unreleased_resources > 0
              ? `${w.unreleased_resources} unreleased resource${w.unreleased_resources === 1 ? '' : 's'}`
              : null,
          ])}`,
        );
      }
    }
    if (r.orphaned_resources.length > 0) {
      lines.push('orphaned_resources:');
      for (const o of r.orphaned_resources) {
        lines.push(
          `${I1}${join([
            resourceText(o.resource, now),
            o.item_id,
            `run ${o.run_id} ended ${formatTime(o.run_ended_at, now)}`,
          ])}`,
        );
      }
    }
    return lines.join('\n');
  },
};

/** The compact text block for a tool's successful result. */
export function renderResult<N extends ToolName>(
  name: N,
  result: ToolOutput<N>,
  opts?: ResultRenderOptions,
): string;
export function renderResult(name: ToolName, result: unknown, opts?: ResultRenderOptions): string;
export function renderResult(
  name: ToolName,
  result: unknown,
  opts: ResultRenderOptions = {},
): string {
  const render = RENDERERS[name] as Renderer<ToolName>;
  const text = render(result as never, opts.args ?? {}, opts.now ?? new Date());
  return withExtras(text, result as { replayed?: boolean; warnings?: string[] });
}
