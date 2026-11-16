import type { Item, Run } from '@tasklite/shared';
import { describe, expect, it } from 'vitest';
import { checklistProgress, resumeNote, unpushedCommits } from './resumeNote';

const ws = (over: Partial<NonNullable<Run['workspace']>> = {}): NonNullable<Run['workspace']> => ({
  host: null,
  repo: null,
  path: 'C:/work/rcp-15',
  branch: 'rcp-15-pantry',
  base_ref: 'origin/main',
  base_sha: '9a10624',
  head_sha: '4be1c09',
  pushed_sha: '4be1c09',
  dirty: false,
  state: 'at_risk',
  updated_at: '2026-11-06T10:00:00Z',
  ...over,
});
const commits = (...shas: string[]): Item['commits'] =>
  shas.map((sha, i) => ({ sha, branch: null, at: `2026-11-06T10:0${9 - i}:00Z` }));
const step = (state: 'todo' | 'done' | 'skipped') =>
  ({ state }) as unknown as Item['checklist']['work'][number];
const item = (work: ('todo' | 'done' | 'skipped')[], c: Item['commits'] = []) =>
  ({ id: 'RCP-15', checklist: { work: work.map(step) }, commits: c }) as unknown as Pick<
    Item,
    'id' | 'checklist' | 'commits'
  >;

describe('unpushedCommits', () => {
  it('is 0 when the head is pushed, null when no head was reported', () => {
    expect(unpushedCommits({ workspace: ws() }, [])).toBe(0);
    expect(unpushedCommits({ workspace: ws({ head_sha: null }) }, [])).toBeNull();
    expect(unpushedCommits({ workspace: null }, [])).toBeNull();
  });

  it('counts the commits reported after the pushed one (newest first), at least 1', () => {
    const c = commits('88bb002', '77aa001', '6f00e12');
    expect(
      unpushedCommits({ workspace: ws({ head_sha: '88bb002', pushed_sha: '6f00e12' }) }, c),
    ).toBe(2);
    expect(
      unpushedCommits({ workspace: ws({ head_sha: '88bb002', pushed_sha: 'abcdef0' }) }, c),
    ).toBe(1);
    expect(unpushedCommits({ workspace: ws({ head_sha: '88bb002', pushed_sha: null }) }, c)).toBe(
      3,
    );
  });
});

describe('checklistProgress', () => {
  it('counts done and skipped steps of the current plan', () => {
    expect(checklistProgress(item(['done', 'skipped', 'todo', 'todo']))).toEqual({
      done: 2,
      total: 4,
    });
  });
});

describe('resumeNote (UI_SPEC §6.3.2)', () => {
  it('reads as the three lines a coordinator re-dispatches from', () => {
    const note = resumeNote(
      item(['done', 'done', 'todo', 'todo']),
      { workspace: ws(), brief_document_version_id: 'dv_01JX' },
      'http://127.0.0.1:7420',
    );
    expect(note).toBe(
      [
        'Resume RCP-15: worktree C:/work/rcp-15 on rcp-15-pantry @ 4be1c09',
        '(clean),',
        'brief dv_01JX (http://127.0.0.1:7420/api/documents/dv_01JX/content), checklist 2/4, claim_lead first',
      ].join('\n'),
    );
  });

  it('names unpushed commits and uncommitted changes, and says what was never recorded', () => {
    const at = item(['todo'], commits('77aa001', '6f00e12'));
    expect(
      resumeNote(
        at,
        {
          workspace: ws({ head_sha: '77aa001', pushed_sha: '6f00e12', dirty: true }),
          brief_document_version_id: null,
        },
        'http://x',
      ),
    ).toBe(
      [
        'Resume RCP-15: worktree C:/work/rcp-15 on rcp-15-pantry @ 6f00e12',
        '(1 unpushed commit / uncommitted changes),',
        'brief not recorded, checklist 0/1, claim_lead first',
      ].join('\n'),
    );
    expect(
      resumeNote(item([]), { workspace: null, brief_document_version_id: null }, 'http://x'),
    ).toBe(
      [
        'Resume RCP-15: worktree (worktree not recorded) on (branch not recorded) @ (nothing pushed)',
        '(push state not reported),',
        'brief not recorded, checklist 0/0, claim_lead first',
      ].join('\n'),
    );
  });
});
