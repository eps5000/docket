/**
 * B79 (owner decision 62), with synthetic text only: tickets added to an epic
 * after it started (marking, the digest, Done refused while untriaged, triage
 * by moving), idle In progress tickets (open, parked and needs-input runs keep
 * one live, activity resets it, the problem and its ways forward, the radar
 * and overlap checks leaving it alone, conflicts cleared with a reason), and
 * acknowledged problems that no longer count as open until they need you.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DIGEST_MAX_CHARS, IDLE_AFTER_MS, renderResult, type Status } from '@docket/shared';
import { inFlightItems } from '../../src/domain/radar.js';
import { claimOverlaps } from '../../src/domain/shared-changes.js';
import { idleTickets } from '../../src/domain/idle.js';
import { undoMutation } from '../../src/domain/undo.js';
import { idleOnce } from '../../src/jobs/sweeper.js';
import type { Actor } from '../../src/domain/write.js';
import { addProject, declareNone, forceStatus, startDomain, type Domain } from '../us1-helpers.js';

const OWNER: Actor = { kind: 'owner', client: null, label: null, session_id: null, run_id: null };
const DAY = 24 * 60 * 60 * 1000;

let d: Domain;
let producer: Actor;
let worker: Actor;

beforeEach(() => {
  d = startDomain({ seed: false, now: new Date('2026-11-24T08:00:00.000Z') });
  addProject(d, 'TST');
  producer = d.agent('claude', { label: 'producer' });
  worker = d.agent('codex', { label: 'worker' });
});
afterEach(() => d.cleanup());

type Kind = 'Epic' | 'Story' | 'Task' | 'Bug';
const create = (type: Kind, opts: { epic?: string; status?: Status; title?: string } = {}) => {
  const { id } = d.write(producer, (w, s) =>
    s.items.create(w, {
      project: 'TST',
      type,
      title: opts.title ?? `Synthetic ${type.toLowerCase()}`,
      priority: 2,
      ...(opts.status === 'inbox' || opts.status === undefined ? {} : { status: 'planning' }),
      ...(opts.epic ? { epic: opts.epic } : {}),
    }),
  );
  declareNone(d, id);
  if (opts.status && opts.status !== 'inbox' && opts.status !== 'planning') {
    forceStatus(d, id, opts.status);
  }
  return id;
};
const version = (id: string) =>
  d.row<{ version: number }>('SELECT version FROM items WHERE id = ?', id).version;
const status = (id: string) =>
  d.row<{ status: Status }>('SELECT status FROM items WHERE id = ?', id).status;
const claim = (id: string, actor = worker) =>
  d.write(actor, (w, s) => s.runs.claim(w, { id, agent_label: 'worker' })).run_id;
const detail = (id: string) => d.services.views.itemDetail(d.read(), { id });
const lastMutation = () =>
  d.row<{ mutation_id: string }>('SELECT mutation_id FROM events ORDER BY seq DESC LIMIT 1')
    .mutation_id;
const needsYou = () => d.services.views.needsYou(d.read(), { scope: 'TST' });

/** An epic with one Ready ticket, started by its lead's claim; then a minute passes. */
function startedEpic() {
  const epic = create('Epic', { status: 'ready' });
  const before = create('Task', { epic, status: 'ready' });
  claim(epic, producer);
  expect(status(epic)).toBe('progress');
  d.clock.advance(60_000);
  return { epic, before };
}

