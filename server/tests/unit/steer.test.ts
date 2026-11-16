/**
 * The owner steers (BUILD_SPEC §5.3, §5.5; MCP_SPEC §8; tasks.md T120):
 * *Release lead claim*, *Return to Ready*, and the owner's own work steps,
 * checks and human review items.
 *
 * - Release ends the lead run as `interrupted` (`end_reason: owner_released`)
 *   with a `claim.released` event naming the run, moves the item back to
 *   Ready with its plan kept, and a later call naming the old run gets
 *   `conflict`. Undo restores the status, not the run. B10's recovery
 *   views see the release as an interruption that awaits a restart.
 * - Owner-added steps and checks survive agent patches and replaces; agents
 *   may change their state but get `forbidden` on their text or removal.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { In, Services } from '../../src/domain/contracts.js';
import { endLeadForOwner } from '../../src/domain/runs.js';
import { undoMutation } from '../../src/domain/undo.js';
import { OWNER_ACTOR, type Actor, type WriteContext } from '../../src/domain/write.js';
import { startDomain, type Domain } from '../us1-helpers.js';

let d: Domain;
beforeEach(() => {
  d = startDomain();
});
afterEach(() => d.cleanup());

type RunRow = { id: string; state: string; end_reason: string | null; client: string };

const run = (id: string) => d.row<RunRow>('SELECT * FROM runs WHERE id = ?', id);
const status = (id: string) =>
  d.row<{ status: string }>('SELECT status FROM items WHERE id = ?', id).status;
const leadRun = (item: string) =>
  d.row<RunRow>(
    'SELECT * FROM runs WHERE item_id = ? AND is_lead = 1 ORDER BY created_at DESC, id DESC LIMIT 1',
    item,
  );
const steps = (item: string) =>
  d.services.items.get(d.read(), { id: item, view: 'full' } as In<'get_item'>).item.checklist!.work;
const checks = (item: string) =>
  d.services.items.get(d.read(), { id: item, view: 'full' } as In<'get_item'>).item.checklist!
    .checks;

function owner<T>(fn: (w: WriteContext, s: Services) => T) {
  return d.server.runtime.write.run({ actor: OWNER_ACTOR, operation: 'test', args: {} }, (w) =>
    fn(w, d.services),
  );
}

const release = (id: string, extra: { expected_version?: number } = {}) =>
  owner((w, s) => s.runs.ownerRelease(w, { id, ...extra }));

/** A lead on RCP-17 (Ready, unblocked and unclaimed in the seed) for `client`. */
function claim(client = 'claude'): Actor {
  const actor = d.agent(client);
  const { run_id } = d.write(actor, (w, s) =>
    s.runs.claim(w, { id: 'RCP-17', agent_label: 'orca-w5' } as In<'claim_lead'>),
  );
  return { ...actor, run_id };
}

