/**
 * Human review, packets and the owner's decision (BUILD_SPEC §5.5–§5.6;
 * FR-019, FR-020, FR-050, FR-051; tasks.md T087).
 *
 * - The human review item rules: authors edit their own declared items;
 *   agents get forbidden on owner-added ones; `ready` items are locked.
 * - The `submit_packet` guards: blocked, a packet already open, nothing
 *   declared, a failing check without a gap; and what a round stores.
 * - The decision outcomes: approve all; any changes (a checklist step or a
 *   Bug); defer with or without a follow-up; mixed; approvals carry forward
 *   to the next round; the Done gate; one atomic decision with an undo that
 *   restores everything.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { In } from '../../src/domain/contracts.js';
import { OWNER_ACTOR } from '../../src/domain/write.js';
import { startDomain, type Domain } from '../us1-helpers.js';
import {
  commit,
  decide,
  declare,
  hrOf,
  newTicket,
  owner,
  packetArgs,
  snapshot,
  statusOf,
  submit,
  undo,
  type Ticket,
} from '../us3-helpers.js';

let d: Domain;
beforeEach(() => {
  d = startDomain();
});
afterEach(() => d.cleanup());

const TWO = [
  'On your phone, drag recipes between days and meal slots. Does it feel right?',
  'Move a recipe using only the keyboard (Space, arrows, Enter).',
];

function handedOff(texts = TWO, opts: Parameters<typeof newTicket>[1] = {}) {
  const t = newTicket(d, opts);
  declare(d, t, texts);
  const out = submit(d, t);
  return { t, packet: out, hr: hrOf(d, t.id) };
}

// ---- Human review items (§5.5) ----

describe('human review items', () => {
  it('an agent declares items; they are declared, by that client, in order', () => {
    const t = newTicket(d);
    const list = declare(d, t, TWO);
    expect(list.map((h) => [h.text, h.state, h.added_by, h.added_by_client, h.locked])).toEqual([
      [TWO[0], 'declared', 'agent', 'codex', false],
      [TWO[1], 'declared', 'agent', 'codex', false],
    ]);
    expect(list.every((h) => /^hr_/.test(h.id))).toBe(true);
  });

  it('the author edits and removes its own declared item', () => {
    const t = newTicket(d);
    const [a, b] = declare(d, t, TWO);
    const edited = d.write(t.agent, (w, s) =>
      s.humanReview.update(w, {
        id: t.id,
        hr_item_id: a!.id,
        expected_version: 1,
        text: 'Drag on a phone.',
      }),
    );
    expect(edited.find((h) => h.id === a!.id)!.text).toBe('Drag on a phone.');
    const after = d.write(t.agent, (w, s) =>
      s.humanReview.update(w, { id: t.id, hr_item_id: b!.id, expected_version: 1, remove: true }),
    );
    expect(after.map((h) => h.id)).toEqual([a!.id]);
  });

  it('a stale expected_version is conflict', () => {
    const t = newTicket(d);
    const [a] = declare(d, t, TWO);
    d.fails(
      t.agent,
      (w, s) =>
        s.humanReview.update(w, { id: t.id, hr_item_id: a!.id, expected_version: 9, text: 'x' }),
      'conflict',
    );
  });

  it('agents get forbidden on owner-added items; the owner may change agent-added ones', () => {
    const t = newTicket(d);
    const [agentItem] = declare(d, t, [TWO[0]!]);
    const ownerItem = owner<{ id: string }>(d, (w, s) =>
      s.humanReview.ownerAdd(w, { id: t.id, text: 'Try it on your phone' }),
    );
    const err = d.fails(
      t.agent,
      (w, s) =>
        s.humanReview.update(w, {
          id: t.id,
          hr_item_id: ownerItem.id,
          expected_version: 1,
          text: 'x',
        }),
      'forbidden',
    );
    expect(err.message).toContain('only the owner can change it');
    owner(d, (w, s) =>
      s.humanReview.ownerUpdate(w, {
        id: t.id,
        hrId: agentItem!.id,
        expected_version: 1,
        text: 'Owner wording',
      }),
    );
    expect(hrOf(d, t.id)[0]!.text).toBe('Owner wording');
  });

  it("another agent can't change an item it didn't declare", () => {
    const t = newTicket(d);
    const [a] = declare(d, t, [TWO[0]!]);
    d.fails(
      d.agent('claude'),
      (w, s) =>
        s.humanReview.update(w, { id: t.id, hr_item_id: a!.id, expected_version: 1, text: 'x' }),
      'forbidden',
    );
  });

  it('items in the open packet are locked for agents and the owner; new ones wait for the next round', () => {
    const { t, hr } = handedOff();
    expect(hr.every((h) => h.state === 'ready')).toBe(true);
    const err = d.fails(
      t.agent,
      (w, s) =>
        s.humanReview.update(w, {
          id: t.id,
          hr_item_id: hr[0]!.id,
          expected_version: hr[0]!.version,
          text: 'x',
        }),
      'forbidden',
    );
    expect(err.message).toContain('locked');
    d.fails(
      OWNER_ACTOR,
      (w, s) => s.humanReview.ownerRemove(w, { id: t.id, hrId: hr[1]!.id }),
      'forbidden',
    );
    const list = declare(d, t, ['Check the empty week state.']);
    expect(list.at(-1)!.state).toBe('declared');
  });

  it('an item that was in an earlier round can be edited but not removed (its round stays readable)', () => {
    const { t, hr } = handedOff();
    decide(d, t.id, 1, [
      { hr_item_id: hr[0]!.id, kind: 'changes', note: 'Too small', into: 'checklist' },
      { hr_item_id: hr[1]!.id, kind: 'approve' },
    ]);
    const h = hrOf(d, t.id)[0]!;
    d.fails(
      t.agent,
      (w, s) =>
        s.humanReview.update(w, {
          id: t.id,
          hr_item_id: h.id,
          expected_version: h.version,
          remove: true,
        }),
      'validation',
    );
    d.write(t.agent, (w, s) =>
      s.humanReview.update(w, {
        id: t.id,
        hr_item_id: h.id,
        expected_version: h.version,
        text: 'Drag with bigger targets.',
      }),
    );
  });

  it('declaring the text of a deferred item re-declares it instead of adding a duplicate', () => {
    const { t, hr } = handedOff([TWO[0]!]);
    decide(d, t.id, 1, [
      { hr_item_id: hr[0]!.id, kind: 'defer', note: 'No phone handy', follow: 'none' },
    ]);
    expect(statusOf(d, t.id).status).toBe('done');
    const t2 = { ...t, agent: d.agent('codex') };
    d.write(t2.agent, (w, s) =>
      s.items.setStatus(w, {
        id: t.id,
        status: 'progress',
        reason: 'Recheck on a phone',
      } as In<'set_status'>),
    );
    const list = d.write(t2.agent, (w, s) =>
      s.humanReview.declare(w, { id: t.id, items: [TWO[0]!] }),
    );
    expect(list).toHaveLength(1);
    expect(list[0]!).toMatchObject({ id: hr[0]!.id, state: 'declared' });
    expect(list[0]!.last_decision?.kind).toBe('defer');
  });

  it('declaring on a closed item is refused', () => {
    d.fails(
      d.agent('codex'),
      (w, s) => s.humanReview.declare(w, { id: 'RCP-11', items: ['x'] }),
      'validation',
    );
  });
});

// ---- submit_packet guards (FR-020) ----

describe('submit_packet guards', () => {
  it('nothing declared: validation, close with set_status instead', () => {
    const t = newTicket(d);
    const err = d.fails(t.agent, (w, s) => s.packets.submit(w, packetArgs(t.id)), 'validation');
    expect(err.message).toContain('set_status');
    expect(err.details).toMatchObject({ reason: 'nothing_declared' });
  });

  it('a packet already open: validation', () => {
    const { t } = handedOff();
    const err = d.fails(t.agent, (w, s) => s.packets.submit(w, packetArgs(t.id)), 'validation');
    expect(err.message).toContain('already open');
    expect(err.details).toMatchObject({ reason: 'packet_open', round: 1 });
  });

  it('blocked: validation naming the blockers', () => {
    const t = newTicket(d);
    declare(d, t, TWO);
    d.sql
      .prepare(
        `INSERT INTO links (id, from_id, to_id, type, created_by, created_at, updated_at) VALUES ('lnk_t', 'RCP-24', ?, 'blocks', 'owner', '2026-11-06T00:00:00Z', '2026-11-06T00:00:00Z')`,
      )
      .run(t.id);
    const err = d.fails(t.agent, (w, s) => s.packets.submit(w, packetArgs(t.id)), 'validation');
    expect(err.message).toContain('blocked by RCP-24');
    expect(err.details).toMatchObject({ reason: 'blocked', blocked_by: ['RCP-24'] });
  });

  it('a failing check without a gap: validation; a gap naming it (id or text) lets it through', () => {
    const t = newTicket(d);
    declare(d, t, TWO);
    const { checks } = d.write(t.agent, (w, s) =>
      s.checklist.setChecks(w, {
        id: t.id,
        mode: 'patch',
        checks: [{ text: 'Android drag works' }],
      } as In<'set_checks'>),
    );
    d.write(t.agent, (w, s) =>
      s.checklist.updateCheck(w, {
        id: t.id,
        check_id: checks[0]!.id,
        state: 'fail',
        evidence: 'no device',
      } as In<'update_check'>),
    );
    const err = d.fails(
      t.agent,
      (w, s) => s.packets.submit(w, packetArgs(t.id, { gaps: ['Not tested on iOS.'] })),
      'validation',
    );
    expect(err.message).toContain(checks[0]!.id);
    expect(err.details).toMatchObject({ reason: 'failing_check' });
    expect(submit(d, t, { gaps: ['Android drag works: no device to test on.'] }).round).toBe(1);
  });

  it('a gap may name the failing check by id', () => {
    const t = newTicket(d);
    declare(d, t, TWO);
    const { checks } = d.write(t.agent, (w, s) =>
      s.checklist.setChecks(w, {
        id: t.id,
        mode: 'patch',
        checks: [{ text: 'E2E on CI' }],
      } as In<'set_checks'>),
    );
    d.write(t.agent, (w, s) =>
      s.checklist.updateCheck(w, {
        id: t.id,
        check_id: checks[0]!.id,
        state: 'fail',
        evidence: 'flaky',
      } as In<'update_check'>),
    );
    expect(
      submit(d, t, { gaps: [`${checks[0]!.id} fails on CI only (a known flake).`] }).round,
    ).toBe(1);
  });

  it('only from In progress', () => {
    const plain = d.agent('codex');
    const err = d.fails(plain, (w, s) => s.packets.submit(w, packetArgs('RCP-23')), 'validation');
    expect(err.details).toMatchObject({ reason: 'status' });
  });

  it('hr_item_ids picks a subset of declared items; a decided one is refused', () => {
    const t = newTicket(d);
    const [a, b] = declare(d, t, TWO);
    const out = submit(d, t, { hr_item_ids: [b!.id] });
    expect(out.round).toBe(1);
    expect(hrOf(d, t.id).map((h) => h.state)).toEqual(['declared', 'ready']);
    expect(a).toBeDefined();
  });

  it('an attachment from another item is refused; an unknown one is not_found', () => {
    const t = newTicket(d);
    declare(d, t, TWO);
    const other = d.row<{ id: string }>(
      "SELECT v.id FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE d.item_id = 'RCP-12' LIMIT 1",
    );
    d.fails(
      t.agent,
      (w, s) =>
        s.packets.submit(w, packetArgs(t.id, { attachments: [{ document_version_id: other.id }] })),
      'validation',
    );
    d.fails(
      t.agent,
      (w, s) =>
        s.packets.submit(
          w,
          packetArgs(t.id, { attachments: [{ document_version_id: 'dv_nope' }] }),
        ),
      'not_found',
    );
  });
});

describe('a submitted round', () => {
  it('moves the item to Review, sets its items ready, snapshots their text and hashes the packet', () => {
    const { t, packet, hr } = handedOff();
    expect(packet.round).toBe(1);
    expect(packet.display_id).toMatch(/^pkt-[0-9a-f]{4}$/);
    expect(packet.item.status).toBe('review');
    expect(packet.item.human_review).toMatchObject({ ready: 2, declared: 0 });
    const row = d.row<{
      content_hash: string;
      built_from_commit: string;
      created_by: string;
      how: string;
      checked: string;
    }>('SELECT * FROM packets WHERE id = ?', packet.packet_id);
    expect(row.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(packet.display_id).toBe(`pkt-${row.content_hash.slice(0, 4)}`);
    expect(row.built_from_commit).toBe('7d21aa3');
    expect(row.created_by).toBe('codex');
    expect(JSON.parse(row.checked)).toEqual([
      { text: '214 unit and integration tests pass', provenance: 'ci', evidence: 'CI #88' },
    ]);
    const snaps = d.rows<{ text_snapshot: string }>(
      'SELECT text_snapshot FROM packet_items WHERE packet_id = ? ORDER BY id',
      packet.packet_id,
    );
    expect(snaps.map((s) => s.text_snapshot).sort()).toEqual([...TWO].sort());
    expect(hr.every((h) => h.state === 'ready')).toBe(true);
    // The run goes on: submitting doesn't end it.
    expect(d.row<{ state: string }>('SELECT state FROM runs WHERE id = ?', t.run_id).state).toBe(
      'open',
    );
  });

  it('records the commit it was built from when it was not reported yet, and not twice', () => {
    const { t } = handedOff();
    expect(d.rows('SELECT sha FROM commits WHERE item_id = ?', t.id)).toEqual([{ sha: '7d21aa3' }]);
    const t2 = newTicket(d);
    declare(d, t2, TWO);
    commit(d, t2, '7d21aa3c0ffee');
    submit(d, t2, { built_from_commit: '7d21aa3' });
    expect(d.rows('SELECT sha FROM commits WHERE item_id = ?', t2.id)).toEqual([
      { sha: '7d21aa3c0ffee' },
    ]);
  });

  it('the same packet content hashes the same; another estimate hashes differently', () => {
    const a = handedOff(TWO, { title: 'A' });
    const b = handedOff(TWO, { title: 'A' });
    const hash = (id: string) =>
      d.row<{ content_hash: string }>('SELECT content_hash FROM packets WHERE id = ?', id)
        .content_hash;
    expect(hash(a.packet.packet_id)).not.toBe(hash(b.packet.packet_id)); // the item ID is part of it
    expect(a.packet.display_id).toMatch(/^pkt-/);
  });

  it('records packet.submitted (for you) and the move to review', () => {
    const { t } = handedOff();
    const types = d
      .rows<{ type: string }>(
        'SELECT type FROM events WHERE item_id = ? ORDER BY seq DESC LIMIT 2',
        t.id,
      )
      .map((e) => e.type);
    expect(types).toEqual(['item.status_changed', 'packet.submitted']);
  });
});

// ---- The owner's decision (FR-050, FR-051) ----

describe('decision outcomes', () => {
  it('approve all: Done, closed by the owner, items approved, dependents unblocked', () => {
    const { t, hr } = handedOff();
    const dep = d.write(d.agent('claude'), (w, s) =>
      s.items.create(w, {
        project: 'RCP',
        type: 'Task',
        title: 'Waits on the planner',
        priority: 2,
        blocked_by: [t.id],
      } as In<'create_item'>),
    );
    const out = decide(
      d,
      t.id,
      1,
      hr.map((h) => ({ hr_item_id: h.id, kind: 'approve' as const })),
    );
    expect(out.outcome).toBe('done');
    expect(out.unblocked).toEqual([dep.id]);
    expect(statusOf(d, t.id)).toEqual({ status: 'done', closed_by: 'owner' });
    expect(hrOf(d, t.id).map((h) => h.state)).toEqual(['approved', 'approved']);
    expect(JSON.parse(hrOf(d, t.id)[0]!.last_decision!)).toMatchObject({
      kind: 'approve',
      round: 1,
      note: null,
    });
    expect(
      d.row<{ state: string }>('SELECT state FROM packets WHERE item_id = ?', t.id).state,
    ).toBe('decided');
    // The open lead run ends as finished.
    expect(d.row<{ state: string }>('SELECT state FROM runs WHERE id = ?', t.run_id).state).toBe(
      'finished',
    );
  });

  it('changes into the checklist: a work step from your review; the item goes back to In progress', () => {
    const { t, hr } = handedOff();
    const out = decide(d, t.id, 1, [
      {
        hr_item_id: hr[0]!.id,
        kind: 'changes',
        note: 'Drop targets are too small on my phone.',
        into: 'checklist',
      },
      { hr_item_id: hr[1]!.id, kind: 'approve' },
    ]);
    expect(out.outcome).toBe('progress');
    expect(out.created).toEqual([]);
    const step = d.row<{
      id: string;
      text: string;
      added_by: string;
      from_review: string;
      state: string;
    }>('SELECT * FROM work_steps WHERE item_id = ?', t.id);
    expect(step).toMatchObject({
      text: 'Drop targets are too small on my phone.',
      added_by: 'owner',
      state: 'todo',
    });
    expect(JSON.parse(step.from_review)).toEqual({
      item_id: t.id,
      round: 1,
      hr_item_id: hr[0]!.id,
    });
    const [h0, h1] = hrOf(d, t.id);
    expect(h0!.state).toBe('declared');
    expect(JSON.parse(h0!.last_decision!)).toMatchObject({
      kind: 'changes',
      note: 'Drop targets are too small on my phone.',
      result_ref: step.id,
    });
    expect(h1!.state).toBe('approved');
    expect(statusOf(d, t.id).status).toBe('progress');
    // An agent's next plan keeps the step from review.
    const item = d.services.items.get(d.read(), { id: t.id } as In<'get_item'>).item;
    expect(item.checklist!.work[0]!.from_review).toEqual({ round: 1, hr_item_id: hr[0]!.id });
  });

  it('changes into a bug: a Bug in Ready with the parent project, epic and priority, a 70-character title and a relates link', () => {
    const { t, hr } = handedOff(TWO, { epic: 'RCP-1', priority: 1 });
    const note =
      'Keyboard works, but after a reload the planner jumps back to the current week, every single time.';
    const out = decide(d, t.id, 1, [
      { hr_item_id: hr[0]!.id, kind: 'approve' },
      { hr_item_id: hr[1]!.id, kind: 'changes', note, into: 'bug' },
    ]);
    expect(out.created).toHaveLength(1);
    const bugId = out.created[0]!.id;
    expect(out.created[0]!.kind).toBe('bug');
    const bug = d.row<{
      type: string;
      status: string;
      project_key: string;
      epic_id: string;
      priority: number;
      title: string;
      from_review: string;
    }>('SELECT * FROM items WHERE id = ?', bugId);
    expect(bug).toMatchObject({
      type: 'Bug',
      status: 'ready',
      project_key: 'RCP',
      epic_id: 'RCP-1',
      priority: 1,
    });
    expect(bug.title.length).toBe(70);
    expect(bug.title.endsWith('…')).toBe(true);
    expect(note.startsWith(bug.title.slice(0, -1))).toBe(true);
    expect(JSON.parse(bug.from_review)).toEqual({ item_id: t.id, round: 1, hr_item_id: hr[1]!.id });
    expect(d.rows('SELECT type FROM links WHERE from_id = ? AND to_id = ?', t.id, bugId)).toEqual([
      { type: 'relates' },
    ]);
    expect(JSON.parse(hrOf(d, t.id)[1]!.last_decision!).result_ref).toBe(bugId);
    expect(
      d.row<{ result_ref: string; into: string }>(
        'SELECT result_ref, "into" FROM review_decisions WHERE hr_item_id = ?',
        hr[1]!.id,
      ),
    ).toEqual({ result_ref: bugId, into: 'bug' });
    expect(statusOf(d, t.id).status).toBe('progress');
  });

  it('a short note is the bug title as is', () => {
    const { t, hr } = handedOff([TWO[0]!]);
    const out = decide(d, t.id, 1, [
      { hr_item_id: hr[0]!.id, kind: 'changes', note: 'Drag fails on touch.', into: 'bug' },
    ]);
    expect(
      d.row<{ title: string }>('SELECT title FROM items WHERE id = ?', out.created[0]!.id).title,
    ).toBe('Drag fails on touch.');
  });

  it('defer with a follow-up: Done (deferred, not verified) and a test ticket in Inbox carrying the check', () => {
    const long =
      'Sign in from a second browser and confirm the session is separate from the first one.';
    const { t, hr } = handedOff([long], { epic: 'RCP-1', priority: 3 });
    const out = decide(d, t.id, 1, [
      {
        hr_item_id: hr[0]!.id,
        kind: 'defer',
        note: 'Only one browser profile handy.',
        follow: 'ticket',
      },
    ]);
    expect(out.outcome).toBe('done');
    expect(statusOf(d, t.id)).toEqual({ status: 'done', closed_by: 'owner' });
    const followId = out.created[0]!.id;
    expect(out.created[0]!.kind).toBe('test_ticket');
    const task = d.row<{
      type: string;
      status: string;
      epic_id: string;
      priority: number;
      title: string;
    }>('SELECT * FROM items WHERE id = ?', followId);
    expect(task).toMatchObject({ type: 'Task', status: 'inbox', epic_id: 'RCP-1', priority: 3 });
    expect(task.title.startsWith('Verify: ')).toBe(true);
    expect(task.title.length - 'Verify: '.length).toBe(60);
    expect(hrOf(d, followId)).toMatchObject([{ text: long, state: 'declared', added_by: 'owner' }]);
    const parent = hrOf(d, t.id)[0]!;
    expect(parent).toMatchObject({ state: 'deferred', follow_up_item_id: followId });
    expect(
      d.rows('SELECT type FROM links WHERE from_id = ? AND to_id = ?', t.id, followId),
    ).toEqual([{ type: 'relates' }]);
  });

  it('defer without a follow-up: Done, nothing created, the item deferred', () => {
    const { t, hr } = handedOff([TWO[0]!]);
    const before = d.row<{ n: number }>('SELECT count(*) AS n FROM items').n;
    const out = decide(d, t.id, 1, [{ hr_item_id: hr[0]!.id, kind: 'defer', follow: 'none' }]);
    expect(out).toMatchObject({ outcome: 'done', created: [] });
    expect(d.row<{ n: number }>('SELECT count(*) AS n FROM items').n).toBe(before);
    expect(hrOf(d, t.id)[0]).toMatchObject({ state: 'deferred', follow_up_item_id: null });
    expect(
      d.row<{ follow: string; note: string | null }>(
        'SELECT follow, note FROM review_decisions WHERE hr_item_id = ?',
        hr[0]!.id,
      ),
    ).toEqual({ follow: 'none', note: null });
  });

  it('mixed (approve, changes, defer): In progress; the deferred item stays deferred', () => {
    const { t, hr } = handedOff([...TWO, 'Open it on a tablet.']);
    const out = decide(d, t.id, 1, [
      { hr_item_id: hr[0]!.id, kind: 'approve' },
      { hr_item_id: hr[1]!.id, kind: 'changes', note: 'Space does nothing.', into: 'checklist' },
      { hr_item_id: hr[2]!.id, kind: 'defer', note: 'No tablet', follow: 'ticket' },
    ]);
    expect(out.outcome).toBe('progress');
    expect(hrOf(d, t.id).map((h) => h.state)).toEqual(['approved', 'declared', 'deferred']);
    expect(out.created.map((c) => c.kind)).toEqual(['test_ticket']);
  });

  it('approvals carry forward: round 2 holds only the sent-back item, and approving it closes the ticket', () => {
    const { t, hr } = handedOff();
    decide(d, t.id, 1, [
      { hr_item_id: hr[0]!.id, kind: 'approve' },
      { hr_item_id: hr[1]!.id, kind: 'changes', note: 'Space does nothing.', into: 'checklist' },
    ]);
    // The agent resumes (its run is still open) and hands off round 2.
    commit(d, t, '9c0e7f2');
    const r2 = submit(d, t, { built_from_commit: '9c0e7f2' });
    expect(r2.round).toBe(2);
    const items = d.rows<{ hr_item_id: string }>(
      'SELECT hr_item_id FROM packet_items WHERE packet_id = ?',
      r2.packet_id,
    );
    expect(items.map((i) => i.hr_item_id)).toEqual([hr[1]!.id]);
    expect(hrOf(d, t.id).map((h) => h.state)).toEqual(['approved', 'ready']);
    const out = decide(d, t.id, 2, [{ hr_item_id: hr[1]!.id, kind: 'approve' }]);
    expect(out.outcome).toBe('done');
    expect(hrOf(d, t.id).map((h) => h.state)).toEqual(['approved', 'approved']);
  });

  it('the Done gate holds: items declared after the packet keep the ticket open after approve all', () => {
    const { t, hr } = handedOff();
    declare(d, t, ['Check the empty week state.']);
    const out = decide(
      d,
      t.id,
      1,
      hr.map((h) => ({ hr_item_id: h.id, kind: 'approve' as const })),
    );
    expect(out.outcome).toBe('progress');
    expect(statusOf(d, t.id)).toEqual({ status: 'progress', closed_by: null });
  });

  it("an epic-level packet doesn't close an epic with open children", () => {
    const epic = newTicket(d, { type: 'Epic', title: 'Planner v2' });
    newTicket(d, { epic: epic.id, title: 'Child' });
    declare(d, epic, ['Walk through the whole feature.']);
    const p = submit(d, epic);
    const hr = hrOf(d, epic.id);
    const out = decide(d, epic.id, p.round, [{ hr_item_id: hr[0]!.id, kind: 'approve' }]);
    expect(out.outcome).toBe('progress');
    expect(hrOf(d, epic.id)[0]!.state).toBe('approved');
  });

  it('set_status done is refused while items are declared or ready, naming them', () => {
    const t = newTicket(d);
    const [a, b] = declare(d, t, TWO);
    const err = d.fails(
      t.agent,
      (w, s) => s.items.setStatus(w, { id: t.id, status: 'done' } as In<'set_status'>),
      'validation',
    );
    expect(err.message).toContain('2 human review items are undecided');
    expect((err.details as { reason: string }).reason).toContain(`${a!.id}, ${b!.id}`);
    submit(d, t);
    const ready = d.fails(
      t.agent,
      (w, s) => s.items.setStatus(w, { id: t.id, status: 'done' } as In<'set_status'>),
      'validation',
    );
    expect((ready.details as { reason: string }).reason).toContain(a!.id);
  });
});

describe('decision validation', () => {
  it('every ready item needs a verdict', () => {
    const { t, hr } = handedOff();
    const err = d.fails(
      OWNER_ACTOR,
      (w, s) =>
        s.reviewDecisions.decide(w, {
          id: t.id,
          round: 1,
          verdicts: [{ hr_item_id: hr[0]!.id, kind: 'approve' }],
        }),
      'validation',
    );
    expect(err.message).toContain('Decide every item first');
  });

  it('changes needs a note', () => {
    const { t, hr } = handedOff([TWO[0]!]);
    d.fails(
      OWNER_ACTOR,
      (w, s) =>
        s.reviewDecisions.decide(w, {
          id: t.id,
          round: 1,
          verdicts: [{ hr_item_id: hr[0]!.id, kind: 'changes', note: '  ', into: 'bug' }],
        }),
      'validation',
    );
  });

  it('an item not in the packet is refused', () => {
    const { t, hr } = handedOff([TWO[0]!]);
    d.fails(
      OWNER_ACTOR,
      (w, s) =>
        s.reviewDecisions.decide(w, {
          id: t.id,
          round: 1,
          verdicts: [
            { hr_item_id: hr[0]!.id, kind: 'approve' },
            { hr_item_id: 'hr_other', kind: 'approve' },
          ],
        }),
      'validation',
    );
  });

  it('another round, or no open packet, is conflict', () => {
    const { t, hr } = handedOff([TWO[0]!]);
    d.fails(
      OWNER_ACTOR,
      (w, s) =>
        s.reviewDecisions.decide(w, {
          id: t.id,
          round: 2,
          verdicts: [{ hr_item_id: hr[0]!.id, kind: 'approve' }],
        }),
      'conflict',
    );
    decide(d, t.id, 1, [{ hr_item_id: hr[0]!.id, kind: 'approve' }]);
    d.fails(
      OWNER_ACTOR,
      (w, s) =>
        s.reviewDecisions.decide(w, {
          id: t.id,
          round: 1,
          verdicts: [{ hr_item_id: hr[0]!.id, kind: 'approve' }],
        }),
      'conflict',
    );
  });

  it('only the owner decides', () => {
    const { t, hr } = handedOff([TWO[0]!]);
    d.fails(
      t.agent,
      (w, s) =>
        s.reviewDecisions.decide(w, {
          id: t.id,
          round: 1,
          verdicts: [{ hr_item_id: hr[0]!.id, kind: 'approve' }],
        }),
      'forbidden',
    );
  });

  it('a refused decision changes nothing (one atomic call)', () => {
    const { t, hr } = handedOff();
    const before = snapshot(d, t.id);
    d.fails(
      OWNER_ACTOR,
      (w, s) =>
        s.reviewDecisions.decide(w, {
          id: t.id,
          round: 1,
          verdicts: [
            { hr_item_id: hr[0]!.id, kind: 'changes', note: 'Too small', into: 'bug' },
            { hr_item_id: hr[1]!.id, kind: 'changes', note: ' ', into: 'checklist' },
          ],
        }),
      'validation',
    );
    expect(snapshot(d, t.id)).toEqual(before);
  });
});

describe('undo restores everything', () => {
  it.each([
    [
      'approve all',
      (hr: { id: string }[]) => hr.map((h) => ({ hr_item_id: h.id, kind: 'approve' as const })),
    ],
    [
      'changes into a step and a bug',
      (hr: { id: string }[]) => [
        {
          hr_item_id: hr[0]!.id,
          kind: 'changes' as const,
          note: 'Too small',
          into: 'checklist' as const,
        },
        {
          hr_item_id: hr[1]!.id,
          kind: 'changes' as const,
          note: 'Reload jumps',
          into: 'bug' as const,
        },
      ],
    ],
    [
      'defer with a test ticket',
      (hr: { id: string }[]) => [
        { hr_item_id: hr[0]!.id, kind: 'approve' as const },
        {
          hr_item_id: hr[1]!.id,
          kind: 'defer' as const,
          note: 'No keyboard',
          follow: 'ticket' as const,
        },
      ],
    ],
  ])('%s', (_name, verdicts) => {
    const { t, hr } = handedOff();
    const before = snapshot(d, t.id);
    const out = decide(d, t.id, 1, verdicts(hr));
    expect(snapshot(d, t.id)).not.toEqual(before);
    d.clock.advance(5_000);
    undo(d, out.mutation_id);
    const after = snapshot(d, t.id);
    // Versions move forward on undo; everything else is as it was.
    const strip = (s: ReturnType<typeof snapshot>) =>
      JSON.parse(JSON.stringify(s, (k, v) => (k === 'version' ? undefined : v))) as unknown;
    expect(strip(after)).toEqual(strip(before));
    for (const c of out.created)
      expect(d.rows('SELECT id FROM items WHERE id = ?', c.id)).toEqual([]);
    expect(statusOf(d, t.id).status).toBe('review');
    // And the owner can decide again.
    expect(
      decide(
        d,
        t.id,
        1,
        hr.map((h) => ({ hr_item_id: h.id, kind: 'approve' as const })),
      ).outcome,
    ).toBe('done');
  });

  it('the decision is recorded with the owner as the actor', () => {
    const { t, hr } = handedOff([TWO[0]!]);
    decide(d, t.id, 1, [{ hr_item_id: hr[0]!.id, kind: 'approve' }]);
    const e = d.row<{ actor_kind: string; summary: string }>(
      "SELECT actor_kind, summary FROM events WHERE type = 'review.decided' AND item_id = ?",
      t.id,
    );
    expect(e.actor_kind).toBe('owner');
    expect(e.summary).toContain('You reviewed round 1');
  });
});

describe('test ticket for a deferred item (Create test ticket)', () => {
  it('creates the follow-up once, records it on the item and the decision, and can be undone', () => {
    const { t, hr } = handedOff([TWO[0]!]);
    decide(d, t.id, 1, [{ hr_item_id: hr[0]!.id, kind: 'defer', follow: 'none' }]);
    const out = owner<{ id: string; status: string }>(d, (w, s) =>
      s.reviewDecisions.createFollowUp(w, { hr_item_id: hr[0]!.id }),
    );
    expect(out).toMatchObject({ status: 'inbox' });
    expect(hrOf(d, t.id)[0]!.follow_up_item_id).toBe(out.id);
    expect(
      d.row<{ follow: string; result_ref: string }>(
        'SELECT follow, result_ref FROM review_decisions WHERE hr_item_id = ?',
        hr[0]!.id,
      ),
    ).toEqual({ follow: 'ticket', result_ref: out.id });
    d.fails(
      OWNER_ACTOR,
      (w, s) => s.reviewDecisions.createFollowUp(w, { hr_item_id: hr[0]!.id }),
      'conflict',
    );
    d.clock.advance(1000);
    undo(d, out.mutation_id);
    expect(hrOf(d, t.id)[0]!.follow_up_item_id).toBeNull();
    expect(d.rows('SELECT id FROM items WHERE id = ?', out.id)).toEqual([]);
  });

  it('only for deferred items', () => {
    const t: Ticket = newTicket(d);
    const [a] = declare(d, t, [TWO[0]!]);
    d.fails(
      OWNER_ACTOR,
      (w, s) => s.reviewDecisions.createFollowUp(w, { hr_item_id: a!.id }),
      'validation',
    );
  });
});
