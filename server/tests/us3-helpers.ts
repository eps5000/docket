/**
 * Helpers for the US3 domain tests (tasks.md T087–T088): a fresh ticket an
 * agent leads, human review on it, a packet, and the owner's decision, all
 * through the one write path.
 */
import type { In } from '../src/domain/contracts.js';
import { OWNER_ACTOR, type Actor } from '../src/domain/write.js';
import type { Domain } from './us1-helpers.js';

export interface Ticket {
  id: string;
  agent: Actor;
  run_id: string;
}

/** A new item in RCP, claimed by `client`. */
export function newTicket(
  d: Domain,
  opts: {
    client?: string;
    type?: 'Task' | 'Story' | 'Bug' | 'Epic';
    epic?: string;
    priority?: 1 | 2 | 3;
    title?: string;
  } = {},
): Ticket {
  const client = opts.client ?? 'codex';
  const plain = d.agent(client);
  const item = d.write(plain, (w, s) =>
    s.items.create(w, {
      project: 'RCP',
      type: opts.type ?? 'Task',
      title: opts.title ?? 'Drag recipes between days',
      status: 'planning',
      priority: opts.priority ?? 2,
      ...(opts.epic ? { epic: opts.epic } : {}),
    } as In<'create_item'>),
  );
  d.write(plain, (w, s) =>
    s.items.setStatus(w, { id: item.id, status: 'ready' } as In<'set_status'>),
  );
  const { run_id } = d.write(plain, (w, s) => s.runs.claim(w, { id: item.id } as In<'claim_lead'>));
  return { id: item.id, agent: d.agent(client, { run_id }), run_id };
}

export function declare(d: Domain, t: Ticket, items: string[]) {
  return d.write(t.agent, (w, s) => s.humanReview.declare(w, { id: t.id, items }));
}

export type PacketArgs = Partial<Omit<In<'submit_packet'>, 'id'>>;

export function packetArgs(id: string, args: PacketArgs = {}): In<'submit_packet'> {
  return {
    id,
    built_from_commit: '7d21aa3',
    estimate: '10 min',
    how: ['Open the preview build at http://127.0.0.1:5173.'],
    checked: [
      { text: '214 unit and integration tests pass', provenance: 'ci', evidence: 'CI #88' },
    ],
    ...args,
  } as In<'submit_packet'>;
}

export function submit(d: Domain, t: Ticket, args: PacketArgs = {}) {
  return d.write(t.agent, (w, s) => s.packets.submit(w, packetArgs(t.id, args)));
}

export function commit(d: Domain, t: Ticket | { id: string; agent: Actor }, sha: string) {
  return d.write(t.agent, (w, s) =>
    s.evidence.reportCommit(w, { id: t.id, sha, pushed: false } as In<'report_commit'>),
  );
}

export type Verdict = {
  hr_item_id: string;
  kind: 'approve' | 'changes' | 'defer';
  note?: string;
  into?: 'checklist' | 'bug';
  follow?: 'ticket' | 'none';
  /** Approve with a note only (owner decision 35). */
  keep?: 'item' | 'epic' | 'project';
};

/** The owner's decision, as the API sends it; returns the result and its mutation ID. */
export function decide(d: Domain, id: string, round: number, verdicts: Verdict[]) {
  const out = d.server.runtime.write.run(
    { actor: OWNER_ACTOR, operation: 'review.decide', args: { id, round, verdicts } },
    (w) => d.services.reviewDecisions.decide(w, { id, round, verdicts }),
  );
  return { ...out.result, mutation_id: out.mutation_id };
}

export function undo(d: Domain, mutationId: string) {
  return d.server.runtime.write.run(
    { actor: OWNER_ACTOR, operation: 'undo', args: { mutation_id: mutationId } },
    (w) => d.services.undo.undo(w, { mutation_id: mutationId }),
  ).result;
}

export function owner<T>(
  d: Domain,
  fn: Parameters<Domain['write']>[1],
): T & { mutation_id: string } {
  const out = d.server.runtime.write.run(
    { actor: OWNER_ACTOR, operation: 'test', args: {} },
    (w) => fn(w, d.services) as T,
  );
  return Object.assign(typeof out.result === 'object' && out.result !== null ? out.result : {}, {
    mutation_id: out.mutation_id,
  }) as T & { mutation_id: string };
}

export const hrOf = (d: Domain, id: string) =>
  d.rows<{
    id: string;
    text: string;
    state: string;
    added_by: string;
    last_decision: string | null;
    follow_up_item_id: string | null;
    version: number;
  }>('SELECT * FROM hr_items WHERE item_id = ? ORDER BY position, id', id);

export const statusOf = (d: Domain, id: string) =>
  d.row<{ status: string; closed_by: string | null }>(
    'SELECT status, closed_by FROM items WHERE id = ?',
    id,
  );

/** Everything a decision can touch, for comparing before and after an undo. */
export function snapshot(d: Domain, id: string) {
  return {
    item: d.row('SELECT status, closed_by, closed_at, version FROM items WHERE id = ?', id),
    hr: d.rows(
      'SELECT id, state, last_decision, follow_up_item_id, version FROM hr_items WHERE item_id = ? ORDER BY id',
      id,
    ),
    packets: d.rows('SELECT id, state, version FROM packets WHERE item_id = ? ORDER BY round', id),
    decisions: d.rows(
      'SELECT rd.id FROM review_decisions rd JOIN packets p ON p.id = rd.packet_id WHERE p.item_id = ?',
      id,
    ),
    steps: d.rows('SELECT id, text FROM work_steps WHERE item_id = ? ORDER BY id', id),
    links: d.rows('SELECT id FROM links WHERE from_id = ? OR to_id = ? ORDER BY id', id, id),
    items: d.row<{ n: number }>('SELECT count(*) AS n FROM items').n,
    notes: d.rows('SELECT id FROM owner_notes WHERE item_id = ?', id),
  };
}
