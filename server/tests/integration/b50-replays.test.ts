/**
 * Scripted replays of the Gameflow status failures behind owner decision 42
 * (GF-370), against a real git repository in a temporary push root.
 *
 * Each replay drives only what the old code also had: the same claims, parks,
 * commits and releases. So this file runs unchanged on the commit before B50,
 * where every replay fails on the status it reports, not on a missing tool.
 * The newer calls are optional for that reason (`activityCheck`, `coordinator`).
 */
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/domain/write.js';
import * as sweeper from '../../src/jobs/sweeper.js';
import { callTool } from '../../src/mcp/register.js';
import { TOOL_HANDLERS } from '../../src/mcp/tools/index.js';
import { git, makeRadarRepo, type RadarRepo } from '../fixtures/radar-repo.js';
import { tempDir, type TempDir } from '../helpers.js';
import { minutes, startDomain, type Domain } from '../us1-helpers.js';

const HAS_GIT = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const COORDINATOR = 'gameflow-coordinator';

let tmp: TempDir;
let d: Domain;
let repo: RadarRepo;
let worker: Actor;

beforeEach(() => {
  tmp = tempDir('docket-b50-replay-');
  if (!HAS_GIT) return;
  repo = makeRadarRepo(tmp.dir);
  // The clock starts after the fixture's own commits, so only the replay's commits are new.
  d = startDomain({ env: { DOCKET_PUSH_ROOT: tmp.dir }, now: new Date(Date.now() + minutes(5)) });
  d.sql
    .prepare("UPDATE projects SET repo_path = 'recipe-app', main_branch = 'main' WHERE key = 'RCP'")
    .run();
  worker = d.agent('claude', { label: 'worker-1' });
});
afterEach(async () => {
  await d?.cleanup();
  rmSync(tmp.dir, { recursive: true, force: true });
});

/** The check Docket runs every two minutes. Absent before B50. */
const activityCheck = async () =>
  (await (
    sweeper as unknown as { runActivityOnce?: (r: unknown) => Promise<string[]> }
  ).runActivityOnce?.(d.server.runtime)) ?? [];

/** A commit on a branch, dated by the test clock. */
function commitAt(branch: 'feat/a', message: string) {
  const at = d.clock.now().toISOString();
  const r = spawnSync(
    'git',
    [
      '-c',
      'user.name=Replay',
      '-c',
      'user.email=replay@docket.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      message,
    ],
    {
      cwd: repo.worktrees[branch],
      env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
      windowsHide: true,
    },
  );
  expect(r.status, String(r.stderr)).toBe(0);
  return git(repo.worktrees[branch], 'rev-parse', 'HEAD').trim();
}

const digestRow = (id: string, cursor?: string) =>
  d.services.digest
    .get(d.read(), { project: 'RCP', ...(cursor ? { cursor } : {}) })
    .runs.rows.find((r) => r.item_id === id);
const status = (id: string) =>
  d.row<{ status: string }>('SELECT status FROM items WHERE id = ?', id).status;
const statusMoves = (id: string) =>
  d.rows<{ data: string }>(
    "SELECT data FROM events WHERE item_id = ? AND type = 'item.status_changed' ORDER BY seq",
    id,
  ).length;

function park(id: string, waiting_on: Record<string, unknown>, reason: string) {
  const { run_id } = d.write(worker, (w, s) =>
    s.runs.claim(w, {
      id,
      agent_label: 'worker-1',
      orchestrator: { name: COORDINATOR },
      workspace: { path: repo.worktrees['feat/a'], branch: 'feat/a' },
    }),
  );
  d.write({ ...worker, run_id }, (w, s) => s.runs.park(w, { run_id, reason, waiting_on }));
  return run_id;
}

