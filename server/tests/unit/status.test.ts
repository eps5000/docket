/**
 * Status transitions (BUILD_SPEC §5.1; FR-003 to FR-005; tasks.md T064).
 * Every guard runs in the domain layer, inside the mutation's transaction.
 */
import type { ItemSummary, Status } from '@docket/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/domain/write.js';
import { OWNER_ACTOR } from '../../src/domain/write.js';
import { addProject, forceStatus, startDomain, type Domain } from '../us1-helpers.js';

let d: Domain;
let claude: Actor;
let codex: Actor;

beforeEach(() => {
  d = startDomain({ seed: false });
  addProject(d, 'TST');
  claude = d.agent('claude');
  codex = d.agent('codex');
});
afterEach(() => d.cleanup());

function create(
  title: string,
  extra: Partial<{
    type: 'Epic' | 'Story' | 'Task' | 'Bug';
    epic: string;
    blocked_by: string[];
  }> = {},
): ItemSummary {
  return d.write(claude, (w, s) =>
    s.items.create(w, {
      project: 'TST',
      type: extra.type ?? 'Task',
      title,
      priority: 2,
      status: 'inbox',
      ...(extra.epic ? { epic: extra.epic } : {}),
      ...(extra.blocked_by ? { blocked_by: extra.blocked_by } : {}),
    }),
  );
}

function move(id: string, status: Status, actor: Actor = claude, reason?: string) {
  return d.write(actor, (w, s) => s.items.setStatus(w, { id, status, reason }));
}

function moveFails(id: string, status: Status, code = 'validation' as const, reason?: string) {
  return d.fails(claude, (w, s) => s.items.setStatus(w, { id, status, reason }), code);
}

function claim(id: string, actor: Actor = claude) {
  return d.write(actor, (w, s) => s.runs.claim(w, { id }));
}

/** An item walked to `status` the normal way. */
function itemIn(status: Status, title = `In ${status}`): string {
  const { id } = create(title);
  if (status === 'inbox') return id;
  move(id, 'planning');
  if (status === 'planning') return id;
  move(id, 'ready');
  if (status === 'ready') return id;
  move(id, 'progress');
  if (status === 'progress') return id;
  if (status === 'review') {
    forceStatus(d, id, 'review');
    return id;
  }
  if (status === 'done') {
    move(id, 'done');
    return id;
  }
  move(id, 'canceled', claude, 'Not needed.');
  return id;
}

const status = (id: string) =>
  d.row<{ status: string }>('SELECT status FROM items WHERE id = ?', id).status;

describe('the workflow (owner decision 8)', () => {
  it('walks inbox → planning → ready → progress → done', () => {
    const { id, status: first } = create('Walk the workflow');
    expect(first).toBe('inbox');
    expect(move(id, 'planning').status).toBe('planning');
    expect(move(id, 'ready').status).toBe('ready');
    expect(move(id, 'planning').status).toBe('planning');
    expect(move(id, 'ready').status).toBe('ready');
    expect(move(id, 'progress').status).toBe('progress');
    const done = move(id, 'done');
    expect(done.status).toBe('done');
    expect(d.row('SELECT closed_by, closed_at FROM items WHERE id = ?', id)).toEqual({
      closed_by: 'agent',
      closed_at: d.clock.now().toISOString(),
    });
  });

  it('records each move as an item.status_changed event with the old and new status', () => {
    const { id } = create('Events');
    move(id, 'planning');
    const ev = d.row<{ type: string; data: string; actor_kind: string; client: string }>(
      "SELECT type, data, actor_kind, client FROM events WHERE item_id = ? AND type = 'item.status_changed'",
      id,
    );
    expect(ev.actor_kind).toBe('agent');
    expect(ev.client).toBe('claude');
    expect(JSON.parse(ev.data)).toMatchObject({ status: { old: 'inbox', new: 'planning' } });
  });

  it('bumps the item version on every move', () => {
    const { id, version } = create('Versions');
    expect(move(id, 'planning').version).toBe(version + 1);
  });

  it.each<[Status, Status[]]>([
    ['inbox', ['planning', 'canceled']],
    ['planning', ['ready', 'canceled']],
    ['ready', ['planning', 'progress', 'canceled']],
    ['progress', ['ready', 'done', 'canceled']],
    ['review', ['progress', 'done', 'canceled']],
    ['done', ['progress']],
    ['canceled', []],
  ])('an invalid move from %s is validation listing the allowed moves %j', (from, allowed) => {
    const id = itemIn(from);
    const invalid = (
      ['inbox', 'planning', 'ready', 'progress', 'review', 'done', 'canceled'] as const
    ).filter((s) => !allowed.includes(s) && s !== 'review');
    for (const to of invalid) {
      const err = moveFails(id, to);
      expect(err.details?.allowed).toEqual(allowed);
    }
    expect(status(id)).toBe(from);
  });

  it('refuses progress → review: hand off with submit_packet', () => {
    const id = itemIn('progress');
    const err = moveFails(id, 'review');
    expect(err.message).toContain('submit_packet');
  });
});

