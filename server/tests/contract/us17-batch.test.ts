/**
 * Batches and imported-step details (owner decision 34; B36, tasks.md T177,
 * T178; MCP_SPEC §5.5, §5.13; SC-021), through the official MCP SDK client:
 *
 * - one session onboards at scale: 160 operations in two `apply_batch` calls
 *   (epics and items with `$n` references, enrichments, planning documents,
 *   details on imported steps, links), each with its own result, within the
 *   batch budget (printed for the PR);
 * - atomic per operation: a secret, a stale version or a bad reference fails
 *   that operation only, with the single call's error, and writes nothing;
 * - a retry with the same `idempotency_key` replays what succeeded and runs
 *   only what didn't;
 * - limits: 101 operations, and `run_id` inside an operation, are rejected;
 * - imported steps (a `source`, on an imported item) take added details from
 *   `set_plan` and `update_step`; rewriting or clearing them, and their text,
 *   stay the owner's, and owner-typed steps stay fully protected. The history
 *   reads "details added by <agent>".
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  expectForbidden,
  expectOk,
  expectValidation,
  startHarness,
  tokens,
  type ContractHarness,
} from './harness.js';

let h: ContractHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

type S = Record<string, unknown>;
interface Result {
  index: number;
  op: string;
  ok: boolean;
  id: string | null;
  version: number | null;
  text: string;
  replayed?: boolean;
  error?: { code: string; message: string };
}

/** The batch budget (MCP_SPEC §3.2): 30 tokens of header plus 25 per operation. */
const batchBudget = (n: number) => 30 + 25 * n;

/** Make RCP-14 an imported item whose first two steps came from Jira sub-tasks. */
function importSteps(harness: ContractHarness): { a: string; b: string; typed: string } {
  const db = harness.server.runtime.db.sqlite;
  const steps = db
    .prepare(
      `SELECT id FROM work_steps WHERE item_id = 'RCP-14'
       AND plan_version_no = (SELECT max(plan_version_no) FROM work_steps WHERE item_id = 'RCP-14')
       ORDER BY position`,
    )
    .all() as { id: string }[];
  db.prepare(`UPDATE items SET imported = 1, jira_key = 'GF-9' WHERE id = 'RCP-14'`).run();
  const set = db.prepare(
    `UPDATE work_steps SET added_by = 'owner', source = ?, details_md = ?, details_version = ? WHERE id = ?`,
  );
  set.run('GF-10', 'Jira GF-10 · 3 pts\n\nMerge units across recipes.', 1, steps[0]!.id);
  set.run('GF-11', null, 0, steps[1]!.id);
  // An owner-typed step: no source.
  set.run(null, null, 0, steps[2]!.id);
  return { a: steps[0]!.id, b: steps[1]!.id, typed: steps[2]!.id };
}

