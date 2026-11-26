import { describe, expect, it } from 'vitest';
import type { ItemDetailResponse } from '@docket/shared';
import { itemTabs } from './ItemPage';

describe('epic Map tab progress', () => {
  it('uses the graph count, excluding canceled tickets', () => {
    const data = {
      item: {
        checklist: { work: [], checks: [], human_review: [] },
        links: { blocks: [], blocked_by: [] },
        runs: [],
      },
      children: [{ status: 'done' }, { status: 'progress' }, { status: 'canceled' }],
    } as unknown as ItemDetailResponse;

    expect(itemTabs('epic', data).find((tab) => tab.key === 'map')?.count).toBe('1/2');
  });
});
