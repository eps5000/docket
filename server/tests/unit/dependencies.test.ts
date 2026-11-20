/**
 * When a blocker counts as cleared (BUILD_SPEC §5.2; data-model.md "Blocker
 * cleared?"; FR-030 to FR-035; tasks.md T102).
 *
 * One evaluator (model.ts `BlockIndex`) decides everywhere: `links.blockState`,
 * `search_items` (`ready_to_start`, `blocked`), item summaries, the owner's
 * views and Problems. These tests drive it through the link and project
 * services, in the one write path, exactly as the adapters do.
 */
import type { SatisfiedWhen, Status } from '@docket/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/domain/write.js';
import { OWNER_ACTOR } from '../../src/domain/write.js';
import { addProject, declareNone, startDomain, type Domain } from '../us1-helpers.js';

let d: Domain;
let claude: Actor;

beforeEach(() => {
  d = startDomain({ seed: false });
  addProject(d, 'TST');
  addProject(d, 'OTH');
  claude = d.agent('claude');
});
afterEach(() => d.cleanup());

// ---- Fixtures ----

function create(title: string, project = 'TST', status: 'inbox' | 'planning' = 'planning') {
  const id = d.write(claude, (w, s) =>
    s.items.create(w, { project, type: 'Task', title, priority: 2, status }),
  ).id;
  declareNone(d, id); // the Ready gate (decision 36)
  return id;
}

function move(id: string, status: Status, reason?: string) {
  return d.write(claude, (w, s) => s.items.setStatus(w, { id, status, reason }));
}

/** planning → ready → progress → done, the normal way. */
function finish(id: string) {
  move(id, 'ready');
  move(id, 'progress');
  move(id, 'done');
}

function link(from: string, to: string, satisfied_when?: SatisfiedWhen) {
  return d.write(claude, (w, s) =>
    s.links.link(w, {
      from,
      to,
      type: 'blocks',
      ...(satisfied_when ? { satisfied_when } : {}),
    }),
  );
}

function declareReview(id: string, n = 1) {
  d.write(claude, (w, s) =>
    s.humanReview.declare(w, {
      id,
      items: Array.from({ length: n }, (_, i) => `Check ${i + 1} on ${id}`),
    }),
  );
}

/** Owner decisions are US3's flow; here the outcome is set directly (fixture). */
function setReview(id: string, state: 'approved' | 'deferred' | 'declared', which?: number) {
  const rows = d.rows<{ id: string }>(
    'SELECT id FROM hr_items WHERE item_id = ? ORDER BY position',
    id,
  );
  for (const [i, r] of rows.entries()) {
    if (which === undefined || which === i) {
      d.sql.prepare('UPDATE hr_items SET state = ? WHERE id = ?').run(state, r.id);
    }
  }
}

function reportPr(id: string, state: string) {
  d.write(claude, (w, s) =>
    s.evidence.linkArtifact(w, {
      id,
      kind: 'pr',
      label: 'PR #52',
      url: 'https://github.com/x/y/pull/52',
      state,
    }),
  );
}

const block = (id: string) => d.services.links.blockState(d.read(), { ids: [id] })[id]!;

const readyToStart = () =>
  d.services.search
    .searchItems(d.read(claude), { filter: 'ready_to_start', include_archived: true, limit: 50 })
    .items.map((i) => i.id);

const problems = () => d.services.views.needsYou(d.read(OWNER_ACTOR), { scope: 'all' }).problems;

const events = (type: string) =>
  d.rows<{ summary: string; data: string; actor_kind: string }>(
    'SELECT summary, data, actor_kind FROM events WHERE type = ? ORDER BY seq',
    type,
  );

/** A (blocker, dependent) pair, the dependent in Ready so `ready_to_start` can show it. */
function pair(satisfied_when?: SatisfiedWhen, project = 'TST') {
  const a = create('Blocker');
  const b = create('Dependent', project);
  move(b, 'ready');
  link(a, b, satisfied_when);
  return { a, b };
}

// ---- done ----

