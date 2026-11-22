/**
 * Recovery rules (owner decision 26; BUILD_SPEC §5.16; FR-110 to FR-117;
 * tasks.md T096): parking and resuming, `resume_ready`, the unattended and
 * parked-too-long Problems, `end_reason` on every end, orphaned resources,
 * unpushed work at risk (detected and cleared), and every derived workspace
 * state, including `unknown` when nothing was reported.
 *
 * Mutations go through the one write path; calls that must pass the MCP
 * signal hook (resume on any call) go through the real tool handler.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Problem, WorkspaceState } from '@docket/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyUndo } from '../../src/domain/undo.js';
import { OWNER_ACTOR, SYSTEM_ACTOR, type Actor } from '../../src/domain/write.js';
import { flagOnce, restartSweep, sweepOnce } from '../../src/jobs/sweeper.js';
import { callTool, type RegisterOptions } from '../../src/mcp/register.js';
import type { McpSessionInfo } from '../../src/mcp/server.js';
import { TOOL_HANDLERS } from '../../src/mcp/tools/index.js';
import {
  endRunsAsOldRestart,
  forceStatus,
  minutes,
  startDomain,
  type Domain,
} from '../us1-helpers.js';

let d: Domain;
let claude: Actor;
let codex: Actor;

beforeEach(() => {
  d = startDomain();
  claude = d.agent('claude', { label: 'orca-w2' });
  codex = d.agent('codex', { label: 'orca-w1' });
});
afterEach(() => d.cleanup());

const hours = (n: number) => minutes(60 * n);
const cfg = () => d.server.runtime.config;
const as = (actor: Actor, run_id: string): Actor => ({ ...actor, run_id });

function claim(id: string, extra: Record<string, unknown> = {}, actor: Actor = claude) {
  return d.write(actor, (w, s) =>
    s.runs.claim(w, { id, agent_label: actor.label ?? undefined, ...extra }),
  );
}
const park = (run_id: string, waiting_on?: Record<string, unknown>, reason = 'Waiting.') =>
  d.write(as(claude, run_id), (w, s) => s.runs.park(w, { run_id, reason, waiting_on }));
const heartbeat = (run_id: string, extra: Record<string, unknown> = {}) =>
  d.services.runs.heartbeat(d.read(as(claude, run_id)), { run_id, ...extra });
const resources = (run_id: string, extra: Record<string, unknown>) =>
  d.write(as(claude, run_id), (w, s) => s.runs.updateResources(w, { run_id, ...extra }));
const finish = (run_id: string, result: 'finished' | 'failed' = 'finished') =>
  d.write(as(claude, run_id), (w, s) =>
    s.runs.finish(w, {
      run_id,
      result,
      summary: 'Stopped.',
      error: result === 'failed' ? 'boom' : undefined,
    }),
  );
const run = (id: string) =>
  d.row<{
    state: string;
    end_reason: string | null;
    lease_expires_at: string | null;
    parked_at: string | null;
    workspace: string | null;
    unpushed_handled_at: string | null;
  }>('SELECT * FROM runs WHERE id = ?', id);
const events = (type: string) =>
  d.rows<{ summary: string; data: string }>(
    'SELECT summary, data FROM events WHERE type = ? ORDER BY seq',
    type,
  );
const problems = (kind?: Problem['kind']) =>
  d.services.views
    .needsYou(d.read(OWNER_ACTOR), { scope: 'all' })
    .problems.filter((p) => !kind || p.kind === kind);
const itemView = (id: string) =>
  d.services.items.get(d.read(claude), { id, view: 'full' }).item as unknown as {
    runs: {
      run_id: string;
      run_state: string;
      parked: { resume_ready: boolean; since: string } | null;
      workspace: {
        state: WorkspaceState;
        head_sha: string | null;
        pushed_sha: string | null;
      } | null;
      resources: { id: string; released_at: string | null }[];
    }[];
    resume: {
      workspace: { state: WorkspaceState } | null;
      last_pushed_sha: string | null;
      brief_document_version_id: string | null;
      last_end_reason: string | null;
      unreleased_resources: number;
    } | null;
  };
const runView = (itemId: string, runId: string) =>
  itemView(itemId).runs.find((r) => r.run_id === runId)!;
const report = (extra: Record<string, unknown> = {}) =>
  d.services.recovery.report(d.read(SYSTEM_ACTOR), {
    include_briefs: false,
    limit: 50,
    ...extra,
  } as never);
const wsState = (path: string) =>
  d.services.recovery.workspaceStates(d.read(SYSTEM_ACTOR), { paths: [path] })[path];

/** Call a tool as `claude` through the real handler, so the signal hook runs. */
function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const info: McpSessionInfo = {
    session_id: 'sess-claude',
    client: 'claude',
    client_name: null,
    client_version: null,
    result_mode: 'structured',
    started_at: d.clock.now().toISOString(),
    last_seen_at: d.clock.now().toISOString(),
  };
  const opts: RegisterOptions = {
    runtime: d.server.runtime,
    session: () => info,
    handlers: TOOL_HANDLERS,
  };
  return callTool(opts, name, args);
}

/** Mark an item done with a close time (fixture: the item service's own close is US1's). */
function closeItem(id: string) {
  forceStatus(d, id, 'done');
  d.sql.prepare('UPDATE items SET closed_at = ? WHERE id = ?').run(d.clock.now().toISOString(), id);
}

