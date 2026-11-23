/**
 * Split and withdraw over real MCP clients (owner decision 48; MCP_SPEC §5.3,
 * §5.8): no new tool, a text-only client can do both, and the old
 * `withdraw_decision` call still works. All content is synthetic.
 */
import { TOOL_NAMES } from '@docket/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { askForm } from '../helpers.js';
import {
  PRODUCT_RESULT_MODES,
  expectConflict,
  expectForbidden,
  expectOk,
  expectValidation,
  startHarness,
  textOf,
  type ContractHarness,
} from './harness.js';

let h: ContractHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const RUN_ID = /\brun_(?!id\b)[0-9A-Za-z]+/;
const QUESTION_ID = /\bq_[0-9A-Za-z]+/;
const NEW_ITEM = /Created (RCP-\d+)/;

/** A text-only client gets no structured result, so success is read from the text block. */
function okText(result: Awaited<ReturnType<ContractHarness['call']>>): string {
  const text = textOf(result);
  expect(result.isError ?? false, text).toBe(false);
  return text;
}

async function ticket(harness: ContractHarness) {
  const made = okText(
    await harness.call('create_item', {
      project: 'RCP',
      type: 'Task',
      title: 'A ticket to split',
      acceptance: ['Loads the week', 'Keeps the scroll', 'Saves the filter'],
      status: 'planning',
    }),
  );
  return NEW_ITEM.exec(made)![1]!;
}

const versionOf = async (harness: ContractHarness, id: string) => {
  const text = textOf(await harness.call('get_item', { id, view: 'summary' }));
  return Number(/\bv(\d+)\b/.exec(text)![1]);
};

describe('no new tool (decision 48)', () => {
  it('is still 51 tools', () => {
    expect(TOOL_NAMES).toHaveLength(51);
  });
});

describe('create_item with split_from', () => {
  it('a text-only client splits a ticket and reads both sides', async () => {
    h = await startHarness({ env: PRODUCT_RESULT_MODES });
    const id = await ticket(h);
    const res = okText(
      await h.call('create_item', {
        project: 'RCP',
        type: 'Task',
        title: 'The part that can start now',
        split_from: {
          id,
          expected_version: await versionOf(h, id),
          move: [2],
          relation: 'after_original',
        },
      }),
    );
    const newId = NEW_ITEM.exec(res)![1]!;
    const original = textOf(await h.call('get_item', { id }));
    expect(original).toContain(`split into: ${newId}`);
    expect(original).not.toContain('- Keeps the scroll');
    const created = textOf(await h.call('get_item', { id: newId }));
    expect(created).toContain(`split from: ${id}`);
    expect(created).toContain('- Keeps the scroll');
  });

  it('a stale version is a conflict, and fields that clash with a split are refused', async () => {
    h = await startHarness();
    const id = await ticket(h);
    const version = await versionOf(h, id);
    const base = { project: 'RCP', type: 'Task', title: 'New part' };
    const from = { id, expected_version: version, move: [1], relation: 'none' };
    expectConflict(
      await h.call('create_item', { ...base, split_from: { ...from, expected_version: 99 } }),
    );
    expectValidation(
      await h.call('create_item', { ...base, labels: ['regression'], split_from: from }),
    );
    expectValidation(
      await h.call('create_item', { ...base, blocked_by: ['RCP-24'], split_from: from }),
    );
    expectValidation(await h.call('create_item', { ...base, acceptance: ['x'], split_from: from }));
    expectValidation(await h.call('create_item', { ...base, type: 'Epic', split_from: from }));
    expectValidation(
      await h.call('create_item', { ...base, split_from: { ...from, relation: 'sideways' } }),
    );
  });

  it('another agent cannot split a claimed ticket', async () => {
    h = await startHarness();
    const claim = await h.call('claim_lead', { id: 'RCP-17', agent_label: 'orca-w3' });
    expect(claim.isError ?? false, textOf(claim)).toBe(false);
    const version = await versionOf(h, 'RCP-17');
    await h.call('update_item', {
      id: 'RCP-17',
      expected_version: version,
      acceptance: ['One', 'Two'],
      run_id: RUN_ID.exec(textOf(claim))![0],
    });
    expectForbidden(
      await h.call(
        'create_item',
        {
          project: 'RCP',
          type: 'Bug',
          title: 'Not mine to split',
          split_from: {
            id: 'RCP-17',
            expected_version: await versionOf(h, 'RCP-17'),
            move: [1],
            relation: 'none',
          },
        },
        h.b,
      ),
    );
  });
});

describe('withdraw_decision with question_id', () => {
  it('withdraw, then ask again, from a text-only client', async () => {
    h = await startHarness({ env: PRODUCT_RESULT_MODES });
    const claim = await h.call('claim_lead', { id: 'RCP-17', agent_label: 'orca-w3' });
    const run_id = RUN_ID.exec(textOf(claim))![0];
    const asked = await h.call('ask_owner', {
      id: 'RCP-17',
      run_id,
      ...askForm('Should the planner remember the week?'),
    });
    const question_id = QUESTION_ID.exec(textOf(asked))![0];

    const blocked = await h.call('ask_owner', {
      id: 'RCP-17',
      run_id,
      ...askForm('Should it open on today instead?'),
    });
    expect(blocked.isError).toBe(true);
    expect(textOf(blocked)).toContain('withdraw_decision');

    const gone = okText(
      await h.call('withdraw_decision', {
        question_id,
        run_id,
        reason: 'The design changed, so this no longer matters.',
      }),
    );
    expect(gone).toContain(`Withdrew ${question_id}`);
    expect(textOf(await h.call('get_item', { id: 'RCP-17', run_id }))).toContain('question: none');
    okText(
      await h.call('ask_owner', {
        id: 'RCP-17',
        run_id,
        ...askForm('Should it open on today instead?'),
      }),
    );
  });

  it('takes exactly one of decision_id and question_id', async () => {
    h = await startHarness();
    expectValidation(await h.call('withdraw_decision', { reason: 'No longer applies.' }));
    expectValidation(
      await h.call('withdraw_decision', {
        decision_id: 'dec_1',
        question_id: 'q_1',
        reason: 'No longer applies.',
      }),
    );
    expectValidation(
      await h.call('withdraw_decision', {
        decision_id: 'dec_1',
        coordinator: 'orca',
        reason: 'No longer applies.',
      }),
    );
  });

  it('still withdraws a decision', async () => {
    h = await startHarness();
    const published = await h.call('publish_decision', {
      project: 'RCP',
      scope: { kind: 'project' },
      title: 'Weeks start on Monday',
      decision: 'Every planner view starts its week on Monday.',
    });
    const decision_id = /\bdec_[0-9A-Za-z]+/.exec(textOf(published))![0];
    const res = expectOk(
      await h.call('withdraw_decision', { decision_id, reason: 'No longer applies.' }),
    );
    expect(res.text).toContain(`Withdrew ${decision_id}`);
  });
});
