/**
 * B81, open bugs hold back an epic's release (owner decision 64), with
 * synthetic text only: finding the finish line (one, several, none, marked),
 * the hold on Review and Done with open, done and canceled bugs and bugs
 * outside the epic, the refusal's content, moving a bug out and canceling it
 * with a reason, the owner's review, and what the epic page, the Work epics
 * row, Pick next epic, the implementer's context and the digest show.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DIGEST_MAX_CHARS, renderResult, type Status } from '@docket/shared';
import { finishLineOf } from '../../src/domain/finish-line.js';
import type { Actor } from '../../src/domain/write.js';
import { addProject, declareNone, forceStatus, startDomain, type Domain } from '../us1-helpers.js';
import { decide, owner, packetArgs } from '../us3-helpers.js';

let d: Domain;
let planner: Actor;
let worker: Actor;

beforeEach(() => {
  d = startDomain({ seed: false, now: new Date('2026-11-24T08:00:00.000Z') });
  addProject(d, 'TST');
  planner = d.agent('claude', { label: 'planner' });
  worker = d.agent('codex', { label: 'worker' });
});
afterEach(() => d.cleanup());

type Kind = 'Epic' | 'Story' | 'Task' | 'Bug';
const create = (type: Kind, opts: { epic?: string; status?: Status; title?: string } = {}) => {
  const { id } = d.write(planner, (w, s) =>
    s.items.create(w, {
      project: 'TST',
      type,
      title: opts.title ?? `Synthetic ${type.toLowerCase()}`,
      priority: 2,
      status: 'planning',
      ...(opts.epic ? { epic: opts.epic } : {}),
    }),
  );
  declareNone(d, id);
  if (opts.status && opts.status !== 'planning') forceStatus(d, id, opts.status);
  return id;
};
const link = (from: string, to: string) =>
  d.write(planner, (w, s) => s.links.link(w, { from, to, type: 'blocks' }));
const version = (id: string) =>
  d.row<{ version: number }>('SELECT version FROM items WHERE id = ?', id).version;
const status = (id: string) =>
  d.row<{ status: Status }>('SELECT status FROM items WHERE id = ?', id).status;
const line = (epic: string) => finishLineOf(d.server.runtime.db, epic);
const mark = (epic: string, ticket: string | null, actor = planner) =>
  d.write(actor, (w, s) =>
    s.items.update(w, { id: epic, expected_version: version(epic), finish_line: ticket }),
  );
const claim = (id: string) =>
  d.agent('codex', {
    label: 'worker',
    run_id: d.write(worker, (w, s) => s.runs.claim(w, { id, agent_label: 'worker' })).run_id,
  });
const close = (id: string, actor: Actor) =>
  d.write(actor, (w, s) => s.items.setStatus(w, { id, status: 'done' }));

/** An epic in progress: A → B → R (R is the release ticket), every ticket Ready. */
function chain() {
  const epic = create('Epic', { status: 'progress' });
  const a = create('Story', { epic, status: 'done' });
  const b = create('Story', { epic, status: 'done' });
  const r = create('Task', { epic, status: 'ready', title: 'Release the synthetic build' });
  link(a, b);
  link(b, r);
  return { epic, a, b, r };
}

