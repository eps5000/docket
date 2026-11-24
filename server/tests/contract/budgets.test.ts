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
import { syncBundledFiles } from '../../src/jobs/bundled.js';
import {
  PRODUCT_RESULT_MODES,
  expectOk,
  startHarness,
  textOf,
  tokens,
  type ContractHarness,
} from './harness.js';

const TOLERANCE = 1.2;
/** MCP_SPEC §3.2 (decision 36; B38): measured on 20 parts plus 20%. */
const LIST_SHARED_BUDGET = 1_100;
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

/**
 * Step details (decision 33; SC-020; MCP_SPEC §5.12): get_item standard never
 * carries the details text, only a `· details` marker per step, so an item
 * with 10 steps of 10,000 characters each stays within the RCP-14 standard
 * budget. Measured on RCP-14 brought to 10 steps, before and after the
 * details are added, on its own harness so the seed reads above are untouched.
 */
describe('step details keep get_item standard within budget (decision 33; SC-020)', () => {
  it('RCP-14 with 10 steps of 10,000 characters each ≤ 1,200, and only the markers are added', async () => {
    const own = await startHarness();
    try {
      const paragraph = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ';
      const details = `## Context\n\n${paragraph.repeat(200)}`.slice(0, 10_000);
      expect(details).toHaveLength(10_000);
      const item = (await own.call('get_item', { id: 'RCP-14', view: 'full' })) as never;
      const current = (expectOk(item).structured.item as { checklist: { work: { id: string }[] } })
        .checklist.work;
      const extra = 10 - current.length;
      expectOk(
        await own.call('set_plan', {
          id: 'RCP-14',
          reason: 'Budget check: ten steps',
          steps: Array.from({ length: extra }, (_, i) => ({ text: `Budget step ${i + 1}` })),
        }),
      );
      const before = expectOk(await own.call('get_item', { id: 'RCP-14' }));
      const steps = (before.structured.item as { checklist: { work: { id: string }[] } }).checklist
        .work;
      expect(steps).toHaveLength(10);
      expectOk(
        await own.call('set_plan', {
          id: 'RCP-14',
          reason: 'Budget check: details',
          steps: steps.map((s) => ({ id: s.id, details })),
        }),
      );
      const after = expectOk(await own.call('get_item', { id: 'RCP-14' }));
      const work = (after.structured.item as { checklist: { work: { has_details: boolean }[] } })
        .checklist.work;
      expect(work.every((s) => s.has_details && !('details_md' in s))).toBe(true);
      expect(after.text).not.toContain('Lorem ipsum');
      // Each step line gains exactly the marker; the rest differs only by the new plan version and event.
      const stepLines = (t: string) => t.split('\n').filter((l) => /^ {2}- \[.\] wst_/.test(l));
      expect(stepLines(before.text)).toHaveLength(10);
      expect(stepLines(after.text)).toEqual(stepLines(before.text).map((l) => `${l} · details`));
      within('get_item RCP-14 standard, 10 steps, no details', before.text, 1_200);
      within('get_item RCP-14 standard, 10 steps × 10,000-character details', after.text, 1_200);
      // The full view carries all 100,000 characters; get_step reads one step.
      const full = expectOk(await own.call('get_item', { id: 'RCP-14', view: 'full' }));
      expect(full.text.length).toBeGreaterThan(100_000);
    } finally {
      await own.close();
    }
  });
});

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

  it('get_agent_files RCP listing ≤ 720 (decisions 30 and 66; MCP_SPEC §5.10)', async () => {
    // A real call on the seed data with the shipped files loaded: every skill
    // in skills/, the AGENTS.md block and Workflow notes, one line each.
    syncBundledFiles(h.server.runtime);
    const r = expectOk(await h.call('get_agent_files', { project: 'RCP' }));
    const files = r.structured.files as { content: string | null }[];
    expect(files.length).toBeGreaterThanOrEqual(7);
    expect(files.every((f) => f.content === null)).toBe(true);
    within(`get_agent_files RCP listing (${files.length} files)`, r.text, 720);
  });

  it('onboard_project with the bundled guide ≤ 1,400; finish_onboarding ≤ 60 (decision 31; MCP_SPEC §3.2)', async () => {
    // Exempt from the mutation budget: the text block is a header line and the whole
    // guide (§5.11). Its own row, set in B30 at the measured size plus 20%.
    syncBundledFiles(h.server.runtime);
    const r = expectOk(await h.call('onboard_project', { key: 'BUD', name: 'Budget check' }));
    expect(r.text).toContain((r.structured as { guide: string }).guide);
    within('onboard_project, bundled guide', r.text, 1_400);
    const done = expectOk(
      await h.call('finish_onboarding', {
        session_id: (r.structured as { session_id: string }).session_id,
        summary: 'Nothing to import.',
      }),
    );
    within('finish_onboarding', done.text, 60);
  });

  it('apply_batch with 100 operations ≤ 30 + 25 per operation (decision 34; MCP_SPEC §5.13)', async () => {
    // One line per operation: 100 creates, each the single call's compact line.
    const operations = Array.from({ length: 100 }, (_, i) => ({
      op: 'create_item',
      args: {
        project: 'RCP',
        type: 'Task',
        title: `Onboarded task ${i + 1} from specs/001-checkout/tasks.md`,
        status: 'planning',
      },
    }));
    const r = expectOk(await h.call('apply_batch', { operations }));
    expect(r.structured).toMatchObject({ applied: 100, failed: 0 });
    within('apply_batch, 100 create_item operations', r.text, 30 + 25 * 100);
  });

  it('list_shared_parts with 20 parts ≤ its row; declare_shared_changes ≤ 60 (decision 36; MCP_SPEC §5.15)', async () => {
    // 20 realistic parts (the Gameflow shape: tables, models, endpoints, shared files), each
    // with paths and half with notes; 10 of them declared by an in-flight item with a note.
    const kinds = ['table', 'model', 'endpoint', 'file'] as const;
    const keyOf = (i: number) => {
      const kind = kinds[i % 4]!;
      if (kind === 'table') return `table:recipe_part_${i}`;
      if (kind === 'model') return `model:RecipePart${i}`;
      if (kind === 'endpoint') return `endpoint:POST /recipes/{id}/parts/${i}`;
      return `file:server/src/domain/recipe-part-${i}.ts`;
    };
    const flight = ['RCP-14', 'RCP-15', 'RCP-18', 'RCP-12', 'RCP-16'];
    const keys = Array.from({ length: 20 }, (_, i) => keyOf(i));
    // Register all 20 from an Inbox item (not in flight), in one call.
    const registered = expectOk(
      await h.call('declare_shared_changes', {
        id: 'RCP-20',
        changes: keys.map((part) => ({ part, change: 'change' })),
        new_parts: keys.map((key, i) => ({
          key,
          paths: [`server/src/domain/recipe-part-${i}.ts`, `server/tests/recipe-part-${i}.test.ts`],
          ...(i % 2 === 0 ? { note: 'Shared by the planner and the shopping list' } : {}),
        })),
      }),
    );
    within('declare_shared_changes, registering 20 parts', registered.text, 60);
    // Two parts per in-flight item, with notes: 10 parts declared in flight.
    for (const [n, id] of flight.entries()) {
      const r = expectOk(
        await h.call('declare_shared_changes', {
          id,
          changes: [2 * n, 2 * n + 1].map((i) => ({
            part: keys[i]!,
            change: 'change',
            note: `Adds field ${i} to the recipe shape`,
          })),
        }),
      );
      within(`declare_shared_changes ${id}`, r.text, 60);
    }
    const r = expectOk(await h.call('list_shared_parts', { project: 'RCP' }));
    const parts = r.structured.parts as { in_flight: unknown[] }[];
    expect(parts).toHaveLength(20);
    expect(parts.filter((p) => p.in_flight.length > 0)).toHaveLength(10);
    within('list_shared_parts RCP, 20 parts, 10 declared in flight', r.text, LIST_SHARED_BUDGET);
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
