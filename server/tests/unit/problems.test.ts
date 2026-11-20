/**
 * The words every problem says (owner decision 37; BUILD_SPEC §5.22
 * Problems): what's wrong, what fixes it and who acts, for every kind, and
 * the rule for when an acknowledgement still covers a problem.
 */
import type { Problem, RadarFindingRow, ResolutionRow } from '@docket/shared';
import { describe, expect, it } from 'vitest';
import {
  ackCovers,
  agentWho,
  conflictText,
  explain,
  graceText,
  radarProblems,
} from '../../src/domain/problems.js';

const finding = (over: Partial<RadarFindingRow>): RadarFindingRow => ({
  id: 'rdf_1',
  project: 'GF',
  branch_a: 'eps5000/redesign-438-shell',
  branch_b: 'main',
  item_a: { id: 'GF-228', title: 'Shell redesign', status: 'progress' },
  item_b: null,
  source_a: 'reported',
  source_b: null,
  files: Array.from({ length: 53 }, (_, i) => `src/shell/f${String(i).padStart(2, '0')}.tsx`),
  seen_at: '2026-11-20T10:00:00.000Z',
  cleared_at: null,
  ...over,
});

describe('the explanation for every kind', () => {
  it('a branch out of date with main (the owner’s example)', () => {
    expect(explain.radar(finding({}), new Set(['GF-228']))).toEqual({
      what: "GF-228's branch eps5000/redesign-438-shell is out of date with main: 53 files conflict, including src/shell/f00.tsx, src/shell/f01.tsx and src/shell/f02.tsx.",
      fix: "Rebase it onto main, or split it into short story PRs. If it's an old draft, remove it from GF-228's branches.",
      who: 'agent',
      who_text: 'An agent (the lead of GF-228)',
    });
    // A branch the radar found by name: report the real one.
    expect(explain.radar(finding({ source_a: 'discovered' }), new Set()).fix).toBe(
      "Rebase it onto main, or split it into short story PRs. If it's an old draft, or not GF-228's work, report GF-228's real branch so the radar stops using it.",
    );
    expect(explain.radar(finding({}), new Set()).who_text).toBe(
      'An agent (GF-228 has no lead yet)',
    );
  });

  it('two items’ branches that change the same lines', () => {
    const pair = finding({
      branch_a: 'gf-217-api',
      branch_b: 'gf-235-b',
      item_a: { id: 'GF-217', title: 'API', status: 'progress' },
      item_b: { id: 'GF-235', title: 'B', status: 'progress' },
      source_b: 'reported',
      files: ['shared.txt'],
    });
    expect(explain.radar(pair, new Set(['GF-217', 'GF-235']))).toEqual({
      what: "GF-217's branch gf-217-api and GF-235's branch gf-235-b change the same lines: 1 file conflicts (shared.txt).",
      fix: "Merge one first, then rebase the other onto main and resolve the conflict. If one of them is an old draft, remove it from its item's branches.",
      who: 'agent',
      who_text: 'An agent (the leads of GF-217 and GF-235)',
    });
    expect(explain.radar(pair, new Set(['GF-235'])).who_text).toBe('An agent (the lead of GF-235)');
    expect(explain.radar(pair, new Set()).who_text).toBe(
      'An agent (GF-217 and GF-235 have no lead yet)',
    );
  });

  it('the owner’s kinds, and recovery (the owner or the coordinator)', () => {
    const RECOVERY = 'You, or your coordinator (agents can’t restart themselves)';
    expect(
      explain.stale_run({ item: 'RCP-12', silent: '47m', lease: 'the lease expires in 13m' }),
    ).toEqual({
      what: "RCP-12's lead agent has been silent for 47m and the lease expires in 13m. Docket treats the run as unknown, not finished.",
      fix: 'Check whether the agent is still running. If it stopped, release its claim (Activity → Lead and runs) so another agent can pick RCP-12 up.',
      who: 'owner',
      who_text: RECOVERY,
    });
    expect(explain.failed_run({ item: 'RCP-12', error: 'Tests failed.' })).toEqual({
      what: "RCP-12's lead run failed: Tests failed. Nothing retries it on its own.",
      fix: 'Read the error in Activity, then start an agent on RCP-12 again, or move it back to Ready for any agent to claim.',
      who: 'owner',
      who_text: RECOVERY,
    });
    expect(
      explain.cycle({
        path: 'RCP-1 → RCP-2 → RCP-1',
        members: ['RCP-1', 'RCP-2'],
        imported: true,
      }),
    ).toEqual({
      what: 'RCP-1 and RCP-2 wait on each other in a loop (from the import): RCP-1 → RCP-2 → RCP-1. None of them can start.',
      fix: 'Remove one link in the Dependencies tab: the one that is wrong, or the one that matters least.',
      who: 'owner',
      who_text: 'You (a decision)',
    });
    expect(
      explain.date_risk({ item: 'RCP-12', start: 'Nov 9', blocker: 'RCP-9', blockerEnd: 'Nov 14' }),
    ).toEqual({
      what: 'RCP-12 is planned to start on Nov 9, before its blocker RCP-9 is planned to finish (Nov 14).',
      fix: "Ask the lead to move RCP-12's planned start after Nov 14, or bring RCP-9's finish forward. Agents set the dates.",
      who: 'owner',
      who_text: 'You (a decision)',
    });
    expect(explain.canceled_blocker({ item: 'RCP-12', blocker: 'RCP-9' })).toEqual({
      what: 'RCP-12 is blocked by RCP-9, which was canceled. A canceled blocker never clears on its own.',
      fix: "Remove the link in the Dependencies tab, or reopen RCP-9 if it's still needed.",
      who: 'owner',
      who_text: 'You (a decision)',
    });
    expect(
      explain.deferred_verified_blocker({ item: 'RCP-22', blocker: 'RCP-12', deferred: 1 }),
    ).toEqual({
      what: 'RCP-22 waits for RCP-12 to be verified, but 1 of its checks was deferred, so RCP-12 never counts as verified.',
      fix: 'Finish the deferred check (the test ticket), or change the link to wait for Done instead.',
      who: 'owner',
      who_text: 'You (a decision)',
    });
    expect(
      explain.orphaned_resources({ item: 'RCP-25', what: 'vite (:5173)', after: '18m', n: 1 }),
    ).toEqual({
      what: "vite (:5173) is still running 18m after RCP-25's run ended.",
      fix: 'Stop it, then mark it released.',
      who: 'owner',
      who_text: RECOVERY,
    });
    expect(
      explain.unpushed_work({
        item: 'RCP-25',
        facts: ['1 commit not pushed', 'uncommitted changes'],
        path: 'C:/work/rcp-25',
        ended: 'lease expired',
      }),
    ).toEqual({
      what: "RCP-25's run ended (lease expired) with work that isn't on the remote: 1 commit not pushed and uncommitted changes, in C:/work/rcp-25.",
      fix: "Push or save the work from that folder, then mark it handled. Don't prune the worktree until then.",
      who: 'owner',
      who_text: RECOVERY,
    });
    expect(
      explain.parked_too_long({ item: 'RCP-11', since: 'Nov 14', waiting: 'the coordinator' }),
    ).toEqual({
      what: "RCP-11's lead has been parked since Nov 14, waiting on the coordinator. It keeps its claim.",
      fix: "Check that it's still waiting for something real. Resume it, or release its claim so another agent can take RCP-11.",
      who: 'owner',
      who_text: RECOVERY,
    });
    expect(
      explain.resume_unattended({ item: 'RCP-13', why: 'RCP-11 is done', parked: '40m' }),
    ).toEqual({
      what: 'RCP-13 is ready to resume (RCP-11 is done), but nobody has resumed it. It has been parked 40m.',
      fix: 'Ask your coordinator to resume the parked run, or start an agent on RCP-13.',
      who: 'owner',
      who_text: RECOVERY,
    });
    expect(explain.extra_backup_failed({ error: 'The folder is not writable.' })).toEqual({
      what: 'The extra backup copy failed: The folder is not writable.',
      fix: 'Check the extra backup folder in Settings: it must be mounted and writable. The next nightly backup tries again.',
      who: 'owner',
      who_text: 'You (a setting)',
    });
    expect(
      explain.agent_files_drift({
        change: 'docket-worker edited',
        project: 'Recipe App',
        where: 'C:/code/recipe/.claude/skills',
      }),
    ).toEqual({
      what: "docket-worker edited outside Docket (Recipe App, C:/code/recipe/.claude/skills), so agents follow instructions you haven't reviewed.",
      fix: "Review it in Agent files: adopt it as the project's copy, restore Docket's version, or keep it local.",
      who: 'owner',
      who_text: 'You (a decision)',
    });
    expect(explain.overlap({ first: 'GF-240', other: 'GF-312', parts: 'model Token' })).toEqual({
      what: 'GF-240 and GF-312 both change model Token. An agent tried to start GF-312 while GF-240 is in flight, so it picked other work.',
      fix: "Run them one after the other (GF-312 waits until GF-240 is merged), or mark them compatible if their changes don't collide.",
      who: 'owner',
      who_text: 'You (a decision)',
    });
    expect(explain.undeclared_hold({ item: 'GF-312', parts: 'table decks', packet: true })).toEqual(
      {
        what: "GF-312 changed shared parts it didn't declare: table decks. Its packet waits until you decide.",
        fix: 'Add the parts to its declaration if the change is fine, or send it back with a note.',
        who: 'owner',
        who_text: 'You (a decision)',
      },
    );
  });

  it('words: files, the grace period, who', () => {
    expect(conflictText(['a.ts'])).toBe('1 file conflicts (a.ts)');
    expect(conflictText(['a', 'b', 'c'])).toBe('3 files conflict (a, b and c)');
    expect(graceText(24 * 3_600_000)).toBe('a day');
    expect(graceText(48 * 3_600_000)).toBe('2 days');
    expect(graceText(3_600_000)).toBe('an hour');
    expect(graceText(6 * 3_600_000)).toBe('6 hours');
    expect(agentWho(['GF-1', 'GF-2'], new Set(['GF-2'])).who_text).toBe(
      'An agent (the lead of GF-2)',
    );
  });
});

