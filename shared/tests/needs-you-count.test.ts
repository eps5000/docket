import { describe, expect, it } from 'vitest';
import {
  needsYouCount,
  needsYouProblemActor,
  ownerNeedsYouCount,
  type NeedsYouResponse,
  type Problem,
} from '../src/api/read.js';

const problem = (
  kind: Problem['kind'],
  who: 'owner' | 'agent',
  reason = 'Custody unknown',
): Problem => ({
  kind,
  item_id: 'DKT-1',
  title: 'Work',
  reason,
  related: [],
  link_id: null,
  run_id: null,
  resource_ids: [],
  explanation: { what: reason, fix: 'Inspect the record', who, who_text: who },
});

describe('Needs you actor counts', () => {
  it('reconciles the approved 83 snapshot while the badge counts 17 owner actions', () => {
    const dispatch = [
      ...Array.from({ length: 57 }, () =>
        problem('dispatch_resources', 'agent', 'Custody unknown'),
      ),
      ...Array.from({ length: 2 }, () =>
        problem('dispatch_resources', 'agent', 'Custody unknown · changes protected'),
      ),
      ...Array.from({ length: 3 }, () =>
        problem('dispatch_resources', 'agent', 'agent retained by request · changes protected'),
      ),
    ];
    const view = {
      for_you_now: [{ kind: 'question' }],
      onboarding_reviews: [{ id: 'onb_1' }],
      problems: [
        ...Array.from({ length: 14 }, () => problem('agent_files_drift', 'owner')),
        problem('orphaned_resources', 'owner', 'Retained resources need a decision'),
        ...dispatch,
        problem('dispatch_custody', 'agent'),
        problem('dispatch_custody', 'agent'),
        problem('wait_missing_wake', 'agent'),
        problem('wait_missing_wake', 'agent'),
      ],
    } as unknown as NeedsYouResponse;
    expect(dispatch).toHaveLength(62);
    expect(view.problems.filter((p) => needsYouProblemActor(p) === 'agent')).toHaveLength(66);
    expect(ownerNeedsYouCount(view)).toBe(17);
    expect(needsYouCount(view)).toBe(83);
  });

  it('uses the existing who field, with a kind fallback for older rows', () => {
    expect(needsYouProblemActor(problem('wait_missing_wake', 'agent'))).toBe('agent');
    expect(needsYouProblemActor(problem('dispatch_custody', 'agent'))).toBe('agent');
    expect(
      needsYouProblemActor({ ...problem('dispatch_resources', 'agent'), explanation: undefined }),
    ).toBe('agent');
    expect(
      needsYouProblemActor({ ...problem('agent_files_drift', 'owner'), explanation: undefined }),
    ).toBe('owner');
  });
});