describe('tickets added after the epic started', () => {
  it('marks a ticket created in, or moved into, a started epic; never the ones from before, or a split', () => {
    const { epic, before } = startedEpic();
    const bug = create('Bug', { epic, title: 'Synthetic crash on save' });
    const loose = create('Story', { title: 'Synthetic loose story' });
    d.write(producer, (w, s) => s.items.update(w, { id: loose, expected_version: version(loose), epic }));

    const m = detail(epic).epic_midflight!;
    expect(m.added.map((t) => [t.id, t.untriaged])).toEqual([
      [bug, true],
      [loose, true],
    ]);
    expect(m.untriaged).toBe(2);
    expect(m.added.map((t) => t.id)).not.toContain(before);

    // The epic card and the map's work items say the same.
    const work = d.services.views.work(d.read(), { scope: 'TST', layout: 'map' } as never);
    expect(work.epics.find((e) => e.id === epic)!.midflight!.untriaged).toBe(2);
    const flagged = work.items.filter((i) => i.added_midflight).map((i) => i.id);
    expect(flagged.sort()).toEqual([bug, loose].sort());

    // A ticket's page isn't an epic's: nothing there.
    expect(detail(bug).epic_midflight).toBeUndefined();
  });

  it('an epic that has not started marks nothing', () => {
    const epic = create('Epic', { status: 'ready' });
    create('Bug', { epic });
    expect(detail(epic).epic_midflight).toBeUndefined();
  });

  it('get_digest lists "Added since this epic started: N untriaged" with the tickets, within its cap', () => {
    const { epic } = startedEpic();
    const bug = create('Bug', { epic });
    const story = create('Story', { epic });
    const digest = d.services.digest.get(d.read(producer), { project: 'TST' });
    expect(digest.untriaged_epics).toEqual({
      total: 1,
      rows: [
        {
          id: epic,
          title: 'Synthetic epic',
          untriaged: [
            { id: bug, type: 'Bug' },
            { id: story, type: 'Story' },
          ],
        },
      ],
    });
    const text = renderResult('get_digest', digest, { now: d.clock.now() });
    expect(text).toContain('added mid-flight 1:');
    expect(text).toContain(
      `- ${epic} added since this epic started: 2 untriaged: ${bug} bug, ${story} story`,
    );
    expect(text.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);

    // Triaged (the bug to Ready, the story deferred out of the epic): the section goes away.
    d.write(producer, (w, s) => s.items.setStatus(w, { id: bug, status: 'planning' }));
    declareNone(d, bug);
    d.write(producer, (w, s) => s.items.setStatus(w, { id: bug, status: 'ready' }));
    d.write(producer, (w, s) =>
      s.items.update(w, { id: story, expected_version: version(story), epic: null }),
    );
    expect(d.services.digest.get(d.read(producer), { project: 'TST' }).untriaged_epics).toBe(
      undefined,
    );
    // Still marked as added mid-flight, now triaged.
    expect(detail(epic).epic_midflight!.added.map((t) => [t.id, t.untriaged])).toEqual([
      [bug, false],
    ]);
  });

  it('refuses Done while untriaged tickets added mid-flight are in the epic, listing them', () => {
    const { epic, before } = startedEpic();
    const bug = create('Bug', { epic });
    forceStatus(d, before, 'done');
    const err = d.fails(
      producer,
      (w, s) => s.items.setStatus(w, { id: epic, status: 'done' }),
      'validation',
    );
    expect(err.message).toContain(`Can't close epic ${epic}`);
    expect(err.message).toContain(`${bug} (bug)`);
    expect(err.message).toContain('a story needs the owner');
    expect(err.details!.untriaged).toEqual([{ id: bug, title: 'Synthetic bug', type: 'Bug' }]);

    // Triaged and finished: the epic closes.
    d.write(producer, (w, s) => s.items.setStatus(w, { id: bug, status: 'planning' }));
    forceStatus(d, bug, 'done');
    d.write(producer, (w, s) => s.items.setStatus(w, { id: epic, status: 'done' }));
    expect(status(epic)).toBe('done');
  });

  it('a bug that belongs elsewhere moves to that epic, which marks it there', () => {
    const { epic } = startedEpic();
    const reliability = create('Epic', { status: 'ready', title: 'Synthetic test reliability' });
    claim(reliability, producer);
    d.clock.advance(60_000);
    const flaky = create('Bug', { epic, title: 'Synthetic flaky test' });
    d.write(producer, (w, s) =>
      s.items.update(w, { id: flaky, expected_version: version(flaky), epic: reliability }),
    );
    expect(detail(epic).epic_midflight).toBeUndefined();
    expect(detail(reliability).epic_midflight!.added.map((t) => t.id)).toEqual([flaky]);
  });
});

