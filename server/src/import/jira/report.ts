/**
 * The dry-run report (BUILD_SPEC §9 "The report"; FR-090; SC-011): built
 * from the import plan, shown in the Import dialog, and stored as the
 * project's `import_report` document after the commit.
 *
 * It accounts for every issue read: `issues = would_import + skipped`.
 * `lossy` counts the imported issues that lost something. `lossy_items`
 * lists each lossy issue once, and each skipped one with "Skipped: <why>"
 * (the report schema has one list of issues with reasons, so skipped issues
 * are listed there too, marked).
 *
 * Nothing in it comes from the credentials: no email, no token.
 */
import type { JiraReport } from '@docket/shared';
import { compareKeys } from './mapper.js';
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

export function buildReport(plan: ImportPlan): JiraReport {
  const skipped = plan.outcomes.filter((o) => o.outcome === 'skipped');
  const lossy = plan.outcomes.filter((o) => o.outcome !== 'skipped' && o.reasons.length > 0);
  const attachments = plan.items.flatMap((i) => i.attachments);
  return {
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
