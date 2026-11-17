/**
 * The import commit (BUILD_SPEC §9 step 3; FR-091): every record the plan
 * describes, in the caller's one write-path transaction. A throw anywhere
 * rolls all of it back, so an import is all or nothing.
 *
 * - The target: a new project (`openProject`, which also handles a
 *   deleted project's key) or an existing empty one.
 * - Items in Jira key order, with `jira_key` and `imported = 1`. Done items
 *   get `closed_by = imported`. In-progress items get no lead claim and no
 *   run. Epics are inserted before the items that point at them.
 * - Labels, the epic, planned dates and effort (`dates_set_by = Jira
 *   import`), the sub-tasks as plan version 1 of the parent's work steps,
 *   links as they were in Jira (cycles included: they show under Problems),
 *   and each comment as a `note.added` event "Imported comment · author ·
 *   date: text".
 * - **Event times:** every event is stamped at import time, by the write
 *   path, so burn-down and the timeline (which replay events in time order)
 *   see the import as one moment. Jira's own dates (created, updated,
 *   resolved, and each comment's date) are carried as event data and in
 *   the comment text, never as event times.
 * - One `project.updated` event summarises the import, and the report is
 *   stored as version 1 of the project's `import_report` document.
 *
 * Attachment bytes are not part of the transaction: the service downloads
 * them after the commit (jira-import.ts).
 */
import { ToolError, scanForSecrets, type JiraReport } from '@tasklite/shared';
import type { Db } from '../../db/client.js';
import type { DocumentsService } from '../../domain/contracts.js';
import { allocateItemId, newId } from '../../domain/ids.js';
import { ms } from '../../domain/model.js';
import { openProject } from '../../domain/projects.js';
import type { WriteContext } from '../../domain/write.js';
import type { ImportPlan, PlannedItem } from './types.js';

export const DATES_SET_BY = 'Jira import';

export interface CommitInput {
  import_id: string;
  site: string;
  plan: ImportPlan;
  report: JiraReport;
  target: { kind: 'new'; key: string; name: string } | { kind: 'existing'; key: string };
  docsDir: string;
  documents: DocumentsService;
  /** Secrets matched by value (the service's own, and the Jira token). */
  known: readonly string[];
}

export interface CommitResult {
  project: string;
  project_name: string;
  /** Jira key → Task Lite item ID. */
  ids: Map<string, string>;
  report_document_id: string;
  report_name: string;
}

/** The report document's name: one per import, so a re-import adds a document. */
export const reportName = (jiraProject: string, importId: string) =>
  `jira-import-${jiraProject}-${importId.slice(-8).toLowerCase()}.json`;

/** The JSON stored as the `import_report` document. No credentials, by construction. */
export function reportDocument(input: {
  import_id: string;
  site: string;
  jira_project: string;
  project: string;
  at: string;
  report: JiraReport;
  ids: Map<string, string>;
  attachments?: { stored: number; failed: { name: string; reason: string }[] };
}): string {
  return `${JSON.stringify(
    {
      kind: 'jira_import_report',
      import_id: input.import_id,
      site: input.site,
      jira_project: input.jira_project,
      project: input.project,
      imported_at: input.at,
      report: input.report,
      items: Object.fromEntries(input.ids),
      attachments: input.attachments ?? null,
    },
    null,
    2,
  )}\n`;
}

function emptyProject(db: Db, key: string): { name: string } {
  const row = db.sqlite
    .prepare('SELECT name FROM projects WHERE key = ? AND deleted_at IS NULL')
    .get(key) as { name: string } | undefined;
  if (!row) throw new ToolError('not_found', `No project ${key}. Check the key in Settings.`);
  const n = (
    db.sqlite.prepare('SELECT count(*) AS n FROM items WHERE project_key = ?').get(key) as {
      n: number;
    }
  ).n;
  if (n > 0) {
    throw new ToolError(
      'conflict',
      `Project ${key} isn't empty (${n} ${n === 1 ? 'item' : 'items'}). Import into a new project instead.`,
      { details: { fields: { 'target.key': 'not empty' } } },
    );
  }
  return row;
}

/** Check the target before anything is read from Jira (and again in the commit). */
export function checkExistingTarget(db: Db, key: string): void {
  emptyProject(db, key);
}