describe('idle In progress tickets', () => {
  /** A ticket In progress whose lead run is in `state` (or ended). */
  function inProgress(runState: 'open' | 'parked' | 'needs_input' | 'ended' = 'ended') {
    const id = create('Task', { status: 'ready' });
    const run = claim(id);
    if (runState === 'ended') {
      d.sql.prepare("UPDATE runs SET state = 'interrupted' WHERE id = ?").run(run);
    } else if (runState !== 'open') {
      d.sql.prepare('UPDATE runs SET state = ? WHERE id = ?').run(runState, run);
    }
    expect(status(id)).toBe('progress');
    return { id, run };
  }
  const idleIds = () => [
    ...idleTickets(d.server.runtime.db, d.clock.now().toISOString()).keys(),
  ];

  it('is idle after 3 days with no run and no activity, with one problem for the owner', () => {
    const { id } = inProgress();
    d.clock.advance(IDLE_AFTER_MS - 60_000);
    expect(idleIds()).toEqual([]);
    d.clock.advance(60_000);
    expect(idleIds()).toEqual([id]);

    const problems = needsYou().problems.filter((p) => p.kind === 'idle_ticket');
    expect(problems).toHaveLength(1);
    expect(problems[0]!.id).toBe(`idle_ticket:${id}`);
    expect(problems[0]!.reason).toBe(
      `${id} is In progress but nobody has worked on it since Nov 24`,
    );
    expect(problems[0]!.explanation!.who).toBe('owner');
    expect(problems[0]!.explanation!.fix).toContain(
      'Move it to Planning, Ready or Inbox, cancel it, or clear its branches',
    );
    expect(detail(id).problems!.map((p) => p.kind)).toContain('idle_ticket');
  });

  it.each(['open', 'parked', 'needs_input'] as const)('a %s run keeps it live', (state) => {
    const { id } = inProgress(state);
    d.clock.advance(IDLE_AFTER_MS * 2);
    expect(idleIds()).not.toContain(id);
    expect(needsYou().problems.map((p) => p.id)).not.toContain(`idle_ticket:${id}`);
  });

  it('activity by an agent or the owner resets the clock; Docket’s own events do not', () => {
    const { id } = inProgress();
    d.clock.advance(2 * DAY);
    d.write(worker, (w, s) =>
      s.items.update(w, { id, expected_version: version(id), title: 'Synthetic task, renamed' }),
    );
    d.clock.advance(2 * DAY);
    expect(idleIds()).toEqual([]);
    d.clock.advance(DAY);
    expect(idleIds()).toEqual([id]);
    // A Docket (system) event on it isn't activity.
    d.server.runtime.write.run(
      { actor: { kind: 'system', client: null, label: null }, operation: 'test', args: {} },
      (w) =>
        w.event({
          type: 'branch.discovered',
          summary: 'Synthetic discovery',
          item_id: id,
          project_key: 'TST',
          data: {},
        }),
    );
    expect(idleIds()).toEqual([id]);
  });

  it('an epic In progress is never idle', () => {
    const epic = create('Epic', { status: 'progress' });
    d.clock.advance(IDLE_AFTER_MS * 2);
    expect(idleIds()).not.toContain(epic);
  });

  it.each(['ready', 'planning', 'inbox'] as const)('Move it to %s, undoably', (to) => {
    const { id } = inProgress();
    d.clock.advance(IDLE_AFTER_MS);
    d.write(OWNER, (w, s) => s.archive.settleIdle(w, { id, action: to }));
    expect(status(id)).toBe(to);
    expect(needsYou().problems.map((p) => p.id)).not.toContain(`idle_ticket:${id}`);
    undoMutation(d.server.runtime.write, lastMutation());
    expect(status(id)).toBe('progress');
  });

  it('Cancel it', () => {
    const { id } = inProgress();
    d.clock.advance(IDLE_AFTER_MS);
    d.write(OWNER, (w, s) => s.archive.settleIdle(w, { id, action: 'cancel' }));
    expect(status(id)).toBe('canceled');
  });

  it('Clear its branches marks them not active and clears their findings', () => {
    const { id } = inProgress();
    d.sql
      .prepare('UPDATE items SET branches = ? WHERE id = ?')
      .run(JSON.stringify([{ name: 'tst-old-draft', by: 'worker', at: '2026-11-20T00:00:00.000Z' }]), id);
    d.clock.advance(IDLE_AFTER_MS);
    d.write(OWNER, (w, s) => s.archive.settleIdle(w, { id, action: 'clear_branches' }));
    const stored = JSON.parse(
      d.row<{ branches: string }>('SELECT branches FROM items WHERE id = ?', id).branches,
    ) as { name: string; removed?: boolean }[];
    expect(stored).toEqual([expect.objectContaining({ name: 'tst-old-draft', removed: true })]);
    expect(status(id)).toBe('progress');
    undoMutation(d.server.runtime.write, lastMutation());
    expect(
      JSON.parse(d.row<{ branches: string }>('SELECT branches FROM items WHERE id = ?', id).branches),
    ).toEqual([expect.not.objectContaining({ removed: true })]);
  });

  it('is refused once an agent is on it again', () => {
    const { id, run } = inProgress();
    d.clock.advance(IDLE_AFTER_MS);
    d.sql.prepare("UPDATE runs SET state = 'open' WHERE id = ?").run(run);
    d.fails(OWNER, (w, s) => s.archive.settleIdle(w, { id, action: 'ready' }), 'conflict');
    expect(status(id)).toBe('progress');
  });

  it('the radar skips its branches, and the sweeper clears findings and overlaps against it, saying why', () => {
    const { id: idle } = inProgress();
    const { id: live } = inProgress('open');
    const t = d.clock.now().toISOString();
    d.sql
      .prepare(
        `INSERT INTO radar_findings (id, project_key, branch_a, branch_b, item_a, item_b, files, seen_at, created_at, updated_at)
         VALUES ('rdf_b79', 'TST', 'tst-a', 'tst-b', ?, ?, '["src/a.ts"]', ?, ?, ?)`,
      )
      .run(idle, live, t, t, t);
    const [a, b] = [idle, live].sort() as [string, string];
    d.sql
      .prepare(
        `INSERT INTO part_overlaps (id, project_key, item_a, item_b, parts, claimed_first, state, raised_at, created_at, updated_at, version)
         VALUES ('pov_b79', 'TST', ?, ?, '["file:src/a.ts"]', ?, 'open', ?, ?, ?, 1)`,
      )
      .run(a, b, a, t, t, t);

    // Not idle yet: nothing changes.
    expect(idleOnce(d.server.runtime)).toEqual({ findings: [], overlaps: [] });
    d.clock.advance(IDLE_AFTER_MS);
    // The live one's run keeps signalling (a claim renews it).
    expect(inFlightItems(d.server.runtime.db, 'TST', d.clock.now().toISOString()).map((i) => i.id)).toEqual([
      live,
    ]);
    expect(idleOnce(d.server.runtime)).toEqual({ findings: ['rdf_b79'], overlaps: ['pov_b79'] });
    expect(
      d.row<{ cleared_at: string | null }>("SELECT cleared_at FROM radar_findings WHERE id = 'rdf_b79'")
        .cleared_at,
    ).not.toBeNull();
    expect(d.row<{ state: string }>("SELECT state FROM part_overlaps WHERE id = 'pov_b79'").state).toBe(
      'resolved',
    );
    const said = d.rows<{ item_id: string; summary: string }>(
      "SELECT item_id, summary FROM events WHERE type IN ('radar.cleared', 'overlap.decided') ORDER BY seq",
    );
    expect(said).toContainEqual({
      item_id: live,
      summary: `No longer heading for a conflict with ${idle}: the other ticket is idle`,
    });
    expect(said).toContainEqual({
      item_id: idle,
      summary: `No longer heading for a conflict with ${live}: this ticket is idle`,
    });
    expect(said.some((e) => e.item_id === live && e.summary.includes('the other ticket is idle'))).toBe(
      true,
    );
    // A second pass has nothing left to clear.
    expect(idleOnce(d.server.runtime)).toEqual({ findings: [], overlaps: [] });
    // And Docket's events don't wake the idle ticket up.
    expect(idleIds()).toContain(idle);
  });

  it('a claim’s overlap check doesn’t count an idle ticket as in flight', () => {
    const declare = (id: string, register: boolean) =>
      d.write(producer, (w, s) =>
        s.sharedChanges.declare(w, {
          id,
          changes: [{ part: 'file:src/shared.ts', change: 'change', note: 'Synthetic change.' }],
          ...(register ? { new_parts: [{ key: 'file:src/shared.ts' }] } : {}),
        } as never),
      );
    const { id: idle } = inProgress();
    declare(idle, true);
    const next = create('Task', { status: 'ready' });
    declare(next, false);
    const item = { id: next, project_key: 'TST' };
    expect(claimOverlaps(d.server.runtime.db, item, d.clock.now().toISOString())).toHaveLength(1);
    d.clock.advance(IDLE_AFTER_MS);
    expect(claimOverlaps(d.server.runtime.db, item, d.clock.now().toISOString())).toEqual([]);
  });
});