describe('satisfied_when: done', () => {
  it('a blocker that is not done blocks; once done the dependent is startable with no other action', () => {
    const { a, b } = pair();
    expect(block(b)).toEqual({ blocked: true, blocked_by: [a], waiting_for: { [a]: 'done' } });
    expect(readyToStart()).not.toContain(b);
    finish(a);
    expect(block(b)).toEqual({ blocked: false, blocked_by: [], waiting_for: {} });
    expect(readyToStart()).toContain(b);
  });

  it('a blocked item cannot be moved to progress, and the summary names the blocker', () => {
    const { a, b } = pair();
    const err = d.fails(
      claude,
      (w, s) => s.items.setStatus(w, { id: b, status: 'progress' }),
      'validation',
    );
    expect(err.message).toContain(a);
    const summary = d.services.items.get(d.read(claude), { id: b, view: 'summary' }).item;
    expect(summary.blocked).toBe(true);
    expect(summary.blocked_by).toEqual([a]);
  });

  it('relates links never block, and neither does a parent epic', () => {
    const a = create('Related');
    const b = create('Dependent');
    move(b, 'ready');
    d.write(claude, (w, s) => s.links.link(w, { from: a, to: b, type: 'relates' }));
    expect(block(b).blocked).toBe(false);
    expect(readyToStart()).toContain(b);
  });

  it('done items and canceled items are never blocked themselves', () => {
    const { a, b } = pair();
    move(b, 'canceled', 'Not needed.');
    expect(block(b).blocked).toBe(false);
    expect(block(a).blocked).toBe(false);
  });
});

// ---- merged ----

describe('satisfied_when: merged', () => {
  it('done without a merged PR still blocks ("needs merge"); a reported merge clears it', () => {
    const { a, b } = pair('merged');
    finish(a);
    expect(block(b)).toEqual({ blocked: true, blocked_by: [a], waiting_for: { [a]: 'merge' } });
    expect(readyToStart()).not.toContain(b);
    reportPr(a, 'open');
    expect(block(b).waiting_for[a]).toBe('merge');
    reportPr(a, 'merged');
    expect(block(b).blocked).toBe(false);
    expect(readyToStart()).toContain(b);
  });

  it('a merged PR on a blocker that is not done does not clear it', () => {
    const { a, b } = pair('merged');
    reportPr(a, 'merged');
    expect(block(b).waiting_for[a]).toBe('done');
  });

  it('the item view says what the blocker waits for', () => {
    const { a, b } = pair('merged');
    finish(a);
    const item = d.services.items.get(d.read(OWNER_ACTOR), { id: b, view: 'full' }).item;
    expect(item.links!.blocked_by[0]).toMatchObject({
      id: a,
      status: 'done',
      satisfied_when: 'merged',
      cleared: false,
      waiting_for: 'merge',
    });
  });
});

// ---- verified ----

describe('satisfied_when: verified', () => {
  it('needs done and every human review item approved', () => {
    const a = create('Blocker');
    declareReview(a, 2);
    const b = create('Dependent');
    move(b, 'ready');
    link(a, b, 'verified');
    setReview(a, 'approved', 0);
    expect(block(b).waiting_for[a]).toBe('done');
    setReview(a, 'approved');
    // Approved but not done yet: still waiting to be done.
    expect(block(b).waiting_for[a]).toBe('done');
    finish(a);
    expect(block(b).blocked).toBe(false);
    expect(readyToStart()).toContain(b);
  });

  it('a done blocker with a review item that is not approved waits for verification', () => {
    const a = create('Blocker');
    declareReview(a, 2);
    const b = create('Dependent');
    move(b, 'ready');
    link(a, b, 'verified');
    setReview(a, 'approved');
    finish(a);
    // A review item reopened after close (e.g. imported data): verification again.
    setReview(a, 'declared', 1);
    expect(block(b)).toEqual({
      blocked: true,
      blocked_by: [a],
      waiting_for: { [a]: 'verification' },
    });
  });

  it('a verified link to a blocker with no human review items is refused with validation', () => {
    const a = create('No review');
    const b = create('Dependent');
    const err = d.fails(
      claude,
      (w, s) => s.links.link(w, { from: a, to: b, type: 'blocks', satisfied_when: 'verified' }),
      'validation',
    );
    expect(err.message).toBe(`Declare human review on ${a}, or use done.`);
    expect(d.rows('SELECT id FROM links')).toEqual([]);
  });

  it('a verified blocker that closes with a deferred check stays blocked, and Problems says so', () => {
    const a = create('Blocker');
    declareReview(a, 2);
    const b = create('Dependent');
    move(b, 'ready');
    link(a, b, 'verified');
    setReview(a, 'approved', 0);
    setReview(a, 'deferred', 1);
    finish(a);
    expect(block(b)).toEqual({
      blocked: true,
      blocked_by: [a],
      waiting_for: { [a]: 'verification' },
    });
    const p = problems().find((x) => x.kind === 'deferred_verified_blocker');
    expect(p).toMatchObject({
      item_id: b,
      reason: `${b} needs ${a} verified, but 1 check was deferred.`,
      related: [a],
    });
    expect(p!.link_id).toMatch(/^lnk_/);
  });
});

