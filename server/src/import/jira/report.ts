/**
 * The dry-run report (BUILD_SPEC §9 "The report"; FR-090; SC-011): built
 * from the import plan, shown in the Import dialog, and stored as the
 * project's `import_report` document after the commit.
 *
 * It accounts for every issue read: `issues = would_import + skipped`.
 * `lossy` counts the issues imported with changes (shown as "Imported with
 * changes" since B32; the field names stay), every sub-task included. `lossy_items`
 * lists each lossy issue once, and each skipped one with "Skipped: <why>"
 * (the report schema has one list of issues with reasons, so skipped issues
 * are listed there too, marked).
 *
 * `groups` (B32) puts the changed and skipped issues under their reasons,
 * each with what is kept and what is not, for the dialog and the stored copy.
 *
 * Nothing in it comes from the credentials: no email, no token.
 */
import { TEXT_LIMITS, type JiraReport } from '@docket/shared';
import { STEP_REASON_PREFIX, compareKeys } from './mapper.js';
import type { ImportPlan, PlannedLink } from './types.js';

/** Dependency cycles among `blocks` links (Tarjan's SCC), each as Jira keys in key order. */
export function findCycles(links: readonly PlannedLink[]): string[][] {
  const next = new Map<string, string[]>();
  for (const l of links) {
    if (l.type !== 'blocks') continue;
    next.set(l.from, [...(next.get(l.from) ?? []), l.to]);
    if (!next.has(l.to)) next.set(l.to, []);
  }
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  let counter = 0;
  // Iterative, so a long imported chain can't overflow the call stack.
  for (const root of [...next.keys()].sort(compareKeys)) {
    if (index.has(root)) continue;
    const work: { node: string; i: number }[] = [{ node: root, i: 0 }];
    index.set(root, counter);
    low.set(root, counter++);
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const succ = next.get(frame.node)!;
      if (frame.i < succ.length) {
        const w = succ[frame.i++]!;
        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter++);
          stack.push(w);
          onStack.add(w);
          work.push({ node: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(w)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          component.push(w);
        } while (w !== frame.node);
        if (component.length > 1) out.push(component.sort(compareKeys));
      }
    }
  }
  return out.sort((a, b) => compareKeys(a[0]!, b[0]!));
}

/**
 * The report's legend (B32): every issue is one of these. The JSON keeps
 * its field names (`lossy`, `lossy_items`); these are the words shown.
 */
export const REPORT_LEGEND = {
  as_is: 'Imported as is',
  changed: 'Imported with changes',
  skipped: 'Skipped (not imported, with the reason)',
} as const;

type GroupCopy = {
  /** "42 sub-tasks → checklist steps on their parent". */
  summary: (n: number) => string;
  kept: string | null;
  not_kept: string | null;
};

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * One entry per reason, in display order, each from a row of BUILD_SPEC
 * §9's mapping table: what happens, what is kept and what isn't.
 */
