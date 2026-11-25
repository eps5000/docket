/** An owner can hand an active Epic producer to another agent mid-epic. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { undoMutation } from '../../src/domain/undo.js';
import { OWNER_ACTOR } from '../../src/domain/write.js';
import { addProject, forceStatus, startDomain, type Domain } from '../us1-helpers.js';

let d: Domain;
beforeEach(() => {
  d = startDomain({ seed: false });
  addProject(d, 'TST');
});
afterEach(() => d.cleanup());

const version = (id: string) =>
  d.row<{ version: number }>('SELECT version FROM items WHERE id = ?', id).version;

describe('Epic producer handoff', () => {
  it('ends a live Claude lead, keeps the started Epic and its work, and lets Codex claim it', () => {
    const claude = d.agent('claude', { label: 'producer' });
    const epic = d.write(claude, (w, s) =>
      s.items.create(w, {
        project: 'TST',
        type: 'Epic',
        title: 'Synthetic editor',
        priority: 2,
        status: 'planning',
      }),
    ).id;
    // A started Epic can acquire an unshaped ticket midflight. Moving it to
    // Ready during handoff would block the next producer on the start gate.
    forceStatus(d, epic, 'progress');
    const child = d.write(claude, (w, s) =>
      s.items.create(w, {
        project: 'TST',
        type: 'Implementation',
        title: 'Synthetic follow-up',
        priority: 2,
        status: 'planning',
        epic,
      }),
    ).id;
    const old = d.write(claude, (w, s) =>
      s.runs.claim(w, { id: epic, agent_label: 'producer', producer: 'claude-producer' }),
    ).run_id;
    d.fails(OWNER_ACTOR, (w, s) => s.runs.ownerRelease(w, { id: epic }), 'validation');
    expect(d.row<{ state: string }>('SELECT state FROM runs WHERE id = ?', old).state).toBe('open');

    const { result, mutation_id } = d.server.runtime.write.run(
      { actor: OWNER_ACTOR, operation: 'items.handoffEpic', args: {} },
      (w) => d.services.runs.ownerHandoffEpic(w, { id: epic, expected_version: version(epic) }),
    );
    expect(result).toMatchObject({ id: epic, status: 'progress', lead: null });
    expect(
      d.row<{ state: string; end_reason: string }>(
        'SELECT state, end_reason FROM runs WHERE id = ?',
        old,
      ),
    ).toMatchObject({ state: 'interrupted', end_reason: 'owner_released' });
    expect(d.row<{ status: string }>('SELECT status FROM items WHERE id = ?', child).status).toBe(
      'planning',
    );
    expect(
      d.row<{ producer_hold_until: string | null }>(
        'SELECT producer_hold_until FROM runs WHERE id = ?',
        old,
      ).producer_hold_until,
    ).toBeNull();
    expect(
      d.row<{ inverse: string | null }>(
        'SELECT inverse FROM events WHERE mutation_id = ? AND type = ?',
        mutation_id,
        'claim.released',
      ).inverse,
    ).toBeNull();
    expect(() => undoMutation(d.server.runtime.write, mutation_id)).toThrow(
      "This change can't be undone.",
    );

    const codex = d.agent('codex', { label: 'new-producer' });
    const next = d.write(codex, (w, s) =>
      s.runs.claim(w, { id: epic, agent_label: 'new-producer', producer: 'codex-producer' }),
    );
    expect(next.item).toMatchObject({ id: epic, status: 'progress' });
    expect(next.run_id).not.toBe(old);
    expect(
      d.row<{ client: string; producer: string }>(
        'SELECT client, producer FROM runs WHERE id = ?',
        next.run_id,
      ),
    ).toMatchObject({ client: 'codex', producer: 'codex-producer' });
  });

  it('refuses a ticket and an Epic without a current lead', () => {
    const agent = d.agent('claude');
    const epic = d.write(agent, (w, s) =>
      s.items.create(w, {
        project: 'TST',
        type: 'Epic',
        title: 'Synthetic empty Epic',
        priority: 2,
        status: 'planning',
      }),
    ).id;
    forceStatus(d, epic, 'progress');
    d.fails(OWNER_ACTOR, (w, s) => s.runs.ownerHandoffEpic(w, { id: epic }), 'conflict');
    const ticket = d.write(agent, (w, s) =>
      s.items.create(w, {
        project: 'TST',
        type: 'Implementation',
        title: 'Synthetic ticket',
        priority: 2,
        status: 'planning',
      }),
    ).id;
    d.fails(OWNER_ACTOR, (w, s) => s.runs.ownerHandoffEpic(w, { id: ticket }), 'validation');
  });
});