// ---- Parking ----

describe('park_run (BUILD_SPEC §5.16)', () => {
  it('suspends the lease, keeps the claim, and records run.parked', () => {
    const { run_id } = claim('RCP-17');
    const out = park(
      run_id,
      { orchestrator: true },
      'Waiting for the coordinator to send more work',
    );
    expect(out).toEqual({ run_state: 'parked', resume_ready: false });
    expect(run(run_id)).toMatchObject({
      state: 'parked',
      lease_expires_at: null,
      end_reason: null,
    });
    expect(
      d.rows("SELECT id FROM runs WHERE item_id = 'RCP-17' AND is_lead = 1 AND state = 'parked'"),
    ).toHaveLength(1);
    expect(events('run.parked').at(-1)!.summary).toContain('waiting on the coordinator');
    // Someone else's claim is refused: the parked run holds it.
    d.fails(codex, (w, s) => s.runs.claim(w, { id: 'RCP-17' }), 'conflict');
  });

  it('never goes stale and is never swept: not by the lease sweep, not by a restart', () => {
    const { run_id } = claim('RCP-17');
    park(run_id, { orchestrator: true });
    d.clock.advance(hours(30));
    expect(sweepOnce(d.server.runtime).interrupted).not.toContain(run_id);
    expect(restartSweep(d.server.runtime).kept).not.toContain(run_id);
    expect(runView('RCP-17', run_id).run_state).toBe('parked');
    expect(run(run_id).state).toBe('parked');
    expect(problems('stale_run').map((p) => p.run_id)).not.toContain(run_id);
  });

  it('a read with its run_id leaves it parked (decision 42)', async () => {
    const { run_id } = claim('RCP-17');
    park(run_id, { orchestrator: true });
    d.clock.advance(hours(3));
    const res = await call('get_item', { id: 'RCP-17', view: 'summary', run_id });
    expect(res.isError).toBeFalsy();
    expect(run(run_id).state).toBe('parked');
    expect(events('run.resumed')).toHaveLength(0);
  });

  it('a later write with its run_id resumes it, through the signal hook', async () => {
    const { run_id } = claim('RCP-17');
    park(run_id, { orchestrator: true });
    d.clock.advance(hours(3));
    const res = await call('add_note', { id: 'RCP-17', text: 'Back on it', run_id });
    expect(res.isError).toBeFalsy();
    const after = run(run_id);
    expect(after.state).toBe('open');
    expect(after.lease_expires_at).toBe(
      new Date(d.clock.now().getTime() + cfg().leaseMs).toISOString(),
    );
    expect(after.parked_at).toBeNull();
    expect(events('run.resumed').at(-1)!.summary).toMatch(/resumed after 3h parked/);
  });

  it('a heartbeat resumes it and reports it live or reported again', async () => {
    const { run_id } = claim('RCP-17');
    park(run_id, { orchestrator: true });
    const res = await call('heartbeat', { run_id, note: 'Resuming' });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { run_state: string }).run_state).not.toBe('parked');
    expect(run(run_id).state).toBe('open');
  });

  it('park_run on a parked run re-parks (no resume), keeping when it was first parked', async () => {
    const { run_id } = claim('RCP-17');
    park(run_id, { orchestrator: true });
    const first = run(run_id).parked_at;
    d.clock.advance(minutes(10));
    const res = await call('park_run', {
      run_id,
      reason: 'Now waiting on RCP-12',
      waiting_on: { items: ['RCP-12'] },
    });
    expect(res.isError).toBeFalsy();
    expect(run(run_id)).toMatchObject({ state: 'parked', parked_at: first });
    expect(events('run.resumed')).toHaveLength(0);
    expect(events('run.parked')).toHaveLength(2);
  });

  it('refuses an unknown item, its own item, an ended run and another agent’s run', () => {
    const { run_id } = claim('RCP-17');
    const unknown = d.fails(
      as(claude, run_id),
      (w, s) => s.runs.park(w, { run_id, reason: 'x', waiting_on: { items: ['RCP-999'] } }),
      'validation',
    );
    expect(unknown.message).toContain('RCP-999');
    d.fails(
      as(claude, run_id),
      (w, s) => s.runs.park(w, { run_id, reason: 'x', waiting_on: { items: ['RCP-17'] } }),
      'validation',
    );
    d.fails(as(codex, run_id), (w, s) => s.runs.park(w, { run_id, reason: 'x' }), 'forbidden');
    finish(run_id);
    d.fails(as(claude, run_id), (w, s) => s.runs.park(w, { run_id, reason: 'x' }), 'conflict');
  });
});

// ---- resume_ready, unattended, parked too long ----

