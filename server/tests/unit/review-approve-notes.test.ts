/**
 * Approve with notes (owner decision 35; BUILD_SPEC §5.6; FR-154–FR-157;
 * tasks.md T179–T180).
 *
 * - A note on an approval is stored on the verdict, posted as an owner note
 *   ("Approved with a note: …") that the item's agent receives on its next
 *   get_item, and shown in the packet's round and the item's Activity.
 * - `keep=epic` (the item needs an epic) and `keep=project` also publish an
 *   owner decision in that scope: the title from the note (≤ 120, cut at a
 *   word), the note as the decision, and "From your review of …" as the
 *   rationale. Agents on other tickets in scope get it through get_context.
 * - It is one transaction with the verdict: undo reverts both.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { In } from '../../src/domain/contracts.js';
import { noteTitle } from '../../src/domain/review-decisions.js';
import { OWNER_ACTOR } from '../../src/domain/write.js';
import { startDomain, type Domain } from '../us1-helpers.js';
import {
  decide,
  declare,
  hrOf,
  newTicket,
  snapshot,
  submit,
  undo,
  type Verdict,
} from '../us3-helpers.js';

let d: Domain;
beforeEach(() => {
  d = startDomain();
});
afterEach(() => d.cleanup());

const FINDING = 'Move a recipe using only the keyboard (Space, arrows, Enter).';
const NOTE = 'Fine here, but next time put the fixture in tests/fixtures/';

function handedOff(opts: Parameters<typeof newTicket>[1] = {}) {
  const t = newTicket(d, opts);
  declare(d, t, [FINDING]);
  submit(d, t);
  return { t, hr: hrOf(d, t.id)[0]! };
}

const approve = (hr: string, extra: Partial<Verdict> = {}): Verdict => ({
  hr_item_id: hr,
  kind: 'approve',
  ...extra,
});

const decisions = () =>
  d.rows<{
    id: string;
    project_key: string;
    scope_kind: string;
    scope_id: string | null;
    title: string;
    decision_md: string;
    rationale_md: string;
    authority: string;
    author: string;
    status: string;
  }>('SELECT * FROM decision_records ORDER BY created_at, id');

function getItem(id: string, actor = d.agent('codex')) {
  const r = d.read(actor);
  const { item, delivery } = d.services.items.get(r, { id } as In<'get_item'>);
  if (delivery) d.services.messages.markDelivered(r, delivery);
  return item as unknown as {
    unread_owner_notes?: { text: string }[];
    decisions?: { id: string; title: string }[];
  };
}

const screen = (id: string) => d.services.packets.screen(d.read(OWNER_ACTOR), { id });

describe('approve with a note, kept for this ticket (the default)', () => {
  it('stores the note, posts an owner note for the agent, and shows it in the round and Activity', () => {
    const { t, hr } = handedOff();
    const before = decisions().length;
    const out = decide(d, t.id, 1, [approve(hr.id, { note: `  ${NOTE}  ` })]);
    expect(out.outcome).toBe('done');

    // On the verdict and the item's last decision.
    expect(
      d.row('SELECT kind, note, result_ref FROM review_decisions WHERE hr_item_id = ?', hr.id),
    ).toEqual({ kind: 'approve', note: NOTE, result_ref: null });
    expect(JSON.parse(hrOf(d, t.id)[0]!.last_decision!)).toMatchObject({
      kind: 'approve',
      note: NOTE,
    });
    // No decision record for `item`.
    expect(decisions()).toHaveLength(before);

    // An owner note, delivered once on the agent's next get_item.
    expect(d.rows('SELECT text FROM owner_notes WHERE item_id = ?', t.id)).toEqual([
      { text: `Approved with a note: ${NOTE}` },
    ]);
    expect(getItem(t.id).unread_owner_notes?.map((n) => n.text)).toEqual([
      `Approved with a note: ${NOTE}`,
    ]);
    expect(getItem(t.id).unread_owner_notes ?? []).toEqual([]);

    // The packet's round.
    const item = screen(t.id).packet.items[0]!;
    expect(item.decision).toMatchObject({
      kind: 'approve',
      note: NOTE,
      keep: 'item',
      decision_id: null,
      result_ref: null,
    });

    // Activity: the review, then the note.
    const activity = d.services.views.itemDetail(d.read(OWNER_ACTOR), { id: t.id }).activity;
    const summaries = activity.map((a) => a.summary);
    expect(summaries).toContain(`You approved with a note: ${NOTE}`);
    expect(summaries.find((s) => s.startsWith('You reviewed round 1'))).toContain(
      '1 approved (1 with a note)',
    );
    expect(activity.some((a) => a.decision_ids)).toBe(false);
  });

  it('a plain approval stores no note and posts nothing', () => {
    const { t, hr } = handedOff();
    decide(d, t.id, 1, [approve(hr.id)]);
    expect(d.rows('SELECT id FROM owner_notes WHERE item_id = ?', t.id)).toEqual([]);
    expect(screen(t.id).packet.items[0]!.decision).toMatchObject({ note: null, keep: null });
  });
});

describe('kept for the epic', () => {
  it('publishes an owner decision on the epic; other tickets in the epic get it in get_context', () => {
    const { t, hr } = handedOff({ epic: 'RCP-1' });
    const out = decide(d, t.id, 1, [approve(hr.id, { note: NOTE, keep: 'epic' })]);

    const [rec] = decisions().filter((x) => x.rationale_md?.startsWith('From your review'));
    expect(rec).toMatchObject({
      project_key: 'RCP',
      scope_kind: 'epic',
      scope_id: 'RCP-1',
      title: NOTE,
      decision_md: NOTE,
      rationale_md: `From your review of ${t.id}, round 1: ${FINDING}`,
      authority: 'owner',
      author: 'owner',
      status: 'active',
    });
    // The verdict points at it; so does the round.
    expect(
      d.row<{ result_ref: string }>(
        'SELECT result_ref FROM review_decisions WHERE hr_item_id = ?',
        hr.id,
      ).result_ref,
    ).toBe(rec!.id);
    expect(screen(t.id).packet.items[0]!.decision).toMatchObject({
      keep: 'epic',
      decision_id: rec!.id,
      result_ref: '→ decision for the epic’s future tickets',
    });

    // The epic's Activity records it; the item's Activity links it.
    const published = d.row<{ item_id: string; summary: string; data: string }>(
      "SELECT item_id, summary, data FROM events WHERE type = 'decision.published' ORDER BY seq DESC LIMIT 1",
    );
    expect(published.item_id).toBe('RCP-1');
    expect(published.summary).toBe(`Owner recorded a decision from the review of ${t.id}: ${NOTE}`);
    expect(JSON.parse(published.data)).toMatchObject({
      decision_id: rec!.id,
      authority: 'owner',
      scope: { kind: 'epic', id: 'RCP-1' },
      from_review: { item_id: t.id, round: 1, hr_item_id: hr.id },
    });
    const activity = d.services.views.itemDetail(d.read(OWNER_ACTOR), { id: t.id }).activity;
    expect(activity.find((a) => a.type === 'review.decided')?.decision_ids).toEqual([rec!.id]);

    // The owner note still goes to this ticket's agent.
    expect(d.rows('SELECT text FROM owner_notes WHERE item_id = ?', t.id)).toEqual([
      { text: `Approved with a note: ${NOTE}` },
    ]);

    // Another ticket in the epic: get_context and get_item carry it.
    const other = newTicket(d, { epic: 'RCP-1', title: 'Shopping list from the plan' });
    const ctx = d.services.context.getContext(d.read(other.agent), {
      id: other.id,
      budget: 'medium',
    });
    expect(ctx.decisions.map((x) => x.id)).toContain(rec!.id);
    expect(getItem(other.id, other.agent).decisions?.map((x) => x.id)).toContain(rec!.id);
    // A ticket outside the epic doesn't.
    const outside = newTicket(d, { title: 'Pantry tracking' });
    const ctx2 = d.services.context.getContext(d.read(outside.agent), {
      id: outside.id,
      budget: 'medium',
    });
    expect(ctx2.decisions.map((x) => x.id)).not.toContain(rec!.id);
    expect(out.outcome).toBe('done');
  });

  it('the item has no epic: validation, and nothing is recorded', () => {
    const { t, hr } = handedOff();
    const before = snapshot(d, t.id);
    const err = d.fails(
      OWNER_ACTOR,
      (w, s) =>
        s.reviewDecisions.decide(w, {
          id: t.id,
          round: 1,
          verdicts: [approve(hr.id, { note: NOTE, keep: 'epic' })],
        } as never),
      'validation',
    );
    expect(err.message).toContain(`${t.id} has no epic`);
    expect(err.details).toMatchObject({ fields: { keep: 'the item has no epic' } });
    expect(snapshot(d, t.id)).toEqual(before);
  });

  it('a blank note with keep: validation', () => {
    const { t, hr } = handedOff({ epic: 'RCP-1' });
    d.fails(
      OWNER_ACTOR,
      (w, s) =>
        s.reviewDecisions.decide(w, {
          id: t.id,
          round: 1,
          verdicts: [approve(hr.id, { note: '   ', keep: 'project' })],
        } as never),
      'validation',
    );
  });
});

describe('kept for the project', () => {
  it('publishes a project-wide owner decision, logged on the project', () => {
    const { t, hr } = handedOff();
    decide(d, t.id, 1, [approve(hr.id, { note: NOTE, keep: 'project' })]);
    const [rec] = decisions().filter((x) => x.rationale_md?.startsWith('From your review'));
    expect(rec).toMatchObject({ scope_kind: 'project', scope_id: null, authority: 'owner' });
    const published = d.row<{ item_id: string | null; project_key: string }>(
      "SELECT item_id, project_key FROM events WHERE type = 'decision.published' ORDER BY seq DESC LIMIT 1",
    );
    expect(published).toEqual({ item_id: null, project_key: 'RCP' });
    expect(screen(t.id).packet.items[0]!.decision).toMatchObject({
      keep: 'project',
      decision_id: rec!.id,
      result_ref: '→ decision for all the project’s work',
    });
    // Any RCP ticket sees it.
    const other = newTicket(d, { title: 'Pantry tracking' });
    const ctx = d.services.context.getContext(d.read(other.agent), {
      id: other.id,
      budget: 'medium',
    });
    expect(ctx.decisions.map((x) => x.id)).toContain(rec!.id);
  });
});

describe('undo', () => {
  it('reverts the verdict, the owner note and the decision together', () => {
    const { t, hr } = handedOff({ epic: 'RCP-1' });
    const before = snapshot(d, t.id);
    const records = decisions().length;
    const out = decide(d, t.id, 1, [approve(hr.id, { note: NOTE, keep: 'epic' })]);
    expect(decisions()).toHaveLength(records + 1);
    undo(d, out.mutation_id);
    expect(decisions()).toHaveLength(records);
    const after = snapshot(d, t.id);
    // Versions move forward on undo; everything else is as it was.
    expect({ ...after, item: { ...after.item, version: 0 }, hr: [], packets: [] }).toEqual({
      ...before,
      item: { ...before.item, version: 0 },
      hr: [],
      packets: [],
    });
    expect(after.hr.map((h) => (h as { state: string }).state)).toEqual(['ready']);
    expect(after.notes).toEqual([]);
  });
});

describe('the decision title', () => {
  it('is the note on one line, up to 120 characters, cut at a word boundary', () => {
    expect(noteTitle('  Keep\n fixtures   together ')).toBe('Keep fixtures together');
    const long = `${'word '.repeat(30)}end`;
    const title = noteTitle(long);
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.endsWith('word…')).toBe(true);
    expect(noteTitle('x'.repeat(130))).toBe(`${'x'.repeat(119)}…`);
    expect(noteTitle('a'.repeat(120))).toBe('a'.repeat(120));
  });
});