describe('Release lead claim (owner)', () => {
  it('interrupts the stale lead, records why, and moves the item back to Ready with its plan kept', () => {
    const lead = leadRun('RCP-15');
    expect(lead).toMatchObject({ state: 'open', client: 'codex' });
    const before = steps('RCP-15').map((s) => [s.id, s.text, s.state]);
    expect(before.length).toBeGreaterThan(0);

    const { result } = release('RCP-15');
    expect(result).toMatchObject({ id: 'RCP-15', status: 'ready', lead: null });
    expect(run(lead.id)).toMatchObject({ state: 'interrupted', end_reason: 'owner_released' });
    expect(steps('RCP-15').map((s) => [s.id, s.text, s.state])).toEqual(before);

    const events = d.rows<{ type: string; summary: string; actor_kind: string; data: string }>(
      "SELECT type, summary, actor_kind, data FROM events WHERE item_id = 'RCP-15' AND actor_kind = 'owner' AND type IN ('claim.released', 'item.status_changed') ORDER BY seq",
    );
    expect(events.map((e) => [e.type, e.actor_kind, e.summary])).toEqual([
      [
        'claim.released',
        'owner',
        'You released codex · orca-w1’s lead claim on RCP-15; its run is interrupted and the plan kept',
      ],
      [
        'item.status_changed',
        'owner',
        'RCP-15 moved from progress to ready: lead claim released by you',
      ],
    ]);
    expect(JSON.parse(events[0]!.data)).toMatchObject({
      run_id: lead.id,
      end_reason: 'owner_released',
    });
  });

  it('the old run’s next call gets conflict with the current state', () => {
    const lead = leadRun('RCP-15');
    release('RCP-15');
    const agent = d.agent('codex', { label: 'orca-w1', run_id: lead.id });
    const err = d.fails(
      agent,
      (w, s) =>
        s.checklist.updateStep(w, {
          id: 'RCP-15',
          step_id: steps('RCP-15')[1]!.id,
          state: 'done',
        } as In<'update_step'>),
      'conflict',
    );
    expect(err.message).toBe(
      `Run ${lead.id} has ended (owner released). Stop work on it; claim the item again with claim_lead if it is free.`,
    );
    expect(err.current).toMatchObject({
      run_id: lead.id,
      state: 'interrupted',
      end_reason: 'owner_released',
      item_status: 'ready',
    });
    let hb: unknown;
    try {
      d.services.runs.heartbeat(d.read(agent), { run_id: lead.id } as In<'heartbeat'>);
    } catch (e) {
      hb = e;
    }
    expect(hb).toMatchObject({ code: 'conflict' });
  });

  it('undo restores the status, not the run: the item is In progress with no lead (resumable)', () => {
    const lead = leadRun('RCP-15');
    const { mutation_id } = release('RCP-15');
    undoMutation(d.server.runtime.write, mutation_id);
    expect(status('RCP-15')).toBe('progress');
    expect(run(lead.id)).toMatchObject({ state: 'interrupted', end_reason: 'owner_released' });
    const summary = d.services.items.get(d.read(), {
      id: 'RCP-15',
      view: 'summary',
    } as In<'get_item'>).item;
    expect(summary.lead).toBeNull();
  });

  it('B10’s recovery views see the release: recovery_report, Problems and Workspaces', () => {
    const lead = leadRun('RCP-15');
    // A clean, pushed worktree (fixture): only the interruption puts it at risk.
    const path = 'C:/work/rcp-15';
    d.sql.prepare('UPDATE runs SET workspace = ? WHERE id = ?').run(
      JSON.stringify({
        path,
        branch: 'rcp-15-pantry',
        head_sha: '4be1c09',
        pushed_sha: '4be1c09',
        dirty: false,
        updated_at: d.clock.now().toISOString(),
      }),
      lead.id,
    );
    const problems = () =>
      d.services.views.needsYou(d.read(OWNER_ACTOR), { scope: 'all' } as never).problems;
    expect(problems()).toContainEqual(
      expect.objectContaining({ kind: 'stale_run', item_id: 'RCP-15' }),
    );

    release('RCP-15');
    const report = d.services.recovery.report(d.read(d.agent('claude')), {
      limit: 25,
      include_briefs: false,
    } as In<'recovery_report'>);
    expect(report.interrupted.find((x) => x.run.run_id === lead.id)).toMatchObject({
      item: { id: 'RCP-15', status: 'ready' },
      run: { run_id: lead.id, run_state: 'interrupted', end_reason: 'owner_released' },
      end_reason: 'owner_released',
    });
    // No longer a stale run: it ended.
    expect(problems().some((p) => p.kind === 'stale_run' && p.item_id === 'RCP-15')).toBe(false);
    // The worktree waits for the work to restart, so it is never safe to prune yet.
    expect(d.services.recovery.workspaceStates(d.read(OWNER_ACTOR), { paths: [path] })[path]).toBe(
      'at_risk',
    );
  });

  it('a parked lead can be released too', () => {
    const actor = claim();
    d.write(actor, (w, s) =>
      s.runs.park(w, { run_id: actor.run_id!, reason: 'Waiting on RCP-12.' } as In<'park_run'>),
    );
    release('RCP-17');
    expect(run(actor.run_id!)).toMatchObject({
      state: 'interrupted',
      end_reason: 'owner_released',
    });
    expect(status('RCP-17')).toBe('ready');
  });

  it('a lead in needs_input is released, and its open question stays for the next agent', () => {
    const actor = claim();
    d.write(actor, (w, s) =>
      s.messages.askOwner(w, { id: 'RCP-17', question: 'Grams?' } as In<'ask_owner'>),
    );
    release('RCP-17');
    expect(run(actor.run_id!)).toMatchObject({
      state: 'interrupted',
      end_reason: 'owner_released',
    });
    expect(
      d.row<{ n: number }>(
        "SELECT count(*) AS n FROM questions WHERE item_id = 'RCP-17' AND answered_at IS NULL",
      ).n,
    ).toBe(1);
  });

  it('with no lead to release: conflict, and nothing changes', () => {
    const err = d.fails(
      OWNER_ACTOR,
      (w, s) => s.runs.ownerRelease(w, { id: 'RCP-17' }),
      'conflict',
    );
    expect(err.message).toBe(
      'RCP-17 has no lead claim to release; it may have ended already. Showing the latest.',
    );
    expect(status('RCP-17')).toBe('ready');
  });

  it('a stale expected_version gets conflict', () => {
    const v = d.row<{ version: number }>("SELECT version FROM items WHERE id = 'RCP-15'").version;
    d.fails(
      OWNER_ACTOR,
      (w, s) => s.runs.ownerRelease(w, { id: 'RCP-15', expected_version: v - 1 }),
      'conflict',
    );
    expect(leadRun('RCP-15').state).toBe('open');
  });

  it('an unknown item is not_found', () => {
    d.fails(OWNER_ACTOR, (w, s) => s.runs.ownerRelease(w, { id: 'RCP-99' }), 'not_found');
  });
});

