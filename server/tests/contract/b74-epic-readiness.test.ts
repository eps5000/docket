/**
 * An epic starts only when its tickets are ready (owner decision 58) over real
 * MCP clients: `epic_not_ready` on claim_lead, known gaps proposed with
 * update_item and set_status (the refusal asks the owner through the question
 * form), and what the implementer and the producer read, inside their budgets.
 */
import { DIGEST_MAX_CHARS, GAP_APPROVE_OPTION } from '@docket/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OWNER_ACTOR } from '../../src/domain/write.js';
import {
  expectOk,
  expectToolError,
  startHarness,
  textOf,
  tokens,
  type ContractHarness,
} from './harness.js';

let h: ContractHarness;
const GAPS = ['Which retry limit to use', 'Wording of the empty state'];

const sql = () => h.server.runtime.db.sqlite;
const create = async (type: string, extra: Record<string, unknown> = {}) => {
  const out = expectOk(
    await h.call('create_item', {
      project: 'RCP',
      type,
      title: `Synthetic ${type.toLowerCase()}`,
      status: 'planning',
      ...extra,
    }),
  ).structured;
  return (out.item as { id: string }).id;
};
const version = (id: string) =>
  (sql().prepare('SELECT version FROM items WHERE id = ?').get(id) as { version: number }).version;
const owner = <T>(fn: Parameters<ContractHarness['server']['runtime']['write']['run']>[1]) =>
  h.server.runtime.write.run({ actor: OWNER_ACTOR, operation: 'test', args: {} }, fn) as T;

beforeEach(async () => {
  h = await startHarness();
});
afterEach(() => h.close());

describe('the epic start check over MCP (decision 58)', () => {
  it('claim_lead on a Ready epic with an Inbox ticket is epic_not_ready, listing it and the ways forward', async () => {
    const epic = await create('Epic');
    const ticket = await create('Task', { epic, status: 'inbox' });
    const release = (
      sql().prepare("SELECT id FROM items WHERE epic_id = ? AND type = 'Release'").get(epic) as {
        id: string;
      }
    ).id;
    sql().prepare("UPDATE items SET status = 'ready' WHERE id = ?").run(epic);
    const err = expectToolError(await h.call('claim_lead', { id: epic }), 'epic_not_ready');
    expect(err.message).toContain(`${ticket} (Inbox)`);
    expect(err.details).toMatchObject({
      epic,
      unshaped: [
        { id: release, status: 'inbox' },
        { id: ticket, status: 'inbox' },
      ],
      ways_forward: ['shape', 'known_gaps', 'move', 'remove'],
    });
  });

  it('resuming the seeded In progress epic works although it has unshaped tickets', async () => {
    expectOk(await h.call('claim_lead', { id: 'RCP-1', agent_label: 'producer' }));
  });

  it('get_digest flags the started epic for the producer, inside the digest cap', async () => {
    const text = textOf(await h.call('get_digest', { project: 'RCP' }));
    expect(text).toMatch(
      /started unshaped 1:\n- RCP-1 started with 4 unshaped: RCP-23, RCP-24, RCP-27 \+1 more/,
    );
    expect(text.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
  });
});

describe('known gaps over MCP (decision 58)', () => {
  it('set_status ready with open gaps asks the owner once; approval moves it; the implementer reads them', async () => {
    const id = await create('Task');
    expectOk(await h.call('declare_shared_changes', { id, none: true }));
    expectOk(
      await h.call('update_item', {
        id,
        expected_version: version(id),
        known_gaps: GAPS.map((gap) => ({ gap })),
      }),
    );
    const err = expectToolError(await h.call('set_status', { id, status: 'ready' }), 'forbidden');
    expect(err.message).toContain(`Approve moving ${id} to Ready with these gaps?`);
    const item = textOf(await h.call('get_item', { id }));
    expect(item).toContain(`question: `);
    expect(item).toContain(`Approve moving ${id} to Ready with these gaps?`);
    expect(item).toContain('known gaps (2 open · not approved)');

    const q = sql()
      .prepare('SELECT id FROM questions WHERE item_id = ? AND answered_at IS NULL')
      .get(id) as { id: string };
    owner((w) =>
      h.server.runtime.services.messages.answer(w, {
        id,
        question_id: q.id,
        option: GAP_APPROVE_OPTION,
      }),
    );
    const status = sql().prepare('SELECT status FROM items WHERE id = ?').get(id) as {
      status: string;
    };
    expect(status.status).toBe('ready');

    expectOk(await h.call('claim_lead', { id, agent_label: 'worker' }));
    const context = textOf(await h.call('get_context', { id, budget: 'small' }));
    expect(context).toContain('known gaps to shape (2 open · approved by the owner dec_');
    expect(tokens(context)).toBeLessThanOrEqual(1_000);
  });
});