export const CHANGE_REASONS = {
  subtask: {
    summary: (c) => `${n(c, 'sub-task', 'sub-tasks')} → checklist steps on their parent`,
    kept: 'Kept: title, done or not done.',
    not_kept:
      'Not kept yet: description, comments, assignee, dates (a later update keeps the description and comments).',
  },
  other_type: {
    summary: (c) => `${n(c, 'issue', 'issues')} of other types → Tasks`,
    kept: 'Kept: everything else; the Jira type is noted in the description.',
    not_kept: 'Not kept: the type itself.',
  },
  status: {
    summary: (c) =>
      `${n(c, 'issue', 'issues')} with a non-standard status → the matching Docket status`,
    kept: 'Kept: the status category (To Do, In Progress, Done); the status name is noted in the description.',
    not_kept: 'Not kept: the status name as a status. No category → Inbox.',
  },
  priority: {
    summary: (c) => `${n(c, 'issue', 'issues')} with a non-standard priority → P2`,
    kept: 'Kept: everything else.',
    not_kept: 'Not kept: the priority name.',
  },
  parent: {
    summary: (c) => `${n(c, 'issue', 'issues')} whose parent isn't an imported epic`,
    kept: 'Kept: the item itself.',
    not_kept: 'Not kept: the parent link.',
  },
  link_type: {
    summary: (c) => `${n(c, 'issue', 'issues')} with Duplicates, Clones or other links → relates`,
    kept: 'Kept: the link, with its Jira type noted in the description.',
    not_kept: 'Not kept: the link type.',
  },
  link_dropped: {
    summary: (c) => `${n(c, 'issue', 'issues')} with links to issues outside this import`,
    kept: 'Kept: links between imported items.',
    not_kept: 'Not kept: links to issues that aren’t imported, or to sub-tasks.',
  },
  title: {
    summary: (c) => `${n(c, 'title', 'titles')} shortened`,
    kept: `Kept: the first ${TEXT_LIMITS.title} characters.`,
    not_kept: 'Not kept: the rest of the title.',
  },
  labels: {
    summary: (c) => `${n(c, 'issue', 'issues')} with labels renamed or dropped`,
    kept: 'Kept: labels, renamed to fit Docket’s label rules.',
    not_kept: 'Not kept: labels with no usable characters, or that look like secrets.',
  },
  description: {
    summary: (c) => `${n(c, 'description', 'descriptions')} simplified`,
    kept: 'Kept: the text, as Markdown.',
    not_kept:
      'Not kept: formatting Markdown can’t show (listed per issue); very long descriptions are shortened, and secret-looking ones dropped.',
  },
  comments: {
    summary: (c) => `${n(c, 'issue', 'issues')} with comments simplified or dropped`,
    kept: 'Kept: comments as Activity notes (author, date, text).',
    not_kept:
      'Not kept: formatting Markdown can’t show, the end of very long comments, and secret-looking comments.',
  },
  attachments: {
    summary: (c) => `${n(c, 'issue', 'issues')} with attachments skipped or renamed`,
    kept: 'Kept: attachments up to 500 MB, as documents.',
    not_kept: 'Not kept: larger files, and files whose names look like secrets.',
  },
  dates: {
    summary: (c) => `${n(c, 'issue', 'issues')} with dates or story points that couldn’t be read`,
    kept: 'Kept: everything else.',
    not_kept: 'Not kept: values that aren’t dates or numbers, and a start date after the due date.',
  },
  other: {
    summary: (c) => `${n(c, 'issue', 'issues')} with other changes`,
    kept: null,
    not_kept: null,
  },
} satisfies Record<string, GroupCopy>;

export const SKIP_REASONS = {
  skip_subtask: {
    summary: (c) => `${n(c, 'sub-task', 'sub-tasks')} whose parent isn’t in this import`,
    kept: null,
    not_kept: null,
  },
  skip_secret: {
    summary: (c) => `${n(c, 'issue', 'issues')} whose summary looks like a secret`,
    kept: null,
    not_kept: null,
  },
  skip_no_summary: {
    summary: (c) => `${n(c, 'issue', 'issues')} with no summary`,
    kept: null,
    not_kept: null,
  },
  skip_other: {
    summary: (c) => `${n(c, 'issue', 'issues')} skipped for other reasons`,
    kept: null,
    not_kept: null,
  },
} satisfies Record<string, GroupCopy>;

export type ChangeReason = keyof typeof CHANGE_REASONS;
export type SkipReason = keyof typeof SKIP_REASONS;

