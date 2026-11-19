/**
 * The current step in `get_context` (owner decision 33; B34, tasks.md T171;
 * MCP_SPEC §5.2 `get_context`, §5.12; BUILD_SPEC §5.15 section 4b), through
 * the official MCP SDK client against a seeded server:
 *
 * - the bundle carries the step in state `current`, else the first `todo`,
 *   with its details, as a `step:` section after the blockers and
 *   dependents and before the workflow notes;
 * - details are counted in the budget: at every budget the text stays within
 *   it, and long details are cut inline with a `…truncated; read it with
 *   get_step <item> <step>` line (the numbers are printed: PR evidence);
 * - no open step: no section; a step without details: its header only;
 * - a `set_plan` replace that keeps a step by ID keeps its details and
 *   source, even when it rewords the step and drops another.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { CONTEXT_BUDGETS } from '../../src/domain/context.js';
import { expectOk, startHarness, tokens, type ContractHarness } from './harness.js';

let h: ContractHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const measured: string[] = [];
afterAll(() => {
  if (measured.length > 0)
    console.log(
      [
        '',
        '| get_context RCP-14, 10 steps × 10,000-character details | Tokens | Budget | Step details shown (chars) |',
        '|---|---:|---:|---:|',
        ...measured,
      ].join('\n'),
    );
});

type Step = { id: string; text: string; state: string };
type Current = {
  id: string;
  text: string;
  state: string;
  source: string | null;
  details_md: string | null;
  details_version: number;
  truncated: boolean;
} | null;

const workOf = async (id: string): Promise<Step[]> =>
  (
    expectOk(await h!.call('get_item', { id })).structured.item as {
      checklist: { work: Step[] };
    }
  ).checklist.work;

const context = async (id: string, budget: 'small' | 'medium' | 'large' = 'medium') => {
  const r = expectOk(await h!.call('get_context', { id, budget }));
  const ctx = r.structured.context as { current_step?: Current; truncated_sections: string[] };
  return { text: r.text, step: ctx.current_step ?? null, ctx };
};

const paragraph = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ';
const LONG = `## Context\n\n${paragraph.repeat(200)}`.slice(0, 10_000);

/** RCP-14 brought to ten steps, each with 10,000 characters of details. */
async function tenDetailedSteps(): Promise<Step[]> {
  const current = await workOf('RCP-14');
  expectOk(
    await h!.call('set_plan', {
      id: 'RCP-14',
      reason: 'Budget check: ten steps',
      steps: Array.from({ length: 10 - current.length }, (_, i) => ({
        text: `Budget step ${i + 1}`,
      })),
    }),
  );
  const steps = await workOf('RCP-14');
  expect(steps).toHaveLength(10);
  expectOk(
    await h!.call('set_plan', {
      id: 'RCP-14',
      reason: 'Budget check: details',
      steps: steps.map((s) => ({ id: s.id, details: LONG, source: 'GF-1' })),
    }),
  );
  return steps;
}