describe('resume_ready and the parking Problems', () => {
  it('turns true once every waiting_on item is done, not before', () => {
    const { run_id } = claim('RCP-17');
    expect(park(run_id, { items: ['RCP-12', 'RCP-11'] }).resume_ready).toBe(false); // RCP-12 in review
    expect(runView('RCP-17', run_id).parked!.resume_ready).toBe(false);
    closeItem('RCP-12');
    expect(runView('RCP-17', run_id).parked!.resume_ready).toBe(true);
    expect(report().parked.find((p) => p.run.run_id === run_id)!.resume_ready).toBe(true);
  });

  it('uses the "blocker cleared" rule: a link’s own satisfied_when (verified) beats done', () => {
    const t = d.clock.now().toISOString();
    d.sql
      .prepare(
        `INSERT INTO links (id, from_id, to_id, type, satisfied_when, created_by, version, created_at, updated_at)
         VALUES ('lnk_t', 'RCP-12', 'RCP-17', 'blocks', 'verified', 'owner', 1, ?, ?)`,
      )
      .run(t, t);
    forceStatus(d, 'RCP-17', 'progress'); // claimable as unclaimed In progress despite the link
    const { run_id } = claim('RCP-17');
    park(run_id, { items: ['RCP-12'] });
    closeItem('RCP-12');
    // RCP-12 has undecided human review items: done, but not verified.
    expect(runView('RCP-17', run_id).parked!.resume_ready).toBe(false);
  });

  it('a canceled item never clears; a run parked only on the coordinator or a person stays false', () => {
    const a = claim('RCP-17').run_id;
    park(a, { items: ['RCP-12'] });
    forceStatus(d, 'RCP-12', 'canceled');
    const b = claim('RCP-25').run_id;
    park(b, { orchestrator: true, person: true });
    d.clock.advance(hours(48));
    expect(runView('RCP-17', a).parked!.resume_ready).toBe(false);
    expect(runView('RCP-25', b).parked!.resume_ready).toBe(false);
  });

  it('turns true when `until` passes', () => {
    const { run_id } = claim('RCP-17');
    const until = new Date(d.clock.now().getTime() + minutes(20)).toISOString();
    expect(park(run_id, { until }).resume_ready).toBe(false);
    d.clock.advance(minutes(21));
    expect(runView('RCP-17', run_id).parked!.resume_ready).toBe(true);
  });

  it('"Ready to resume, unattended" once resume_ready for RESUME_UNATTENDED', () => {
    const { run_id } = claim('RCP-17');
    park(run_id, { items: ['RCP-12'] });
    d.clock.advance(hours(2));
    closeItem('RCP-12');
    d.clock.advance(cfg().resumeUnattendedMs - minutes(1));
    expect(problems('resume_unattended')).toEqual([]);
    d.clock.advance(minutes(1));
    const [p] = problems('resume_unattended');
    expect(p).toMatchObject({ item_id: 'RCP-17', run_id });
    expect(p!.reason).toBe('Ready to resume: RCP-12 is done · parked 3h');
  });

  it('"Parked for 24 h" after PARK_MAX, and the run keeps its claim', () => {
    const { run_id } = claim('RCP-17');
    park(run_id, { orchestrator: true });
    d.clock.advance(cfg().parkMaxMs - minutes(1));
    expect(problems('parked_too_long')).toEqual([]);
    d.clock.advance(minutes(1));
    const [p] = problems('parked_too_long');
    expect(p).toMatchObject({ item_id: 'RCP-17', run_id });
    expect(p!.reason).toBe('Parked since Nov 6 · waiting on the coordinator · keeps its claim');
    expect(run(run_id).state).toBe('parked');
    sweepOnce(d.server.runtime);
    expect(run(run_id).state).toBe('parked');
  });

  it('the sweeper flags each once: ready to resume, unattended, parked too long', () => {
    const { run_id } = claim('RCP-17');
    park(run_id, { items: ['RCP-12'] });
    const seen = new Set<string>();
    expect(flagOnce(d.server.runtime, seen)).toEqual([]);
    closeItem('RCP-12');
    expect(flagOnce(d.server.runtime, seen)).toEqual([`resume_ready:${run_id}`]);
    d.clock.advance(cfg().parkMaxMs);
    expect(flagOnce(d.server.runtime, seen).sort()).toEqual(
      [`parked_too_long:${run_id}`, `resume_unattended:${run_id}`].sort(),
    );
    expect(flagOnce(d.server.runtime, seen)).toEqual([]);
  });
});

describe('lead_parked on the owner views (B20, UI API only)', () => {
  it('fills Work cards, the epic Tickets list and Agents rows; null when the lead is not parked', () => {
    const { run_id } = claim('RCP-17');
    park(run_id, { orchestrator: true });
    const owner = d.read(OWNER_ACTOR);
    const work = d.services.views.work(owner, { scope: 'all', filter: 'all', layout: 'board' });
    const card = work.items.find((i) => i.id === 'RCP-17')!;
    expect(card.lead_parked).toEqual({
      waiting_on: { orchestrator: true },
      since: run(run_id).parked_at,
      resume_ready: false,
    });
    expect(
      work.items.filter((i) => i.id !== 'RCP-17').every((i) => (i.lead_parked ?? null) === null),
    ).toBe(true);

    const epic = d.services.views.itemDetail(owner, { id: card.epic! });
    expect(epic.children.find((c) => c.id === 'RCP-17')!.lead_parked).toEqual(card.lead_parked);

    const rows = d.services.views.agents(owner, { scope: 'all' }).rows;
    expect(rows.find((r) => r.run_id === run_id)!.lead_parked).toEqual(card.lead_parked);
    expect(
      rows.filter((r) => r.run_id !== run_id).every((r) => (r.lead_parked ?? null) === null),
    ).toBe(true);
  });

  it('turns resume_ready once what it waits on is done', () => {
    const { run_id } = claim('RCP-17');
    park(run_id, { items: ['RCP-12'] });
    closeItem('RCP-12');
    const owner = d.read(OWNER_ACTOR);
    const card = d.services.views
      .work(owner, { scope: 'all', filter: 'all', layout: 'board' })
      .items.find((i) => i.id === 'RCP-17')!;
    expect(card.lead_parked).toMatchObject({
      waiting_on: { items: ['RCP-12'] },
      resume_ready: true,
    });
  });
});