describe('Return to Ready (owner)', () => {
  function failed(): Actor {
    const actor = claim();
    d.write(actor, (w, s) =>
      s.runs.finish(w, {
        run_id: actor.run_id!,
        result: 'failed',
        summary: 'Tests fail on CI.',
        error: 'AssertionError: expected 3 to be 2',
      } as In<'finish_run'>),
    );
    return actor;
  }

  it('after a failed run: the item is unclaimed and startable again', () => {
    failed();
    expect(status('RCP-17')).toBe('progress');
    const { result } = owner((w, s) => s.runs.returnToReady(w, { id: 'RCP-17' }));
    expect(result).toMatchObject({ id: 'RCP-17', status: 'ready', lead: null, blocked: false });
    const ev = d.row<{ summary: string; actor_kind: string }>(
      "SELECT summary, actor_kind FROM events WHERE item_id = 'RCP-17' AND type = 'item.status_changed' ORDER BY seq DESC LIMIT 1",
    );
    expect(ev).toEqual({
      actor_kind: 'owner',
      summary: 'You moved RCP-17 from progress to ready: returned to Ready',
    });
    // Another agent can claim it.
    const again = claim('codex');
    expect(run(again.run_id!).state).toBe('open');
  });

  it('a reason is kept in the summary, and it is undoable', () => {
    failed();
    const { mutation_id } = owner((w, s) =>
      s.runs.returnToReady(w, { id: 'RCP-17', reason: 'Re-plan first.' }),
    );
    expect(
      d.row<{ summary: string }>(
        "SELECT summary FROM events WHERE item_id = 'RCP-17' AND type = 'item.status_changed' ORDER BY seq DESC LIMIT 1",
      ).summary,
    ).toBe('You moved RCP-17 from progress to ready: Re-plan first.');
    undoMutation(d.server.runtime.write, mutation_id);
    expect(status('RCP-17')).toBe('progress');
  });

  it('while an agent leads it: validation, release the claim instead', () => {
    claim();
    const err = d.fails(
      OWNER_ACTOR,
      (w, s) => s.runs.returnToReady(w, { id: 'RCP-17' }),
      'validation',
    );
    expect(err.message).toBe(
      'claude · orca-w5 leads RCP-17. Release the lead claim instead, or wait for the run to end.',
    );
  });

  it('an item that isn’t In progress: validation', () => {
    const err = d.fails(
      OWNER_ACTOR,
      (w, s) => s.runs.returnToReady(w, { id: 'RCP-17' }),
      'validation',
    );
    expect(err.message).toBe(
      'RCP-17 is ready; only In progress items with no lead can return to Ready.',
    );
  });
});