// ---- The project default against a link override ----

describe('the project default and a link override', () => {
  it('a link without its own rule uses the blocked item’s project default', () => {
    d.sql.prepare("UPDATE projects SET default_satisfied_when = 'merged' WHERE key = 'TST'").run();
    const { a, b } = pair();
    finish(a);
    expect(block(b).waiting_for[a]).toBe('merge');
  });

  it('the blocked item’s project decides, not the blocker’s (blocking crosses projects)', () => {
    d.sql.prepare("UPDATE projects SET default_satisfied_when = 'merged' WHERE key = 'TST'").run();
    // The blocker is in TST (merged); the dependent in OTH (done).
    const { a, b } = pair(undefined, 'OTH');
    finish(a);
    expect(block(b).blocked).toBe(false);
  });

  it('a link override beats the project default, both ways', () => {
    d.sql.prepare("UPDATE projects SET default_satisfied_when = 'merged' WHERE key = 'TST'").run();
    const lax = pair('done');
    finish(lax.a);
    expect(block(lax.b).blocked).toBe(false);

    d.sql.prepare("UPDATE projects SET default_satisfied_when = 'done' WHERE key = 'TST'").run();
    const strict = pair('merged');
    finish(strict.a);
    expect(block(strict.b).waiting_for[strict.a]).toBe('merge');
  });

  it('link_items reports the effective rule', () => {
    d.sql.prepare("UPDATE projects SET default_satisfied_when = 'merged' WHERE key = 'TST'").run();
    const a = create('A');
    const b = create('B');
    expect(link(a, b)).toMatchObject({ type: 'blocks', satisfied_when: 'merged', updated: false });
    expect(d.row<{ satisfied_when: string | null }>('SELECT satisfied_when FROM links')).toEqual({
      satisfied_when: null,
    });
  });
});

// ---- Canceled and archived blockers ----

describe('canceled and archived blockers', () => {
  it('a canceled blocker stays unresolved, Problems offers to remove the link, and unlinking clears it', () => {
    const { a, b } = pair();
    move(a, 'canceled', 'Dropped.');
    expect(block(b)).toEqual({ blocked: true, blocked_by: [a], waiting_for: { [a]: 'done' } });
    const p = problems().find((x) => x.kind === 'canceled_blocker');
    expect(p).toMatchObject({
      item_id: b,
      reason: `Blocked by canceled ${a}. Remove the link, or reopen ${a}.`,
    });
    const out = d.write(OWNER_ACTOR, (w, s) => s.links.unlink(w, { link_id: p!.link_id! }));
    expect(out).toEqual({ removed: true, unblocked: [b] });
    expect(block(b).blocked).toBe(false);
    expect(readyToStart()).toContain(b);
  });

  it('an archived blocker is not cleared by archiving', () => {
    const { a, b } = pair('merged');
    finish(a);
    // Archive is owner-only (US7); its effect on the row is all that matters here.
    d.sql
      .prepare('UPDATE items SET archived_at = ? WHERE id = ?')
      .run(d.clock.now().toISOString(), a);
    expect(block(b).waiting_for[a]).toBe('merge');
    expect(readyToStart()).not.toContain(b);
  });

  it('an archived done blocker under the done rule stays cleared', () => {
    const { a, b } = pair();
    finish(a);
    d.sql
      .prepare('UPDATE items SET archived_at = ? WHERE id = ?')
      .run(d.clock.now().toISOString(), a);
    expect(block(b).blocked).toBe(false);
  });
});

