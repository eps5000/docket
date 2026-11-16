/**
 * Delivery receipts (BUILD_SPEC §5.7; MCP_SPEC §3.2): owner notes and an
 * answer are returned once by get_item (standard and full views), then
 * marked read. `messages.markDelivered` is filled by US3 (B9) because the
 * fresh-packet request posts an owner note (§5.6); US6 reuses it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { In } from '../../src/domain/contracts.js';
import { startDomain, type Domain } from '../us1-helpers.js';

let d: Domain;
beforeEach(() => {
  d = startDomain();
});
afterEach(() => d.cleanup());

/** What the get_item MCP handler does (server/src/mcp/tools/read.ts). */
function getItem(args: Partial<In<'get_item'>> & { id: string }) {
  const r = d.read(d.agent('codex'));
  const { item, delivery } = d.services.items.get(r, args as In<'get_item'>);
  if (delivery) d.services.messages.markDelivered(r, delivery);
  return item;
}

function note(id: string, text: string) {
  const t = d.clock.now().toISOString();
  d.sql
    .prepare(
      'INSERT INTO owner_notes (id, item_id, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(id, 'RCP-14', text, t, t);
}

describe('owner notes', () => {
  it('are delivered once: a second get_item returns nothing new', () => {
    note('note_1', 'Please submit a fresh packet; code changed after 7d21aa3.');
    expect(getItem({ id: 'RCP-14' }).unread_owner_notes!.map((n) => n.text)).toEqual([
      'Please submit a fresh packet; code changed after 7d21aa3.',
    ]);
    expect(
      d.row<{ read_by_agent_at: string }>(
        "SELECT read_by_agent_at FROM owner_notes WHERE id = 'note_1'",
      ).read_by_agent_at,
    ).toBe(d.clock.now().toISOString());
    expect(getItem({ id: 'RCP-14' }).unread_owner_notes).toEqual([]);
  });

  it('the full view delivers too', () => {
    note('note_2', 'Use the metric units.');
    expect(getItem({ id: 'RCP-14', view: 'full' }).unread_owner_notes).toHaveLength(1);
    expect(getItem({ id: 'RCP-14', view: 'full' }).unread_owner_notes).toHaveLength(0);
  });

  it('the summary view only counts them, and delivers nothing', () => {
    note('note_3', 'Hold off until Monday.');
    expect(getItem({ id: 'RCP-14', view: 'summary' }).unread_owner_notes_count).toBe(1);
    expect(getItem({ id: 'RCP-14', view: 'summary' }).unread_owner_notes_count).toBe(1);
    expect(getItem({ id: 'RCP-14' }).unread_owner_notes).toHaveLength(1);
  });

  it('fields without unread_owner_notes deliver nothing', () => {
    note('note_4', 'Ping me when done.');
    getItem({ id: 'RCP-14', fields: ['status'] as never });
    expect(getItem({ id: 'RCP-14' }).unread_owner_notes).toHaveLength(1);
  });

  it('get_context never marks anything delivered', () => {
    note('note_5', 'Context note.');
    try {
      d.services.context.getContext(d.read(d.agent('codex')), {
        id: 'RCP-14',
      } as In<'get_context'>);
    } catch {
      // get_context is US5's; whether or not it exists yet, it must not deliver.
    }
    expect(
      d.row<{ read_by_agent_at: string | null }>(
        "SELECT read_by_agent_at FROM owner_notes WHERE id = 'note_5'",
      ).read_by_agent_at,
    ).toBeNull();
  });

  it('is not an event (a receipt)', () => {
    note('note_6', 'Quiet receipt.');
    const before = d.row<{ n: number }>('SELECT count(*) AS n FROM events').n;
    getItem({ id: 'RCP-14' });
    expect(d.row<{ n: number }>('SELECT count(*) AS n FROM events').n).toBe(before);
  });
});

describe('an answered question', () => {
  it('is delivered once, and its needs_input run goes back to open', () => {
    const t = d.clock.now().toISOString();
    const run = d.row<{ id: string }>(
      "SELECT id FROM runs WHERE item_id = 'RCP-14' AND is_lead = 1 AND state IN ('open', 'needs_input')",
    );
    d.sql.prepare("UPDATE runs SET state = 'needs_input' WHERE id = ?").run(run.id);
    d.sql
      .prepare(
        `INSERT INTO questions (id, item_id, run_id, text, asked_by, answer, answered_at, created_at, updated_at)
         VALUES ('q_1', 'RCP-14', ?, 'Per serving or per 100 g?', 'codex', 'Per serving.', ?, ?, ?)`,
      )
      .run(run.id, t, t, t);
    expect(getItem({ id: 'RCP-14' }).open_question).toMatchObject({
      id: 'q_1',
      answer: 'Per serving.',
    });
    expect(
      d.row<{ read_by_agent_at: string | null }>(
        "SELECT read_by_agent_at FROM questions WHERE id = 'q_1'",
      ).read_by_agent_at,
    ).not.toBeNull();
    expect(d.row<{ state: string }>('SELECT state FROM runs WHERE id = ?', run.id).state).toBe(
      'open',
    );
    expect(getItem({ id: 'RCP-14' }).open_question).toBeNull();
  });

  it('an unanswered question is shown but not marked read', () => {
    const t = d.clock.now().toISOString();
    d.sql
      .prepare(
        `INSERT INTO questions (id, item_id, text, asked_by, created_at, updated_at) VALUES ('q_2', 'RCP-16', 'Which units?', 'codex', ?, ?)`,
      )
      .run(t, t);
    expect(getItem({ id: 'RCP-16' }).open_question).toMatchObject({ id: 'q_2', answer: null });
    expect(getItem({ id: 'RCP-16' }).open_question).toMatchObject({ id: 'q_2' });
  });
});
