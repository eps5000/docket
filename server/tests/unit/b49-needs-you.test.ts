/**
 * Needs you only shows what needs the owner (owner decision 41; BUILD_SPEC
 * §5.22): the six Problem shapes from the Gameflow pilot, routing to agents
 * first, *Keep for later* and *Safe to discard*, and the badge invariant.
 */
import { needsYouCount, type NeedsYouResponse, type Problem } from '@docket/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyUndo } from '../../src/domain/undo.js';
import { OWNER_ACTOR, type Actor } from '../../src/domain/write.js';
import { sweepOnce } from '../../src/jobs/sweeper.js';
import { minutes, startDomain, type Domain } from '../us1-helpers.js';

let d: Domain;
let claude: Actor;
const orca = { name: 'orca', dispatch_id: 'ctx_1' };

beforeEach(() => {
  d = startDomain();
  claude = d.agent('claude', { label: 'orca-w1' });
});
afterEach(() => d.cleanup());

const view = (scope = 'all'): NeedsYouResponse => d.services.views.needsYou(d.read(), { scope });
const inList = (list: readonly Problem[] | undefined, id: string) =>
  (list ?? []).find((p) => p.id === id);
const owners = (id: string) => inList(view().problems, id);
const agents = (id: string) => inList(view().agent_problems, id);
const grace = () => d.server.runtime.config.agentProblemGraceMs;

const claim = (id: string, extra: Record<string, unknown> = {}) =>
  d.write(claude, (w, s) => s.runs.claim(w, { id, agent_label: 'orca-w1', ...extra })).run_id;
const park = (run_id: string, waiting_on: Record<string, unknown> = { orchestrator: true }) =>
  d.write({ ...claude, run_id }, (w, s) =>
    s.runs.park(w, { run_id, reason: 'Waiting.', waiting_on }),
  );

/** An ended run that last reported an unpushed commit and uncommitted changes. */
function leftWork(id: string, extra: Record<string, unknown> = {}) {
  const run_id = claim(id, { workspace: { path: `C:/work/${id}`, branch: id }, ...extra });
  d.write({ ...claude, run_id }, (w, s) =>
    s.evidence.reportCommit(w, { id, sha: '77aa001', pushed: false }),
  );
  d.services.runs.heartbeat(d.read({ ...claude, run_id }), {
    run_id,
    workspace: { dirty: true },
  });
  d.write({ ...claude, run_id }, (w, s) =>
    s.runs.finish(w, { run_id, result: 'finished', summary: 'Stopped.' }),
  );
  return run_id;
}
const gitSays = (run_id: string, check: Record<string, unknown>) =>
  d.sql.prepare('UPDATE runs SET worktree_check = ? WHERE id = ?').run(
    JSON.stringify({
      checked_at: d.clock.now().toISOString(),
      head_sha: '77aa001',
      on_main: false,
      on_remote: false,
      unpushed_commits: 0,
      uncommitted_files: 0,
      ...check,
    }),
    run_id,
  );
const cancelAsOwner = (id: string) => {
  const { version } = d.row<{ version: number }>('SELECT version FROM items WHERE id = ?', id);
  d.write(OWNER_ACTOR, (w, s) =>
    s.items.setStatus(w, {
      id,
      status: 'canceled',
      reason: 'Deferred.',
      expected_version: version,
    }),
  );
};
const wsState = (path: string) =>
  d.services.recovery.workspaceStates(d.read(), { paths: [path] })[path];

describe('parked_too_long goes to the coordinator first', () => {
  it('with a coordinator: agents handle it, in plain words, until the grace ends', () => {
    const run_id = claim('RCP-17', { orchestrator: orca });
    park(run_id, {
      orchestrator: true,
      wake: {
        actor: 'orca',
        event: 'next review',
        due_at: new Date(d.clock.now().getTime() + 72 * 3_600_000).toISOString(),
      },
    });
    const id = `parked_too_long:${run_id}`;
    d.clock.advance(d.server.runtime.config.parkMaxMs + minutes(1));
    expect(owners(id)).toBeUndefined();
    expect(agents(id)!.explanation).toMatchObject({
      who: 'agent',
      who_text: 'Your coordinator (orca)',
    });
    d.clock.advance(grace());
    expect(agents(id)).toBeUndefined();
    expect(owners(id)!.reached_you).toBe('Not handled by an agent for a day');
  });

  it('with no coordinator it reaches the owner at once, saying why', () => {
    const run_id = claim('RCP-17');
    park(run_id, {
      orchestrator: true,
      wake: {
        actor: 'owner',
        event: 'next review',
        due_at: new Date(d.clock.now().getTime() + 72 * 3_600_000).toISOString(),
      },
    });
    d.clock.advance(d.server.runtime.config.parkMaxMs + minutes(1));
    const p = owners(`parked_too_long:${run_id}`)!;
    expect(p.reached_you).toBe('No coordinator or lead is on RCP-17');
    expect(p.explanation!.who).toBe('owner');
  });

  it('waiting on a person is the owner’s at once, even with a coordinator', () => {
    const run_id = claim('RCP-17', { orchestrator: orca });
    park(run_id, { person: true });
    d.clock.advance(d.server.runtime.config.parkMaxMs + minutes(1));
    expect(owners(`parked_too_long:${run_id}`)!.reached_you).toBe('It is waiting on a person');
  });
});