// ---- end_reason ----

describe('end_reason on every terminal path (FR-114)', () => {
  it('finished and failed (finish_run), released (release_lead)', () => {
    const a = claim('RCP-17').run_id;
    finish(a, 'finished');
    expect(run(a)).toMatchObject({ state: 'finished', end_reason: 'finished' });
    const b = claim('RCP-17').run_id;
    finish(b, 'failed');
    expect(run(b)).toMatchObject({ state: 'failed', end_reason: 'failed' });
    const c = claim('RCP-25').run_id;
    d.write(as(claude, c), (w, s) =>
      s.runs.release(w, { id: 'RCP-25', run_id: c, reason: 'Stopping.' }),
    );
    expect(run(c)).toMatchObject({ state: 'interrupted', end_reason: 'released' });
  });

  it('lease_expired (sweeper), service_restart (history before decision 41), canceled (set_status)', () => {
    const a = claim('RCP-17').run_id;
    d.clock.advance(cfg().leaseMs + minutes(1));
    sweepOnce(d.server.runtime);
    expect(run(a)).toMatchObject({ state: 'interrupted', end_reason: 'lease_expired' });
    const b = claim('RCP-25').run_id;
    endRunsAsOldRestart(d.server.runtime);
    expect(run(b)).toMatchObject({ state: 'interrupted', end_reason: 'service_restart' });
    const c = claim('DOC-5').run_id;
    const version = d.row<{ version: number }>(
      "SELECT version FROM items WHERE id = 'DOC-5'",
    ).version;
    d.write(as(claude, c), (w, s) =>
      s.items.setStatus(w, {
        id: 'DOC-5',
        status: 'canceled',
        reason: 'Not needed.',
        expected_version: version,
      }),
    );
    expect(run(c)).toMatchObject({ state: 'interrupted', end_reason: 'canceled' });
  });

  it('a parked run that is resumed and finished ends finished, never parked', async () => {
    const { run_id } = claim('RCP-17');
    park(run_id, { orchestrator: true });
    const res = await call('finish_run', { run_id, result: 'finished', summary: 'Done waiting.' });
    expect(res.isError).toBeFalsy();
    expect(run(run_id)).toMatchObject({ state: 'finished', end_reason: 'finished' });
  });
});

// ---- Resources ----

describe('resources and orphans (FR-113)', () => {
  const devServer = {
    kind: 'dev_server',
    label: 'dev server :5173',
    locator: { port: 5173, pid: 4242 },
  };

  it('declaring and releasing append resource events; the heartbeat lists what is still running', () => {
    const { run_id } = claim('RCP-17');
    const out = resources(run_id, { resources_started: [devServer] });
    expect(out.resources).toEqual([
      { id: expect.stringMatching(/^rsc_/), label: 'dev server :5173' },
    ]);
    expect(heartbeat(run_id).resources).toEqual(out.resources);
    resources(run_id, {
      resources_released: [{ resource_id: out.resources[0]!.id, note: 'Stopped.' }],
    });
    expect(heartbeat(run_id).resources).toEqual([]);
    expect(events('resource.declared')).toHaveLength(1);
    expect(events('resource.released')).toHaveLength(1);
  });

  it('a run of another item cannot release it; an unknown one is not_found', () => {
    const a = claim('RCP-17').run_id;
    const rsc = resources(a, { resources_started: [devServer] }).resources[0]!.id;
    const b = claim('RCP-25').run_id;
    d.fails(
      as(claude, b),
      (w, s) =>
        s.runs.updateResources(w, { run_id: b, resources_released: [{ resource_id: rsc }] }),
      'forbidden',
    );
    d.fails(
      as(claude, b),
      (w, s) =>
        s.runs.updateResources(w, { run_id: b, resources_released: [{ resource_id: 'rsc_nope' }] }),
      'not_found',
    );
  });

  it('orphaned after ORPHAN_AFTER once the run ended, with how to find it', () => {
    const { run_id } = claim('RCP-17');
    const rsc = resources(run_id, { resources_started: [devServer] }).resources[0]!.id;
    expect(finish(run_id)).toMatchObject({
      warnings: ['1 resource still declared: dev server :5173'],
    });
    d.clock.advance(cfg().orphanAfterMs - 1000);
    expect(problems('orphaned_resources')).toEqual([]);
    expect(report().orphaned_resources).toEqual([]);
    d.clock.advance(1000);
    const [p] = problems('orphaned_resources');
    expect(p).toMatchObject({ item_id: 'RCP-17', run_id, resource_ids: [rsc] });
    expect(p!.reason).toBe(
      'dev server :5173 (pid 4242, port 5173) still running 15m after its run ended · stop it, then mark it released',
    );
    expect(report().orphaned_resources).toEqual([
      expect.objectContaining({
        item_id: 'RCP-17',
        run_id,
        resource: expect.objectContaining({ id: rsc }),
      }),
    ]);
  });

  it('a later run of the same item releases it, and the orphan clears', () => {
    const a = claim('RCP-17').run_id;
    const rsc = resources(a, { resources_started: [devServer] }).resources[0]!.id;
    d.clock.advance(cfg().leaseMs + minutes(1));
    sweepOnce(d.server.runtime);
    d.clock.advance(cfg().orphanAfterMs);
    expect(problems('orphaned_resources')).toHaveLength(1);
    const b = claim('RCP-17').run_id;
    resources(b, { resources_released: [{ resource_id: rsc, note: 'Killed pid 4242.' }] });
    expect(problems('orphaned_resources')).toEqual([]);
  });

  it('the owner’s Mark released sets released_by owner, and Undo restores it', () => {
    const { run_id } = claim('RCP-17');
    const rsc = resources(run_id, { resources_started: [devServer] }).resources[0]!.id;
    finish(run_id);
    d.clock.advance(cfg().orphanAfterMs);
    let mutation = '';
    d.write(OWNER_ACTOR, (w, s) => {
      mutation = w.mutationId;
      return s.recovery.ownerReleaseResource(w, { id: rsc, note: 'Stopped it.' });
    });
    expect(d.row('SELECT released_by, release_note FROM run_resources WHERE id = ?', rsc)).toEqual({
      released_by: 'owner',
      release_note: 'Stopped it.',
    });
    expect(problems('orphaned_resources')).toEqual([]);
    d.write(OWNER_ACTOR, (w) => applyUndo(w, mutation));
    expect(
      d.row<{ released_at: string | null }>(
        'SELECT released_at FROM run_resources WHERE id = ?',
        rsc,
      ).released_at,
    ).toBeNull();
    expect(problems('orphaned_resources')).toHaveLength(1);
    d.write(OWNER_ACTOR, (w, s) => s.recovery.ownerReleaseResource(w, { id: rsc }));
    d.fails(OWNER_ACTOR, (w, s) => s.recovery.ownerReleaseResource(w, { id: rsc }), 'conflict');
  });
});