describe('the owner’s work steps', () => {
  it('are added at the end (or after a step) as the owner’s, and are undoable', () => {
    const n = steps('RCP-15').length;
    const { result, mutation_id } = owner((w, s) =>
      s.checklist.ownerAddStep(w, { id: 'RCP-15', text: 'Handle an empty pantry' }),
    );
    expect(result).toMatchObject({
      text: 'Handle an empty pantry',
      state: 'todo',
      added_by: 'owner',
    });
    expect(steps('RCP-15').map((s) => s.id)).toHaveLength(n + 1);
    expect(steps('RCP-15').at(-1)!.id).toBe(result.id);
    expect(
      d.row<{ summary: string }>(
        "SELECT summary FROM events WHERE type = 'plan.updated' ORDER BY seq DESC LIMIT 1",
      ).summary,
    ).toBe('You added a work step on RCP-15: “Handle an empty pantry”');
    undoMutation(d.server.runtime.write, mutation_id);
    expect(steps('RCP-15')).toHaveLength(n);

    const first = steps('RCP-15')[0]!.id;
    const after = owner((w, s) =>
      s.checklist.ownerAddStep(w, { id: 'RCP-15', text: 'Check units', after: first }),
    ).result;
    expect(steps('RCP-15')[1]!.id).toBe(after.id);
  });

  it('on an item with no plan yet, the step survives the agent’s first plan', () => {
    const step = owner((w, s) =>
      s.checklist.ownerAddStep(w, { id: 'RCP-17', text: 'Try an empty week' }),
    ).result;
    const actor = claim();
    d.write(actor, (w, s) =>
      s.checklist.setPlan(w, { id: 'RCP-17', steps: [{ text: 'Reproduce' }] } as In<'set_plan'>),
    );
    expect(steps('RCP-17').map((s) => [s.text, s.added_by])).toEqual([
      ['Try an empty week', 'owner'],
      ['Reproduce', 'agent'],
    ]);
    expect(steps('RCP-17')[0]!.id).toBe(step.id);
  });

  it('are kept by an agent’s patch and replace; agents may change the state, not the text', () => {
    const step = owner((w, s) =>
      s.checklist.ownerAddStep(w, { id: 'RCP-14', text: 'Owner step' }),
    ).result;
    const agent = d.agent('claude', { label: 'orca-w3' });
    d.write(agent, (w, s) =>
      s.checklist.setPlan(w, {
        id: 'RCP-14',
        reason: 'Restate',
        mode: 'replace',
        steps: [{ text: 'Only this' }],
      } as In<'set_plan'>),
    );
    expect(steps('RCP-14').map((s) => s.text)).toEqual(['Only this', 'Owner step']);
    d.write(agent, (w, s) =>
      s.checklist.setPlan(w, {
        id: 'RCP-14',
        reason: 'Started it',
        steps: [{ id: step.id, state: 'current' }],
      } as In<'set_plan'>),
    );
    expect(steps('RCP-14').find((s) => s.id === step.id)!.state).toBe('current');
    d.fails(
      agent,
      (w, s) =>
        s.checklist.setPlan(w, {
          id: 'RCP-14',
          reason: 'x',
          steps: [{ id: step.id, text: 'Mine' }],
        } as In<'set_plan'>),
      'forbidden',
    );
    d.fails(
      agent,
      (w, s) =>
        s.checklist.setPlan(w, { id: 'RCP-14', reason: 'x', remove: [step.id] } as In<'set_plan'>),
      'forbidden',
    );
  });

  it('the owner removes their own undone steps only', () => {
    const step = owner((w, s) =>
      s.checklist.ownerAddStep(w, { id: 'RCP-15', text: 'Owner step' }),
    ).result;
    const { mutation_id } = owner((w, s) =>
      s.checklist.ownerRemoveStep(w, { id: 'RCP-15', stepId: step.id }),
    );
    expect(steps('RCP-15').some((s) => s.id === step.id)).toBe(false);
    expect(
      d.row<{ summary: string }>(
        "SELECT summary FROM events WHERE type = 'plan.updated' ORDER BY seq DESC LIMIT 1",
      ).summary,
    ).toBe('You removed the work step “Owner step” from RCP-15');
    undoMutation(d.server.runtime.write, mutation_id);
    expect(steps('RCP-15').at(-1)).toMatchObject({ id: step.id, text: 'Owner step' });

    const agentStep = steps('RCP-15')[0]!;
    const err = d.fails(
      OWNER_ACTOR,
      (w, s) => s.checklist.ownerRemoveStep(w, { id: 'RCP-15', stepId: agentStep.id }),
      'forbidden',
    );
    expect(err.message).toBe(
      `${agentStep.id} is the agent’s step; you can only remove steps you added. Leave the agent a note instead.`,
    );

    d.sql.prepare("UPDATE work_steps SET state = 'done' WHERE id = ?").run(step.id);
    const done = d.fails(
      OWNER_ACTOR,
      (w, s) => s.checklist.ownerRemoveStep(w, { id: 'RCP-15', stepId: step.id }),
      'validation',
    );
    expect(done.message).toBe(`${step.id} is already done, so it stays on the checklist.`);
    d.fails(
      OWNER_ACTOR,
      (w, s) => s.checklist.ownerRemoveStep(w, { id: 'RCP-15', stepId: 'wst_nope' }),
      'not_found',
    );
  });

  it('a done or canceled item takes no new steps', () => {
    d.fails(
      OWNER_ACTOR,
      (w, s) => s.checklist.ownerAddStep(w, { id: 'RCP-11', text: 'Too late' }),
      'validation',
    );
  });

  it('the plan has at most 30 steps', () => {
    for (let i = steps('RCP-15').length; i < 30; i++) {
      owner((w, s) => s.checklist.ownerAddStep(w, { id: 'RCP-15', text: `Step ${i}` }));
    }
    d.fails(
      OWNER_ACTOR,
      (w, s) => s.checklist.ownerAddStep(w, { id: 'RCP-15', text: 'One more' }),
      'validation',
    );
  });
});