describe.runIf(HAS_GIT)('replays of the Gameflow status failures (decision 42)', () => {
  it('GF-269: the work moved on while it read "waiting on a mailbox"', async () => {
    park('RCP-17', { orchestrator: true }, 'Waiting on a mailbox route');
    d.clock.advance(minutes(90));
    // The coordinator's session replaces the route and enables the flag: real commits, no run_id.
    commitAt('feat/a', 'Replace the mailbox route');
    d.clock.advance(minutes(2));
    await activityCheck();

    // Within a few minutes, with no human noticing, the status says the park may be stale.
    expect(digestRow('RCP-17')?.activity, 'GF-269 shows activity since parked').toContain(
      '1 commit',
    );
    expect(digestRow('RCP-17')?.state).toBe('parked');

    // The coordinator corrects it without borrowing the run ID, and is named for it.
    d.write(d.agent('claude', { label: 'coordinator' }), (w, s) =>
      s.runs.updateStatus(w, {
        id: 'RCP-17',
        coordinator: COORDINATOR,
        resume: true,
        current_action: 'Mailbox route replaced, verifying the flag',
      }),
    );
    expect(digestRow('RCP-17')).toMatchObject({ updated_by: COORDINATOR });
    expect(digestRow('RCP-17')?.state).not.toBe('parked');
    expect(digestRow('RCP-17')?.activity).toBeUndefined();
  });

  it('GF-336: a blocker cleared, the producer was idle, and a restart came in between', async () => {
    park('RCP-17', { items: ['RCP-25'] }, 'Waiting on the memory check');
    const { cursor } = d.services.digest.get(d.read(), { project: 'RCP' });
    d.clock.advance(minutes(60));
    const at = d.clock.now().toISOString();
    d.sql
      .prepare(
        "UPDATE items SET status = 'done', closed_at = ?, updated_at = ? WHERE id = 'RCP-25'",
      )
      .run(at, at);

    // Docket restarts before anyone looks. The run stays parked, and the check still finds it.
    sweeper.restartSweep(d.server.runtime);
    d.clock.advance(minutes(2));
    await activityCheck();

    // A coordinator watching by cursor is told, though the event was on the blocker.
    const row = digestRow('RCP-17', cursor);
    expect(row, 'GF-336 reaches a coordinator watching the change cursor').toBeDefined();
    expect(row).toMatchObject({ state: 'parked', resume_ready: true });
    expect(row?.activity).toContain('RCP-25 cleared');

    // Nothing here is the owner's: it stays out of Needs you until B49's routing says so.
    const needs = d.services.views.needsYou(d.read(), { scope: 'RCP' });
    expect(needs.problems.filter((p) => p.item_id === 'RCP-17')).toEqual([]);

    // Later checks add no second event: the flag doesn't flap.
    d.clock.advance(minutes(2));
    await activityCheck();
    expect(
      d.rows("SELECT seq FROM events WHERE type = 'run.activity' AND item_id = 'RCP-17'"),
    ).toHaveLength(1);
  });

  it('GF-374: reading a parked ticket with its run_id does not wake it', async () => {
    const run_id = park('RCP-17', { orchestrator: true }, 'Waiting on the coordinator');
    const before = d.row('SELECT state, lease_expires_at, version FROM runs WHERE id = ?', run_id);
    d.clock.advance(minutes(10));
    const opts = {
      runtime: d.server.runtime,
      session: () => undefined,
      handlers: TOOL_HANDLERS,
    };
    const result = await callTool(opts, 'get_item', { id: 'RCP-17', run_id });
    expect(result.isError ?? false).toBe(false);
    expect(
      d.row('SELECT state, lease_expires_at, version FROM runs WHERE id = ?', run_id),
      'GF-374 stays parked after a read',
    ).toEqual(before);
    expect(d.rows("SELECT seq FROM events WHERE type = 'run.resumed'")).toEqual([]);
  });

  it('GF-280: five small workers under one producer never send it back to Ready', () => {
    const seen: string[] = [];
    for (let n = 1; n <= 5; n += 1) {
      const a = d.agent('claude', { label: `worker-${n}`, session_id: `sess-${n}` });
      const { run_id } = d.write(a, (w, s) =>
        s.runs.claim(w, { id: 'RCP-17', agent_label: `worker-${n}`, producer: 'producer-7' }),
      );
      seen.push(status('RCP-17'));
      d.clock.advance(minutes(5));
      d.write({ ...a, run_id }, (w, s) =>
        s.runs.release(w, { id: 'RCP-17', run_id, reason: 'Done with my slice' }),
      );
      seen.push(status('RCP-17'));
      d.clock.advance(minutes(5));
    }
    expect(seen, 'GF-280 stays In progress through every handoff').toEqual(
      Array<string>(10).fill('progress'),
    );
    expect(statusMoves('RCP-17'), 'GF-280 moves once, from Ready to In progress').toBe(1);

    // Another producer still can't take it between workers.
    d.fails(
      d.agent('codex'),
      (w, s) => s.runs.claim(w, { id: 'RCP-17', producer: 'someone-else' }),
      'conflict',
    );

    // If the producer really is gone, its hold runs out and the story returns to Ready.
    d.clock.advance(d.server.runtime.config.producerGraceMs + minutes(1));
    sweeper.sweepOnce(d.server.runtime);
    expect(status('RCP-17')).toBe('ready');
  });
});