// ---- Unpushed work at risk ----

describe('unpushed work may be lost (FR-114)', () => {
  const ws = {
    path: 'C:/work/rcp-17',
    branch: 'rcp-17-week',
    base_ref: 'origin/main',
    base_sha: '9a10624',
  };

  function interruptedWithWork(dirty: boolean) {
    const { run_id } = claim('RCP-17', { workspace: ws });
    d.write(as(claude, run_id), (w, s) =>
      s.evidence.reportCommit(w, { id: 'RCP-17', sha: '6f00e12', pushed: true }),
    );
    d.write(as(claude, run_id), (w, s) =>
      s.evidence.reportCommit(w, { id: 'RCP-17', sha: '77aa001', pushed: false }),
    );
    heartbeat(run_id, { workspace: { dirty } });
    d.clock.advance(cfg().leaseMs + minutes(1));
    sweepOnce(d.server.runtime);
    return run_id;
  }

  it('flags a run that ended unexpectedly with head ≠ pushed or dirty', () => {
    const run_id = interruptedWithWork(true);
    const [p] = problems('unpushed_work');
    expect(p).toMatchObject({ item_id: 'RCP-17', run_id });
    expect(p!.reason).toBe(
      '1 commit not pushed · uncommitted changes · unverified · C:/work/rcp-17 · run ended (lease expired)',
    );
  });

  it('flags a run that finished with commits not pushed too (MCP_SPEC §10 test 20; B10 ruling Q2)', () => {
    const { run_id } = claim('RCP-17', { workspace: ws });
    d.write(as(claude, run_id), (w, s) =>
      s.evidence.reportCommit(w, { id: 'RCP-17', sha: '6f00e12', pushed: true }),
    );
    d.write(as(claude, run_id), (w, s) =>
      s.evidence.reportCommit(w, { id: 'RCP-17', sha: '77aa001', pushed: false }),
    );
    d.write(as(claude, run_id), (w, s) =>
      s.evidence.reportCommit(w, { id: 'RCP-17', sha: '88bb002', pushed: false }),
    );
    expect(finish(run_id)).toEqual({ run_state: 'finished', warnings: ['2 commits not pushed'] });
    const [p] = problems('unpushed_work');
    expect(p).toMatchObject({ item_id: 'RCP-17', run_id });
    expect(p!.reason).toBe(
      '2 commits not pushed · unverified · C:/work/rcp-17 · run ended (finished)',
    );
    expect(wsState('C:/work/rcp-17')).toBe('at_risk');
  });

  it('flags a failed run left dirty; not a finished run that pushed everything and was clean', () => {
    const a = claim('RCP-17', { workspace: ws }).run_id;
    heartbeat(a, { workspace: { dirty: true } });
    finish(a, 'failed');
    expect(problems('unpushed_work').map((p) => p.run_id)).toEqual([a]);
    const b = claim('RCP-25', { workspace: { path: 'C:/work/rcp-25', branch: 'b' } }).run_id;
    d.write(as(claude, b), (w, s) =>
      s.evidence.reportCommit(w, { id: 'RCP-25', sha: '4be1c09', pushed: true }),
    );
    heartbeat(b, { workspace: { dirty: false } });
    expect(finish(b)).toEqual({ run_state: 'finished' });
    expect(problems('unpushed_work').map((p) => p.run_id)).toEqual([a]);
  });

  it('clears when a later run reports a pushed commit', () => {
    interruptedWithWork(false);
    expect(problems('unpushed_work')).toHaveLength(1);
    d.clock.advance(minutes(5));
    const b = claim('RCP-17', { workspace: ws }).run_id;
    d.write(as(claude, b), (w, s) =>
      s.evidence.reportCommit(w, { id: 'RCP-17', sha: '77aa001', pushed: true }),
    );
    expect(problems('unpushed_work')).toEqual([]);
  });

  it('clears when the owner marks it Handled, and Undo brings it back', () => {
    const run_id = interruptedWithWork(true);
    let mutation = '';
    const out = d.write(OWNER_ACTOR, (w, s) => {
      mutation = w.mutationId;
      return s.recovery.markUnpushedHandled(w, { runId: run_id });
    });
    expect(out).toEqual({
      run_id,
      unpushed_handled_at: d.clock.now().toISOString(),
      outcome: 'discard',
    });
    expect(problems('unpushed_work')).toEqual([]);
    // Handled, but the work still waits to be restarted: not safe to prune yet (ruling Q1).
    expect(wsState('C:/work/rcp-17')).toBe('at_risk');
    expect(events('run.unpushed_handled')).toHaveLength(1);
    d.write(OWNER_ACTOR, (w) => applyUndo(w, mutation));
    expect(problems('unpushed_work')).toHaveLength(1);
  });

  it('Handled is refused on a run that is still going', () => {
    const { run_id } = claim('RCP-17', { workspace: ws });
    d.fails(
      OWNER_ACTOR,
      (w, s) => s.recovery.markUnpushedHandled(w, { runId: run_id }),
      'validation',
    );
  });
});

