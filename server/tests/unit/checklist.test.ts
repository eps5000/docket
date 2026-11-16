/**
 * Plan and check patching (BUILD_SPEC §5.5; MCP_SPEC §3.3; FR-017; tasks.md T067):
 * silence preserves. Patch never removes unlisted entries; replace removes
 * agent entries only; owner entries are always kept; at most 30 of each.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { In } from '../../src/domain/contracts.js';
import type { Actor } from '../../src/domain/write.js';
import { startDomain, type Domain } from '../us1-helpers.js';

let d: Domain;
let claude: Actor;
const ID = 'RCP-17';

beforeEach(() => {
  d = startDomain();
  const { run_id } = d.write(d.agent('claude'), (w, s) => s.runs.claim(w, { id: ID }));
  claude = d.agent('claude', { run_id });
});
afterEach(() => d.cleanup());

type PlanArgs = Omit<In<'set_plan'>, 'id' | 'mode'> & { mode?: 'patch' | 'replace' };
type CheckArgs = Omit<In<'set_checks'>, 'id' | 'mode'> & { mode?: 'patch' | 'replace' };

const plan = (args: PlanArgs, id = ID) =>
  d.write(claude, (w, s) => s.checklist.setPlan(w, { id, mode: 'patch', ...args }));
const checks = (args: CheckArgs, id = ID) =>
  d.write(claude, (w, s) => s.checklist.setChecks(w, { id, mode: 'patch', ...args }));
const texts = (list: { text: string }[]) => list.map((x) => x.text);

function ownerStep(text: string, position: number) {
  const t = d.clock.now().toISOString();
  const pv = d.row<{ v: number }>(
    'SELECT coalesce(max(version_no), 0) AS v FROM plan_versions WHERE item_id = ?',
    ID,
  ).v;
  d.sql
    .prepare(
      `INSERT INTO work_steps (id, item_id, plan_version_no, position, text, state, added_by, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'todo', 'owner', 1, ?, ?)`,
    )
    .run(`wst_owner${position}`, ID, pv, position, text, t, t);
  return `wst_owner${position}`;
}

function ownerCheck(text: string, position: number) {
  const t = d.clock.now().toISOString();
  d.sql
    .prepare(
      `INSERT INTO agent_checks (id, item_id, position, text, state, provenance, added_by, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'todo', 'agent', 'owner', 1, ?, ?)`,
    )
    .run(`chk_owner${position}`, ID, position, text, t, t);
  return `chk_owner${position}`;
}

describe('set_plan', () => {
  it('the first plan needs no reason and is version 1, with steps in order', () => {
    const out = plan({ steps: [{ text: 'Reproduce' }, { text: 'Fix' }, { text: 'Test' }] });
    expect(out.plan_version).toBe(1);
    expect(texts(out.work)).toEqual(['Reproduce', 'Fix', 'Test']);
    expect(out.work.every((s) => s.state === 'todo' && s.added_by === 'agent')).toBe(true);
    expect(out.work.every((s) => /^wst_/.test(s.id))).toBe(true);
  });

  it('a revision needs a reason', () => {
    plan({ steps: [{ text: 'Reproduce' }] });
    const err = d.fails(
      claude,
      (w, s) => s.checklist.setPlan(w, { id: ID, mode: 'patch', steps: [{ text: 'More' }] }),
      'validation',
    );
    expect(err.message).toContain('reason');
  });

  it('patch: sending one changed step leaves the others unchanged, and records the old text and reason', () => {
    const v1 = plan({
      steps: [{ text: 'Reproduce' }, { text: 'Export to Reminders' }, { text: 'Test' }],
    });
    const target = v1.work[1]!;
    const v2 = plan({
      reason: 'Reminders API not reachable',
      steps: [{ id: target.id, text: 'Export as a Markdown checklist' }],
    });
    expect(v2.plan_version).toBe(2);
    expect(texts(v2.work)).toEqual(['Reproduce', 'Export as a Markdown checklist', 'Test']);
    const changed = v2.work[1]!;
    expect(changed.id).toBe(target.id);
    expect(changed.was_text).toBe('Export to Reminders');
    expect(changed.change_reason).toBe('Reminders API not reachable');
    expect(v2.work[0]).toEqual(v1.work[0]);
    expect(v2.work[2]).toEqual(v1.work[2]);
  });

  it('patch: new steps go at the end, or after a given step', () => {
    const v1 = plan({ steps: [{ text: 'A' }, { text: 'B' }] });
    const v2 = plan({
      reason: 'More',
      steps: [{ text: 'C' }, { text: 'A2', after: v1.work[0]!.id }],
    });
    expect(texts(v2.work)).toEqual(['A', 'A2', 'B', 'C']);
  });

  it('patch: nothing is removed unless listed in remove', () => {
    const v1 = plan({ steps: [{ text: 'A' }, { text: 'B' }, { text: 'C' }] });
    const v2 = plan({ reason: 'Drop B', remove: [v1.work[1]!.id] });
    expect(texts(v2.work)).toEqual(['A', 'C']);
  });

  it('every revision is kept as history with its reason', () => {
    plan({ steps: [{ text: 'A' }] });
    plan({ reason: 'Found a second cause', steps: [{ text: 'B' }] });
    expect(
      d.rows(
        'SELECT version_no, reason, created_by FROM plan_versions WHERE item_id = ? ORDER BY version_no',
        ID,
      ),
    ).toEqual([
      { version_no: 1, reason: null, created_by: 'claude' },
      { version_no: 2, reason: 'Found a second cause', created_by: 'claude' },
    ]);
    const ev = d.rows<{ type: string }>(
      "SELECT type FROM events WHERE item_id = ? AND type = 'plan.updated'",
      ID,
    );
    expect(ev).toHaveLength(2);
  });

  it('replace: agent steps not restated are removed', () => {
    const v1 = plan({ steps: [{ text: 'A' }, { text: 'B' }, { text: 'C' }] });
    const v2 = plan({
      mode: 'replace',
      reason: 'Rethink',
      steps: [{ id: v1.work[2]!.id }, { text: 'D' }],
    });
    expect(texts(v2.work)).toEqual(['C', 'D']);
  });

  it('replace keeps owner-added steps; the agent may change their state, not their text', () => {
    plan({ steps: [{ text: 'A' }, { text: 'B' }] });
    const owner = ownerStep('Owner: check the empty state', 5);
    const v2 = plan({ mode: 'replace', reason: 'Rethink', steps: [{ text: 'Z' }] });
    expect(texts(v2.work)).toEqual(['Z', 'Owner: check the empty state']);
    expect(v2.work.find((s) => s.id === owner)?.added_by).toBe('owner');

    const v3 = plan({ reason: 'Done it', steps: [{ id: owner, state: 'done' }] });
    expect(v3.work.find((s) => s.id === owner)?.state).toBe('done');
    d.fails(
      claude,
      (w, s) =>
        s.checklist.setPlan(w, {
          id: ID,
          mode: 'patch',
          reason: 'Edit',
          steps: [{ id: owner, text: 'Mine now' }],
        }),
      'forbidden',
    );
    d.fails(
      claude,
      (w, s) => s.checklist.setPlan(w, { id: ID, mode: 'patch', reason: 'Drop', remove: [owner] }),
      'forbidden',
    );
  });

  it('an unknown step id is validation', () => {
    plan({ steps: [{ text: 'A' }] });
    d.fails(
      claude,
      (w, s) =>
        s.checklist.setPlan(w, {
          id: ID,
          mode: 'patch',
          reason: 'x',
          steps: [{ id: 'wst_nope', text: 'B' }],
        }),
      'validation',
    );
    d.fails(
      claude,
      (w, s) =>
        s.checklist.setPlan(w, { id: ID, mode: 'patch', reason: 'x', remove: ['wst_nope'] }),
      'validation',
    );
  });

  it('a new step needs text', () => {
    d.fails(
      claude,
      (w, s) => s.checklist.setPlan(w, { id: ID, mode: 'patch', steps: [{ state: 'done' }] }),
      'validation',
    );
  });

  it('at most 30 steps on the plan in total', () => {
    plan({ steps: Array.from({ length: 30 }, (_, i) => ({ text: `Step ${i + 1}` })) });
    const err = d.fails(
      claude,
      (w, s) =>
        s.checklist.setPlan(w, {
          id: ID,
          mode: 'patch',
          reason: 'One more',
          steps: [{ text: 'Step 31' }],
        }),
      'validation',
    );
    expect(err.message).toContain('30');
  });
});

describe('update_step', () => {
  it('changes one step’s state, recording who and when', () => {
    const v1 = plan({ steps: [{ text: 'A' }, { text: 'B' }] });
    const out = d.write(claude, (w, s) =>
      s.checklist.updateStep(w, { id: ID, step_id: v1.work[0]!.id, state: 'current' }),
    );
    expect(out.step).toMatchObject({
      id: v1.work[0]!.id,
      state: 'current',
      state_by: 'claude',
      state_at: d.clock.now().toISOString(),
    });
    expect(d.row('SELECT state FROM work_steps WHERE id = ?', v1.work[1]!.id)).toEqual({
      state: 'todo',
    });
    // The run's current step follows.
    expect(d.row('SELECT current_step_id FROM runs WHERE id = ?', claude.run_id)).toEqual({
      current_step_id: v1.work[0]!.id,
    });
  });

  it('an unknown step is not_found', () => {
    d.fails(
      claude,
      (w, s) => s.checklist.updateStep(w, { id: ID, step_id: 'wst_nope', state: 'done' }),
      'not_found',
    );
  });
});

describe('set_checks', () => {
  it('patch adds and updates; nothing is removed unless listed', () => {
    const c1 = checks({
      checks: [
        { text: 'Planner tests pass', provenance: 'agent' },
        { text: 'Reload keeps the week', provenance: 'agent' },
      ],
    });
    expect(texts(c1.checks)).toEqual(['Planner tests pass', 'Reload keeps the week']);
    expect(
      c1.checks.every(
        (c) => c.state === 'todo' && c.provenance === 'agent' && c.added_by === 'agent',
      ),
    ).toBe(true);
    const c2 = checks({
      checks: [
        {
          id: c1.checks[0]!.id,
          state: 'pass',
          evidence: 'vitest: 212 passed',
          provenance: 'agent',
        },
      ],
    });
    expect(c2.checks[0]).toMatchObject({ state: 'pass', evidence: 'vitest: 212 passed' });
    expect(c2.checks[1]).toEqual(c1.checks[1]);
    const c3 = checks({ remove: [c1.checks[1]!.id] });
    expect(texts(c3.checks)).toEqual(['Planner tests pass']);
  });

  it('replace removes agent checks only; owner checks are kept', () => {
    checks({
      checks: [
        { text: 'A', provenance: 'agent' },
        { text: 'B', provenance: 'agent' },
      ],
    });
    ownerCheck('Owner: run it on a phone', 9);
    const out = checks({ mode: 'replace', checks: [{ text: 'C', provenance: 'observed' }] });
    expect(texts(out.checks)).toEqual(['C', 'Owner: run it on a phone']);
    expect(out.checks[0]!.provenance).toBe('observed');
  });

  it('at most 30 checks in total', () => {
    checks({
      checks: Array.from({ length: 30 }, (_, i) => ({
        text: `Check ${i + 1}`,
        provenance: 'agent' as const,
      })),
    });
    d.fails(
      claude,
      (w, s) =>
        s.checklist.setChecks(w, {
          id: ID,
          mode: 'patch',
          checks: [{ text: 'One more', provenance: 'agent' }],
        }),
      'validation',
    );
  });

  it('update_check sets state and evidence; evidence left out stays', () => {
    const c1 = checks({ checks: [{ text: 'A', provenance: 'agent', evidence: 'first run' }] });
    const out = d.write(claude, (w, s) =>
      s.checklist.updateCheck(w, { id: ID, check_id: c1.checks[0]!.id, state: 'pass' }),
    );
    expect(out.check).toMatchObject({ state: 'pass', evidence: 'first run' });
    d.fails(
      claude,
      (w, s) => s.checklist.updateCheck(w, { id: ID, check_id: 'chk_nope', state: 'pass' }),
      'not_found',
    );
  });
});

describe('log_subagent', () => {
  it('records a line under the step, never a ticket', () => {
    const v1 = plan({ steps: [{ text: 'A' }] });
    const items = d.row<{ n: number }>('SELECT count(*) AS n FROM items').n;
    const out = d.write(claude, (w, s) =>
      s.checklist.logSubagent(w, {
        id: ID,
        step_id: v1.work[0]!.id,
        name: 'explorer',
        outcome: 'Mapped 214 units',
        provenance: 'relayed',
      }),
    );
    expect(out).toEqual({ logged: true });
    expect(d.row<{ n: number }>('SELECT count(*) AS n FROM items').n).toBe(items);
    const item = d.services.items.get(d.read(), { id: ID, view: 'standard' }).item;
    expect(item.checklist?.work[0]?.subagents).toEqual([
      expect.objectContaining({
        name: 'explorer',
        outcome: 'Mapped 214 units',
        provenance: 'relayed',
        child_run_id: null,
      }),
    ]);
  });
});
