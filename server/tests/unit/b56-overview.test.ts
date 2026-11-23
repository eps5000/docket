/**
 * B56: the chart's buckets name their tickets (bounded, on the Completed
 * definition), and each at-risk worktree says who it waits on, from the same
 * Problems routing as Needs you, without changing the badge.
 */
import {
  needsYouCount,
  OVERVIEW_BUCKET_TICKETS,
  type NeedsYouResponse,
  type OverviewResponse,
  type Problem,
  type WorkspaceRow,
} from '@docket/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkspaceFacts } from '../../src/domain/recovery-model.js';
import { OWNER_ACTOR, type Actor } from '../../src/domain/write.js';
import { atRiskOwner } from '../../src/domain/worktree-owner.js';
import { addProject, forceStatus, minutes, startDomain, type Domain } from '../us1-helpers.js';

let d: Domain;
afterEach(() => d.cleanup());

describe('each chart bucket lists its tickets', () => {
  const start = () => {
    d = startDomain({ seed: false });
    addProject(d, 'OV');
  };
  const overview = (window: '24h' | '7d' | '30d' = '24h'): OverviewResponse =>
    d.services.views.overview(d.read(), { scope: 'OV', window });
  const ticket = (title: string, type: 'Task' | 'Epic' = 'Task') => {
    const { id } = d.write(OWNER_ACTOR, (w, s) =>
      s.items.create(w, { project: 'OV', type, title, priority: 2, status: 'planning' }),
    );
    forceStatus(d, id, 'progress');
    return id;
  };
  const move = (id: string, status: 'done' | 'progress' | 'canceled') =>
    d.write(OWNER_ACTOR, (w, s) => s.items.setStatus(w, { id, status, reason: 'Test move.' }));
  const closed = (title: string) => {
    const id = ticket(title);
    move(id, 'done');
    return id;
  };
  const listed = (o: OverviewResponse) => o.completed.buckets.flatMap((b) => b.tickets);

  it('gives the ID and title, newest first', () => {
    start();
    const a = closed('First');
    d.clock.advance(1000);
    const b = closed('Second');
    const bucket = overview().completed.buckets.find((x) => x.count > 0)!;
    expect(bucket.count).toBe(2);
    expect(bucket.tickets).toEqual([
      { id: b, title: 'Second' },
      { id: a, title: 'First' },
    ]);
  });

  it('stops at the limit, while the count stays whole', () => {
    start();
    const ids: string[] = [];
    for (let n = 0; n < OVERVIEW_BUCKET_TICKETS + 3; n++) {
      ids.push(closed(`Ticket ${n}`));
      d.clock.advance(1000);
    }
    const o = overview();
    const bucket = o.completed.buckets.find((x) => x.count > 0)!;
    expect(bucket.count).toBe(OVERVIEW_BUCKET_TICKETS + 3);
    expect(bucket.tickets).toHaveLength(OVERVIEW_BUCKET_TICKETS);
    expect(bucket.tickets.map((t) => t.id)).toEqual(ids.slice(-OVERVIEW_BUCKET_TICKETS).reverse());
    expect(o.completed.buckets.reduce((n, b) => n + b.count, 0)).toBe(o.completed.count);
  });

  it('leaves out what Completed leaves out: epics, canceled, imported and reopened', () => {
    start();
    const epic = ticket('An epic', 'Epic');
    move(epic, 'done');
    move(ticket('Canceled'), 'canceled');
    const imported = closed('Imported as done');
    d.sql
      .prepare("UPDATE items SET closed_by = 'imported', imported = 1 WHERE id = ?")
      .run(imported);
    const reopened = closed('Reopened');
    move(reopened, 'progress');
    const real = closed('Real work');
    for (const window of ['24h', '7d', '30d'] as const) {
      expect(listed(overview(window)).map((t) => t.id)).toEqual([real]);
    }
  });

  it('an empty bucket has no tickets', () => {
    start();
    closed('One');
    const empty = overview().completed.buckets.filter((b) => b.count === 0);
    expect(empty.length).toBeGreaterThan(0);
    for (const b of empty) expect(b.tickets).toEqual([]);
  });

  it('stays bounded over 30 days with many tickets', () => {
    start();
    for (let n = 0; n < 40; n++) {
      closed(`Ticket ${n}`);
      d.clock.advance(minutes(60 * 8));
    }
    const o = overview('30d');
    for (const b of o.completed.buckets) {
      expect(b.tickets.length).toBeLessThanOrEqual(OVERVIEW_BUCKET_TICKETS);
      expect(b.tickets.length).toBe(Math.min(b.count, OVERVIEW_BUCKET_TICKETS));
    }
  });
});

