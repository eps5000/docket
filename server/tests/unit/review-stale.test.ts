/**
 * Stale packets, fresh-packet requests and the deferred list (BUILD_SPEC
 * §5.6; FR-052, FR-053; tasks.md T088).
 *
 * - A packet is out of date once a commit with another SHA is reported for
 *   its item after it was built; for an epic-level packet, a commit on any
 *   child counts. `report_commit` returns `stale_packets`.
 * - *Ask for a fresh packet* withdraws it, puts its items back to declared,
 *   returns the item to In progress and leaves the agent a note; undoable.
 * - Deferred, not verified: listed until the follow-up is done with its own
 *   review approved, or the item is re-declared (and later approved).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { In } from '../../src/domain/contracts.js';
import { OWNER_ACTOR } from '../../src/domain/write.js';
import { declareNone, startDomain, type Domain } from '../us1-helpers.js';
import {
  commit,
  decide,
  declare,
  hrOf,
  newTicket,
  owner,
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

function handedOff(opts: Parameters<typeof newTicket>[1] = {}, texts = ['Drag on a phone.']) {
  const t = newTicket(d, opts);
  declare(d, t, texts);
  const p = submit(d, t);
  d.clock.advance(60_000);
  return { t, p };
}

const review = (id: string) => d.services.packets.getReview(d.read(), { id } as In<'get_review'>);
const screen = (id: string) => d.services.packets.screen(d.read(), { id });
const needsYouRow = (id: string) =>
  d.services.views
    .needsYou(d.read(OWNER_ACTOR), { scope: 'all' } as never)
    .for_you_now.find((r) => r.item_id === id) as { stale?: boolean } | undefined;

describe('stale packets: ticket level', () => {
  it('a commit with another SHA after the packet makes it out of date, everywhere', () => {
    const { t, p } = handedOff();
    expect(review(t.id).rounds[0]!.stale).toBe(false);
    const out = commit(d, t, 'c71e002');
    expect(out.stale_packets).toEqual([{ item_id: t.id, packet_id: p.packet_id, round: 1 }]);
    expect(review(t.id).rounds[0]!.stale).toBe(true);
    expect(screen(t.id).packet.stale).toBe(true);
    expect(screen(t.id).queue.find((q) => q.item_id === t.id)!.stale).toBe(true);
    expect(needsYouRow(t.id)?.stale).toBe(true);
    const item = d.services.items.get(d.read(), { id: t.id } as In<'get_item'>).item;
    expect(item.packets![0]!.stale).toBe(true);
  });

  it('the commit it was built from (or a longer form of it) is not newer', () => {
    const { t } = handedOff();
    expect(commit(d, t, '7d21aa3').stale_packets).toEqual([]);
    expect(commit(d, t, '7d21aa3fffffff').stale_packets).toEqual([]);
    expect(review(t.id).rounds[0]!.stale).toBe(false);
  });

  it('records packet.stale once, though every later commit still reports it', () => {
    const { t } = handedOff();
    commit(d, t, 'c71e002');
    d.clock.advance(1000);
    expect(commit(d, t, 'c71e003').stale_packets).toHaveLength(1);
    expect(
      d.rows("SELECT seq FROM events WHERE type = 'packet.stale' AND item_id = ?", t.id),
    ).toHaveLength(1);
  });

  it('a commit on a sibling ticket does not touch a ticket-level packet', () => {
    const { t } = handedOff({ epic: 'RCP-1' });
    const sibling = newTicket(d, { epic: 'RCP-1', client: 'claude' });
    expect(commit(d, sibling, 'abc1234').stale_packets).toEqual([]);
    expect(review(t.id).rounds[0]!.stale).toBe(false);
  });

  it('a decided packet is never stale', () => {
    const { t } = handedOff();
    const hr = hrOf(d, t.id);
    decide(d, t.id, 1, [
      { hr_item_id: hr[0]!.id, kind: 'changes', note: 'Too small', into: 'checklist' },
    ]);
    expect(commit(d, t, 'c71e002').stale_packets).toEqual([]);
    expect(review(t.id).rounds[0]!.stale).toBe(false);
  });
});

describe('stale packets: epic level', () => {
  it('a commit on any child of the epic makes the epic-level packet out of date', () => {
    const epic = newTicket(d, { type: 'Epic', title: 'Docs v2' });
    const child = newTicket(d, { epic: epic.id, client: 'claude', title: 'Child' });
    declare(d, epic, ['Read the whole API reference as a new developer would.']);
    const p = submit(d, epic);
    d.clock.advance(60_000);
    const out = commit(d, child, 'beef123');
    expect(out.stale_packets).toEqual([{ item_id: epic.id, packet_id: p.packet_id, round: 1 }]);
    expect(review(epic.id).rounds[0]!.stale).toBe(true);
    expect(screen(epic.id).packet.stale).toBe(true);
    expect(
      d.row<{ summary: string }>("SELECT summary FROM events WHERE type = 'packet.stale'").summary,
    ).toContain(`on ${child.id}`);
  });
});

describe('ask for a fresh packet', () => {
  function staleTicket(): { t: Ticket; packetId: string } {
    const { t, p } = handedOff({}, ['Drag on a phone.', 'Keyboard only.']);
    commit(d, t, 'c71e002');
    return { t, packetId: p.packet_id };
  }

  it('withdraws the packet, items back to declared, In progress, and a note for the agent', () => {
    const { t, packetId } = staleTicket();
    const out = owner<{ status: string }>(d, (w, s) =>
      s.packets.refresh(w, { id: t.id, packet_id: packetId }),
    );
    expect(out.status).toBe('progress');
    expect(d.row<{ state: string }>('SELECT state FROM packets WHERE id = ?', packetId).state).toBe(
      'withdrawn',
    );
    expect(hrOf(d, t.id).map((h) => h.state)).toEqual(['declared', 'declared']);
    expect(d.rows('SELECT text FROM owner_notes WHERE item_id = ?', t.id)).toEqual([
      { text: 'Please submit a fresh packet; code changed after 7d21aa3.' },
    ]);
    // The agent sees the note on its next get_item, and can hand off round 2.
    const item = d.services.items.get(d.read(t.agent), { id: t.id } as In<'get_item'>).item;
    expect(item.unread_owner_notes!.map((n) => n.text)).toEqual([
      'Please submit a fresh packet; code changed after 7d21aa3.',
    ]);
    expect(submit(d, t, { built_from_commit: 'c71e002' }).round).toBe(2);
    expect(review(t.id).rounds.map((r) => r.state)).toEqual(['withdrawn', 'open']);
  });

  it('a released item becomes resumable', () => {
    const { t, packetId } = staleTicket();
    d.write(t.agent, (w, s) =>
      s.runs.finish(w, {
        run_id: t.run_id,
        result: 'finished',
        summary: 'Packet sent',
      } as In<'finish_run'>),
    );
    owner(d, (w, s) => s.packets.refresh(w, { id: t.id, packet_id: packetId }));
    const found = d.services.search.searchItems(d.read(d.agent('codex')), {
      project: 'RCP',
      filter: 'resumable',
      limit: 25,
    } as In<'search_items'>);
    expect(found.items.map((i) => i.id)).toContain(t.id);
  });

  it('is undoable', () => {
    const { t, packetId } = staleTicket();
    const before = snapshot(d, t.id);
    const out = owner(d, (w, s) => s.packets.refresh(w, { id: t.id, packet_id: packetId }));
    d.clock.advance(1000);
    undo(d, out.mutation_id);
    const strip = (s: unknown) =>
      JSON.parse(JSON.stringify(s, (k, v) => (k === 'version' ? undefined : v))) as unknown;
    expect(strip(snapshot(d, t.id))).toEqual(strip(before));
    expect(statusOf(d, t.id).status).toBe('review');
  });

  it('a packet that is no longer open is conflict; one from another item is not_found', () => {
    const { t, packetId } = staleTicket();
    owner(d, (w, s) => s.packets.refresh(w, { id: t.id, packet_id: packetId }));
    d.fails(
      OWNER_ACTOR,
      (w, s) => s.packets.refresh(w, { id: t.id, packet_id: packetId }),
      'conflict',
    );
    d.fails(
      OWNER_ACTOR,
      (w, s) => s.packets.refresh(w, { id: 'RCP-12', packet_id: packetId }),
      'not_found',
    );
  });
});

describe('the deferred list (deferred_reviews, Needs you)', () => {
  const deferred = (project?: string) =>
    d.services.packets.deferredReviews(d.read(), { project, limit: 25 } as In<'deferred_reviews'>)
      .items;

  function deferOne(follow: 'ticket' | 'none', text = 'Sign in from a second browser.') {
    const { t } = handedOff({}, [text]);
    const hr = hrOf(d, t.id);
    const out = decide(d, t.id, 1, [
      { hr_item_id: hr[0]!.id, kind: 'defer', note: 'One profile only', follow },
    ]);
    return { t, hrId: hr[0]!.id, followId: out.created[0]?.id ?? null };
  }

  it('the seed lists its two deferred checks, newest first, with their follow-ups', () => {
    const items = deferred();
    expect(items.map((i) => i.item_id)).toEqual(expect.arrayContaining(['RCP-11', 'DOC-2']));
    expect(items.find((i) => i.item_id === 'RCP-11')!.follow_up).toEqual({
      id: 'RCP-29',
      status: 'inbox',
    });
    expect(deferred('DOC').map((i) => i.item_id)).toEqual(['DOC-2']);
  });

  it('a deferred item without a follow-up is listed, with the note', () => {
    const { t, hrId } = deferOne('none');
    expect(deferred()[0]).toMatchObject({
      item_id: t.id,
      hr_item_id: hrId,
      note: 'One profile only',
      follow_up: null,
    });
  });

  it('with a follow-up, it stays listed until the follow-up is done with its own review approved', () => {
    const { t, followId } = deferOne('ticket');
    expect(deferred()[0]).toMatchObject({
      item_id: t.id,
      follow_up: { id: followId, status: 'inbox' },
    });
    // The follow-up is worked like any other ticket: claimed, reviewed, approved.
    const agent = d.agent('claude');
    d.write(agent, (w, s) =>
      s.items.setStatus(w, { id: followId!, status: 'planning' } as In<'set_status'>),
    );
    declareNone(d, followId!); // the Ready gate (decision 36)
    d.write(agent, (w, s) =>
      s.items.setStatus(w, { id: followId!, status: 'ready' } as In<'set_status'>),
    );
    const { run_id } = d.write(agent, (w, s) =>
      s.runs.claim(w, { id: followId! } as In<'claim_lead'>),
    );
    const f: Ticket = { id: followId!, agent: d.agent('claude', { run_id }), run_id };
    submit(d, f);
    expect(deferred().map((x) => x.item_id)).toContain(t.id);
    const fhr = hrOf(d, followId!);
    decide(d, followId!, 1, [{ hr_item_id: fhr[0]!.id, kind: 'approve' }]);
    expect(deferred().map((x) => x.item_id)).not.toContain(t.id);
  });

  it('re-declaring the item takes it off the list', () => {
    const { t } = deferOne('none', 'Open it on a tablet.');
    const agent = d.agent('codex');
    d.write(agent, (w, s) =>
      s.items.setStatus(w, {
        id: t.id,
        status: 'progress',
        reason: 'Tablet available now',
      } as In<'set_status'>),
    );
    d.write(agent, (w, s) =>
      s.humanReview.declare(w, { id: t.id, items: ['Open it on a tablet.'] }),
    );
    expect(deferred().map((x) => x.item_id)).not.toContain(t.id);
  });

  it('pages with an opaque cursor', () => {
    deferOne('none', 'One.');
    deferOne('none', 'Two.');
    const first = d.services.packets.deferredReviews(d.read(), {
      limit: 2,
    } as In<'deferred_reviews'>);
    expect(first.items).toHaveLength(2);
    expect(first.next_cursor).not.toBeNull();
    const next = d.services.packets.deferredReviews(d.read(), {
      limit: 2,
      cursor: first.next_cursor!,
    } as In<'deferred_reviews'>);
    expect(next.items.length).toBeGreaterThan(0);
    expect(next.items.map((i) => i.hr_item_id)).not.toContain(first.items[0]!.hr_item_id);
  });

  it('an unknown project is not_found', () => {
    expect(() => deferred('ZZZ')).toThrow(/No project ZZZ/);
  });
});
