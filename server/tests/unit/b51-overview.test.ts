/**
 * The Overview metrics (owner decision 43; BUILD_SPEC §5.24): each definition,
 * including handoffs, reopened and canceled tickets, epics and imports, and
 * that every number equals the list behind it.
 */
import type { OverviewItemsResponse, OverviewMetric, OverviewResponse } from '@docket/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OWNER_ACTOR, type Actor } from '../../src/domain/write.js';
import { addProject, forceStatus, minutes, startDomain, type Domain } from '../us1-helpers.js';

let d: Domain;
let claude: Actor;
const HOUR = minutes(60);
const DAY = 24 * HOUR;

beforeEach(() => {
  d = startDomain({ seed: false });
  addProject(d, 'OV');
  addProject(d, 'OW');
  claude = d.agent('claude', { label: 'w1' });
});
afterEach(() => d.cleanup());

const overview = (scope = 'OV', window: '24h' | '7d' | '30d' = '7d'): OverviewResponse =>
  d.services.views.overview(d.read(), { scope, window });
const list = (metric: OverviewMetric, scope = 'OV'): OverviewItemsResponse =>
  d.services.views.overviewItems(d.read(), { scope, window: '7d', metric });
const ids = (metric: OverviewMetric, scope = 'OV') => list(metric, scope).rows.map((r) => r.id);

function ticket(
  title: string,
  status = 'planning',
  over: { project?: string; type?: 'Task' | 'Story' | 'Epic'; epic?: string } = {},
): string {
  const { id } = d.write(OWNER_ACTOR, (w, s) =>
    s.items.create(w, {
      project: over.project ?? 'OV',
      type: over.type ?? 'Task',
      title,
      priority: 2,
      status: 'planning',
      ...(over.epic ? { epic: over.epic } : {}),
    }),
  );
  if (status !== 'planning') forceStatus(d, id, status);
  return id;
}

const move = (id: string, status: 'done' | 'progress' | 'canceled') =>
  d.write(OWNER_ACTOR, (w, s) => s.items.setStatus(w, { id, status, reason: 'Test move.' }));
const closed = (title: string, over: Parameters<typeof ticket>[2] = {}) => {
  const id = ticket(title, 'progress', over);
  move(id, 'done');
  return id;
};
const claim = (id: string, extra: Record<string, unknown> = {}, actor = claude) =>
  d.write(actor, (w, s) => s.runs.claim(w, { id, agent_label: 'w1', ...extra })).run_id;
const park = (run_id: string, waiting_on: Record<string, unknown>) =>
  d.write({ ...claude, run_id }, (w, s) =>
    s.runs.park(w, { run_id, reason: 'Waiting.', waiting_on }),
  );

describe('Completed', () => {
  it('counts tickets that entered Done in the window, and the window before it', () => {
    closed('Before the prior window');
    d.clock.advance(8 * DAY);
    closed('In the prior window');
    d.clock.advance(8 * DAY);
    const a = closed('In the window');
    d.clock.advance(HOUR);
    const b = closed('Also in the window');
    const o = overview();
    expect(o.completed.count).toBe(2);
    expect(o.completed.prior).toBe(1);
    expect(ids('completed')).toEqual([b, a]);
  });

  it('leaves out epics, canceled tickets and imports', () => {
    const epic = ticket('An epic', 'progress', { type: 'Epic' });
    move(epic, 'done');
    move(ticket('Canceled', 'progress'), 'canceled');
    const imported = closed('Imported as done');
    d.sql
      .prepare("UPDATE items SET closed_by = 'imported', imported = 1 WHERE id = ?")
      .run(imported);
    const real = closed('Real work');
    expect(overview().completed.count).toBe(1);
    expect(ids('completed')).toEqual([real]);
  });

  it('drops a reopened ticket, and counts it once when it closes again', () => {
    const id = closed('Reopened');
    expect(overview().completed.count).toBe(1);
    move(id, 'progress');
    expect(overview().completed.count).toBe(0);
    d.clock.advance(HOUR);
    move(id, 'done');
    expect(overview().completed.count).toBe(1);
  });

  it('a close exactly at the window start belongs to the prior window', () => {
    closed('On the boundary');
    d.clock.advance(7 * DAY);
    const o = overview();
    expect(o.completed.count).toBe(0);
    expect(o.completed.prior).toBe(1);
  });

  it('buckets always sum to the count: hours for 24h, days for 7d and 30d', () => {
    closed('One');
    d.clock.advance(5 * HOUR);
    closed('Two');
    d.clock.advance(2 * DAY);
    closed('Three');
    const day = overview('OV', '24h');
    expect(day.completed.granularity).toBe('hour');
    expect(day.completed.buckets).toHaveLength(24);
    expect(day.completed.buckets.reduce((n, b) => n + b.count, 0)).toBe(day.completed.count);
    for (const w of ['7d', '30d'] as const) {
      const o = overview('OV', w);
      expect(o.completed.granularity).toBe('day');
      expect(o.completed.buckets.reduce((n, b) => n + b.count, 0)).toBe(3);
      expect(new Set(o.completed.buckets.map((b) => b.key)).size).toBe(o.completed.buckets.length);
    }
  });
});

