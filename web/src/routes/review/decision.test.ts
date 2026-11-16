import { describe, expect, it } from 'vitest';
import {
  EMPTY_DRAFT,
  agentOf,
  decidedMessage,
  missingNote,
  outcomeCallout,
  submitLabel,
  tally,
  verdictsOf,
  type Drafts,
} from './decision';

const items = [{ hr_item_id: 'hr_a' }, { hr_item_id: 'hr_b' }];
const data = {
  item: { id: 'RCP-12' } as never,
  unblocks: ['RCP-22', 'RCP-23'],
  packet: { display_id: 'pkt-9c0e', round: 2 },
};
const d = (kinds: (string | undefined)[], extra: Partial<typeof EMPTY_DRAFT> = {}): Drafts =>
  Object.fromEntries(
    kinds.map((k, i) => [
      items[i]!.hr_item_id,
      { ...EMPTY_DRAFT, ...extra, ...(k ? { kind: k as 'approve' } : {}) },
    ]),
  );

describe('the primary button names the outcome (UI_SPEC §6.4)', () => {
  it.each([
    [[undefined, undefined], 'Decide every item first'],
    [['approve', undefined], 'Decide every item first'],
    [['approve', 'approve'], 'Approve and close ticket'],
    [['approve', 'defer'], 'Close ticket (1 deferred)'],
    [['defer', 'defer'], 'Close ticket (2 deferred)'],
    [['approve', 'changes'], 'Send back to codex'],
    [['defer', 'changes'], 'Send back to codex'],
  ])('%j → %s', (kinds, label) => {
    expect(submitLabel(tally(items, d(kinds)), 'codex')).toBe(label);
  });

  it('counts decided items', () => {
    expect(tally(items, d(['approve', undefined]))).toMatchObject({
      decided: 1,
      total: 2,
      complete: false,
    });
  });
});

describe('the callout says exactly what will happen', () => {
  it('approve all names the packet and what it unblocks', () => {
    expect(outcomeCallout(tally(items, d(['approve', 'approve'])), data)).toBe(
      'Approving records your decision on pkt-9c0e and closes RCP-12, which unblocks RCP-22, RCP-23.',
    );
  });
  it('changes: back to In progress, and the next round', () => {
    expect(outcomeCallout(tally(items, d(['changes', 'defer'])), data)).toBe(
      'Each finding becomes a checklist item or a bug. RCP-12 goes back to In progress and you’ll get a round 3 packet. Deferred items stay deferred.',
    );
  });
  it('deferred: closes, never as approved', () => {
    expect(outcomeCallout(tally(items, d(['approve', 'defer'])), data)).toContain(
      '1 item is recorded as deferred, not verified',
    );
  });
  it('nothing until every item is decided', () => {
    expect(outcomeCallout(tally(items, d(['approve', undefined])), data)).toBeNull();
  });
});

describe('verdicts sent to the API', () => {
  it('changes needs a note; the first one missing is found', () => {
    expect(missingNote(items, d(['approve', 'changes']))).toBe('hr_b');
    expect(missingNote(items, d(['approve', 'changes'], { note: 'Too small' }))).toBeNull();
  });
  it('shapes each verdict for its kind', () => {
    const drafts: Drafts = {
      hr_a: { kind: 'changes', note: ' Too small ', into: 'bug', follow: 'ticket' },
      hr_b: { kind: 'defer', note: '', into: 'checklist', follow: 'none' },
    };
    expect(verdictsOf(items, drafts)).toEqual([
      { hr_item_id: 'hr_a', kind: 'changes', note: 'Too small', into: 'bug' },
      { hr_item_id: 'hr_b', kind: 'defer', follow: 'none' },
    ]);
    expect(verdictsOf(items, d(['approve', 'approve']))).toEqual([
      { hr_item_id: 'hr_a', kind: 'approve' },
      { hr_item_id: 'hr_b', kind: 'approve' },
    ]);
  });
});

describe('toasts and names', () => {
  it('the agent is the client part of created_by', () => {
    expect(agentOf('codex · orca-w3')).toBe('codex');
    expect(agentOf('claude')).toBe('claude');
  });
  it('a close names what it unblocked; a send-back names the new bug', () => {
    expect(
      decidedMessage(
        { outcome: 'done', unblocked: ['RCP-22'], created: [] },
        'RCP-12',
        tally(items, d(['approve', 'defer'])),
        'codex',
      ),
    ).toBe('RCP-12 closed with 1 deferred. RCP-22 unblocked.');
    expect(
      decidedMessage(
        { outcome: 'progress', unblocked: [], created: [{ id: 'RCP-30', kind: 'bug' }] },
        'RCP-12',
        tally(items, d(['changes', 'approve'])),
        'codex',
      ),
    ).toBe('Sent RCP-12 back to codex; created RCP-30.');
  });
});