describe('the owner’s checks', () => {
  it('are added as the owner’s, kept by agents, and removable by the owner while todo', () => {
    const n = checks('RCP-15').length;
    const { result: check, mutation_id } = owner((w, s) =>
      s.checklist.ownerAddCheck(w, {
        id: 'RCP-15',
        text: 'Run the full suite on a clean checkout',
      }),
    );
    expect(check).toMatchObject({
      state: 'todo',
      added_by: 'owner',
      text: 'Run the full suite on a clean checkout',
    });
    expect(
      d.row<{ summary: string }>(
        "SELECT summary FROM events WHERE type = 'checks.updated' ORDER BY seq DESC LIMIT 1",
      ).summary,
    ).toBe('You added a check on RCP-15: “Run the full suite on a clean checkout”');
    undoMutation(d.server.runtime.write, mutation_id);
    expect(checks('RCP-15')).toHaveLength(n);

    const kept = owner((w, s) =>
      s.checklist.ownerAddCheck(w, { id: 'RCP-15', text: 'Owner check' }),
    ).result;
    const agent = d.agent('codex', { label: 'orca-w1' });
    d.write(agent, (w, s) =>
      s.checklist.setChecks(w, {
        id: 'RCP-15',
        mode: 'replace',
        checks: [{ text: 'Agent check' }],
      } as In<'set_checks'>),
    );
    expect(checks('RCP-15').map((c) => c.text)).toEqual(['Agent check', 'Owner check']);
    d.fails(
      agent,
      (w, s) => s.checklist.setChecks(w, { id: 'RCP-15', remove: [kept.id] } as In<'set_checks'>),
      'forbidden',
    );
    d.fails(
      agent,
      (w, s) =>
        s.checklist.setChecks(w, {
          id: 'RCP-15',
          checks: [{ id: kept.id, text: 'Changed' }],
        } as In<'set_checks'>),
      'forbidden',
    );

    owner((w, s) => s.checklist.ownerRemoveCheck(w, { id: 'RCP-15', checkId: kept.id }));
    expect(checks('RCP-15').map((c) => c.text)).toEqual(['Agent check']);
    expect(
      d.row<{ summary: string }>(
        "SELECT summary FROM events WHERE type = 'checks.updated' ORDER BY seq DESC LIMIT 1",
      ).summary,
    ).toBe('You removed the check “Owner check” from RCP-15');
  });

  it('a check that has run stays; an agent’s check is not the owner’s to remove', () => {
    const c = owner((w, s) =>
      s.checklist.ownerAddCheck(w, { id: 'RCP-15', text: 'Owner check' }),
    ).result;
    d.sql.prepare("UPDATE agent_checks SET state = 'pass' WHERE id = ?").run(c.id);
    const ran = d.fails(
      OWNER_ACTOR,
      (w, s) => s.checklist.ownerRemoveCheck(w, { id: 'RCP-15', checkId: c.id }),
      'validation',
    );
    expect(ran.message).toBe(`${c.id} has already run (pass), so it stays on the checklist.`);
    const theirs = checks('RCP-15').find((x) => x.added_by === 'agent')!;
    d.fails(
      OWNER_ACTOR,
      (w, s) => s.checklist.ownerRemoveCheck(w, { id: 'RCP-15', checkId: theirs.id }),
      'forbidden',
    );
  });
});