describe('Agents, per story and never per run', () => {
  it('a lead with child runs is one story', () => {
    const id = ticket('Story', 'ready');
    const lead = claim(id);
    d.write({ ...claude, run_id: lead }, (w, s) =>
      s.runs.startRun(w, { id, parent_run_id: lead, agent_label: 'sub-1' }),
    );
    d.write({ ...claude, run_id: lead }, (w, s) =>
      s.runs.startRun(w, { id, parent_run_id: lead, agent_label: 'sub-2' }),
    );
    expect(overview().agents).toEqual({ working: 1, waiting: 0 });
    expect(ids('agents_working')).toEqual([id]);
  });

  it('a story handed between workers under a producer counts once throughout', () => {
    const id = ticket('Handed over', 'ready');
    const first = claim(id, { producer: 'p1' });
    expect(overview().agents.working).toBe(1);
    d.write({ ...claude, run_id: first }, (w, s) =>
      s.runs.release(w, { id, run_id: first, reason: 'Slice done.' }),
    );
    // Between workers: held for the producer.
    expect(overview().agents.working).toBe(1);
    expect(list('agents_working').rows[0]!.agent).toBe('p1');
    claim(id, { producer: 'p1', agent_label: 'w2' }, d.agent('codex', { label: 'w2' }));
    expect(overview().agents.working).toBe(1);
  });

  it('a hold that ran out is no longer work', () => {
    const id = ticket('Abandoned', 'ready');
    const run = claim(id, { producer: 'p1' });
    d.write({ ...claude, run_id: run }, (w, s) =>
      s.runs.release(w, { id, run_id: run, reason: 'Slice done.' }),
    );
    d.clock.advance(d.server.runtime.config.producerGraceMs + minutes(1));
    expect(overview().agents.working).toBe(0);
  });

  it('a stale lead and a lead waiting for the owner are neither working nor waiting', () => {
    const a = ticket('Stale', 'ready');
    claim(a);
    d.clock.advance(d.server.runtime.config.staleAfterMs + minutes(1));
    expect(overview().agents).toEqual({ working: 0, waiting: 0 });
    const b = ticket('Asked the owner', 'ready');
    const run = claim(b);
    d.sql.prepare("UPDATE runs SET state = 'needs_input' WHERE id = ?").run(run);
    expect(overview().agents).toEqual({ working: 0, waiting: 0 });
  });

  it('waiting means parked on a named dependency that has not cleared', () => {
    const blocker = ticket('Blocker', 'progress');
    const a = ticket('Parked on it', 'ready');
    const run = claim(a);
    park(run, { items: [blocker] });
    expect(overview().agents).toEqual({ working: 0, waiting: 1 });
    expect(ids('agents_waiting')).toEqual([a]);
    // The dependency clears: ready to resume, so no longer waiting on anything.
    move(blocker, 'done');
    expect(overview().agents.waiting).toBe(0);
  });

  it('a park that names nothing is not waiting', () => {
    const a = ticket('Parked', 'ready');
    const run = claim(a);
    park(run, { orchestrator: true });
    expect(overview().agents.waiting).toBe(1);
    d.sql.prepare('UPDATE runs SET waiting_on = NULL WHERE id = ?').run(run);
    expect(overview().agents.waiting).toBe(0);
  });

  it('leaves out epics and other projects', () => {
    claim(ticket('An epic', 'ready', { type: 'Epic' }));
    claim(ticket('Elsewhere', 'ready', { project: 'OW' }));
    expect(overview().agents.working).toBe(0);
    expect(overview('all').agents.working).toBe(1);
  });
});

