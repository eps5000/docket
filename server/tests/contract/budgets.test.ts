/**
 * Token budgets (MCP_SPEC §3.2; §10 item 11; tasks.md T069), measured on the
 * text block as characters ÷ 4 against the seed data. A test fails above
 * 120% of its budget, and prints the measured numbers so regressions show.
 *
 * SC-001 (find, claim and get full context in ≤ 4 calls and ≤ 3,500 tokens)
 * is measured on the flow MCP_SPEC §7.1 names: whoami → search_items →
 * claim_lead → get_context (US5, tasks.md T112).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PRODUCT_RESULT_MODES,
  expectOk,
  startHarness,
  textOf,
  tokens,
  type ContractHarness,
} from './harness.js';

const TOLERANCE = 1.2;
const measured: { call: string; tokens: number; budget: number }[] = [];

let h: ContractHarness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
  console.log(
    [
      '',
      '| Call | Measured (tokens) | Budget | Limit (120%) |',
      '|---|---:|---:|---:|',
      ...measured.map(
        (m) => `| ${m.call} | ${m.tokens} | ${m.budget} | ${Math.floor(m.budget * TOLERANCE)} |`,
      ),
    ].join('\n'),
  );
});

function within(call: string, text: string, budget: number) {
  const n = tokens(text);
  measured.push({ call, tokens: n, budget });
  expect(n, `${call}: ${n} tokens, budget ${budget}`).toBeLessThanOrEqual(budget * TOLERANCE);
}

const ITEM_IDS = [
  'RCP-1',
  'RCP-2',
  'RCP-11',
  'RCP-12',
  'RCP-14',
  'RCP-15',
  'RCP-16',
  'RCP-17',
  'RCP-18',
  'RCP-19',
  'RCP-20',
  'RCP-21',
  'RCP-22',
  'RCP-23',
  'RCP-24',
  'RCP-25',
  'RCP-27',
  'RCP-29',
  'DOC-2',
  'DOC-4',
  'DOC-5',
  'DOC-7',
  'DOC-8',
  'DOC-9',
  'DOC-10',
];

describe('reads', () => {
  it('get_item RCP-14 standard ≤ 1,200', async () => {
    within('get_item RCP-14 standard', textOf(await h.call('get_item', { id: 'RCP-14' })), 1_200);
  });

  it('get_item summary ≤ 300, for every seeded item', async () => {
    let worst = { id: '', n: 0, text: '' };
    for (const id of ITEM_IDS) {
      const text = expectOk(await h.call('get_item', { id, view: 'summary' })).text;
      if (tokens(text) > worst.n) worst = { id, n: tokens(text), text };
    }
    within(`get_item summary (largest: ${worst.id})`, worst.text, 300);
  });

  it('get_context RCP-14 medium ≤ 3,000', async () => {
    within(
      'get_context RCP-14 medium',
      textOf(await h.call('get_context', { id: 'RCP-14', budget: 'medium' })),
      3_000,
    );
  });

  it('search_items with 25 results ≤ 1,000', async () => {
    const r = expectOk(await h.call('search_items', { limit: 25 }));
    expect((r.structured.items as unknown[]).length).toBe(25);
    within('search_items, 25 results', r.text, 1_000);
  });
});

describe('mutations ≤ 60', () => {
  it('every US1 mutation result stays one short line', async () => {
    const call = async (name: string, args: Record<string, unknown>) => {
      const text = expectOk(await h.call(name, args)).text;
      within(name, text, 60);
      return expectOk(await h.call('get_item', { id: 'RCP-17', view: 'summary' })).structured;
    };
    const claim = expectOk(await h.call('claim_lead', { id: 'RCP-17', agent_label: 'orca-w3' }));
    within('claim_lead', claim.text, 60);
    const run_id = claim.structured.run_id as string;
    const planText = expectOk(
      await h.call('set_plan', {
        id: 'RCP-17',
        run_id,
        steps: [{ text: 'Reproduce' }, { text: 'Fix' }],
      }),
    );
    within('set_plan', planText.text, 60);
    const work = planText.structured.work as { id: string }[];
    const checks = expectOk(
      await h.call('set_checks', {
        id: 'RCP-17',
        run_id,
        checks: [{ text: 'Planner tests pass' }],
      }),
    );
    within('set_checks', checks.text, 60);
    const check = (checks.structured.checks as { id: string }[])[0]!.id;
    await call('update_step', { id: 'RCP-17', run_id, step_id: work[0]!.id, state: 'current' });
    await call('log_subagent', {
      id: 'RCP-17',
      run_id,
      name: 'explorer',
      outcome: 'Found it',
      provenance: 'relayed',
    });
    await call('report_commit', {
      id: 'RCP-17',
      run_id,
      sha: '4be1c09',
      branch: 'rcp-17-week-reload',
      pushed: true,
    });
    await call('update_check', {
      id: 'RCP-17',
      run_id,
      check_id: check,
      state: 'pass',
      evidence: 'vitest: 212 passed',
    });
    await call('add_note', { id: 'RCP-17', run_id, text: 'Root cause: stale cache key.' });
    await call('link_artifact', {
      id: 'RCP-17',
      run_id,
      kind: 'ci',
      label: 'CI build #91',
      state: 'passed',
    });
    await call('heartbeat', { run_id, note: 'Writing the regression test' });
    const created = expectOk(
      await h.call('create_item', {
        project: 'RCP',
        type: 'Task',
        title: 'Pantry inventory schema',
      }),
    );
    within('create_item', created.text, 60);
    const item = created.structured.item as { id: string; version: number };
    within(
      'update_item',
      expectOk(
        await h.call('update_item', { id: item.id, expected_version: item.version, priority: 1 }),
      ).text,
      60,
    );
    within(
      'set_status',
      expectOk(await h.call('set_status', { id: item.id, status: 'planning' })).text,
      60,
    );
    const child = expectOk(
      await h.call('start_run', {
        id: 'RCP-17',
        parent_run_id: run_id,
        agent_label: 'units-worker',
      }),
    );
    within('start_run', child.text, 60);
    within(
      'finish_run',
      expectOk(
        await h.call('finish_run', {
          run_id: child.structured.run_id,
          result: 'finished',
          summary: 'Done.',
        }),
      ).text,
      60,
    );
    within(
      'release_lead',
      expectOk(await h.call('release_lead', { id: 'RCP-17', run_id, reason: 'Pausing.' })).text,
      60,
    );
  });
});

describe('SC-001', () => {
  // From connecting: whoami → search_items → claim_lead → get_context, in ≤ 4 calls and
  // ≤ 3,500 tokens of results in total, on the sample data (spec.md SC-001). Its own
  // fresh server, so the mutation tests above don't change what is ready.
  it('finds, claims and gets full context in ≤ 4 calls and ≤ 3,500 tokens', async () => {
    const fresh = await startHarness();
    try {
      const calls: { call: string; tokens: number }[] = [];
      const call = async (name: string, args: Record<string, unknown>) => {
        const out = expectOk(await fresh.call(name, args));
        calls.push({ call: `${name} ${JSON.stringify(args)}`, tokens: tokens(out.text) });
        return out;
      };
      await call('whoami', {});
      const found = await call('search_items', { filter: 'ready_to_start', limit: 1 });
      const best = (found.structured.items as { id: string }[])[0]!.id;
      const claim = await call('claim_lead', { id: best, agent_label: 'orca-w3' });
      expect(claim.structured.run_id).toBeTruthy();
      const context = await call('get_context', { id: best });
      expect(context.text.split('\n')[0]).toMatch(new RegExp(`^Context for ${best} `));

      const total = calls.reduce((n, c) => n + c.tokens, 0);
      console.log(
        [
          '',
          `SC-001 (best item ${best}):`,
          '| Call | Tokens |',
          '|---|---:|',
          ...calls.map((c) => `| ${c.call} | ${c.tokens} |`),
          `| **Total (${calls.length} calls)** | **${total}** |`,
        ].join('\n'),
      );
      measured.push({ call: `SC-001 total (${calls.length} calls)`, tokens: total, budget: 3_500 });
      expect(calls.length).toBeLessThanOrEqual(4);
      expect(total, `SC-001: ${total} tokens`).toBeLessThanOrEqual(3_500);
    } finally {
      await fresh.close();
    }
  });

  // A text-only client (MCP_SPEC §3 Results; owner decision 28), here `claude-code` under the
  // shipped default: its model sees every result in full, which is the text block alone.
  it("holds for what a text-only client's model sees", async () => {
    const fresh = await startHarness({ env: PRODUCT_RESULT_MODES });
    try {
      const calls: { call: string; tokens: number }[] = [];
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await fresh.call(name, args);
        expect(result.isError ?? false, `${name}: ${JSON.stringify(result)}`).toBe(false);
        expect(result, `${name} is text-only`).not.toHaveProperty('structuredContent');
        // Everything in the result that a model could be given.
        const seen = result.content.map((c) => (c.type === 'text' ? c.text : JSON.stringify(c)));
        calls.push({ call: `${name} ${JSON.stringify(args)}`, tokens: tokens(seen.join('\n')) });
        return textOf(result);
      };
      await call('whoami', {});
      const found = await call('search_items', { filter: 'ready_to_start', limit: 1 });
      // The header line, then one row per item, ID first (§3.1).
      const best = /^(\S+) /.exec(found.split('\n')[1]!)![1]!;
      await call('claim_lead', { id: best, agent_label: 'orca-w3' });
      const context = await call('get_context', { id: best });
      expect(context.split('\n')[0]).toMatch(new RegExp(`^Context for ${best} `));

      const total = calls.reduce((n, c) => n + c.tokens, 0);
      console.log(
        [
          '',
          `SC-001, text-only client (best item ${best}):`,
          '| Call | Tokens the model sees |',
          '|---|---:|',
          ...calls.map((c) => `| ${c.call} | ${c.tokens} |`),
          `| **Total (${calls.length} calls)** | **${total}** |`,
        ].join('\n'),
      );
      measured.push({
        call: `SC-001 text-only total (${calls.length} calls)`,
        tokens: total,
        budget: 3_500,
      });
      expect(calls.length).toBeLessThanOrEqual(4);
      expect(total, `SC-001 text-only: ${total} tokens`).toBeLessThanOrEqual(3_500);
    } finally {
      await fresh.close();
    }
  });
});