describe('finding the finish line', () => {
  it('one: the only ticket that depends on others and that nothing depends on', () => {
    const { epic, r } = chain();
    expect(line(epic)).toMatchObject({ id: r, how: 'detected', candidates: [], open_bugs: [] });
  });

  it('several: no finish line, with the candidates, until one is marked', () => {
    const epic = create('Epic', { status: 'progress' });
    const a = create('Story', { epic, status: 'ready' });
    const b = create('Story', { epic, status: 'ready' });
    const c = create('Task', { epic, status: 'ready' });
    link(a, b);
    link(a, c);
    expect(line(epic)).toMatchObject({ id: null, how: null, candidates: [b, c] });
    mark(epic, c);
    expect(line(epic)).toMatchObject({ id: c, how: 'explicit', candidates: [] });
    mark(epic, null);
    expect(line(epic)).toMatchObject({ id: null, candidates: [b, c] });
  });

  it('none: no links means no finish line and no candidates', () => {
    const epic = create('Epic', { status: 'progress' });
    create('Story', { epic, status: 'ready' });
    create('Task', { epic, status: 'ready' });
    expect(line(epic)).toEqual({ id: null, how: null, candidates: [], open_bugs: [] });
  });

  it('an empty epic has no finish line', () => {
    const epic = create('Epic', { status: 'ready' });
    expect(line(epic)).toEqual({ id: null, how: null, candidates: [], open_bugs: [] });
  });

  it('bugs never are the finish line, and a bug waiting on a ticket keeps that ticket last', () => {
    const { epic, r } = chain();
    const bug = create('Bug', { epic, status: 'ready' });
    link(r, bug);
    expect(line(epic)).toMatchObject({ id: r, how: 'detected' });
  });

  it('a done dependent keeps the finish line; a canceled one is ignored', () => {
    const { epic, b, r } = chain();
    forceStatus(d, r, 'done');
    expect(line(epic).id).toBe(r);
    forceStatus(d, r, 'canceled');
    expect(line(epic)).toMatchObject({ id: b, how: 'detected' });
  });

  it('a mark stops counting once its ticket is canceled or leaves the epic', () => {
    const epic = create('Epic', { status: 'progress' });
    const a = create('Story', { epic, status: 'ready' });
    const b = create('Story', { epic, status: 'ready' });
    const c = create('Task', { epic, status: 'ready' });
    link(a, b);
    link(a, c);
    mark(epic, b);
    forceStatus(d, b, 'canceled');
    expect(line(epic)).toMatchObject({ id: c, how: 'detected' });
  });

  it('refuses a mark that is a bug, canceled, outside the epic, or on something that is not an epic', () => {
    const { epic, a, r } = chain();
    const bug = create('Bug', { epic, status: 'ready' });
    const gone = create('Task', { epic, status: 'canceled' });
    const elsewhere = create('Task', { status: 'ready' });
    const tries: [string, string, RegExp][] = [
      [epic, bug, /is a bug: bugs hold the finish line, they can't be it/],
      [epic, gone, /is canceled, so it can't be the finish line/],
      [epic, elsewhere, /isn't a ticket in epic/],
    ];
    for (const [on, ticket, message] of tries) {
      const err = d.fails(
        planner,
        (w, s) => s.items.update(w, { id: on, expected_version: version(on), finish_line: ticket }),
        'validation',
      );
      expect(err.message).toMatch(message);
    }
    const err = d.fails(
      planner,
      (w, s) => s.items.update(w, { id: a, expected_version: version(a), finish_line: r }),
      'validation',
    );
    expect(err.message).toContain("isn't an epic");
  });

  it('the owner marks it from the epic page, recorded in Activity', () => {
    const epic = create('Epic', { status: 'progress' });
    const a = create('Story', { epic, status: 'ready' });
    const b = create('Story', { epic, status: 'ready' });
    const c = create('Task', { epic, status: 'ready' });
    link(a, b);
    link(a, c);
    owner(d, (w, s) =>
      s.items.ownerPatch(w, { id: epic, expected_version: version(epic), finish_line: c }),
    );
    expect(line(epic)).toMatchObject({ id: c, how: 'explicit' });
    const event = d.row<{ summary: string }>(
      "SELECT summary FROM events WHERE item_id = ? AND type = 'item.updated' ORDER BY seq DESC LIMIT 1",
      epic,
    );
    expect(event.summary).toBe(`You marked ${c} as ${epic}'s finish line`);
  });
});

describe('open bugs hold the finish line', () => {
  it.each<[Status, boolean]>([
    ['inbox', true],
    ['planning', true],
    ['ready', true],
    ['progress', true],
    ['review', true],
    ['done', false],
    ['canceled', false],
  ])('a %s bug in the epic holds Done: %s', (bugStatus, holds) => {
    const { epic, r } = chain();
    const bug = create('Bug', { epic, status: bugStatus, title: 'Synthetic crash on save' });
    const lead = claim(r);
    if (!holds) {
      close(r, lead);
      expect(status(r)).toBe('done');
      return;
    }
    const err = d.fails(
      lead,
      (w, s) => s.items.setStatus(w, { id: r, status: 'done' }),
      'bugs_open',
    );
    expect(err.message).toContain(`${r} is the finish line of epic ${epic}`);
    expect(err.message).toContain("can't move to Done while a bug in the epic is open");
    expect(err.message).toContain(bug);
    expect(err.message).toContain(
      'fix it (Done); or move it to another epic as a follow-up (update_item epic); or cancel it with a reason (set_status canceled)',
    );
    expect(err.details).toEqual({
      epic,
      finish_line: r,
      open_bugs: [{ id: bug, title: 'Synthetic crash on save', status: bugStatus }],
      ways_forward: ['fix', 'move', 'cancel'],
    });
    expect(status(r)).toBe('progress');
  });

  it('bugs outside the epic, and tickets that are not the finish line, are not held', () => {
    const { epic, b, r } = chain();
    create('Bug', { status: 'ready' }); // No epic.
    const other = create('Epic', { status: 'progress' });
    create('Bug', { epic: other, status: 'ready' });
    const lead = claim(r);
    close(r, lead);
    expect(status(r)).toBe('done');
    // A ticket earlier in the chain closes even while a bug in its epic is open.
    create('Bug', { epic, status: 'ready' });
    forceStatus(d, b, 'ready');
    const lb = claim(b);
    close(b, lb);
    expect(status(b)).toBe('done');
  });

  it('lists several bugs in ID order, and says how many', () => {
    const { epic, r } = chain();
    const bugs = [create('Bug', { epic }), create('Bug', { epic }), create('Bug', { epic })];
    const lead = claim(r);
    const err = d.fails(
      lead,
      (w, s) => s.items.setStatus(w, { id: r, status: 'done' }),
      'bugs_open',
    );
    expect(err.message).toContain('3 bugs in the epic are open');
    expect((err.details!.open_bugs as { id: string }[]).map((b) => b.id)).toEqual(bugs);
  });

  it('a marked finish line is held too', () => {
    const epic = create('Epic', { status: 'progress' });
    const a = create('Story', { epic, status: 'done' });
    const b = create('Story', { epic, status: 'ready' });
    const c = create('Task', { epic, status: 'ready' });
    link(a, b);
    link(a, c);
    create('Bug', { epic, status: 'ready' });
    const lead = claim(c);
    close(c, lead); // No finish line yet: nothing to hold.
    forceStatus(d, c, 'ready');
    mark(epic, b);
    const lb = claim(b);
    d.fails(lb, (w, s) => s.items.setStatus(w, { id: b, status: 'done' }), 'bugs_open');
  });

  it('submit_packet (Review) is refused while a bug is open, then goes once it is fixed', () => {
    const { epic, r } = chain();
    const bug = create('Bug', { epic, status: 'ready' });
    const lead = claim(r);
    d.write(lead, (w, s) => s.humanReview.declare(w, { id: r, items: ['Open the synthetic app'] }));
    const err = d.fails(lead, (w, s) => s.packets.submit(w, packetArgs(r)), 'bugs_open');
    expect(err.message).toContain("can't move to Review while a bug in the epic is open");
    forceStatus(d, bug, 'done');
    d.write(lead, (w, s) => s.packets.submit(w, packetArgs(r)));
    expect(status(r)).toBe('review');
  });

  it("the owner's approval keeps it open while a bug filed after the hand-off is open", () => {
    const { epic, r } = chain();
    const lead = claim(r);
    d.write(lead, (w, s) => s.humanReview.declare(w, { id: r, items: ['Open the synthetic app'] }));
    d.write(lead, (w, s) => s.packets.submit(w, packetArgs(r)));
    const bug = create('Bug', { epic, status: 'ready' });
    const hr = d.row<{ id: string }>('SELECT id FROM hr_items WHERE item_id = ?', r);
    decide(d, r, 1, [{ hr_item_id: hr.id, kind: 'approve' }]);
    expect(status(r)).toBe('progress');
    const event = d.row<{ summary: string }>(
      "SELECT summary FROM events WHERE item_id = ? AND type = 'item.status_changed' ORDER BY seq DESC LIMIT 1",
      r,
    );
    expect(event.summary).toBe(
      `You moved ${r} from review to progress: it's ${epic}'s finish line and ${bug} is still open`,
    );
    forceStatus(d, bug, 'done');
    const again = d.agent('codex', { label: 'worker', run_id: lead.run_id });
    close(r, again);
    expect(status(r)).toBe('done');
  });
});

describe('a bug leaves the epic on purpose', () => {
  it('moving it to another epic lets the release go, and Activity says so', () => {
    const { epic, r } = chain();
    const later = create('Epic', { status: 'ready' });
    const bug = create('Bug', { epic, status: 'ready' });
    d.write(planner, (w, s) =>
      s.items.update(w, { id: bug, expected_version: version(bug), epic: later }),
    );
    const event = d.row<{ summary: string }>(
      "SELECT summary FROM events WHERE item_id = ? AND type = 'item.updated' ORDER BY seq DESC LIMIT 1",
      bug,
    );
    expect(event.summary).toBe(
      `claude · planner updated ${bug}: epic (bug left ${epic} for ${later}, so it no longer holds ${epic}'s release)`,
    );
    close(r, claim(r));
    expect(status(r)).toBe('done');
  });

  it('canceling a bug in an epic needs a reason, from an agent or the owner', () => {
    const { epic, r } = chain();
    const bug = create('Bug', { epic, status: 'ready' });
    const err = d.fails(
      planner,
      (w, s) => s.items.setStatus(w, { id: bug, status: 'canceled', reason: ' ' }),
      'validation',
    );
    expect(err.message).toContain(`holds epic ${epic}'s release`);
    let caught: unknown;
    try {
      owner(d, (w, s) => s.archive.cancel(w, { id: bug, expected_version: version(bug) }));
    } catch (e) {
      caught = e;
    }
    expect((caught as { code: string }).code).toBe('validation');
    owner(d, (w, s) =>
      s.archive.cancel(w, {
        id: bug,
        expected_version: version(bug),
        reason: 'Only happens on a retired synthetic device',
      }),
    );
    const event = d.row<{ summary: string }>(
      "SELECT summary FROM events WHERE item_id = ? AND type = 'item.status_changed' ORDER BY seq DESC LIMIT 1",
      bug,
    );
    expect(event.summary).toContain('Only happens on a retired synthetic device');
    close(r, claim(r));
    expect(status(r)).toBe('done');
  });

  it('a bug outside any epic cancels without a reason from the owner', () => {
    const bug = create('Bug', { status: 'ready' });
    owner(d, (w, s) => s.archive.cancel(w, { id: bug, expected_version: version(bug) }));
    expect(status(bug)).toBe('canceled');
  });
});

describe('what the views and agents read', () => {
  it('the epic page has the finish line and its bugs; the finish line has its hold', () => {
    const { epic, r } = chain();
    const bug = create('Bug', { epic, status: 'progress' });
    const page = d.services.views.itemDetail(d.read(), { id: epic });
    expect(page.finish_line).toMatchObject({
      id: r,
      how: 'detected',
      open_bugs: [{ id: bug, status: 'progress' }],
    });
    expect(page.release_hold).toBeUndefined();
    const ticket = d.services.views.itemDetail(d.read(), { id: r });
    expect(ticket.release_hold).toEqual({
      epic,
      open_bugs: [{ id: bug, title: 'Synthetic bug', status: 'progress' }],
    });
    expect(ticket.finish_line).toBeUndefined();
  });

  it('the Work epics row and Pick next epic count open bugs', () => {
    const { epic, r } = chain();
    create('Bug', { epic, status: 'ready' });
    create('Bug', { epic, status: 'done' });
    const work = d.services.views.work(d.read(), {
      scope: 'TST',
      layout: 'board',
    } as Parameters<typeof d.services.views.work>[1]);
    const card = work.epics.find((e) => e.id === epic)!;
    expect(card.release).toEqual({ finish_line: r, open_bugs: 1 });
    const pick = d.services.subgraph.pickEpic(d.read(), { key: 'TST' });
    const row = pick.epics.find((p) => p.id === epic);
    expect(row?.release).toEqual({ finish_line: r, open_bugs: 1 });
  });

  it("get_context gives the finish line's implementer the open bugs, never cut", () => {
    const { epic, r } = chain();
    const bug = create('Bug', { epic, status: 'ready', title: 'Synthetic crash on save' });
    const lead = claim(r);
    const ctx = d.services.context.getContext(d.read(lead), { id: r, budget: 'small' });
    expect(ctx.release_hold).toEqual({
      epic,
      open_bugs: [{ id: bug, title: 'Synthetic crash on save', status: 'ready' }],
    });
    const text = renderResult(
      'get_context',
      { context: ctx },
      { args: { id: r }, now: d.clock.now() },
    );
    expect(text).toContain(`release held: finish line of ${epic}, which has 1 bug open`);
    expect(text).toContain(`- ${bug} ready · Synthetic crash on save`);
    // Not on other tickets.
    const other = d.services.context.getContext(d.read(), { id: bug, budget: 'small' });
    expect(other.release_hold).toBeUndefined();
  });

  it("get_digest shows the bugs holding each epic's release, inside the digest cap", () => {
    const { epic, r } = chain();
    const bugs = [create('Bug', { epic }), create('Bug', { epic }), create('Bug', { epic })];
    const loose = create('Epic', { status: 'progress' });
    const looseBug = create('Bug', { epic: loose, status: 'ready' });
    const digest = d.services.digest.get(d.read(worker), { project: 'TST' });
    expect(digest.release_bugs).toEqual({
      total: 2,
      rows: [
        { epic, finish_line: r, bugs },
        { epic: loose, finish_line: null, bugs: [looseBug] },
      ],
    });
    const text = renderResult('get_digest', digest, { now: d.clock.now() });
    expect(text).toContain(
      `release held by bugs 2:\n- ${epic} finish line ${r} waits on 3 bugs: ${bugs.join(', ')}\n- ${loose} no finish line waits on 1 bug: ${looseBug}`,
    );
    expect(text.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
  });

  it('get_digest leaves the section out when no bug is open', () => {
    chain();
    const digest = d.services.digest.get(d.read(worker), { project: 'TST' });
    expect(digest.release_bugs).toBeUndefined();
  });
});
