/**
 * The Jira → Task Lite mapping (BUILD_SPEC §9), as a pure function of what
 * the dry run read. It builds the import plan in memory and tallies every
 * mapping, skip and loss for the report. Nothing here touches the database.
 *
 * | Jira | Task Lite |
 * |---|---|
 * | Epic; Story, Task, Bug | the same type |
 * | Sub-task | a work step on its parent (state from the status category); its own comments, assignee, dates and the rest drop out, listed |
 * | other issue types | Task, with the original type noted in the description |
 * | status category To Do / In Progress / Done | Inbox / In progress (no lead, no run) / Done (`closed_by=imported`); other status names noted |
 * | priority Highest, High / Medium / Low, Lowest | P1 / P2 / P3; anything else P2, noted |
 * | parent epic | `epic_id` |
 * | Blocks | `blocks` |
 * | Relates | `relates` |
 * | Duplicate, Cloners, other link types | `relates`, with the link type noted in the description |
 * | labels | labels (Task Lite names are lowercase letters, digits and dashes; renamed ones are listed) |
 * | description (ADF) | Markdown; unsupported nodes listed |
 * | comments | events: "Imported comment · author · date" |
 * | attachments | documents, up to 500 MB each; larger ones skipped and listed |
 * | due date, start date, story points | `planned_end`, `planned_start`, `effort`; the start and points fields are found by name, and the report says which |
 * | assignee, reporter, sprint, fix versions, components, other custom fields | not mapped: counted in the report |
 *
 * Secrets (constitution Principle VI): text that looks like a credential is
 * never imported. A summary that does skips the issue; a description,
 * comment, label or attachment name that does is dropped and listed. The
 * Jira token itself is matched by value.
 */
import {
  AGENT_UPLOAD_MAX_BYTES,
  DATE_RE,
  LIMITS,
  TEXT_LIMITS,
  findSecret,
  type ItemType,
} from '@docket/shared';
import { adfToMarkdown } from './adf.js';
import type {
  FieldTally,
  FieldsUsed,
  ImportPlan,
  ImportStatus,
  IssueOutcome,
  JiraAttachment,
  JiraComment,
  JiraField,
  JiraIssue,
  JiraLink,
  JiraSnapshot,
  PlannedAttachment,
  PlannedComment,
  PlannedItem,
  PlannedLink,
  PlannedStep,
  Tally,
} from './types.js';

// ---- Tables ----

export const STATUS_OF: Record<string, ImportStatus> = {
  new: 'inbox',
  indeterminate: 'progress',
  done: 'done',
};
export const STEP_STATE_OF: Record<string, PlannedStep['state']> = {
  new: 'todo',
  indeterminate: 'current',
  done: 'done',
};
const CATEGORY_NAME: Record<string, string> = {
  new: 'To Do',
  indeterminate: 'In Progress',
  done: 'Done',
};
const STATUS_LABEL: Record<ImportStatus, string> = {
  inbox: 'Inbox',
  progress: 'In progress',
  done: 'Done',
};
export const PRIORITY_OF: Record<string, 1 | 2 | 3> = {
  highest: 1,
  high: 1,
  medium: 2,
  low: 3,
  lowest: 3,
};
const SAME_TYPES: Record<string, ItemType> = {
  epic: 'Epic',
  story: 'Story',
  task: 'Task',
  bug: 'Bug',
};

/** The system fields the search asks for, besides every custom field. */
export const SYSTEM_FIELDS = [
  'summary',
  'issuetype',
  'status',
  'priority',
  'parent',
  'labels',
  'description',
  'issuelinks',
  'comment',
  'attachment',
  'duedate',
  'assignee',
  'reporter',
  'fixVersions',
  'components',
  'created',
  'updated',
  'resolutiondate',
] as const;

/** Field rows in the report, in display order. */
export const FIELD_ROWS = [
  'Summary',
  'Description',
  'Status',
  'Priority',
  'Parent',
  'Labels',
  'Links',
  'Comments',
  'Attachments',
  'Due date',
  'Start date',
  'Story points',
  'Assignee',
  'Reporter',
  'Sprint',
  'Fix versions',
  'Components',
  'Other custom fields',
] as const;
type FieldRow = (typeof FIELD_ROWS)[number];