describe('ready → progress', () => {
  it('is refused while the item is blocked, naming the blockers', () => {
    const blocker = itemIn('ready', 'Blocker');
    const { id } = create('Blocked', { blocked_by: [blocker] });
    move(id, 'planning');
    move(id, 'ready');
    const err = moveFails(id, 'progress');
    expect(err.details?.blocked_by).toEqual([blocker]);
  });

  it('does not claim the item (use claim_lead)', () => {
    const id = itemIn('ready');
    move(id, 'progress');
    expect(d.rows('SELECT id FROM runs WHERE item_id = ?', id)).toEqual([]);
  });
});

describe('progress → ready', () => {
  it('ends your lead claim: the run is interrupted (released), the item back in Ready', () => {
    const id = itemIn('ready');
    const { run_id } = claim(id);
    move(id, 'ready', { ...claude, run_id });
    expect(d.row('SELECT state, end_reason FROM runs WHERE id = ?', run_id)).toEqual({
      state: 'interrupted',
      end_reason: 'released',
    });
    expect(status(id)).toBe('ready');
  });

  it("is forbidden while another agent leads it (FR-027: never release another agent's claim)", () => {
    const id = itemIn('ready');
    claim(id, codex);
    const err = d.fails(
      claude,
      (w, s) => s.items.setStatus(w, { id, status: 'ready' }),
      'forbidden',
    );
    expect(err.message).toContain('codex');
    expect(status(id)).toBe('progress');
  });
});

describe('the resume claim (progress → progress)', () => {
  it('claims an In progress item with no lead, keeping the status', () => {
    const id = itemIn('progress');
    const out = claim(id);
    expect(out.item.status).toBe('progress');
    expect(out.item.lead?.run_id).toBe(out.run_id);
  });

  it('works again after the lead run fails', () => {
    const id = itemIn('ready');
    const { run_id } = claim(id, codex);
    d.write({ ...codex, run_id }, (w, s) =>
      s.runs.finish(w, { run_id, result: 'failed', summary: 'Broke.', error: 'boom' }),
    );
    expect(status(id)).toBe('progress');
    expect(claim(id).item.lead?.client).toBe('claude');
  });

  it.each<Status>(['inbox', 'planning', 'review', 'done', 'canceled'])(
    'is refused from %s',
    (from) => {
      const id = itemIn(from);
      d.fails(claude, (w, s) => s.runs.claim(w, { id }), 'validation');
    },
  );
});

describe('the Done gate (decision 13)', () => {
  it('closes an item with no human review items: closed by the agent, the lead run finished', () => {
    const id = itemIn('ready');
    const { run_id } = claim(id);
    const out = move(id, 'done', { ...claude, run_id });
    expect(out.status).toBe('done');
    expect(out.lead).toBeNull();
    expect(d.row('SELECT state, end_reason FROM runs WHERE id = ?', run_id)).toEqual({
      state: 'finished',
      end_reason: 'finished',
    });
  });

  it.each(['declared', 'ready'])('is refused while a human review item is %s', (state) => {
    const id = itemIn('progress');
    const t = d.clock.now().toISOString();
    for (const n of [1, 2]) {
      d.sql
        .prepare(
          `INSERT INTO hr_items (id, item_id, position, text, state, added_by, version, created_at, updated_at)
           VALUES (?, ?, ?, 'Check it by hand.', ?, 'claude', 1, ?, ?)`,
        )
        .run(`hr_${state}${n}`, id, n, state, t, t);
    }
    const err = moveFails(id, 'done');
    expect(err.details?.allowed).toEqual(['ready', 'canceled']);
    expect(String(err.details?.reason)).toBe(
      `2 human review items are undecided: hr_${state}1, hr_${state}2`,
    );
    expect(err.message).toContain('submit_packet');
  });

  it('allows done once every human review item is approved or deferred', () => {
    const id = itemIn('review');
    const t = d.clock.now().toISOString();
    d.sql
      .prepare(
        `INSERT INTO hr_items (id, item_id, position, text, state, added_by, version, created_at, updated_at)
         VALUES ('hr_ok', ?, 0, 'Checked.', 'approved', 'claude', 1, ?, ?), ('hr_later', ?, 1, 'Later.', 'deferred', 'claude', 1, ?, ?)`,
      )
      .run(id, t, t, id, t, t);
    expect(move(id, 'done').status).toBe('done');
  });

  it('is refused for another agent while it holds the lead', () => {
    const id = itemIn('ready');
    claim(id, codex);
    d.fails(claude, (w, s) => s.items.setStatus(w, { id, status: 'done' }), 'forbidden');
  });
});