describe('acknowledged problems', () => {
  it('leave Needs you and the Has problems filter, and stay on the item marked acknowledged', () => {
    const id = create('Task', { status: 'ready' });
    const run = claim(id);
    d.sql.prepare("UPDATE runs SET state = 'interrupted' WHERE id = ?").run(run);
    d.clock.advance(IDLE_AFTER_MS);
    const problemId = `idle_ticket:${id}`;
    d.write(OWNER, (w, s) => s.problems.acknowledge(w, { problem_id: problemId }));

    const view = needsYou();
    expect(view.problems.map((p) => p.id)).not.toContain(problemId);
    expect(view.acknowledged!.map((p) => p.id)).toContain(problemId);
    const banner = detail(id).problems!.find((p) => p.id === problemId)!;
    expect(banner.acknowledged).toEqual({ by: 'owner', at: expect.any(String) });
    const filtered = d.services.views.work(d.read(), {
      scope: 'TST',
      layout: 'list',
      has: 'has_problem',
    } as never);
    expect(filtered.items.map((i) => i.id)).not.toContain(id);

    // Still acknowledged later: nobody has touched it, and acknowledging isn't activity.
    d.clock.advance(DAY);
    expect(needsYou().acknowledged!.map((p) => p.id)).toContain(problemId);
  });

  it('come back as open with a new proposed resolution', () => {
    const blocker = create('Task', { status: 'ready' });
    const blocked = create('Task', { status: 'ready' });
    d.write(producer, (w, s) => s.links.link(w, { from: blocker, to: blocked, type: 'blocks' }));
    d.write(OWNER, (w, s) =>
      s.archive.cancel(w, { id: blocker, expected_version: version(blocker) }),
    );
    const problem = needsYou().problems.find((p) => p.kind === 'canceled_blocker')!;
    d.write(OWNER, (w, s) => s.problems.acknowledge(w, { problem_id: problem.id! }));
    expect(needsYou().problems.map((p) => p.id)).not.toContain(problem.id);
    expect(detail(blocked).problems!.find((p) => p.id === problem.id)!.acknowledged).not.toBeNull();

    d.clock.advance(60_000);
    d.write(worker, (w, s) =>
      s.problems.propose(w, {
        problem: problem.id!,
        kind: 'other',
        plan_md: 'Synthetic plan: remove the link.',
        reason: 'Synthetic reason.',
      }),
    );
    expect(needsYou().problems.map((p) => p.id)).toContain(problem.id);
    expect(detail(blocked).problems!.find((p) => p.id === problem.id)!.acknowledged).toBeNull();
  });
});