/** Not mapped at all (BUILD_SPEC §9 last row): counted as skipped. */
const UNMAPPED: FieldRow[] = [
  'Assignee',
  'Reporter',
  'Sprint',
  'Fix versions',
  'Components',
  'Other custom fields',
];

const LABEL_MAX = LIMITS.label_name;
const COMMENT_MAX = TEXT_LIMITS.note;

// ---- Field detection (BUILD_SPEC §12 V4) ----

export interface FieldCandidates {
  story_points: string[];
  start_date: string[];
  sprint: string[];
}

/** Candidate field IDs, found by name: field IDs vary by site. */
export function detectFields(fields: readonly JiraField[]): FieldCandidates {
  const named = (re: RegExp) => fields.filter((f) => re.test(f.name.trim())).map((f) => f.id);
  const points = [
    ...named(/^story points?$/i),
    ...named(/^story point estimate$/i),
    ...fields.filter((f) => f.schema?.custom?.endsWith(':jsw-story-points')).map((f) => f.id),
  ];
  const sprint = [
    ...named(/^sprint$/i),
    ...fields
      .filter((f) => f.schema?.custom === 'com.pyxis.greenhopper.jira:gh-sprint')
      .map((f) => f.id),
  ];
  return {
    story_points: [...new Set(points)],
    start_date: [...new Set(named(/^start date$/i))],
    sprint: [...new Set(sprint)],
  };
}

/** The fields the search requests: the system ones and every custom field (for the counts). */
export function searchFields(fields: readonly JiraField[]): string[] {
  const custom = fields.filter((f) => f.custom || f.id.startsWith('customfield_')).map((f) => f.id);
  return [...SYSTEM_FIELDS, ...new Set(custom)];
}

// ---- Small helpers ----

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const present = (v: unknown): boolean =>
  v !== null &&
  v !== undefined &&
  v !== '' &&
  !(Array.isArray(v) && v.length === 0) &&
  !(obj(v) !== null && Object.keys(obj(v)!).length === 0);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const keyNumber = (key: string) => Number(key.slice(key.lastIndexOf('-') + 1)) || 0;
export const compareKeys = (a: string, b: string) => {
  const pa = a.slice(0, a.lastIndexOf('-'));
  const pb = b.slice(0, b.lastIndexOf('-'));
  return pa === pb ? keyNumber(a) - keyNumber(b) : pa < pb ? -1 : 1;
};

/** Shorten to `max` characters with an ellipsis. */
function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** A label as Task Lite stores it: lowercase letters, digits and dashes, at most 40. */
export function labelName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, LABEL_MAX)
    .replace(/-+$/g, '');
}

/** A date field's value as `YYYY-MM-DD`, or null. */
function dateOf(v: unknown): string | null {
  const s = str(v).slice(0, 10);
  return DATE_RE.test(s) ? s : null;
}

/** A document name within the limit, keeping the extension. */
function documentName(raw: string): string {
  const name = raw.trim() || 'attachment';
  if (name.length <= LIMITS.document_name) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
  return `${name.slice(0, LIMITS.document_name - ext.length - 1)}…${ext}`;
}

/** `a.txt`, `a (2).txt`, … unique within one item. */
function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 2; ; n++) {
    const next = `${stem} (${n})${ext}`;
    if (!taken.has(next)) return next;
  }
}

function isSubtask(issue: JiraIssue): boolean {
  const t = obj(issue.fields.issuetype);
  return t?.subtask === true || t?.hierarchyLevel === -1;
}

function typeName(issue: JiraIssue): string {
  return str(obj(issue.fields.issuetype)?.name) || 'Unknown';
}

function isEpic(issue: JiraIssue): boolean {
  return typeName(issue).toLowerCase() === 'epic';
}

function parentKey(issue: JiraIssue): string | null {
  return str(obj(issue.fields.parent)?.key) || null;
}

// ---- The mapper ----

export interface MapOptions {
  /** Secrets matched by value: the service's own, and the Jira token. */
  known?: readonly string[];
}