export function commitPlan(w: WriteContext, input: CommitInput): CommitResult {
  if (w.actor.kind !== 'owner') {
    throw new ToolError('forbidden', 'Only the owner imports from Jira, in Settings.');
  }
  const { plan } = input;
  // The mapper already dropped secret-like text; this is the domain layer's own check.
  const hit = scanForSecrets(
    plan.items.map((i) => [
      i.title,
      i.description_md,
      i.labels,
      i.steps.map((s) => s.text),
      i.comments.map((c) => [c.author, c.text]),
      i.attachments.map((a) => a.name),
    ]),
    { known: input.known },
  );
  if (hit)
    throw new ToolError('validation', `Looks like a secret (${hit.kind}); run the dry run again.`);

  let projectKey: string;
  let projectName: string;
  if (input.target.kind === 'new') {
    const p = openProject(w, input.docsDir, { key: input.target.key, name: input.target.name });
    projectKey = p.key;
    projectName = p.name;
  } else {
    projectKey = input.target.key;
    projectName = emptyProject(w.db, projectKey).name;
  }

  // IDs in Jira key order; epics go in first so the others can point at them.
  const ids = new Map<string, string>();
  for (const item of plan.items) ids.set(item.jira_key, allocateItemId(w.db.sqlite, projectKey));
  const ordered = [
    ...plan.items.filter((i) => i.type === 'Epic'),
    ...plan.items.filter((i) => i.type !== 'Epic'),
  ];

  const labelIds = new Map<string, string>();
  const labelId = (name: string, created: string[]): string => {
    const cached = labelIds.get(name);
    if (cached) return cached;
    const row = w.db.sqlite
      .prepare('SELECT id FROM labels WHERE project_key = ? AND name = ?')
      .get(projectKey, name) as { id: string } | undefined;
    if (row) {
      labelIds.set(name, row.id);
      return row.id;
    }
    const id = newId('lbl', ms(w.now));
    w.insert('labels', { id, project_key: projectKey, name, brief_md: '' });
    labelIds.set(name, id);
    created.push(name);
    return id;
  };

  for (const item of ordered) insertItem(w, item, ids, projectKey, labelId);

  for (const link of plan.links) {
    const from = ids.get(link.from)!;
    const to = ids.get(link.to)!;
    const linkId = newId('lnk', ms(w.now));
    w.insert('links', {
      id: linkId,
      from_id: from,
      to_id: to,
      type: link.type,
      created_by: 'owner',
    });
    w.event({
      type: 'link.added',
      summary: `${from} ${link.type === 'blocks' ? 'blocks' : 'relates to'} ${to} (imported from Jira ${link.jira_types.join(', ')})`,
      item_id: to,
      project_key: projectKey,
      data: {
        link_id: linkId,
        from,
        to,
        type: link.type,
        jira: { from: link.from, to: link.to, types: link.jira_types },
      },
      objects: [
        { kind: 'item', id: from },
        { kind: 'link', id: linkId },
      ],
    });
  }

  w.event({
    type: 'project.updated',
    summary: `Imported ${input.report.totals.would_import} of ${input.report.totals.issues} Jira issues from ${plan.jira_project} into ${projectName} (${projectKey})`,
    project_key: projectKey,
    data: {
      import_id: input.import_id,
      jira_project: plan.jira_project,
      site: input.site,
      totals: input.report.totals,
      items: plan.items.length,
      links: plan.links.length,
    },
    objects: [{ kind: 'project', id: projectKey }],
  });

  const name = reportName(plan.jira_project, input.import_id);
  // `import_report` is written only here; put_document's schema doesn't offer it to agents.
  const doc = input.documents.put(w, {
    project: projectKey,
    name,
    kind: 'import_report' as 'other',
    mime: 'application/json',
    content_text: reportDocument({
      import_id: input.import_id,
      site: input.site,
      jira_project: plan.jira_project,
      project: projectKey,
      at: w.now,
      report: input.report,
      ids,
    }),
  });
  return {
    project: projectKey,
    project_name: projectName,
    ids,
    report_document_id: doc.document_id,
    report_name: name,
  };
}

function insertItem(
  w: WriteContext,
  item: PlannedItem,
  ids: Map<string, string>,
  projectKey: string,
  labelId: (name: string, created: string[]) => string,
): void {
  const id = ids.get(item.jira_key)!;
  const dated = item.planned_start !== null || item.planned_end !== null;
  const done = item.status === 'done';
  w.insert('items', {
    id,
    project_key: projectKey,
    type: item.type,
    title: item.title,
    description_md: item.description_md,
    outcome_md: '',
    status: item.status,
    priority: item.priority,
    epic_id: item.epic_key ? ids.get(item.epic_key)! : null,
    planned_start: item.planned_start,
    planned_end: item.planned_end,
    dates_set_by: dated ? DATES_SET_BY : null,
    dates_set_at: dated ? w.now : null,
    effort: item.effort,
    closed_by: done ? 'imported' : null,
    closed_at: done ? w.now : null,
    jira_key: item.jira_key,
    imported: true,
  });
  const created: string[] = [];
  for (const name of item.labels) {
    w.insert('item_labels', {
      id: newId('il', ms(w.now)),
      item_id: id,
      label_id: labelId(name, created),
    });
  }
  w.event({
    type: 'item.created',
    summary: `Imported ${item.jira_key} from Jira as ${item.type.toLowerCase()} ${id} ${item.title}`,
    item_id: id,
    project_key: projectKey,
    data: {
      status: item.status,
      imported: true,
      jira_key: item.jira_key,
      labels_created: created,
      // Jira's own times: data, never the event time.
      jira: item.jira,
    },
  });

  if (item.steps.length > 0) {
    w.insert('plan_versions', {
      id: newId('pv', ms(w.now)),
      item_id: id,
      version_no: 1,
      reason: 'Imported from Jira sub-tasks',
      created_by: 'owner',
    });
    item.steps.forEach((step, position) => {
      w.insert('work_steps', {
        id: newId('wst', ms(w.now)),
        item_id: id,
        plan_version_no: 1,
        position,
        text: step.text,
        state: step.state,
        added_by: 'owner',
        state_by: 'owner',
        state_at: w.now,
      });
    });
    w.event({
      type: 'plan.updated',
      summary: `Imported ${item.steps.length} work ${item.steps.length === 1 ? 'step' : 'steps'} on ${id} from Jira sub-tasks`,
      item_id: id,
      project_key: projectKey,
      data: {
        plan_version: 1,
        reason: 'Imported from Jira sub-tasks',
        steps: item.steps.map((s) => ({ jira_key: s.jira_key, text: s.text, state: s.state })),
      },
    });
  }

  for (const c of item.comments) {
    const date = c.created ? c.created.slice(0, 10) : 'undated';
    w.event({
      type: 'note.added',
      summary: `Imported comment · ${c.author} · ${date}: ${c.text}`,
      item_id: id,
      project_key: projectKey,
      data: {
        imported_comment: true,
        jira_comment_id: c.jira_id,
        author: c.author,
        created: c.created,
        text: c.text,
      },
    });
  }
}