describe('unpushed_work tells the truth, and goes to agents first', () => {
  it('GF-280: HEAD on main with 3 uncommitted files, item still active', () => {
    const run_id = leftWork('RCP-17', { orchestrator: orca });
    d.write(d.agent('codex'), (w, s) => s.runs.claim(w, { id: 'RCP-17' }));
    gitSays(run_id, { on_main: true, on_remote: true, uncommitted_files: 3 });
    const id = `unpushed_work:${run_id}`;
    expect(owners(id)).toBeUndefined();
    const p = agents(id)!;
    expect(p.explanation!.who_text).toBe('An agent (the lead of RCP-17)');
    expect(p.explanation!.what).toContain('Its commits are already on main.');
    expect(p.explanation!.what).toContain('3 uncommitted files');
    expect(p.explanation!.what).not.toContain('not pushed');
    expect(p.reason).not.toContain('not pushed');
  });

  it('GF-336: canceled by the owner, never told to push, the owner keeps or lets go', () => {
    const run_id = leftWork('RCP-25', { orchestrator: orca });
    cancelAsOwner('RCP-25');
    gitSays(run_id, { uncommitted_files: 6 });
    const p = owners(`unpushed_work:${run_id}`)!;
    expect(p.explanation).toMatchObject({
      who: 'owner',
      what: 'RCP-25 was canceled by your decision. Its worktree still has 6 uncommitted files, in C:/work/RCP-25.',
      fix: 'Keep them for later, or mark them safe to discard. Docket never deletes a worktree or files itself.',
    });
    expect(p.explanation!.fix).not.toMatch(/push/i);
    expect(p.reached_you).toContain("isn't being worked on");
  });

  it('canceled by an agent citing no owner decision says only "was canceled"', () => {
    const run_id = leftWork('RCP-25');
    const { version } = d.row<{ version: number }>("SELECT version FROM items WHERE id = 'RCP-25'");
    d.write(claude, (w, s) =>
      s.items.setStatus(w, {
        id: 'RCP-25',
        status: 'canceled',
        reason: 'Duplicate.',
        expected_version: version,
      }),
    );
    expect(owners(`unpushed_work:${run_id}`)!.explanation!.what).toMatch(/^RCP-25 was canceled\. /);
  });

  it('an agent’s cancel under an owner decision naming the item counts as the owner’s', () => {
    const run_id = leftWork('RCP-25');
    d.write(OWNER_ACTOR, (w, s) =>
      s.decisions.publish(w, {
        project: 'RCP',
        scope: { kind: 'project' },
        title: 'Defer pantry work',
        decision: 'Stop RCP-25 for now.',
      }),
    );
    const { version } = d.row<{ version: number }>("SELECT version FROM items WHERE id = 'RCP-25'");
    d.write(claude, (w, s) =>
      s.items.setStatus(w, {
        id: 'RCP-25',
        status: 'canceled',
        reason: 'Per the decision.',
        expected_version: version,
      }),
    );
    expect(owners(`unpushed_work:${run_id}`)!.explanation!.what).toContain(
      'was canceled by your decision',
    );
  });

  it('no coordinator and no lead: the owner at once, with what they can do', () => {
    const run_id = leftWork('RCP-17');
    const p = owners(`unpushed_work:${run_id}`)!;
    expect(p.reached_you).toBe('No coordinator or lead is on RCP-17');
    expect(p.explanation!.fix).toContain('Neither button commits, pushes or deletes anything.');
  });

  it('with a coordinator it reaches the owner only after the grace', () => {
    const run_id = leftWork('RCP-17', { orchestrator: orca });
    const id = `unpushed_work:${run_id}`;
    expect(owners(id)).toBeUndefined();
    d.clock.advance(grace() + minutes(1));
    expect(owners(id)!.reached_you).toBe('Not handled by an agent for a day');
  });

  it('git showing everything safe clears it', () => {
    const run_id = leftWork('RCP-17');
    gitSays(run_id, { on_main: true });
    expect(owners(`unpushed_work:${run_id}`)).toBeUndefined();
  });
});