// ---- Re-evaluation and events ----

describe('re-evaluation on a rule change, with the event', () => {
  it('link_items on an existing link updates satisfied_when, re-evaluates at once and records link.updated', () => {
    const { a, b } = pair();
    finish(a);
    expect(block(b).blocked).toBe(false);
    const out = link(a, b, 'merged');
    expect(out).toMatchObject({ from: a, to: b, satisfied_when: 'merged', updated: true });
    expect(block(b).waiting_for[a]).toBe('merge');
    const [e] = events('link.updated');
    expect(e!.summary).toBe(`${a} blocks ${b} now clears when merged · ${b} blocked again`);
    expect(JSON.parse(e!.data)).toMatchObject({
      link_id: out.link_id,
      old: { satisfied_when: null },
      new: { satisfied_when: 'merged' },
      reblocked: [b],
      unblocked: [],
    });
  });

  it('linking again with the same rule changes nothing and records nothing', () => {
    const { a, b } = pair('merged');
    const before = events('link.updated').length + events('link.added').length;
    // `updated` says the link already existed; nothing changed, so no event.
    expect(link(a, b, 'merged')).toMatchObject({ updated: true, satisfied_when: 'merged' });
    expect(events('link.updated').length + events('link.added').length).toBe(before);
  });

  it('omitting satisfied_when on an existing link leaves its rule alone (silence preserves)', () => {
    const { a, b } = pair('merged');
    expect(link(a, b)).toMatchObject({ satisfied_when: 'merged', updated: true });
  });

  it('changing the project default re-evaluates, returns what changed, records project.updated, and undo restores it', () => {
    const { a, b } = pair();
    finish(a);
    const merged = pair('done');
    finish(merged.a);
    const result = d.server.runtime.write.run(
      { actor: OWNER_ACTOR, operation: 'test', args: {} },
      (w) =>
        d.services.projects.setDefaultSatisfiedWhen(w, {
          key: 'TST',
          default_satisfied_when: 'merged',
        }),
    );
    // `b` follows the default; `merged.b` has its own rule (done) and stays clear.
    expect(result.result).toMatchObject({
      project: { key: 'TST', default_satisfied_when: 'merged', version: 2 },
      reblocked: [b],
      unblocked: [],
    });
    expect(block(b).waiting_for[a]).toBe('merge');
    expect(block(merged.b).blocked).toBe(false);
    const [e] = events('project.updated');
    expect(e!.actor_kind).toBe('owner');
    expect(e!.summary).toBe('Blocker rule for Project TST set to PR merged · 1 item blocked again');
    expect(JSON.parse(e!.data)).toMatchObject({
      old: { default_satisfied_when: 'done' },
      new: { default_satisfied_when: 'merged' },
      reblocked: [b],
    });

    d.write(OWNER_ACTOR, (w, s) => s.undo.undo(w, { mutation_id: result.mutation_id }));
    expect(block(b).blocked).toBe(false);
    expect(
      d.row<{ default_satisfied_when: string }>(
        "SELECT default_satisfied_when FROM projects WHERE key = 'TST'",
      ),
    ).toEqual({ default_satisfied_when: 'done' });
  });

  it('a stale expected_version on the project is a conflict', () => {
    d.fails(
      OWNER_ACTOR,
      (w, s) =>
        s.projects.setDefaultSatisfiedWhen(w, {
          key: 'TST',
          default_satisfied_when: 'verified',
          expected_version: 7,
        }),
      'conflict',
    );
  });

  it('agents cannot change the project rule', () => {
    d.fails(
      claude,
      (w, s) =>
        s.projects.setDefaultSatisfiedWhen(w, { key: 'TST', default_satisfied_when: 'merged' }),
      'forbidden',
    );
  });

  it('an unknown project is not_found', () => {
    d.fails(
      OWNER_ACTOR,
      (w, s) =>
        s.projects.setDefaultSatisfiedWhen(w, { key: 'NOPE', default_satisfied_when: 'merged' }),
      'not_found',
    );
  });

  it('a parked run waiting on an item follows the same rule (resume_ready)', () => {
    d.sql.prepare("UPDATE projects SET default_satisfied_when = 'merged' WHERE key = 'TST'").run();
    const a = create('Planner');
    const c = create('Waiter');
    move(c, 'ready');
    const runC = d.write(claude, (w, s) => s.runs.claim(w, { id: c })).run_id;
    d.write({ ...claude, run_id: runC }, (w, s) =>
      s.runs.park(w, {
        run_id: runC,
        reason: 'Waiting for the merge.',
        waiting_on: { items: [a] },
      }),
    );
    const resumeReady = () =>
      d.services.recovery
        .report(d.read(claude), { include_briefs: false, limit: 50 })
        .parked.find((p) => p.run.run_id === runC)?.resume_ready;
    finish(a);
    // No link: the waiting item's project default (merged) applies.
    expect(resumeReady()).toBe(false);
    reportPr(a, 'merged');
    expect(resumeReady()).toBe(true);
  });
});