describe('In flight, Blocked and Workload', () => {
  it('in flight is open tickets in In progress or Review, never epics', () => {
    const a = ticket('Doing', 'progress');
    const b = ticket('In review', 'review');
    ticket('Ready', 'ready');
    ticket('Epic in progress', 'progress', { type: 'Epic' });
    expect(overview().in_flight).toEqual({ count: 2, progress: 1, review: 1 });
    expect(ids('in_flight').sort()).toEqual([a, b].sort());
  });

  it('counts each open ticket in one workload bucket, per epic, blocked first', () => {
    const epic = ticket('Visual', 'progress', { type: 'Epic' });
    const blocker = ticket('Blocker', 'ready', { epic });
    const waiting = ticket('Waiting', 'ready', { epic });
    ticket('Reviewing', 'review', { epic });
    ticket('Loose', 'inbox');
    closed('Done is not workload', { epic });
    d.write(OWNER_ACTOR, (w, s) => s.links.link(w, { from: blocker, to: waiting, type: 'blocks' }));

    const o = overview();
    expect(o.blocked).toBe(1);
    const group = o.workload.find((g) => g.epic_id === epic)!;
    expect(group.title).toBe('Visual');
    expect(group.total).toBe(3);
    expect(group.counts).toMatchObject({ ready: 1, blocked: 1, review: 1, progress: 0 });
    const loose = o.workload.find((g) => g.epic_id === null)!;
    expect(loose.counts.inbox).toBe(1);
    expect(ids('no_epic')).toHaveLength(1);
    // The buckets add up to every open ticket, and Blocked to the Blocked number.
    const sum = o.workload.reduce((n, g) => n + g.total, 0);
    expect(sum).toBe(4);
    expect(o.workload.reduce((n, g) => n + g.counts.blocked, 0)).toBe(o.blocked);
  });

  it('a canceled ticket leaves every open number', () => {
    const id = ticket('Doing', 'progress');
    expect(overview().in_flight.count).toBe(1);
    move(id, 'canceled');
    const o = overview();
    expect(o.in_flight.count).toBe(0);
    expect(o.workload).toEqual([]);
  });

  it('follows the project scope', () => {
    ticket('Here', 'progress');
    ticket('There', 'progress', { project: 'OW' });
    expect(overview('OV').in_flight.count).toBe(1);
    expect(overview('OW').in_flight.count).toBe(1);
    expect(overview('all').in_flight.count).toBe(2);
  });
});

describe('the API contract', () => {
  it('every list has the same count as its number', () => {
    closed('Completed');
    const a = ticket('Working', 'ready');
    claim(a);
    const blocker = ticket('Blocker', 'progress');
    const b = ticket('Waiting', 'ready');
    park(claim(b), { items: [blocker] });
    ticket('Review', 'review');
    const o = overview();
    expect(list('completed').count).toBe(o.completed.count);
    expect(list('agents_working').count).toBe(o.agents.working);
    expect(list('agents_waiting').count).toBe(o.agents.waiting);
    expect(list('in_flight').count).toBe(o.in_flight.count);
    expect(list('no_epic').count).toBe(o.workload.find((g) => g.epic_id === null)!.total);
  });

  it('reading writes nothing', () => {
    closed('Completed');
    claim(ticket('Working', 'ready'));
    const events = () => d.row<{ n: number }>('SELECT count(*) AS n FROM events').n;
    const before = events();
    const changes = d.sql.prepare('SELECT total_changes() AS n').get() as { n: number };
    overview();
    for (const m of [
      'completed',
      'agents_working',
      'agents_waiting',
      'in_flight',
      'no_epic',
    ] as const)
      list(m);
    expect(events()).toBe(before);
    expect(d.sql.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
  });

  it('reports no estimated or token metric', () => {
    const keys = JSON.stringify(overview());
    expect(keys).not.toMatch(/token|estimate/i);
  });
});