describe('the owner’s human review items', () => {
  it('agents cannot edit or remove them (forbidden)', () => {
    const hr = owner((w, s) =>
      s.humanReview.ownerAdd(w, { id: 'RCP-15', text: 'Try it on your phone' }),
    ).result;
    const agent = d.agent('codex', { label: 'orca-w1' });
    d.fails(
      agent,
      (w, s) =>
        s.humanReview.update(w, {
          id: 'RCP-15',
          hr_item_id: hr.id,
          expected_version: hr.version,
          remove: true,
        } as In<'update_human_review'>),
      'forbidden',
    );
  });
});

describe('endLeadForOwner: the owner ends a lead (shared with US7’s owner cancel)', () => {
  it('canceled: the run is interrupted with end_reason canceled, its end event names it, and undo keeps it ended', () => {
    const lead = leadRun('RCP-15');
    const { mutation_id } = owner((w) => {
      const item = { id: 'RCP-15', project_key: 'RCP' };
      const ended = endLeadForOwner(w, item, 'canceled');
      // What US7's cancel adds: the item's own status change, with its inverse.
      const inverse = w.update('items', 'RCP-15', { status: 'canceled' });
      w.event({
        type: 'item.status_changed',
        summary: 'You canceled RCP-15',
        item_id: 'RCP-15',
        project_key: 'RCP',
        data: { status: { old: 'progress', new: 'canceled' } },
        inverse: [inverse],
      });
      return ended;
    });
    expect(run(lead.id)).toMatchObject({ state: 'interrupted', end_reason: 'canceled' });
    const ev = d.row<{ summary: string; data: string }>(
      "SELECT summary, data FROM events WHERE type = 'claim.released' ORDER BY seq DESC LIMIT 1",
    );
    expect(ev.summary).toBe(
      'codex · orca-w1’s lead run on RCP-15 was interrupted: you canceled the item',
    );
    expect(JSON.parse(ev.data)).toMatchObject({ run_id: lead.id, end_reason: 'canceled' });
    // A canceled item's run is not work waiting to restart (B10).
    const report = d.services.recovery.report(d.read(d.agent('claude')), {
      limit: 25,
      include_briefs: false,
    } as In<'recovery_report'>);
    expect(report.interrupted.some((x) => x.run.run_id === lead.id)).toBe(false);

    undoMutation(d.server.runtime.write, mutation_id);
    expect(status('RCP-15')).toBe('progress');
    expect(run(lead.id)).toMatchObject({ state: 'interrupted', end_reason: 'canceled' });
  });

  it('returns undefined, and writes nothing, when there is no lead', () => {
    const before = d.row<{ n: number }>('SELECT count(*) AS n FROM events').n;
    const ended = d.write(OWNER_ACTOR, (w) =>
      endLeadForOwner(w, { id: 'RCP-17', project_key: 'RCP' }, 'canceled'),
    );
    expect(ended).toBeUndefined();
    expect(d.row<{ n: number }>('SELECT count(*) AS n FROM events').n).toBe(before);
  });
});