// ---- Workspace state ----

describe('workspace state, derived per worktree path (MCP_SPEC §3)', () => {
  const path = 'C:/work/rcp-17';
  const ws = { path, branch: 'rcp-17-week' };
  const pushedClean = (run_id: string) => {
    d.write(as(claude, run_id), (w, s) =>
      s.evidence.reportCommit(w, { id: 'RCP-17', sha: '4be1c09', pushed: true }),
    );
    heartbeat(run_id, { workspace: { dirty: false } });
  };

  it('unknown when nothing was reported (never safe to prune), and for a path nobody reported', () => {
    const { run_id } = claim('RCP-17', { workspace: ws });
    finish(run_id);
    expect(wsState(path)).toBe('unknown');
    expect(wsState('C:/work/never-seen')).toBe('unknown');
  });

  it('in_use with an open run, parked with a parked run', () => {
    const { run_id } = claim('RCP-17', { workspace: ws });
    expect(wsState(path)).toBe('in_use');
    expect(runView('RCP-17', run_id).workspace!.state).toBe('in_use');
    park(run_id, { orchestrator: true });
    expect(wsState(path)).toBe('parked');
  });

  it('at_risk when dirty, unpushed, or with resources unreleased, once no run is open', () => {
    const a = claim('RCP-17', { workspace: ws }).run_id;
    pushedClean(a);
    heartbeat(a, { workspace: { dirty: true } });
    finish(a);
    expect(wsState(path)).toBe('at_risk');

    const b = claim('RCP-17', { workspace: { path: 'C:/work/b', branch: 'b' } }).run_id;
    heartbeat(b, { workspace: { head_sha: '77aa001', pushed_sha: '6f00e12', dirty: false } });
    finish(b);
    expect(wsState('C:/work/b')).toBe('at_risk');

    const c = claim('RCP-17', { workspace: { path: 'C:/work/c', branch: 'c' } }).run_id;
    heartbeat(c, { workspace: { head_sha: '6f00e12', pushed_sha: '6f00e12', dirty: false } });
    resources(c, {
      resources_started: [{ kind: 'session', label: 'tmux w3', locator: { session_id: 'w3' } }],
    });
    finish(c);
    expect(wsState('C:/work/c')).toBe('at_risk');
  });

  it('at_risk while an interrupted run waits to be restarted, even clean and pushed (B10 ruling Q1)', () => {
    const { run_id } = claim('RCP-17', { workspace: ws });
    pushedClean(run_id);
    endRunsAsOldRestart(d.server.runtime); // RCP-17 is still In progress, nobody leads it
    expect(wsState(path)).toBe('at_risk');
    expect(itemView('RCP-17').resume!.workspace!.state).toBe('at_risk');
    // A newer run claims the item (elsewhere) and finishes: the old worktree follows the normal rules.
    const b = claim('RCP-17', { workspace: { path: 'C:/work/rcp-17-b', branch: 'b' } }).run_id;
    expect(wsState(path)).toBe('safe_to_prune');
    finish(b);
    expect(wsState(path)).toBe('safe_to_prune');
  });

  it('at_risk after lease expiry until the item is done or canceled', () => {
    const { run_id } = claim('RCP-17', { workspace: ws });
    pushedClean(run_id);
    d.clock.advance(cfg().leaseMs + minutes(1));
    sweepOnce(d.server.runtime); // lease_expired; RCP-17 back to Ready
    expect(wsState(path)).toBe('at_risk');
    forceStatus(d, 'RCP-17', 'canceled');
    expect(wsState(path)).toBe('safe_to_prune');
    forceStatus(d, 'RCP-17', 'done');
    expect(wsState(path)).toBe('safe_to_prune');
  });

  it('a run the agent released itself, or finished, does not hold its worktree at risk', () => {
    const { run_id } = claim('RCP-17', { workspace: ws });
    pushedClean(run_id);
    d.write(as(claude, run_id), (w, s) =>
      s.runs.release(w, { id: 'RCP-17', run_id, reason: 'Done for now.' }),
    );
    expect(wsState(path)).toBe('safe_to_prune');
  });

  it('safe_to_prune when every run ended, the head is pushed, clean and nothing is running', () => {
    const { run_id } = claim('RCP-17', { workspace: ws });
    pushedClean(run_id);
    expect(wsState(path)).toBe('in_use');
    finish(run_id);
    expect(wsState(path)).toBe('safe_to_prune');
    // The same worktree, written with backslashes and a trailing slash.
    expect(wsState('C:\\work\\rcp-17\\')).toBe('safe_to_prune');
  });

  it('report_commit pushed:true moves pushed_sha (and head_sha); a plain commit moves only the head', () => {
    const { run_id } = claim('RCP-17', { workspace: ws });
    d.write(as(claude, run_id), (w, s) =>
      s.evidence.reportCommit(w, { id: 'RCP-17', sha: '6f00e12', pushed: true }),
    );
    expect(runView('RCP-17', run_id).workspace).toMatchObject({
      head_sha: '6f00e12',
      pushed_sha: '6f00e12',
    });
    d.write(as(claude, run_id), (w, s) =>
      s.evidence.reportCommit(w, { id: 'RCP-17', sha: '77aa001', pushed: false }),
    );
    expect(runView('RCP-17', run_id).workspace).toMatchObject({
      head_sha: '77aa001',
      pushed_sha: '6f00e12',
    });
    // Re-reporting the same SHA once it is pushed moves pushed_sha only.
    d.write(as(claude, run_id), (w, s) =>
      s.evidence.reportCommit(w, { id: 'RCP-17', sha: '77aa001', pushed: true }),
    );
    expect(runView('RCP-17', run_id).workspace).toMatchObject({
      head_sha: '77aa001',
      pushed_sha: '77aa001',
    });
  });

  it('heartbeat patches the workspace: what it leaves out stays', () => {
    const { run_id } = claim('RCP-17', {
      workspace: { ...ws, base_sha: '9a10624', host: 'devbox' },
    });
    heartbeat(run_id, { workspace: { head_sha: '77aa001', dirty: true } });
    heartbeat(run_id, { workspace: { dirty: false } });
    expect(runView('RCP-17', run_id).workspace).toMatchObject({
      path,
      branch: 'rcp-17-week',
      host: 'devbox',
      head_sha: '77aa001',
      pushed_sha: null,
    });
    expect(JSON.parse(run(run_id).workspace!)).toMatchObject({ dirty: false, base_sha: '9a10624' });
  });

  it('a later push reported without a run catches an ended run’s worktree up', () => {
    const { run_id } = claim('RCP-17', { workspace: ws });
    heartbeat(run_id, { workspace: { head_sha: '77aa001', pushed_sha: '6f00e12', dirty: false } });
    finish(run_id);
    expect(wsState(path)).toBe('at_risk');
    d.write(codex, (w, s) =>
      s.evidence.reportCommit(w, { id: 'RCP-17', sha: '77aa001', pushed: true }),
    );
    expect(wsState(path)).toBe('safe_to_prune');
  });
});