describe('apply_batch (decision 34; MCP_SPEC §5.13)', () => {
  it('runs 160 operations in one session, each with its own result, within the budget (SC-021)', async () => {
    h = await startHarness();
    const steps = importSteps(h);

    // Batch 1: an epic, 60 items under it ("$1"), and 39 planning documents.
    const ops1: S[] = [
      {
        op: 'create_item',
        args: {
          project: 'RCP',
          type: 'Epic',
          title: 'Checkout (specs/001-checkout)',
          status: 'planning',
        },
      },
      ...Array.from({ length: 60 }, (_, i) => ({
        op: 'create_item',
        args: {
          project: 'RCP',
          type: 'Task',
          title: `Checkout task T${String(i + 1).padStart(3, '0')}`,
          status: 'planning',
          epic: '$1',
          description_md: `Source: specs/001-checkout/tasks.md#T${String(i + 1).padStart(3, '0')}`,
        },
      })),
      ...Array.from({ length: 39 }, (_, i) => ({
        op: 'put_document',
        args: {
          item_id: '$1',
          name: `001-checkout-doc-${i + 1}.md`,
          kind: 'planning',
          content_text: `# Spec part ${i + 1}\n\nWhat the checkout does.`,
        },
      })),
    ];
    expect(ops1).toHaveLength(100);
    const r1 = expectOk(
      await h.call('apply_batch', { operations: ops1, idempotency_key: 'onboard-gf-1' }),
    );
    const res1 = r1.structured.results as Result[];
    expect(r1.structured).toMatchObject({ applied: 100, failed: 0 });
    expect(res1.map((r) => r.index)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    const epic = res1[0]!.id!;
    expect(epic).toMatch(/^RCP-\d+$/);
    const items = res1.slice(1, 61).map((r) => r.id!);
    expect(new Set(items).size).toBe(60);
    expect(res1.slice(61).every((r) => r.op === 'put_document' && /^doc_/.test(r.id!))).toBe(true);
    // "$1" became the epic: every item sits under it.
    const child = expectOk(await h.call('get_item', { id: items[0]!, view: 'summary' }));
    expect((child.structured.item as S).epic).toBe(epic);
    const n1 = tokens(r1.text);
    expect(n1, `apply_batch 100 operations: ${n1} tokens`).toBeLessThanOrEqual(
      batchBudget(100) * 1.2,
    );

    // Batch 2: 44 enrichments, details on imported steps, links, and one secret.
    const ops2: S[] = [
      ...items.slice(0, 44).map((id) => ({
        op: 'update_item',
        args: {
          id,
          expected_version: 1,
          outcome_md: 'Shoppers can pay.',
          acceptance: ['Card payments succeed'],
        },
      })),
      {
        op: 'update_step',
        args: {
          id: 'RCP-14',
          step_id: steps.a,
          state: 'todo',
          details:
            'Jira GF-10 · 3 pts\n\nMerge units across recipes.\n\nSpec Kit: specs/001-checkout/tasks.md#T004',
        },
      },
      {
        op: 'set_plan',
        args: {
          id: 'RCP-14',
          reason: 'Matched Spec Kit tasks to Jira sub-tasks',
          steps: [{ id: steps.b, details: 'Spec Kit: specs/001-checkout/tasks.md#T005' }],
        },
      },
      ...items.slice(44, 57).map((id, i) => ({
        op: 'link_items',
        args: { from: items[i]!, to: id, type: 'blocks' },
      })),
      {
        op: 'update_item',
        args: {
          id: items[59]!,
          expected_version: 1,
          description_md: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
        },
      },
    ];
    expect(ops2).toHaveLength(60);
    const r2 = expectOk(
      await h.call('apply_batch', { operations: ops2, idempotency_key: 'onboard-gf-2' }),
    );
    const res2 = r2.structured.results as Result[];
    expect(r2.structured).toMatchObject({ applied: 59, failed: 1 });
    expect(res2.slice(0, 44).every((r) => r.ok && r.version === 2)).toBe(true);
    expect(res2[44]).toMatchObject({ ok: true, op: 'update_step', id: steps.a });
    expect(res2[45]).toMatchObject({ ok: true, op: 'set_plan', id: 'RCP-14' });
    expect(res2.slice(46, 59).every((r) => r.ok && /^lnk_/.test(r.id!))).toBe(true);
    const bad = res2[59]!;
    expect(bad).toMatchObject({ ok: false, id: null, error: { code: 'validation' } });
    expect(bad.error!.message).toMatch(/secret/i);
    expect(r2.text).toContain('#60 failed update_item · validation:');
    // The failed operation wrote nothing; the others stand.
    const untouched = expectOk(await h.call('get_item', { id: items[59]!, view: 'summary' }));
    expect((untouched.structured.item as S).version).toBe(1);
    const n2 = tokens(r2.text);
    expect(n2, `apply_batch 60 operations: ${n2} tokens`).toBeLessThanOrEqual(
      batchBudget(60) * 1.2,
    );

    const total = res1.length + res2.length;
    expect(total).toBe(160);
    console.log(
      [
        '',
        '| apply_batch call | Operations | Applied | Failed | Measured (tokens) | Budget |',
        '|---|---:|---:|---:|---:|---:|',
        `| 1: epic, 60 items, 39 documents | 100 | 100 | 0 | ${n1} | ${batchBudget(100)} |`,
        `| 2: 44 enrichments, 2 imported-step details, 13 links, 1 secret | 60 | 59 | 1 | ${n2} | ${batchBudget(60)} |`,
        `| total, one session | ${total} | 159 | 1 | ${n1 + n2} | |`,
        '',
        r2.text.split('\n').slice(0, 3).join('\n'),
        '…',
        r2.text.split('\n').slice(-2).join('\n'),
      ].join('\n'),
    );
  });

  it('a retry with the same idempotency_key replays what succeeded and runs only the rest', async () => {
    h = await startHarness();
    const ops = [
      { op: 'create_item', args: { project: 'RCP', type: 'Task', title: 'First' } },
      { op: 'update_item', args: { id: 'RCP-14', expected_version: 99, outcome_md: 'x' } },
    ];
    const first = expectOk(
      await h.call('apply_batch', { operations: ops, idempotency_key: 'retry-1' }),
    );
    const [a, b] = first.structured.results as Result[];
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: false, error: { code: 'conflict' } });

    ops[1] = { op: 'update_item', args: { id: 'RCP-14', expected_version: 1, outcome_md: 'x' } };
    const again = expectOk(
      await h.call('apply_batch', { operations: ops, idempotency_key: 'retry-1' }),
    );
    const [a2, b2] = again.structured.results as Result[];
    expect(a2).toMatchObject({ ok: true, id: a!.id, replayed: true });
    expect(b2, JSON.stringify(b2)).toMatchObject({ ok: true, id: 'RCP-14', version: 2 });
    const found = expectOk(await h.call('search_items', { project: 'RCP', text: 'First' }));
    expect((found.structured.items as S[]).filter((i) => i.title === 'First')).toHaveLength(1);
  });

  it('refers only to earlier operations that succeeded; run_id belongs to the batch', async () => {
    h = await startHarness();
    const r = expectOk(
      await h.call('apply_batch', {
        operations: [
          {
            op: 'create_item',
            args: { project: 'RCP', type: 'Task', title: 'ghp_' + 'a'.repeat(36) },
          },
          { op: 'create_item', args: { project: 'RCP', type: 'Task', title: 'Child', epic: '$1' } },
          { op: 'create_item', args: { project: 'RCP', type: 'Task', title: 'Ahead', epic: '$4' } },
          { op: 'update_item', args: { id: 'RCP-14', expected_version: 7, run_id: 'run_x' } },
        ],
      }),
    );
    const res = r.structured.results as Result[];
    expect(res.map((x) => x.ok)).toEqual([false, false, false, false]);
    expect(res[1]!.error!.message).toContain('operation 1, which failed');
    expect(res[2]!.error!.message).toContain("doesn't come before this one");
    expect(res[3]!.error!.message).toContain('run_id once on apply_batch');
  });

  it('takes at most 100 operations, and only the listed tools', async () => {
    h = await startHarness();
    const op = { op: 'create_item', args: { project: 'RCP', type: 'Task', title: 'x' } };
    expectValidation(
      await h.call('apply_batch', { operations: Array.from({ length: 101 }, () => op) }),
    );
    expectValidation(
      await h.call('apply_batch', {
        operations: [{ op: 'set_status', args: { id: 'RCP-14', status: 'ready' } }],
      }),
    );
  });
});