describe('get_context includes the current step (decision 33; MCP_SPEC §5.12)', () => {
  it('picks the current step, else the first todo, and shows short details whole', async () => {
    h = await startHarness();
    const steps = await workOf('RCP-14');
    const open = steps.find((s) => s.state === 'current') ?? steps.find((s) => s.state === 'todo');
    expect(open, 'the seed gives RCP-14 an open step').toBeDefined();
    expectOk(
      await h.call('set_plan', {
        id: 'RCP-14',
        reason: 'Add context to the open step',
        steps: [{ id: open!.id, details: 'Open `planner.ts`.\n\nKeep the week in the URL.' }],
      }),
    );
    const { text, step } = await context('RCP-14');
    expect(step).toMatchObject({
      id: open!.id,
      details_md: 'Open `planner.ts`.\n\nKeep the week in the URL.',
      details_version: 1,
      truncated: false,
    });
    const lines = text.split('\n');
    const at = lines.findIndex((l) => l.startsWith(`step: ${open!.id} `));
    expect(at).toBeGreaterThan(0);
    expect(lines[at]).toContain(' · details v1');
    expect(lines.slice(at + 1, at + 4)).toEqual([
      '  Open `planner.ts`.',
      '  ',
      '  Keep the week in the URL.',
    ]);
    expect(text).not.toContain('read it with get_step');
    // After the blockers, before any workflow notes.
    const blockedBy = lines.findIndex((l) => l.startsWith('blocked_by'));
    expect(blockedBy).toBeLessThan(at);
    const wf = lines.findIndex((l) => l.startsWith('workflow:'));
    if (wf >= 0) expect(wf).toBeGreaterThan(at);

    // Marking it done moves the section to the next open step.
    const next = steps.find(
      (s) => s.id !== open!.id && (s.state === 'todo' || s.state === 'current'),
    );
    expectOk(
      await h.call('set_plan', {
        id: 'RCP-14',
        reason: 'Finish the first',
        steps: [{ id: open!.id, state: 'done' }],
      }),
    );
    const after = await context('RCP-14');
    if (next) {
      expect(after.step?.id).toBe(next.id);
      // A step without details shows its header only.
      expect(after.text).toContain(`step: ${next.id} ${next.text}`);
    } else {
      expect(after.step).toBeNull();
    }
  });

  it('no open step: no section', async () => {
    h = await startHarness();
    const steps = await workOf('RCP-14');
    expectOk(
      await h.call('set_plan', {
        id: 'RCP-14',
        reason: 'All done',
        steps: steps.map((s) => ({ id: s.id, state: 'done' })),
      }),
    );
    const { text, step } = await context('RCP-14');
    expect(step).toBeNull();
    expect(text).not.toMatch(/^step: /m);
  });

  it('counts details in the budget and cuts them with a marker pointing at get_step', async () => {
    h = await startHarness();
    await tenDetailedSteps();
    for (const budget of ['small', 'medium', 'large'] as const) {
      const { text, step, ctx } = await context('RCP-14', budget);
      const n = tokens(text);
      expect(n, `get_context RCP-14 ${budget}: ${n} tokens`).toBeLessThanOrEqual(
        CONTEXT_BUDGETS[budget],
      );
      if (step) {
        const whole = step.details_md === LONG;
        expect(step.truncated).toBe(!whole);
        if (budget === 'small') expect(whole).toBe(false);
        if (!whole) expect(text).toContain(`  …truncated; read it with get_step RCP-14 ${step.id}`);
        else expect(text).not.toContain('read it with get_step');
        expect(text).toMatch(new RegExp(`^step: ${step.id} .* · source GF-1 · details v1$`, 'm'));
      } else {
        // Left out entirely: the marker says how to read it.
        expect(ctx.truncated_sections.some((s) => s.includes('read it with get_step RCP-14'))).toBe(
          true,
        );
      }
      measured.push(
        `| ${budget} | ${n} | ${CONTEXT_BUDGETS[budget]} | ${step?.details_md?.length ?? 0} |`,
      );
    }
    // The large budget has room for all 10,000 characters.
    const large = await context('RCP-14', 'large');
    expect(large.step?.details_md).toBe(LONG);
  });
});

describe('set_plan replace keeps a kept step’s details (decision 33; BUILD_SPEC §5.5)', () => {
  it('rewording a kept step and dropping another keeps the kept step’s details and source', async () => {
    h = await startHarness();
    const { run_id } = expectOk(await h.call('claim_lead', { id: 'RCP-17', agent_label: 'w1' }))
      .structured as { run_id: string };
    const planned = expectOk(
      await h.call('set_plan', {
        id: 'RCP-17',
        run_id,
        steps: [
          { text: 'Reproduce', details: 'Reload the planner twice.', source: 'GF-7' },
          { text: 'Fix it' },
        ],
      }),
    ).structured.work as Step[];
    const [a, b] = planned as [Step, Step];
    expectOk(
      await h.call('set_plan', {
        id: 'RCP-17',
        run_id,
        reason: 'Restate',
        mode: 'replace',
        steps: [{ id: a.id, text: 'Reproduce the jump after reload' }, { text: 'Ship it' }],
      }),
    );
    const step = expectOk(await h.call('get_step', { id: 'RCP-17', step_id: a.id })).structured
      .step as { text: string; details_md: string; details_version: number; source: string };
    expect(step).toMatchObject({
      text: 'Reproduce the jump after reload',
      details_md: 'Reload the planner twice.',
      details_version: 1,
      source: 'GF-7',
    });
    expect((await workOf('RCP-17')).map((s) => s.id)).not.toContain(b.id);
  });
});