/** Which group a mapper reason belongs to (the reasons are all written in mapper.ts). */
export function reasonCode(reason: string): ChangeReason | SkipReason {
  if (reason.startsWith('Skipped: ')) {
    const why = reason.slice('Skipped: '.length);
    if (/sub-task/.test(why)) return 'skip_subtask';
    if (/looks like a secret/.test(why)) return 'skip_secret';
    if (/no summary/.test(why)) return 'skip_no_summary';
    return 'skip_other';
  }
  if (reason.startsWith(STEP_REASON_PREFIX)) return 'subtask';
  if (/^link .* imported as relates$/.test(reason)) return 'link_type';
  if (/^link .* dropped/.test(reason)) return 'link_dropped';
  if (/^Jira type .* imported as Task$/.test(reason)) return 'other_type';
  if (reason.startsWith('title shortened')) return 'title';
  if (reason.startsWith('status ')) return 'status';
  if (reason.startsWith('priority ')) return 'priority';
  if (reason.startsWith('parent ')) return 'parent';
  if (/^(a label|label )/.test(reason)) return 'labels';
  if (reason.startsWith('description')) return 'description';
  if (/^(due date|start date|story points)/.test(reason)) return 'dates';
  if (/^comment by |comments? couldn't be read$/.test(reason)) return 'comments';
  if (/^(an attachment|attachment )/.test(reason)) return 'attachments';
  return 'other';
}

/** The changed and skipped issues, grouped by reason, in the tables' order. */
export function groupOutcomes(outcomes: ImportPlan['outcomes']): JiraReport['groups'] {
  const order = [...Object.keys(CHANGE_REASONS), ...Object.keys(SKIP_REASONS)] as (
    ChangeReason | SkipReason
  )[];
  const byCode = new Map<string, { key: string; title: string; detail: string }[]>();
  for (const o of outcomes) {
    const seen = new Map<string, string[]>();
    for (const r of o.reasons) {
      const code = reasonCode(r);
      seen.set(code, [...(seen.get(code) ?? []), r]);
    }
    for (const [code, details] of seen) {
      byCode.set(code, [
        ...(byCode.get(code) ?? []),
        { key: o.key, title: o.title, detail: details.join('; ') },
      ]);
    }
  }
  return order
    .filter((code) => byCode.has(code))
    .map((code) => {
      const skipped = code in SKIP_REASONS;
      const copy: GroupCopy = skipped
        ? SKIP_REASONS[code as SkipReason]
        : CHANGE_REASONS[code as ChangeReason];
      const items = byCode.get(code)!;
      return {
        outcome: skipped ? ('skipped' as const) : ('changed' as const),
        reason: code,
        summary: copy.summary(items.length),
        kept: copy.kept,
        not_kept: copy.not_kept,
        count: items.length,
        items,
      };
    });
}

export function buildReport(plan: ImportPlan): JiraReport {
  const skipped = plan.outcomes.filter((o) => o.outcome === 'skipped');
  const lossy = plan.outcomes.filter((o) => o.outcome !== 'skipped' && o.reasons.length > 0);
  const attachments = plan.items.flatMap((i) => i.attachments);
  return {
    groups: groupOutcomes(plan.outcomes),
    totals: {
      issues: plan.outcomes.length,
      would_import: plan.outcomes.length - skipped.length,
      skipped: skipped.length,
      lossy: lossy.length,
    },
    mapping: [...plan.mapping.values()].map((r) => ({ ...r })),
    fields: [...plan.fields.entries()]
      .filter(([, t]) => t.mapped + t.skipped > 0)
      .map(([field, t]) => ({ field, ...t })),
    lossy_items: plan.outcomes
      .filter((o) => o.reasons.length > 0)
      .map((o) => ({ key: o.key, title: o.title, reason: o.reasons.join('; ') })),
    cycles: findCycles(plan.links),
    fields_used: [
      { field: 'Story points', jira_field: plan.fields_used.story_points },
      { field: 'Start date', jira_field: plan.fields_used.start_date },
      { field: 'Due date', jira_field: plan.fields_used.due_date },
    ],
    attachments: {
      count: attachments.length,
      bytes: attachments.reduce((n, a) => n + a.size, 0),
      skipped: plan.attachments_skipped.map((a) => ({ ...a })),
    },
  };
}