describe('who an at-risk worktree waits on', () => {
  const orca = { name: 'orca', dispatch_id: 'ctx_1' };
  let claude: Actor;
  const start = () => {
    d = startDomain();
    claude = d.agent('claude', { label: 'orca-w1' });
  };
  const claim = (id: string, extra: Record<string, unknown> = {}) =>
    d.write(claude, (w, s) => s.runs.claim(w, { id, agent_label: 'orca-w1', ...extra })).run_id;
  /** An ended run that last reported an unpushed commit and uncommitted changes. */
  function leftWork(id: string, extra: Record<string, unknown> = {}) {
    const run_id = claim(id, { workspace: { path: `C:/work/${id}`, branch: id }, ...extra });
    d.write({ ...claude, run_id }, (w, s) =>
      s.evidence.reportCommit(w, { id, sha: '77aa001', pushed: false }),
    );
    d.services.runs.heartbeat(d.read({ ...claude, run_id }), {
      run_id,
      workspace: { dirty: true },
    });
    d.write({ ...claude, run_id }, (w, s) =>
      s.runs.finish(w, { run_id, result: 'finished', summary: 'Stopped.' }),
    );
    return run_id;
  }
  const row = (id: string): WorkspaceRow =>
    d.services.recovery
      .workspaces(d.read(), { scope: 'all' })
      .rows.find((r) => r.path === `C:/work/${id}`)!;
  const badge = () => needsYouCount(d.services.views.needsYou(d.read(), { scope: 'all' }));

  it('agents, while a coordinator has it, and the badge doesn’t move', () => {
    start();
    const before = badge();
    leftWork('RCP-17', { orchestrator: orca });
    expect(row('RCP-17')).toMatchObject({ state: 'at_risk', at_risk_owner: 'agents' });
    expect(badge()).toBe(before);
  });

  it('agents, when the story has a live lead in another worktree', () => {
    start();
    leftWork('RCP-17', { orchestrator: orca });
    d.write(d.agent('codex'), (w, s) => s.runs.claim(w, { id: 'RCP-17' }));
    expect(row('RCP-17').at_risk_owner).toBe('agents');
  });

  it('you, as soon as its Problem reaches Needs you', () => {
    start();
    leftWork('RCP-17');
    expect(row('RCP-17').at_risk_owner).toBe('you');
  });

  it('you, once agents have had it past the grace period', () => {
    start();
    leftWork('RCP-17', { orchestrator: orca });
    d.clock.advance(d.server.runtime.config.agentProblemGraceMs + minutes(1));
    expect(row('RCP-17').at_risk_owner).toBe('you');
  });

  it('kept, after Keep for later, and it stays at risk and off Needs you', () => {
    start();
    const run_id = leftWork('RCP-17');
    const before = badge();
    d.write(OWNER_ACTOR, (w, s) =>
      s.recovery.markUnpushedHandled(w, { runId: run_id, outcome: 'keep' }),
    );
    expect(row('RCP-17')).toMatchObject({ state: 'at_risk', at_risk_owner: 'kept' });
    expect(badge()).toBe(before - 1);
  });

  it('kept no longer applies once newer work is reported there', () => {
    start();
    const first = leftWork('RCP-17');
    d.write(OWNER_ACTOR, (w, s) =>
      s.recovery.markUnpushedHandled(w, { runId: first, outcome: 'keep' }),
    );
    d.clock.advance(minutes(5));
    leftWork('RCP-17');
    expect(row('RCP-17').at_risk_owner).toBe('you');
  });

  it('unknown, when nothing says who has it, rather than a guess', () => {
    start();
    const run_id = leftWork('RCP-17');
    // Git says nothing is left, so there's no Problem, and nobody is on the ticket.
    d.sql.prepare('UPDATE runs SET worktree_check = ? WHERE id = ?').run(
      JSON.stringify({
        checked_at: d.clock.now().toISOString(),
        head_sha: '77aa001',
        on_main: false,
        on_remote: true,
        unpushed_commits: 0,
        uncommitted_files: 0,
      }),
      run_id,
    );
    expect(row('RCP-17')).toMatchObject({ state: 'at_risk', at_risk_owner: 'unknown' });
  });

  it('null for a worktree that isn’t at risk', () => {
    start();
    claim('RCP-17', { workspace: { path: 'C:/work/RCP-17', branch: 'b' } });
    expect(row('RCP-17')).toMatchObject({ state: 'in_use', at_risk_owner: null });
  });

  describe('the order of the rules', () => {
    const facts = (over: Partial<WorkspaceFacts> = {}) =>
      ({
        runs: [{ id: 'run_1', orchestrator: null }],
        latest: { id: 'run_1', item_id: 'RCP-1', orchestrator: null },
        kept: false,
        ...over,
      }) as unknown as WorkspaceFacts;
    const problem = (kind: Problem['kind'], run_id = 'run_1') => ({ kind, run_id }) as Problem;
    const routed = (over: Partial<NeedsYouResponse> = {}) =>
      ({ problems: [], agent_problems: [], acknowledged: [], ...over }) as NeedsYouResponse;
    const owner = (f: WorkspaceFacts, view: NeedsYouResponse, status = 'progress') =>
      atRiskOwner(f, view, new Set(), () => status);

    it('a Problem on Needs you beats a keep', () => {
      const view = routed({ problems: [problem('orphaned_resources')] });
      expect(owner(facts({ kept: true }), view)).toBe('you');
    });

    it('an acknowledged Problem isn’t asked again', () => {
      const view = routed({ acknowledged: [problem('orphaned_resources')] });
      expect(owner(facts(), view)).toBe('acknowledged');
    });

    it('ignores Problems about another run or something else', () => {
      const view = routed({
        problems: [problem('unpushed_work', 'run_2'), problem('date_risk')],
      });
      expect(owner(facts(), view)).toBe('unknown');
    });

    it('a coordinator only counts while the ticket is in play', () => {
      const run = { id: 'run_1', item_id: 'RCP-1', orchestrator: '{"name":"orca"}' };
      const f = facts({ runs: [run], latest: run } as unknown as Partial<WorkspaceFacts>);
      expect(owner(f, routed())).toBe('agents');
      expect(owner(f, routed(), 'done')).toBe('unknown');
    });
  });
});
