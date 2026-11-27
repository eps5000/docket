import type { Page } from '@playwright/test';
import type { NeedsYouResponse } from '@docket/shared';

/** DKT-16's bounded count model, with fictional records and no host identifiers. */
export function needsYouSnapshot83(): NeedsYouResponse {
  const problem = (
    kind: NeedsYouResponse['problems'][number]['kind'],
    id: string,
    who: 'owner' | 'agent',
    reason: string,
  ): NeedsYouResponse['problems'][number] => ({
    kind,
    id,
    item_id: 'RCP-12',
    title: `Example ${id}`,
    reason,
    related: [],
    link_id: null,
    run_id: null,
    resource_ids: [],
    explanation: {
      what: reason,
      fix: 'Inspect the individual record',
      who,
      who_text: who === 'agent' ? 'Coordinator' : 'You',
    },
  });
  return {
    for_you_now: [
      {
        kind: 'question',
        item_id: 'RCP-12',
        title: 'Example owner question',
        project: 'RCP',
        question_id: 'qst_example',
        asked_by: 'codex',
        text: 'Choose a direction?',
        asked_at: '2026-11-27T05:11:00Z',
      },
    ],
    onboarding_reviews: [
      {
        id: 'onb_example',
        project: 'RCP',
        project_name: 'Recipe App',
        started_by: 'codex',
        run_id: null,
        state: 'ready_for_review',
        summary: 'Ready for your review.',
        questions: [],
        changes: { created: 1, enriched: 0, documents: 0, decisions: 0, proposals: 0 },
        workflow_proposal_id: null,
        started_at: '2026-11-27T05:11:00Z',
        finished_at: '2026-11-27T05:11:00Z',
        reviewed_at: null,
      },
    ],
    problems: [
      ...Array.from({ length: 14 }, (_, i) =>
        problem('agent_files_drift', `drift-${i}`, 'owner', 'Agent file changed'),
      ),
      problem('orphaned_resources', 'held', 'owner', 'Resource retained for a decision'),
      ...Array.from({ length: 57 }, (_, i) =>
        problem('dispatch_resources', `unknown-${i}`, 'agent', 'worktree status unknown'),
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        problem(
          'dispatch_resources',
          `protected-${i}`,
          'agent',
          'worktree status unknown · changes protected',
        ),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        problem(
          'dispatch_resources',
          `retained-${i}`,
          'agent',
          'agent retained · changes protected',
        ),
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        problem('dispatch_custody', `custody-${i}`, 'agent', 'dispatch custody unknown'),
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        problem('wait_missing_wake', `wake-${i}`, 'agent', 'wake route missing'),
      ),
    ],
    deferred: [],
    planning_queue: [],
    agent_counts: {},
  };
}

/**
 * The tab title counts only actions owed by Eric, from this response.
 */
export async function needsYouTitle(page: Page, scope = 'all'): Promise<string> {
  const view = await page.evaluate(async (s) => {
    const res = await fetch(`/api/needs-you?scope=${encodeURIComponent(s)}`);
    return (await res.json()) as NeedsYouResponse;
  }, scope);
  const n =
    view.for_you_now.length +
    view.problems.filter(
      (p) =>
        p.explanation?.who !== 'agent' &&
        !(
          !p.explanation &&
          ['dispatch_resources', 'dispatch_custody', 'wait_missing_wake'].includes(p.kind)
        ),
    ).length +
    (view.onboarding_reviews?.length ?? 0) +
    (view.overlaps?.length ?? 0) +
    (view.undeclared_holds?.length ?? 0) +
    (view.design_reviews?.length ?? 0) +
    (view.resolutions?.length ?? 0) +
    (view.project_decisions?.length ?? 0) +
    (view.project_decision_groups?.length ?? 0);
  return n > 0 ? `(${n}) Docket` : 'Docket';
}