export function mapSnapshot(snapshot: JiraSnapshot, opts: MapOptions = {}): ImportPlan {
  const known = opts.known ?? [];
  const secret = (text: string) => findSecret(text, { known });
  const issues = [...snapshot.issues].sort((a, b) => compareKeys(a.key, b.key));
  const byKey = new Map(issues.map((i) => [i.key, i]));
  const candidates = detectFields(snapshot.fields);
  const customIds = snapshot.fields
    .filter((f) => f.custom || f.id.startsWith('customfield_'))
    .map((f) => f.id);

  // The field used is the candidate with the most values (a site can have both
  // "Story Points" and "Story point estimate"); the first one when none has any.
  const choose = (ids: string[], valid: (v: unknown) => boolean): string | null => {
    let best: string | null = ids[0] ?? null;
    let bestCount = 0;
    for (const id of ids) {
      const n = issues.filter((i) => valid(i.fields[id])).length;
      if (n > bestCount) [best, bestCount] = [id, n];
    }
    return best;
  };
  const fieldsUsed: FieldsUsed = {
    story_points: choose(candidates.story_points, (v) => typeof v === 'number'),
    start_date: choose(candidates.start_date, (v) => present(v)),
    due_date: snapshot.fields.some((f) => f.id === 'duedate') ? 'duedate' : null,
  };
  const known_custom = new Set(
    [fieldsUsed.story_points, fieldsUsed.start_date, ...candidates.sprint].filter(Boolean),
  );

  // ---- Which issues become items, steps, or are skipped ----
  const skipReason = new Map<string, string>();
  for (const issue of issues) {
    const title = str(issue.fields.summary).trim();
    const hit = secret(title);
    if (hit) skipReason.set(issue.key, `its summary looks like a secret (${hit.kind})`);
    else if (!title) skipReason.set(issue.key, 'it has no summary');
  }
  const asItem = (key: string | null) =>
    !!key && byKey.has(key) && !isSubtask(byKey.get(key)!) && !skipReason.has(key);
  for (const issue of issues) {
    if (!isSubtask(issue) || skipReason.has(issue.key)) continue;
    const parent = parentKey(issue);
    if (!asItem(parent)) {
      skipReason.set(
        issue.key,
        parent
          ? `sub-task of ${parent}, which isn't in this import`
          : "it's a sub-task with no parent",
      );
    }
  }

  // ---- Tallies ----
  const groups = {
    type: new Map<string, { jira: string; task_lite: string } & Tally>(),
    status: new Map<string, { jira: string; task_lite: string } & Tally>(),
    priority: new Map<string, { jira: string; task_lite: string } & Tally>(),
    parent: new Map<string, { jira: string; task_lite: string } & Tally>(),
    link: new Map<string, { jira: string; task_lite: string } & Tally>(),
  };
  const row = (group: keyof typeof groups, jira: string, taskLite: string, lossy = false) => {
    const k = `${jira}→${taskLite}`;
    const r = groups[group].get(k) ?? { jira, task_lite: taskLite, count: 0, lossy: 0 };
    r.count++;
    if (lossy) r.lossy++;
    groups[group].set(k, r);
  };
  const fields = new Map<string, FieldTally>(
    FIELD_ROWS.map((f) => [f, { mapped: 0, skipped: 0, lossy: 0 }]),
  );
  const field = (name: FieldRow, how: 'mapped' | 'lossy' | 'skipped') => {
    const t = fields.get(name)!;
    if (how === 'skipped') t.skipped++;
    else {
      t.mapped++;
      if (how === 'lossy') t.lossy++;
    }
  };

  const reasons = new Map<string, string[]>(issues.map((i) => [i.key, []]));
  const note = (key: string, reason: string) => reasons.get(key)?.push(reason);
  const footers = new Map<string, string[]>();
  const footer = (key: string, text: string) =>
    footers.set(key, [...(footers.get(key) ?? []), text]);
  const attachmentsSkipped: ImportPlan['attachments_skipped'] = [];

  /** Which tracked fields an issue has a value for. */
  const presentFields = (issue: JiraIssue): Set<FieldRow> => {
    const f = issue.fields;
    const out = new Set<FieldRow>();
    const add = (name: FieldRow, v: unknown) => present(v) && out.add(name);
    add('Summary', f.summary);
    add('Description', f.description);
    add('Status', f.status);
    add('Priority', f.priority);
    add('Parent', f.parent);
    add('Labels', f.labels);
    add('Links', f.issuelinks);
    const comment = obj(f.comment);
    if (
      Number(comment?.total ?? 0) > 0 ||
      present(comment?.comments) ||
      present(snapshot.comments[issue.key])
    ) {
      out.add('Comments');
    }
    add('Attachments', f.attachment);
    add('Due date', f.duedate);
    if (fieldsUsed.start_date) add('Start date', f[fieldsUsed.start_date]);
    if (fieldsUsed.story_points) add('Story points', f[fieldsUsed.story_points]);
    add('Assignee', f.assignee);
    add('Reporter', f.reporter);
    if (candidates.sprint.some((id) => present(f[id]))) out.add('Sprint');
    add('Fix versions', f.fixVersions);
    add('Components', f.components);
    if (customIds.some((id) => !known_custom.has(id) && present(f[id])))
      out.add('Other custom fields');
    return out;
  };

  const commentsOf = (issue: JiraIssue): JiraComment[] => {
    const all = snapshot.comments[issue.key];
    if (all) return all;
    const embedded = obj(issue.fields.comment)?.comments;
    return Array.isArray(embedded) ? (embedded as JiraComment[]) : [];
  };

  // ---- Links (each appears on both issues; deduped by id) ----
  const seenLinks = new Set<string>();
  const planned = new Map<string, PlannedLink>();
  for (const issue of issues) {
    const list = Array.isArray(issue.fields.issuelinks)
      ? (issue.fields.issuelinks as JiraLink[])
      : [];
    for (const link of list) {
      const id = String(link.id ?? '');
      if (id && seenLinks.has(id)) continue;
      if (id) seenLinks.add(id);
      const outward = str(link.outwardIssue?.key);
      const inward = str(link.inwardIssue?.key);
      const [from, to] = outward ? [issue.key, outward] : [inward, issue.key];
      if (!from || !to || from === to) continue;
      const name = str(link.type?.name) || 'Link';
      const blocks = name.toLowerCase() === 'blocks';
      const type = blocks ? 'blocks' : 'relates';
      const fromOk = asItem(from);
      const toOk = asItem(to);
      if (!fromOk || !toOk) {
        row('link', `Link: ${name}`, 'not imported', true);
        for (const [self, other] of [
          [from, to],
          [to, from],
        ] as const) {
          const selfIssue = byKey.get(self);
          if (!selfIssue || skipReason.has(self)) continue;
          if (isSubtask(selfIssue)) {
            note(self, `link ${name} dropped`);
            continue;
          }
          if (asItem(other)) continue;
          const otherIssue = byKey.get(other);
          const why = !otherIssue
            ? 'not in this import'
            : isSubtask(otherIssue) && !skipReason.has(other)
              ? `${other} is a sub-task (a work step)`
              : `${other} isn't imported`;
          note(self, `link ${name} with ${other} dropped: ${why}`);
        }
        continue;
      }
      const lossy = !blocks && name.toLowerCase() !== 'relates';
      row('link', `Link: ${name}`, type, lossy);
      if (lossy) {
        const phrase = str(link.type?.outward) || name.toLowerCase();
        footer(from, `${phrase} ${to}`);
        note(from, `link ${name} to ${to} imported as relates`);
      }
      const k = `${from}|${to}|${type}`;
      const existing = planned.get(k);
      if (existing) {
        if (!existing.jira_types.includes(name)) existing.jira_types.push(name);
      } else {
        planned.set(k, { from, to, type, jira_types: [name] });
      }
    }
  }

  // ---- Issues ----
  const items: PlannedItem[] = [];
  const stepsOf = new Map<string, PlannedStep[]>();
  const itemByKey = new Map<string, PlannedItem>();
  const outcomes: IssueOutcome[] = [];

  for (const issue of issues) {
    const f = issue.fields;
    const has = presentFields(issue);
    const title = str(f.summary).trim();
    const jiraType = typeName(issue);
    const skip = skipReason.get(issue.key);
    if (skip) {
      for (const name of has) field(name, 'skipped');
      row('type', `Type: ${jiraType}`, 'Skipped', true);
      outcomes.push({
        key: issue.key,
        title: skip.includes('secret') ? '(not shown: looks like a secret)' : shorten(title, 200),
        outcome: 'skipped',
        reasons: [`Skipped: ${skip}`],
      });
      continue;
    }

    const status = obj(f.status);
    const statusName = str(status?.name) || 'No status';
    const category = str(obj(status?.statusCategory)?.key);

    if (isSubtask(issue)) {
      // A work step on its parent; everything else about it drops out, listed.
      const state = STEP_STATE_OF[category] ?? 'todo';
      field('Summary', 'mapped');
      if (has.has('Status')) field('Status', STEP_STATE_OF[category] ? 'mapped' : 'lossy');
      field('Parent', 'mapped');
      const dropped: string[] = [];
      for (const name of has) {
        if (name === 'Summary' || name === 'Status' || name === 'Parent') continue;
        field(name, 'skipped');
      }
      if (has.has('Assignee')) dropped.push('assignee');
      const nComments = commentsOf(issue).length || Number(obj(f.comment)?.total ?? 0);
      if (nComments > 0) dropped.push(plural(nComments, 'comment'));
      if (has.has('Due date')) dropped.push('due date');
      if (has.has('Start date')) dropped.push('start date');
      if (has.has('Story points')) dropped.push('story points');
      if (has.has('Description')) dropped.push('description');
      const nAttachments = Array.isArray(f.attachment) ? f.attachment.length : 0;
      if (nAttachments > 0) dropped.push(plural(nAttachments, 'attachment'));
      if (has.has('Labels')) dropped.push('labels');
      if (!STEP_STATE_OF[category])
        dropped.push(`status “${statusName}” (no category; the step is to do)`);
      const parent = parentKey(issue)!;
      const text = shorten(title, TEXT_LIMITS.step);
      const parentSteps = (stepsOf.get(parent) ?? []).concat({ jira_key: issue.key, text, state });
      stepsOf.set(parent, parentSteps);
      const own = reasons.get(issue.key)!;
      const lost = [...dropped, ...own.filter((r) => r.startsWith('link'))];
      const lossy = lost.length > 0;
      row('type', `Type: ${jiraType}`, 'Work step', lossy);
      outcomes.push({
        key: issue.key,
        title: shorten(title, 200),
        outcome: 'step',
        reasons: lossy
          ? [
              `Imported as a work step on ${parent}; dropped: ${[
                ...dropped,
                ...(own.some((r) => r.startsWith('link')) ? ['links'] : []),
              ].join(', ')}`,
            ]
          : [],
      });
      continue;
    }

    // ---- An item ----
    const lower = jiraType.toLowerCase();
    const type: ItemType = SAME_TYPES[lower] ?? 'Task';
    const otherType = !SAME_TYPES[lower];
    row('type', `Type: ${jiraType}`, type, otherType);
    if (otherType) {
      footer(issue.key, `type ${jiraType}`);
      note(issue.key, `Jira type ${jiraType} imported as Task`);
    }

    // Title.
    const finalTitle = shorten(title, TEXT_LIMITS.title);
    field('Summary', finalTitle === title ? 'mapped' : 'lossy');
    if (finalTitle !== title) note(issue.key, `title shortened to ${TEXT_LIMITS.title} characters`);

    // Status.
    const itemStatus = STATUS_OF[category] ?? 'inbox';
    const standard = !!STATUS_OF[category] && CATEGORY_NAME[category] === statusName;
    const categoryName = CATEGORY_NAME[category] ?? 'No category';
    row('status', `Status: ${categoryName}`, STATUS_LABEL[itemStatus], !standard);
    if (has.has('Status')) field('Status', standard ? 'mapped' : 'lossy');
    if (!STATUS_OF[category]) {
      footer(issue.key, `status “${statusName}”`);
      note(issue.key, `status “${statusName}” has no category; imported as Inbox`);
    } else if (!standard) {
      footer(issue.key, `status “${statusName}”`);
      note(issue.key, `status “${statusName}” noted; imported as ${STATUS_LABEL[itemStatus]}`);
    }

    // Priority.
    const priorityName = str(obj(f.priority)?.name);
    const mappedPriority = PRIORITY_OF[priorityName.toLowerCase()];
    const priority = mappedPriority ?? 2;
    row(
      'priority',
      `Priority: ${priorityName || '(none)'}`,
      `P${priority}`,
      !!priorityName && !mappedPriority,
    );
    if (priorityName) {
      field('Priority', mappedPriority ? 'mapped' : 'lossy');
      if (!mappedPriority)
        note(issue.key, `priority ${priorityName} isn't standard; imported as P2`);
    }

    // Parent epic.
    let epicKey: string | null = null;
    const parent = parentKey(issue);
    if (parent) {
      const p = byKey.get(parent);
      if (type === 'Epic') {
        field('Parent', 'skipped');
        row('parent', 'Parent', 'not imported', true);
        note(issue.key, `parent ${parent} dropped: an epic can't belong to another item`);
      } else if (p && isEpic(p) && asItem(parent)) {
        epicKey = parent;
        field('Parent', 'mapped');
        row('parent', 'Parent: Epic', 'epic');
      } else {
        field('Parent', 'skipped');
        row('parent', 'Parent', 'not imported', true);
        note(
          issue.key,
          !p
            ? `parent ${parent} dropped: not in this import`
            : !isEpic(p)
              ? `parent ${parent} dropped: it isn't an epic`
              : `parent ${parent} dropped: it isn't imported`,
        );
      }
    }

    // Labels.
    const labels: string[] = [];
    if (Array.isArray(f.labels) && f.labels.length > 0) {
      let lossy = false;
      for (const raw of f.labels.map(str).filter(Boolean)) {
        const hit = secret(raw);
        const name = hit ? '' : labelName(raw);
        if (!name) {
          lossy = true;
          note(
            issue.key,
            hit
              ? `a label was dropped: it looks like a secret (${hit.kind})`
              : `label “${raw}” dropped: no usable characters`,
          );
          continue;
        }
        if (name !== raw) {
          lossy = true;
          note(issue.key, `label “${raw}” imported as ${name}`);
        }
        if (!labels.includes(name)) labels.push(name);
      }
      field('Labels', lossy ? 'lossy' : 'mapped');
    }

    // Description.
    let description = '';
    if (has.has('Description')) {
      const { markdown, losses } = adfToMarkdown(f.description);
      const hit = secret(markdown);
      if (hit) {
        field('Description', 'skipped');
        note(issue.key, `description dropped: it looks like a secret (${hit.kind})`);
      } else {
        description = markdown;
        if (losses.length > 0)
          note(issue.key, `description: ${losses.join(', ')} simplified or dropped`);
        field('Description', losses.length > 0 ? 'lossy' : 'mapped');
      }
    }

    // Dates and effort.
    let plannedEnd: string | null = null;
    let plannedStart: string | null = null;
    let effort: number | null = null;
    if (has.has('Due date')) {
      plannedEnd = dateOf(f.duedate);
      field('Due date', plannedEnd ? 'mapped' : 'skipped');
      if (!plannedEnd) note(issue.key, 'due date dropped: not a date');
    }
    if (has.has('Start date') && fieldsUsed.start_date) {
      const raw = f[fieldsUsed.start_date];
      plannedStart = dateOf(raw);
      if (!plannedStart) {
        field('Start date', 'skipped');
        note(issue.key, 'start date dropped: not a date');
      } else if (plannedEnd && plannedStart > plannedEnd) {
        field('Start date', 'skipped');
        note(issue.key, `start date ${plannedStart} dropped: after the due date ${plannedEnd}`);
        plannedStart = null;
      } else {
        field('Start date', 'mapped');
      }
    }
    if (has.has('Story points') && fieldsUsed.story_points) {
      const raw = f[fieldsUsed.story_points];
      if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
        effort = raw;
        field('Story points', 'mapped');
      } else {
        field('Story points', 'skipped');
        note(issue.key, `story points ${String(raw)} dropped: not a number ≥ 0`);
      }
    }

    // Comments.
    const comments: PlannedComment[] = [];
    if (has.has('Comments')) {
      let lossy = false;
      const list = commentsOf(issue);
      for (const c of list) {
        const author = str(c.author?.displayName) || 'Unknown';
        const { markdown, losses } = adfToMarkdown(c.body);
        const authorHit = secret(author);
        const hit = secret(markdown) ?? authorHit;
        if (hit) {
          lossy = true;
          note(
            issue.key,
            `comment by ${authorHit ? 'someone' : author} dropped: it looks like a secret (${hit.kind})`,
          );
          continue;
        }
        if (losses.length > 0) {
          lossy = true;
          note(issue.key, `comment by ${author}: ${losses.join(', ')} simplified or dropped`);
        }
        let text = markdown || '(empty comment)';
        if (text.length > COMMENT_MAX) {
          lossy = true;
          text = shorten(text, COMMENT_MAX);
          note(
            issue.key,
            `comment by ${author} shortened to ${COMMENT_MAX.toLocaleString('en-US')} characters`,
          );
        }
        comments.push({ jira_id: String(c.id), author, created: str(c.created) || null, text });
      }
      const total = Number(obj(f.comment)?.total ?? list.length);
      if (total > list.length) {
        lossy = true;
        note(issue.key, `${plural(total - list.length, 'comment')} couldn't be read`);
      }
      field('Comments', lossy ? 'lossy' : 'mapped');
    }

    // Attachments.
    const attachments: PlannedAttachment[] = [];
    if (Array.isArray(f.attachment) && f.attachment.length > 0) {
      let lossy = false;
      const taken = new Set<string>();
      for (const a of f.attachment as JiraAttachment[]) {
        const raw = str(a.filename) || `attachment-${String(a.id)}`;
        const size = Number(a.size ?? 0);
        const hit = secret(raw);
        if (hit) {
          lossy = true;
          attachmentsSkipped.push({
            key: issue.key,
            name: '(name not shown)',
            reason: `its name looks like a secret (${hit.kind})`,
          });
          note(issue.key, `an attachment was skipped: its name looks like a secret (${hit.kind})`);
          continue;
        }
        if (size > AGENT_UPLOAD_MAX_BYTES) {
          lossy = true;
          attachmentsSkipped.push({ key: issue.key, name: raw, reason: 'larger than 500 MB' });
          note(issue.key, `attachment ${raw} skipped: larger than 500 MB`);
          continue;
        }
        const name = uniqueName(documentName(raw), taken);
        taken.add(name);
        if (name !== raw) {
          lossy = true;
          note(issue.key, `attachment ${raw} stored as ${name}`);
        }
        attachments.push({
          jira_id: String(a.id),
          name,
          size,
          mime: str(a.mimeType) || 'application/octet-stream',
        });
      }
      field('Attachments', lossy ? 'lossy' : 'mapped');
    }

    // Links (the tally ran above; this is the per-issue field row).
    if (has.has('Links')) {
      const lost = reasons.get(issue.key)!.filter((r) => r.startsWith('link '));
      const list = issue.fields.issuelinks as JiraLink[];
      field(
        'Links',
        lost.length === 0 ? 'mapped' : lost.length >= list.length ? 'skipped' : 'lossy',
      );
    }

    for (const name of UNMAPPED) if (has.has(name)) field(name, 'skipped');

    const item: PlannedItem = {
      jira_key: issue.key,
      type,
      title: finalTitle,
      description_md: description,
      status: itemStatus,
      priority,
      epic_key: epicKey,
      labels,
      planned_start: plannedStart,
      planned_end: plannedEnd,
      effort,
      steps: [],
      comments,
      attachments,
      jira: {
        type: jiraType,
        status: statusName,
        priority: priorityName || null,
        created: str(f.created) || null,
        updated: str(f.updated) || null,
        resolved: str(f.resolutiondate) || null,
      },
    };
    items.push(item);
    itemByKey.set(issue.key, item);
    outcomes.push({
      key: issue.key,
      title: finalTitle,
      outcome: 'item',
      reasons: reasons.get(issue.key)!,
    });
  }

  // Steps onto their parents, and the "From Jira" notes into descriptions.
  for (const [parent, steps] of stepsOf) itemByKey.get(parent)!.steps = steps;
  for (const item of items) {
    const notes = footers.get(item.jira_key);
    const tail = notes
      ? `---
From Jira: ${notes.join(' · ')}`
      : '';
    const room = TEXT_LIMITS.markdown - (tail ? tail.length + 2 : 0);
    if (item.description_md.length > room) {
      item.description_md = shorten(item.description_md, room);
      const own = reasons.get(item.jira_key)!;
      if (!own.some((r) => r.startsWith('description:'))) fields.get('Description')!.lossy++;
      note(
        item.jira_key,
        `description shortened to ${TEXT_LIMITS.markdown.toLocaleString('en-US')} characters`,
      );
    }
    if (tail)
      item.description_md = item.description_md
        ? `${item.description_md}

${tail}`
        : tail;
  }

  return {
    jira_project: snapshot.project.key,
    items,
    links: [...planned.values()],
    outcomes,
    fields_used: fieldsUsed,
    mapping: new Map(
      (['type', 'status', 'priority', 'parent', 'link'] as const).flatMap((g) =>
        [...groups[g].entries()].map(([k, v]) => [`${g}:${k}`, v] as const),
      ),
    ),
    fields,
    attachments_skipped: attachmentsSkipped,
  };
}