describe('imported steps take added details (decision 34; MCP_SPEC §5.5)', () => {
  it('set or extend through update_step and set_plan; rewriting, clearing and text stay the owner’s', async () => {
    h = await startHarness();
    const steps = importSteps(h);
    const original = 'Jira GF-10 · 3 pts\n\nMerge units across recipes.';

    // Extend: the current text stays at the start.
    const extended = `${original}\n\nSpec Kit: tasks.md#T004`;
    const up = expectOk(
      await h.call('update_step', {
        id: 'RCP-14',
        step_id: steps.a,
        state: 'done',
        details: extended,
      }),
    );
    expect((up.structured.step as S).state).toBe('done');
    // Set: an imported step without details.
    expectOk(
      await h.call('set_plan', {
        id: 'RCP-14',
        reason: 'Matched Spec Kit',
        steps: [{ id: steps.b, details: 'Spec Kit: tasks.md#T005' }],
      }),
    );

    // Rewrite and clear: forbidden, with the reason.
    const rewrite = expectForbidden(
      await h.call('update_step', {
        id: 'RCP-14',
        step_id: steps.a,
        state: 'done',
        details: 'Something else',
      }),
    );
    expect(rewrite.message).toContain('imported from Jira; you may add to its details');
    expectForbidden(
      await h.call('set_plan', {
        id: 'RCP-14',
        reason: 'Clear',
        steps: [{ id: steps.a, details: null }],
      }),
    );
    // Text and source stay the owner's.
    expectForbidden(
      await h.call('set_plan', {
        id: 'RCP-14',
        reason: 'Reword',
        steps: [{ id: steps.a, text: 'Reworded' }],
      }),
    );
    // Owner-typed steps (no source) stay fully protected.
    const typed = expectForbidden(
      await h.call('update_step', {
        id: 'RCP-14',
        step_id: steps.typed,
        state: 'todo',
        details: 'Agent details',
      }),
    );
    expect(typed.message).toContain('was added by the owner');

    // The history says who added the details.
    const step = expectOk(await h.call('get_step', { id: 'RCP-14', step_id: steps.a }));
    const history = step.structured.history as { change: string; note?: string | null }[];
    expect(history.filter((e) => e.change === 'details').map((e) => e.note)).toEqual([
      'details added by claude',
    ]);
    expect(step.text).toContain('details added by claude');
    expect((step.structured.step as S).details_md).toBe(extended);
  });
});
