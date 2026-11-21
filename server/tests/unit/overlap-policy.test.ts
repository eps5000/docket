/**
 * The overlap classification (owner decision 39; BUILD_SPEC §5.21): every
 * path of the three questions, from declarations alone. Whether the lines
 * collide is the radar's check (b46-overlaps.test.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  normaliseSharedPartKey,
  splitPartMember,
  type OverlapHandling,
  type SharedChange,
  type SharedPartKind,
} from '@docket/shared';
import { classifyPair, type PolicyChange } from '../../src/domain/overlap-policy.js';

function change(key: string, how: SharedChange = 'add', extra: Partial<PolicyChange> = {}) {
  const kind = key.slice(0, key.indexOf(':')) as SharedPartKind;
  const split = splitPartMember(key, (k) => !k.slice(k.indexOf(':') + 1).includes('.'));
  return {
    part: key,
    base: split?.part ?? key,
    member: split?.member ?? null,
    kind,
    change: how,
    design_impact: 'none',
    design_note: null,
    disputed: false,
    ...extra,
  } satisfies PolicyChange;
}

const classify = (a: PolicyChange[], b: PolicyChange[], mode: OverlapHandling = 'agents_resolve') =>
  classifyPair('GF-1', a, 'GF-2', b, mode);

describe('splitPartMember (decision 39)', () => {
  const known = new Set(['model:Token', 'table:decks', 'model:Gameflow.Domain.Deck']);
  const isPart = (k: string) => known.has(k);

  it('names a member of a registered part', () => {
    expect(splitPartMember('model:Token.expiresAt', isPart)).toEqual({
      part: 'model:Token',
      member: 'expiresAt',
    });
    expect(splitPartMember('table:decks.archived_at', isPart)).toEqual({
      part: 'table:decks',
      member: 'archived_at',
    });
  });

  it('keeps an existing part whose name holds a dot as a bare part, and takes the longest', () => {
    expect(splitPartMember('model:Gameflow.Domain.Deck', isPart)).toEqual({
      part: 'model:Gameflow.Domain.Deck',
      member: null,
    });
    expect(splitPartMember('model:Gameflow.Domain.Deck.title', isPart)).toEqual({
      part: 'model:Gameflow.Domain.Deck',
      member: 'title',
    });
  });

  it('is null for an unregistered part, and an endpoint has no member syntax', () => {
    expect(splitPartMember('model:Other.field', isPart)).toBeNull();
    const endpoint = normaliseSharedPartKey('endpoint:POST /decks/{id}/export');
    expect(endpoint.ok && endpoint.key).toBe('endpoint:POST /decks/{id}/export');
    expect(splitPartMember('endpoint:POST /decks/v1.2', () => false)).toBeNull();
  });
});

describe('1. Can they safely run at the same time?', () => {
  it('file-only overlaps run in parallel, whatever the change', () => {
    expect(
      classify([change('file:src/App.cs', 'change')], [change('file:src/App.cs', 'remove')]),
    ).toMatchObject({ outcome: 'parallel', reason: 'file_only', parts: ['file:src/App.cs'] });
  });

  it('add-only changes to different members run in parallel', () => {
    expect(
      classify([change('model:Token.expiresAt')], [change('model:Token.scopes')]),
    ).toMatchObject({
      outcome: 'parallel',
      reason: 'different_members',
      parts: ['model:Token.expiresAt', 'model:Token.scopes'],
    });
  });

  it('no shared part is no overlap', () => {
    expect(classify([change('model:Token.a')], [change('table:decks.b')])).toBeNull();
  });
});

describe('2. Would running them in order solve it?', () => {
  it.each([
    ['the same member', 'model:Token.a', 'add', 'model:Token.a', 'add', 'same_member'],
    ['a changed member', 'model:Token.a', 'change', 'model:Token.b', 'add', 'change_touches_part'],
    ['a removed member', 'table:decks.a', 'add', 'table:decks.b', 'remove', 'change_touches_part'],
    ['a bare part and a member', 'model:Token', 'add', 'model:Token.b', 'add', 'bare_part'],
    ['two bare parts', 'table:decks', 'change', 'table:decks', 'add', 'bare_part'],
    ['the same endpoint', 'endpoint:POST /a', 'add', 'endpoint:POST /a', 'add', 'same_member'],
    ['an unclear part', 'other:billing', 'add', 'other:billing', 'add', 'unclear'],
  ] as const)('%s is sequenced', (_name, a, howA, b, howB, reason) => {
    expect(classify([change(a, howA)], [change(b, howB)])).toMatchObject({
      outcome: 'sequence',
      reason,
    });
  });

  it('one colliding part sequences the pair, even if another part is safe', () => {
    expect(
      classify(
        [change('file:a.txt'), change('model:Token.a')],
        [change('file:a.txt'), change('model:Token.a')],
      ),
    ).toMatchObject({ outcome: 'sequence', reason: 'same_member' });
  });

  it('unclear never goes to the owner by itself', () => {
    expect(classify([change('other:x')], [change('other:x')])?.outcome).toBe('sequence');
  });
});

describe('3. Does it need the owner?', () => {
  it('a change to an approved design is not an overlap question: its review is separate', () => {
    const c = classify(
      [
        change('file:a.txt', 'change', {
          design_impact: 'changes_approved_design',
          design_note: 'Decision 12: tokens never expire',
        }),
      ],
      [change('file:a.txt')],
    );
    // The classifier neither escalates it nor clears it (design-review.ts); it keeps the note.
    expect(c).toMatchObject({ outcome: 'parallel', reason: 'file_only' });
    expect(c?.evidence.design_note).toBe('Decision 12: tokens never expire');
  });

  it('disputed ownership does', () => {
    expect(
      classify([change('model:Token.a', 'add', { disputed: true })], [change('model:Token.b')]),
    ).toMatchObject({ outcome: 'owner', reason: 'disputed' });
  });

  it('a design note on a part the other item does not touch changes nothing', () => {
    expect(
      classify(
        [
          change('file:a.txt'),
          change('model:Other', 'change', {
            design_impact: 'changes_approved_design',
            design_note: 'Elsewhere',
          }),
        ],
        [change('file:a.txt')],
      ),
    ).toMatchObject({ outcome: 'parallel' });
  });
});

describe('Overlap handling', () => {
  const file = [change('file:a.txt')];
  const model = [change('model:Token.a')];
  const modelB = [change('model:Token.b')];

  it('Agents resolve: only level 3 reaches the owner', () => {
    expect(classify(file, file)?.outcome).toBe('parallel');
    expect(classify(model, modelB)?.outcome).toBe('parallel');
  });

  it('Ask on shared data: also tables, models and endpoints, but not files or other parts', () => {
    expect(classify(model, modelB, 'ask_shared_data')).toMatchObject({
      outcome: 'owner',
      reason: 'setting',
    });
    expect(classify([change('table:d.a')], [change('table:d.b')], 'ask_shared_data')?.outcome).toBe(
      'owner',
    );
    expect(
      classify([change('endpoint:GET /a')], [change('endpoint:GET /a')], 'ask_shared_data')
        ?.outcome,
    ).toBe('owner');
    expect(classify(file, file, 'ask_shared_data')?.outcome).toBe('parallel');
    expect(classify([change('other:x')], [change('other:x')], 'ask_shared_data')?.outcome).toBe(
      'sequence',
    );
  });

  it('Ask on every overlap: every overlap', () => {
    expect(classify(file, file, 'ask_every')).toMatchObject({
      outcome: 'owner',
      reason: 'setting',
    });
  });

  it('a design change follows the setting like any overlap; its review is what asks', () => {
    const designed = [
      change('file:a.txt', 'add', {
        design_impact: 'changes_approved_design',
        design_note: 'AC 3',
      }),
    ];
    expect(classify(designed, file, 'ask_every')?.reason).toBe('setting');
    expect(classify(designed, file, 'agents_resolve')?.outcome).toBe('parallel');
  });
});