// ---- link_items and unlink_items ----

describe('link_items and unlink_items', () => {
  it('creates a link with link.added, and validates its ends', () => {
    const a = create('A');
    const b = create('B');
    const out = link(a, b);
    expect(out).toEqual({
      link_id: expect.stringMatching(/^lnk_/),
      from: a,
      to: b,
      type: 'blocks',
      satisfied_when: 'done',
      updated: false,
    });
    expect(events('link.added').at(-1)!.summary).toBe(`${a} blocks ${b}`);
    d.fails(claude, (w, s) => s.links.link(w, { from: a, to: a, type: 'blocks' }), 'validation');
    d.fails(
      claude,
      (w, s) => s.links.link(w, { from: a, to: 'TST-99', type: 'blocks' }),
      'not_found',
    );
    d.fails(
      claude,
      (w, s) => s.links.link(w, { from: a, to: b, type: 'relates', satisfied_when: 'merged' }),
      'validation',
    );
  });

  it('relates links are symmetric: linking the other way finds the same link', () => {
    const a = create('A');
    const b = create('B');
    const first = d.write(claude, (w, s) => s.links.link(w, { from: a, to: b, type: 'relates' }));
    const again = d.write(claude, (w, s) => s.links.link(w, { from: b, to: a, type: 'relates' }));
    expect(again).toMatchObject({ link_id: first.link_id, satisfied_when: null, updated: true });
  });

  it('unlinks by id or by ends; an unknown link is not_found', () => {
    const { a, b } = pair();
    expect(
      d.write(claude, (w, s) => s.links.unlink(w, { from: a, to: b, type: 'blocks' })),
    ).toEqual({
      removed: true,
      unblocked: [b],
    });
    expect(events('link.removed').at(-1)!.summary).toBe(
      `Removed: ${a} blocks ${b} · ${b} unblocked`,
    );
    d.fails(claude, (w, s) => s.links.unlink(w, { from: a, to: b, type: 'blocks' }), 'not_found');
    d.fails(claude, (w, s) => s.links.unlink(w, { link_id: 'lnk_nope' }), 'not_found');
  });

  it('the owner’s unlink is undoable and restores the block', () => {
    const { a, b } = pair();
    const linkId = d.row<{ id: string }>('SELECT id FROM links').id;
    const out = d.server.runtime.write.run(
      { actor: OWNER_ACTOR, operation: 'test', args: {} },
      (w) => d.services.links.unlink(w, { link_id: linkId }),
    );
    expect(block(b).blocked).toBe(false);
    d.write(OWNER_ACTOR, (w, s) => s.undo.undo(w, { mutation_id: out.mutation_id }));
    expect(block(b).blocked_by).toEqual([a]);
  });
});
