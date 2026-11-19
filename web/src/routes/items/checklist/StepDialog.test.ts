/**
 * The step dialog's history lines (decision 33; UI_SPEC §6.3.1a; B34): a
 * step the Jira import made reads "Imported from Jira (TL-8)", not "Added by
 * you" (the import adds steps as the owner); every other step keeps who
 * added it.
 */
import { describe, expect, it } from 'vitest';
import type { StepHistoryEntry } from '@docket/shared';
import { historyText } from './StepDialog';

const added = (by: string): StepHistoryEntry => ({
  at: '2026-11-19T00:59:00Z',
  by,
  change: 'added',
});

describe('historyText', () => {
  it('an imported step’s "added" line names Jira and the sub-task’s key', () => {
    expect(historyText(added('owner'), 'TL-8')).toBe('Imported from Jira (TL-8)');
  });

  it('otherwise says who added it', () => {
    expect(historyText(added('owner'))).toBe('Added by you');
    expect(historyText(added('codex · e2e-w1'))).toBe('Added by codex · e2e-w1');
    // An agent's step on an imported item is still the agent's.
    expect(historyText(added('codex · e2e-w1'), 'TL-8')).toBe('Added by codex · e2e-w1');
  });

  it('other changes are unaffected by the import', () => {
    expect(
      historyText({ at: 'x', by: 'owner', change: 'details', from: 'v1', to: 'v2' }, 'TL-8'),
    ).toBe('you edited the details (v1 → v2)');
  });
});