describe('when an acknowledgement still covers a problem', () => {
  const db = {
    sqlite: {
      prepare: () => ({
        all: () => [{ id: 'rdf_1', created_at: '2026-11-20T09:00:00.000Z' }],
        get: () => ({ branches: JSON.stringify([{ name: 'eps5000/redesign-438-shell' }]) }),
      }),
    },
  } as unknown as Parameters<typeof radarProblems>[0];
  const build = (files: string[], branch_a = 'eps5000/redesign-438-shell') =>
    radarProblems(db, [finding({ files, branch_a })], '2026-11-20T10:00:00.000Z', 86_400_000)[0]!;
  const ack = (files: string[], over: Record<string, string> = {}) => ({
    id: 'pak_1',
    problem_id: 'rdf_1',
    kind: 'radar_conflict',
    branches: JSON.stringify(['eps5000/redesign-438-shell', 'main']),
    facts: JSON.stringify(files),
    acked_by: 'owner',
    created_at: '2026-11-20T09:30:00.000Z',
    ...over,
  });
  const proposal = (created_at: string, state: ResolutionRow['state'] = 'open') =>
    ({ id: 'prs_1', state, created_at }) as ResolutionRow;

  it('the same facts, or fewer, stay acknowledged', () => {
    expect(ackCovers(ack(['a', 'b']), build(['a', 'b']), null)).toEqual({
      by: 'owner',
      at: '2026-11-20T09:30:00.000Z',
    });
    expect(ackCovers(ack(['a', 'b']), build(['a']), null)).not.toBeNull();
  });

  it('a new file beyond the acknowledged set, a new branch or another kind brings it back', () => {
    expect(ackCovers(ack(['a', 'b']), build(['a', 'b', 'c']), null)).toBeNull();
    expect(ackCovers(ack(['a']), build(['a'], 'eps5000/other'), null)).toBeNull();
    expect(ackCovers(ack(['a'], { kind: 'stale_run' }), build(['a']), null)).toBeNull();
    expect(ackCovers(undefined, build(['a']), null)).toBeNull();
  });

  it('a proposed resolution after the acknowledgement brings it back; a decided or older one doesn’t', () => {
    const p = build(['a']);
    expect(ackCovers(ack(['a']), p, proposal('2026-11-20T09:45:00.000Z'))).toBeNull();
    expect(ackCovers(ack(['a']), p, proposal('2026-11-20T09:00:00.000Z'))).not.toBeNull();
    expect(
      ackCovers(ack(['a']), p, proposal('2026-11-20T09:45:00.000Z', 'approved')),
    ).not.toBeNull();
  });

  it('other kinds are acknowledged with their items, links and resources', () => {
    const stale: Problem = {
      kind: 'date_risk',
      id: 'date_risk:RCP-12',
      item_id: 'RCP-12',
      title: 'x',
      reason: 'x',
      related: ['RCP-9'],
      link_id: null,
      run_id: null,
      resource_ids: [],
    };
    const a = ack(['RCP-12', 'RCP-9'], { kind: 'date_risk', branches: '[]' });
    expect(ackCovers(a, stale, null)).not.toBeNull();
    expect(ackCovers(a, { ...stale, related: ['RCP-9', 'RCP-10'] }, null)).toBeNull();
  });
});