describe('epics (FR-005)', () => {
  it('reach Done only when every child is Done or Canceled, naming the open ones', () => {
    const { id: epic } = create('Epic', { type: 'Epic' });
    const a = create('Child A', { epic }).id;
    const b = create('Child B', { epic }).id;
    forceStatus(d, epic, 'progress');
    const err = moveFails(epic, 'done');
    expect(err.message).toContain(a);
    expect(err.message).toContain(b);

    move(a, 'canceled', claude, 'Dropped.');
    forceStatus(d, b, 'done');
    expect(move(epic, 'done').status).toBe('done');
  });

  it('cannot be canceled with open children', () => {
    const { id: epic } = create('Epic', { type: 'Epic' });
    const child = create('Child', { epic }).id;
    const err = moveFails(epic, 'canceled', 'validation', 'No longer wanted.');
    expect(err.message).toContain(child);
  });
});

describe('cancel (owner decision 23)', () => {
  it('needs a reason from an agent', () => {
    const id = itemIn('planning');
    const err = moveFails(id, 'canceled');
    expect(err.details?.fields ?? err.message).toBeTruthy();
    expect(move(id, 'canceled', claude, 'Duplicate of TST-1.').status).toBe('canceled');
  });

  it('ends your active lead run as interrupted (canceled) and withdraws the open packet', () => {
    const id = itemIn('ready');
    const { run_id } = claim(id);
    const t = d.clock.now().toISOString();
    d.sql
      .prepare(
        `INSERT INTO hr_items (id, item_id, position, text, state, added_by, version, created_at, updated_at)
         VALUES ('hr_r', ?, 0, 'Look.', 'ready', 'claude', 1, ?, ?)`,
      )
      .run(id, t, t);
    d.sql
      .prepare(
        `INSERT INTO packets (id, item_id, round, content_hash, built_from_commit, created_by, state, version, created_at, updated_at)
         VALUES ('pkt_1', ?, 1, 'abcd', '4be1c09', 'claude', 'open', 1, ?, ?)`,
      )
      .run(id, t, t);
    forceStatus(d, id, 'review');
    move(id, 'canceled', { ...claude, run_id }, 'Superseded.');
    expect(d.row('SELECT state, end_reason FROM runs WHERE id = ?', run_id)).toEqual({
      state: 'interrupted',
      end_reason: 'canceled',
    });
    expect(d.row("SELECT state FROM packets WHERE id = 'pkt_1'")).toEqual({ state: 'withdrawn' });
    expect(d.row("SELECT state FROM hr_items WHERE id = 'hr_r'")).toEqual({ state: 'declared' });
  });

  it('is optional-reason for the owner', () => {
    const id = itemIn('inbox');
    expect(move(id, 'canceled', OWNER_ACTOR).status).toBe('canceled');
  });
});

describe('reopen (done → progress)', () => {
  it('needs a reason, and clears closed_by', () => {
    const id = itemIn('done');
    moveFails(id, 'progress');
    expect(move(id, 'progress', claude, 'Regression found.').status).toBe('progress');
    expect(d.row('SELECT closed_by, closed_at FROM items WHERE id = ?', id)).toEqual({
      closed_by: null,
      closed_at: null,
    });
  });
});

describe('optimistic concurrency', () => {
  it('a stale expected_version is conflict with the current record', () => {
    const { id, version } = create('Versioned');
    move(id, 'planning');
    const err = d.fails(
      claude,
      (w, s) => s.items.setStatus(w, { id, status: 'ready', expected_version: version }),
      'conflict',
    );
    expect(err.current).toMatchObject({ id, status: 'planning' });
  });

  it('an unknown item is not_found', () => {
    d.fails(claude, (w, s) => s.items.setStatus(w, { id: 'TST-99', status: 'ready' }), 'not_found');
  });
});