describe('Keep for later and Safe to discard', () => {
  const decide = (run_id: string, outcome?: 'keep' | 'discard') => {
    let mutation = '';
    const out = d.write(OWNER_ACTOR, (w, s) => {
      mutation = w.mutationId;
      return s.recovery.markUnpushedHandled(w, { runId: run_id, outcome });
    });
    return { out, mutation };
  };
  /** Done, so nothing "waits to be restarted" and only the outcome decides the state. */
  const doneRun = () => {
    const run_id = leftWork('RCP-17');
    d.sql.prepare("UPDATE items SET status = 'done' WHERE id = 'RCP-17'").run();
    return run_id;
  };

  it('Keep for later: off Needs you, the worktree stays at risk, and Undo brings it back', () => {
    const run_id = doneRun();
    const { out, mutation } = decide(run_id, 'keep');
    expect(out.outcome).toBe('keep');
    expect(owners(`unpushed_work:${run_id}`)).toBeUndefined();
    expect(wsState('C:/work/RCP-17')).toBe('at_risk');
    expect(
      d.row<{ summary: string }>(
        "SELECT summary FROM events WHERE type = 'run.unpushed_handled' ORDER BY seq DESC",
      ).summary,
    ).toContain('keep the work');
    d.write(OWNER_ACTOR, (w) => applyUndo(w, mutation));
    expect(owners(`unpushed_work:${run_id}`)).toBeDefined();
    expect(
      d.row<{ unpushed_outcome: string | null }>(
        'SELECT unpushed_outcome FROM runs WHERE id = ?',
        run_id,
      ).unpushed_outcome,
    ).toBeNull();
  });

  it('Safe to discard: the worktree can count as safe to prune; nothing is deleted', () => {
    const run_id = doneRun();
    expect(wsState('C:/work/RCP-17')).toBe('at_risk');
    decide(run_id, 'discard');
    expect(wsState('C:/work/RCP-17')).toBe('safe_to_prune');
    expect(
      d.row<{ workspace: string }>('SELECT workspace FROM runs WHERE id = ?', run_id).workspace,
    ).toContain('C:/work/RCP-17');
  });

  it('a call with no outcome keeps meaning what Handled did', () => {
    const run_id = doneRun();
    expect(decide(run_id).out.outcome).toBe('discard');
    expect(wsState('C:/work/RCP-17')).toBe('safe_to_prune');
  });

  it('the owner can change their mind from keep to discard', () => {
    const run_id = doneRun();
    decide(run_id, 'keep');
    expect(wsState('C:/work/RCP-17')).toBe('at_risk');
    decide(run_id, 'discard');
    expect(wsState('C:/work/RCP-17')).toBe('safe_to_prune');
  });
});

describe('the badge equals what the owner can act on (invariant)', () => {
  const boot = () => d.services.views.bootstrap(d.read());
  const shown = (v: NeedsYouResponse) =>
    v.for_you_now.length +
    v.problems.length +
    (v.onboarding_reviews?.length ?? 0) +
    (v.overlaps?.length ?? 0) +
    (v.undeclared_holds?.length ?? 0) +
    (v.design_reviews?.length ?? 0) +
    (v.resolutions?.length ?? 0) +
    (v.project_decisions?.length ?? 0) +
    (v.project_decision_groups?.length ?? 0);
  const holds = () => {
    for (const scope of ['all', 'RCP', 'DOC']) {
      expect(needsYouCount(view(scope)), scope).toBe(shown(view(scope)));
    }
    expect(boot().counts.for_you + boot().counts.problems).toBe(needsYouCount(view('all')));
  };

  it('holds on the seed, and per project', () => {
    holds();
    expect(needsYouCount(view('RCP')) + needsYouCount(view('DOC'))).toBeGreaterThanOrEqual(
      needsYouCount(view('all')),
    );
  });

  it('a problem agents are handling is not counted; one that reaches the owner is', () => {
    const before = needsYouCount(view());
    const run_id = leftWork('RCP-17', { orchestrator: orca });
    expect(agents(`unpushed_work:${run_id}`)).toBeDefined();
    expect(needsYouCount(view())).toBe(before);
    holds();
    d.clock.advance(grace() + minutes(1));
    sweepOnce(d.server.runtime);
    expect(owners(`unpushed_work:${run_id}`)).toBeDefined();
    holds();
  });

  it('is 0 when nothing needs the owner', () => {
    const empty: NeedsYouResponse = {
      for_you_now: [],
      problems: [],
      deferred: [],
      planning_queue: [],
      agent_counts: {},
    };
    expect(needsYouCount(empty)).toBe(0);
    // Deferred and Planning are lists to read, not actions waiting on the owner.
    expect(needsYouCount({ ...empty, agent_problems: view().problems })).toBe(0);
  });
});