// ---- Briefs and Item.resume ----

describe('briefs and Item.resume (FR-111, FR-115)', () => {
  const brief =
    'Work RCP-17.\r\nWorktree: C:/work/rcp-17 · “quotes” and émojis 🚀  \n\ttrailing whitespace kept  ';

  it('stores the brief as an immutable brief document version, byte for byte', () => {
    const { run_id } = claim('RCP-17', { brief });
    const dv = d.row<{ brief_document_version_id: string }>(
      'SELECT brief_document_version_id FROM runs WHERE id = ?',
      run_id,
    ).brief_document_version_id;
    const doc = d.row<{ name: string; kind: string; path: string; size: number }>(
      'SELECT d.name, d.kind, v.path, v.size FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE v.id = ?',
      dv,
    );
    expect(doc).toMatchObject({
      name: `brief-${run_id}.md`,
      kind: 'brief',
      size: Buffer.byteLength(brief),
    });
    expect(readFileSync(join(cfg().paths.docs, doc.path), 'utf8')).toBe(brief);
    expect(events('document.added').at(-1)!.summary).toContain(`brief-${run_id}.md`);
  });

  it('brief_document_version_id references an existing version on the item, else validation', () => {
    const a = claim('RCP-17', { brief }).run_id;
    const dv = d.row<{ v: string }>(
      'SELECT brief_document_version_id AS v FROM runs WHERE id = ?',
      a,
    ).v;
    finish(a);
    const b = claim('RCP-17', { brief_document_version_id: dv }).run_id;
    expect(
      d.row<{ v: string }>('SELECT brief_document_version_id AS v FROM runs WHERE id = ?', b).v,
    ).toBe(dv);
    d.fails(
      claude,
      (w, s) => s.runs.claim(w, { id: 'RCP-25', brief_document_version_id: dv }),
      'validation',
    );
    d.fails(
      claude,
      (w, s) => s.runs.claim(w, { id: 'RCP-25', brief_document_version_id: 'dv_nope' }),
      'validation',
    );
  });

  it('Item.resume is null for a fresh item and set once its last run was interrupted', () => {
    expect(itemView('RCP-17').resume).toBeNull();
    const { run_id } = claim('RCP-17', {
      brief,
      workspace: { path: 'C:/work/rcp-17', branch: 'b' },
    });
    expect(itemView('RCP-17').resume).toBeNull(); // led, not resumable
    d.write(as(claude, run_id), (w, s) =>
      s.evidence.reportCommit(w, { id: 'RCP-17', sha: '4be1c09', pushed: true }),
    );
    resources(run_id, {
      resources_started: [{ kind: 'port', label: 'port 3000', locator: { port: 3000 } }],
    });
    endRunsAsOldRestart(d.server.runtime);
    const resume = itemView('RCP-17').resume!;
    expect(resume).toMatchObject({
      last_pushed_sha: '4be1c09',
      last_end_reason: 'service_restart',
      unreleased_resources: 1,
      brief_document_version_id: expect.stringMatching(/^dv_/),
    });
    expect(resume.workspace!.state).toBe('at_risk');
  });
});

