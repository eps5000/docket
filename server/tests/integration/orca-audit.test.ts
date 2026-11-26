import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/domain/write.js';
import { addProject, forceStatus, startDomain, type Domain } from '../us1-helpers.js';

const source = await import(
  /* @vite-ignore */ pathToFileURL(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'tools',
      'docket-sync',
      'sources',
      'orca-audit.mjs',
    ),
  ).href
);
const now = new Date('2026-11-26T19:30:00.000Z');

describe('bounded Orca resource projection', () => {
  it('drops chat text and process identity, while preserving custody categories', () => {
    const record = source.projectAudit(
      { run_id: 'run_test', dispatch_id: 'ctx_test' },
      {
        projection: {
          outcome: 'succeeded',
          liveness: { verdict: 'live' },
          stage: { activity: 'done' },
          secretTranscript: 'private report',
        },
        terminalResource: { releaseState: 'retained' },
      },
      'in-progress',
      1,
      { count: 2, read: true },
      'private',
      now.toISOString(),
    );
    expect(record).toMatchObject({
      outcome: 'succeeded',
      terminal_state: 'retained',
      live_terminals: 1,
      suspected_processes: 2,
      artifacts: 'private',
    });
    expect(JSON.stringify(record)).not.toContain('private report');
  });
});

describe('Docket dispatch resource reconciliation', () => {
  let d: Domain;
  let id: string;
  let run: string;
  let dispatch: string;
  let worker: Actor;
  beforeEach(() => {
    d = startDomain({ seed: false, now });
    addProject(d, 'GF');
    worker = d.agent('codex');
    id = d.write(worker, (w, s) =>
      s.items.create(w, {
        project: 'GF',
        type: 'Implementation',
        title: 'Synthetic rollout',
        priority: 2,
        status: 'planning',
      }),
    ).id;
    forceStatus(d, id, 'ready');
    dispatch = `ctx_${id}`;
    run = d.write(worker, (w, s) =>
      s.runs.claim(w, {
        id,
        orchestrator: { name: 'orca', dispatch_id: dispatch },
      }),
    ).run_id;
  });
  afterEach(() => d.cleanup());

  const record = (over: Record<string, unknown> = {}) => ({
    key: dispatch,
    run_id: run,
    observed_at: d.clock.now().toISOString(),
    outcome: 'in_progress',
    liveness: 'live',
    terminal_state: 'active',
    protected_hold: false,
    agent_state: 'working',
    worktree_status: 'in-progress',
    live_terminals: 0,
    suspected_processes: 0,
    process_read: true,
    artifacts: 'clean',
    ...over,
  });
  const post = (rows: unknown[]) =>
    d.services.sync.ingest(d.server.runtime.write, 'orca-audit', {
      records: rows as never,
      run: { ok: true, interval_ms: 60_000 },
    });
  const problems = () => d.services.views.needsYou(d.read(), { scope: 'GF' }).problems;

  it('surfaces a lost worker while the parked claim stays live, and clears after a verified live handoff', () => {
    d.write({ ...worker, run_id: run }, (w, s) =>
      s.runs.park(w, {
        run_id: run,
        reason: 'Waiting on a reviewer',
        waiting_on: {
          orchestrator: true,
          wake: {
            actor: 'reviewer',
            event: 'review report',
            due_at: new Date(now.getTime() + 3_600_000).toISOString(),
          },
        },
      }),
    );
    expect(
      post([record({ outcome: 'failed', liveness: 'lost', agent_state: 'done' })]),
    ).toMatchObject({ accepted: 1, changed: 1 });
    expect(problems()).toContainEqual(
      expect.objectContaining({ kind: 'dispatch_custody', run_id: run }),
    );
    expect(d.row<{ state: string }>('SELECT state FROM runs WHERE id = ?', run).state).toBe(
      'parked',
    );
    d.clock.advance(6 * 60_000);
    expect(problems()).toContainEqual(
      expect.objectContaining({
        kind: 'dispatch_custody',
        reason: expect.stringContaining('audit stale'),
      }),
    );
    expect(post([record()])).toMatchObject({ accepted: 1, changed: 1 });
    expect(problems().some((p) => p.kind === 'dispatch_custody')).toBe(false);
  });

  it('reports a completed agent with a live terminal and possible child, preserving private artifacts', () => {
    d.sql
      .prepare("UPDATE runs SET state = 'finished', updated_at = ? WHERE id = ?")
      .run(new Date(now.getTime() - 3 * 60_000).toISOString(), run);
    post([
      record({
        outcome: 'succeeded',
        agent_state: 'done',
        terminal_state: 'retained',
        live_terminals: 1,
        suspected_processes: 1,
        artifacts: 'private',
      }),
    ]);
    expect(problems()).toContainEqual(
      expect.objectContaining({
        kind: 'dispatch_resources',
        run_id: run,
        reason: expect.stringContaining('private artifacts retained'),
      }),
    );
    const inventory = d.services.digest.get(d.read(), { project: 'GF' }).resource_inventory;
    expect(inventory?.rows.rows).toContainEqual(
      expect.objectContaining({
        run_id: run,
        state: 'completed',
        suspected_processes: 1,
      }),
    );
    d.clock.advance(6 * 60_000);
    expect(problems()).toContainEqual(
      expect.objectContaining({
        kind: 'dispatch_resources',
        reason: expect.stringContaining('audit stale'),
      }),
    );
    d.clock.advance(1_000);
    post([
      record({
        outcome: 'succeeded',
        agent_state: 'done',
        terminal_state: 'released',
        worktree_status: 'completed',
        artifacts: 'private',
      }),
    ]);
    expect(problems().some((p) => p.kind === 'dispatch_resources')).toBe(false);
    expect(
      d.row<{ resource_observation: string }>(
        'SELECT resource_observation FROM runs WHERE id = ?',
        run,
      ).resource_observation,
    ).toContain('private');
  });

  it('rejects mismatched dispatches and stale observations; a legitimate park stays quiet', () => {
    d.write({ ...worker, run_id: run }, (w, s) =>
      s.runs.park(w, {
        run_id: run,
        reason: 'Intentional hold',
        waiting_on: { person: true },
      }),
    );
    expect(
      post([
        record({ key: 'ctx_other' }),
        record({
          observed_at: new Date(now.getTime() - 120_000).toISOString(),
        }),
      ]),
    ).toMatchObject({ ignored: 2 });
    expect(post([record()])).toMatchObject({ accepted: 1 });
    expect(
      problems().filter((p) => ['dispatch_custody', 'dispatch_resources'].includes(p.kind)),
    ).toEqual([]);
  });

  it('refuses a fifth active Orca worker claim, while a parked claim frees a slot', () => {
    const next = () => {
      const other = d.write(worker, (w, s) =>
        s.items.create(w, {
          project: 'GF',
          type: 'Implementation',
          title: 'More synthetic work',
          priority: 2,
          status: 'planning',
        }),
      ).id;
      forceStatus(d, other, 'ready');
      return other;
    };
    const claims: string[] = [];
    for (let n = 0; n < 3; n += 1) {
      const other = next();
      claims.push(
        d.write(worker, (w, s) =>
          s.runs.claim(w, {
            id: other,
            orchestrator: { name: 'orca', dispatch_id: `ctx_extra_${n}` },
          }),
        ).run_id,
      );
    }
    const fifth = next();
    expect(() =>
      d.write(worker, (w, s) =>
        s.runs.claim(w, {
          id: fifth,
          orchestrator: { name: 'orca', dispatch_id: 'ctx_fifth' },
        }),
      ),
    ).toThrow('admission is full');
    d.write({ ...worker, run_id: claims[0] }, (w, s) =>
      s.runs.park(w, {
        run_id: claims[0]!,
        reason: 'Intentional wait',
        waiting_on: { person: true },
      }),
    );
    expect(
      d.write(worker, (w, s) =>
        s.runs.claim(w, {
          id: fifth,
          orchestrator: { name: 'orca', dispatch_id: 'ctx_fifth' },
        }),
      ).run_id,
    ).toMatch(/^run_/);
  });

  it('keeps unknown process and worktree custody visible after completion', () => {
    d.sql
      .prepare("UPDATE runs SET state = 'finished', updated_at = ? WHERE id = ?")
      .run(new Date(now.getTime() - 3 * 60_000).toISOString(), run);
    post([
      record({
        outcome: 'succeeded',
        terminal_state: 'released',
        agent_state: 'done',
        worktree_status: 'unknown',
        process_read: false,
        artifacts: 'unknown',
      }),
    ]);
    expect(problems()).toContainEqual(
      expect.objectContaining({
        kind: 'dispatch_resources',
        reason: expect.stringContaining('process inventory unknown'),
      }),
    );
  });

  it('preserves a requested retained agent and its private artifacts', () => {
    d.sql
      .prepare("UPDATE runs SET state = 'finished', updated_at = ? WHERE id = ?")
      .run(new Date(now.getTime() - 3 * 60_000).toISOString(), run);
    post([
      record({
        outcome: 'succeeded',
        terminal_state: 'retained',
        protected_hold: true,
        agent_state: 'done',
        worktree_status: 'in-progress',
        artifacts: 'private',
      }),
    ]);
    expect(problems().some((p) => p.kind === 'dispatch_resources')).toBe(false);
    expect(
      d.services.digest.get(d.read(), { project: 'GF' }).resource_inventory?.rows.rows,
    ).toContainEqual(expect.objectContaining({ protected_hold: true, artifacts: 'private' }));
  });

  it('enforces two active Orca ticket workers per Epic', () => {
    const epic = d.write(worker, (w, s) =>
      s.items.create(w, {
        project: 'GF',
        type: 'Epic',
        title: 'Synthetic Epic',
        priority: 2,
        status: 'planning',
      }),
    ).id;
    d.sql.prepare('UPDATE items SET epic_id = ? WHERE id = ?').run(epic, id);
    const next = () => {
      const other = d.write(worker, (w, s) =>
        s.items.create(w, {
          project: 'GF',
          type: 'Implementation',
          title: 'Epic work',
          priority: 2,
          status: 'planning',
          epic,
        }),
      ).id;
      forceStatus(d, other, 'ready');
      return other;
    };
    const second = next();
    d.write(worker, (w, s) =>
      s.runs.claim(w, {
        id: second,
        orchestrator: { name: 'orca', dispatch_id: 'ctx_second' },
      }),
    );
    const third = next();
    expect(() =>
      d.write(worker, (w, s) =>
        s.runs.claim(w, {
          id: third,
          orchestrator: { name: 'orca', dispatch_id: 'ctx_third' },
        }),
      ),
    ).toThrow('admission is full');
  });
});