// ---- The restart list ----

describe('recovery_report', () => {
  it('lists the interrupted run with its end reason, brief and checklist; parked and stale runs; nothing else of theirs', () => {
    const brief = 'Exact brief\nline 2';
    const a = claim('RCP-17', {
      brief,
      workspace: { path: 'C:/work/rcp-17', branch: 'rcp-17' },
    }).run_id;
    d.write(as(claude, a), (w, s) =>
      s.checklist.setPlan(w, {
        id: 'RCP-17',
        steps: [{ text: 'One' }, { text: 'Two' }, { text: 'Three' }],
        reason: 'Plan',
      } as never),
    );
    const b = claim('RCP-25').run_id;
    park(b, { orchestrator: true });
    // Before the restart, the seed's silent RCP-15 lead is stale.
    expect(report().stale.map((s) => s.item.id)).toContain('RCP-15');
    endRunsAsOldRestart(d.server.runtime);
    const r = report({ include_briefs: true });
    const entry = r.interrupted.find((e) => e.run.run_id === a)!;
    expect(entry).toMatchObject({
      end_reason: 'service_restart',
      brief,
      checklist: { done: 0, total: 3 },
    });
    // Waiting to be restarted: never safe to prune (B10 ruling Q1).
    expect(entry.run.workspace).toMatchObject({ path: 'C:/work/rcp-17', state: 'at_risk' });
    expect(r.parked.map((p) => p.run.run_id)).toContain(b);
    expect(report().interrupted.find((e) => e.run.run_id === a)!.brief).toBeUndefined();
    // The restart interrupted it too: it is on the list to re-dispatch, no longer stale.
    expect(r.stale).toEqual([]);
    expect(r.interrupted.map((e) => e.item.id)).toContain('RCP-15');
    // Re-claimed: no longer on the list.
    claim('RCP-17');
    expect(report().interrupted.map((e) => e.run.run_id)).not.toContain(a);
  });

  it('pages across its sections with an opaque cursor, each entry once', () => {
    for (const id of ['RCP-17', 'RCP-25', 'DOC-5']) {
      claim(id, { workspace: { path: `C:/work/${id}`, branch: id } });
    }
    endRunsAsOldRestart(d.server.runtime);
    const full = report();
    const total =
      full.interrupted.length +
      full.stale.length +
      full.parked.length +
      full.workspaces.length +
      full.orphaned_resources.length;
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = report({ limit: 3, ...(cursor ? { cursor } : {}) });
      seen.push(
        ...page.interrupted.map((e) => `i:${e.run.run_id}`),
        ...page.stale.map((e) => `s:${e.run.run_id}`),
        ...page.parked.map((e) => `p:${e.run.run_id}`),
        ...page.workspaces.map((e) => `w:${e.path}`),
        ...page.orphaned_resources.map((e) => `o:${e.resource.id}`),
      );
      cursor = page.next_cursor ?? undefined;
      pages++;
    } while (cursor);
    expect(new Set(seen).size).toBe(total);
    expect(seen).toHaveLength(total);
    expect(pages).toBe(Math.ceil(total / 3));
    expect(() => report({ cursor: 'nope' })).toThrow(/cursor is not valid/);
  });

  it('is read-only: it writes no event and changes no run', () => {
    claim('RCP-17');
    endRunsAsOldRestart(d.server.runtime);
    const before = d.row<{ n: number }>('SELECT count(*) AS n FROM events').n;
    report({ include_briefs: true });
    expect(d.row<{ n: number }>('SELECT count(*) AS n FROM events').n).toBe(before);
  });
});
