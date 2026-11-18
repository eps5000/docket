/**
 * Lead claims and leases (BUILD_SPEC §5.3; FR-013, FR-014, FR-016; tasks.md T065).
 *
 * The race runs through the real MCP tool handler, the real write path and
 * the real database: 100 sessions claim one item at once.
 */
import { ToolError } from '@docket/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { callTool, type RegisterOptions } from '../../src/mcp/register.js';
import type { McpSessionInfo } from '../../src/mcp/server.js';
import { TOOL_HANDLERS } from '../../src/mcp/tools/index.js';
import { restartSweep, sweepOnce } from '../../src/jobs/sweeper.js';
import { SYSTEM_ACTOR, type Actor } from '../../src/domain/write.js';
import { minutes, startDomain, type Domain } from '../us1-helpers.js';

let d: Domain;
let claude: Actor;
let codex: Actor;

beforeEach(() => {
  d = startDomain();
  claude = d.agent('claude', { label: 'orca-w3' });
  codex = d.agent('codex', { label: 'orca-w1' });
});
afterEach(() => d.cleanup());

const run = (id: string) =>
  d.row<{
    state: string;
    end_reason: string | null;
    lease_expires_at: string | null;
    last_signal_at: string;
  }>('SELECT state, end_reason, lease_expires_at, last_signal_at FROM runs WHERE id = ?', id);
const status = (id: string) =>
  d.row<{ status: string }>('SELECT status FROM items WHERE id = ?', id).status;
const activeLeads = (id: string) =>
  d.rows(
    "SELECT id FROM runs WHERE item_id = ? AND is_lead = 1 AND state IN ('open','needs_input','parked')",
    id,
  );

function claim(id: string, actor: Actor = claude) {
  return d.write(actor, (w, s) => s.runs.claim(w, { id, agent_label: actor.label ?? undefined }));
}

describe('claim_lead', () => {
  it('moves a Ready item to In progress and opens a lead run with a lease (now + LEASE)', () => {
    const out = claim('RCP-17');
    expect(out.item.status).toBe('progress');
    expect(out.run_id).toMatch(/^run_/);
    expect(out.lease_expires_at).toBe(
      new Date(d.clock.now().getTime() + minutes(60)).toISOString(),
    );
    expect(out.item.lead).toEqual({
      client: 'claude',
      label: 'orca-w3',
      run_id: out.run_id,
      run_state: expect.any(String),
    });
    expect(
      d.row('SELECT is_lead, state, client, label, session_id FROM runs WHERE id = ?', out.run_id),
    ).toEqual({
      is_lead: 1,
      state: 'open',
      client: 'claude',
      label: 'orca-w3',
      session_id: 'sess-claude',
    });
    const types = d
      .rows<{ type: string }>("SELECT type FROM events WHERE item_id = 'RCP-17' ORDER BY seq")
      .map((e) => e.type);
    expect(types).toContain('claim.granted');
  });

  it('refuses a held claim with conflict naming the lead, its last signal and lease', () => {
    const err = d.fails(codex, (w, s) => s.runs.claim(w, { id: 'RCP-14' }), 'conflict');
    expect(err.current).toMatchObject({
      lead_client: 'claude',
      lead_label: 'orca-w3',
      run_id: expect.stringMatching(/^run_/),
      last_signal_at: expect.any(String),
      lease_expires_at: expect.any(String),
    });
    expect(err.message).toContain('claude · orca-w3');
    expect(err.message).toMatch(/Pick another item\.$/);
  });

  it('refuses a blocked Ready item with validation naming the blockers', () => {
    const err = d.fails(claude, (w, s) => s.runs.claim(w, { id: 'RCP-16' }), 'validation');
    expect(err.details?.blocked_by).toEqual(expect.arrayContaining(['DOC-4', 'RCP-19']));
  });

  it('an unknown item is not_found', () => {
    d.fails(claude, (w, s) => s.runs.claim(w, { id: 'RCP-99' }), 'not_found');
  });
});

describe('100 concurrent claims (FR-013)', () => {
  it('exactly one wins; the other 99 get conflict naming the winner, recorded as rejected claims', async () => {
    const { runtime } = d.server;
    const opts = (i: number): RegisterOptions => {
      const info: McpSessionInfo = {
        session_id: `race-${i}`,
        client: i % 2 ? 'claude' : 'codex',
        client_name: null,
        client_version: null,
        result_mode: 'structured',
        started_at: d.clock.now().toISOString(),
        last_seen_at: d.clock.now().toISOString(),
      };
      return { runtime, session: () => info, handlers: TOOL_HANDLERS };
    };
    const before = d.row<{ n: number }>(
      "SELECT count(*) AS n FROM events WHERE type = 'claim.rejected'",
    ).n;
    const results = await Promise.all(
      Array.from({ length: 100 }, async (_, i) => {
        // Interleave the calls: each starts on its own turn of the event loop.
        await new Promise((r) => setImmediate(r));
        return callTool(opts(i), 'claim_lead', { id: 'RCP-17', agent_label: `w${i}` });
      }),
    );
    const winners = results.filter((r) => !r.isError);
    const losers = results.filter((r) => r.isError);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(99);
    const winner = winners[0]!.structuredContent as { run_id: string };
    for (const l of losers) {
      const err = l.structuredContent as { code: string; current: { run_id: string } };
      expect(err.code).toBe('conflict');
      expect(err.current.run_id).toBe(winner.run_id);
    }
    expect(activeLeads('RCP-17')).toEqual([{ id: winner.run_id }]);
    const after = d.row<{ n: number }>(
      "SELECT count(*) AS n FROM events WHERE type = 'claim.rejected'",
    ).n;
    expect(after - before).toBe(99);
  });

  it('the database itself refuses a second active lead run on an item', () => {
    const t = d.clock.now().toISOString();
    expect(() =>
      d.sql
        .prepare(
          `INSERT INTO runs (id, item_id, client, is_lead, state, last_signal_at, last_signal_kind, version, created_at, updated_at)
           VALUES ('run_dup', 'RCP-14', 'codex', 1, 'open', ?, 'session', 1, ?, ?)`,
        )
        .run(t, t, t),
    ).toThrow(/UNIQUE/);
  });
});

describe('leases', () => {
  it('any signal from the run renews the lease', () => {
    const { run_id } = claim('RCP-17');
    d.clock.advance(minutes(10));
    d.services.runs.recordSignal(d.read(claude), {
      run_id,
      kind: 'session',
      session_id: 'sess-claude',
    });
    expect(run(run_id).lease_expires_at).toBe(
      new Date(d.clock.now().getTime() + minutes(60)).toISOString(),
    );
    expect(run(run_id).last_signal_at).toBe(d.clock.now().toISOString());
  });

  it('lease expiry: the run is interrupted (lease_expired), the item back in Ready with its plan kept', () => {
    const { run_id } = claim('RCP-17');
    const actor = { ...claude, run_id };
    d.write(actor, (w, s) =>
      s.checklist.setPlan(w, {
        id: 'RCP-17',
        mode: 'patch',
        steps: [{ text: 'Reproduce the jump' }, { text: 'Persist the week in the URL' }],
      }),
    );
    d.clock.advance(minutes(61));
    const { interrupted } = d.write(SYSTEM_ACTOR, (w, s) => s.runs.expireLeases(w));
    // The seed's own leases (RCP-15, RCP-23) have run out by now too.
    expect(interrupted).toContain(run_id);
    expect(run(run_id)).toMatchObject({ state: 'interrupted', end_reason: 'lease_expired' });
    expect(status('RCP-17')).toBe('ready');
    expect(
      d.rows("SELECT text FROM work_steps WHERE item_id = 'RCP-17' ORDER BY position"),
    ).toEqual([{ text: 'Reproduce the jump' }, { text: 'Persist the week in the URL' }]);
    const ev = d.row<{ type: string; actor_kind: string; summary: string }>(
      "SELECT type, actor_kind, summary FROM events WHERE item_id = 'RCP-17' AND type = 'claim.released' ORDER BY seq DESC LIMIT 1",
    );
    expect(ev.actor_kind).toBe('system');
    expect(ev.summary).toMatch(/lease expired/i);
  });

  it('the sweeper does it too, and does nothing when no lease has expired', () => {
    const { run_id } = claim('RCP-17');
    const events = () => d.row<{ n: number }>('SELECT count(*) AS n FROM events').n;
    const n = events();
    sweepOnce(d.server.runtime);
    expect(events()).toBe(n);
    d.clock.advance(minutes(61));
    sweepOnce(d.server.runtime);
    expect(run(run_id).state).toBe('interrupted');
  });

  it('a late signal does not revive an expired lease, and a mutation naming the run gets conflict', () => {
    const { run_id } = claim('RCP-17');
    d.clock.advance(minutes(61));
    const lease = run(run_id).lease_expires_at;
    d.services.runs.recordSignal(d.read(claude), {
      run_id,
      kind: 'session',
      session_id: 'sess-claude',
    });
    expect(run(run_id).lease_expires_at).toBe(lease);
    const err = d.fails(
      { ...claude, run_id },
      (w, s) => s.evidence.addNote(w, { id: 'RCP-17', text: 'Still here.', run_id }),
      'conflict',
    );
    expect(err.current).toBeDefined();
  });

  it('another agent may claim an item whose lead lease has expired, even before the sweep', () => {
    const { run_id } = claim('RCP-17');
    d.clock.advance(minutes(61));
    const out = claim('RCP-17', codex);
    expect(out.item.lead?.client).toBe('codex');
    expect(run(run_id)).toMatchObject({ state: 'interrupted', end_reason: 'lease_expired' });
  });

  it('the original agent coming back after expiry gets conflict with the current state', () => {
    const { run_id } = claim('RCP-17');
    d.clock.advance(minutes(61));
    claim('RCP-17', codex);
    const err = d.fails(
      { ...claude, run_id },
      (w, s) => s.runs.finish(w, { run_id, result: 'finished', summary: 'Done.' }),
      'conflict',
    );
    expect(JSON.stringify(err.current)).toContain('codex');
  });
});

describe('release and finish', () => {
  it('release_lead: the run is interrupted (released), the item back in Ready', () => {
    const { run_id } = claim('RCP-17');
    const out = d.write({ ...claude, run_id }, (w, s) =>
      s.runs.release(w, { id: 'RCP-17', run_id, reason: 'Stopping early.' }),
    );
    expect(out.status).toBe('ready');
    expect(out.lead).toBeNull();
    expect(run(run_id)).toMatchObject({ state: 'interrupted', end_reason: 'released' });
  });

  it("release_lead on another agent's run is forbidden (FR-027)", () => {
    const lead = d.row<{ id: string }>(
      "SELECT id FROM runs WHERE item_id = 'RCP-14' AND is_lead = 1 AND state = 'open'",
    ).id;
    d.fails(
      codex,
      (w, s) => s.runs.release(w, { id: 'RCP-14', run_id: lead, reason: 'Mine now.' }),
      'forbidden',
    );
  });

  it('finish_run releases the claim but leaves the status: the item is resumable', () => {
    const { run_id } = claim('RCP-17');
    const out = d.write({ ...claude, run_id }, (w, s) =>
      s.runs.finish(w, { run_id, result: 'finished', summary: 'Stopping here.' }),
    );
    expect(out).toEqual({ run_state: 'finished' });
    expect(run(run_id)).toMatchObject({ state: 'finished', end_reason: 'finished' });
    expect(status('RCP-17')).toBe('progress');
    expect(activeLeads('RCP-17')).toEqual([]);
  });

  it('finish_run failed records the error', () => {
    const { run_id } = claim('RCP-17');
    d.write({ ...claude, run_id }, (w, s) =>
      s.runs.finish(w, { run_id, result: 'failed', summary: 'Broke.', error: 'TypeError: x' }),
    );
    expect(d.row('SELECT state, end_reason, error FROM runs WHERE id = ?', run_id)).toEqual({
      state: 'failed',
      end_reason: 'failed',
      error: 'TypeError: x',
    });
  });

  it('an unknown run is not_found', () => {
    d.fails(
      claude,
      (w, s) => s.runs.finish(w, { run_id: 'run_nope', result: 'finished', summary: 'x' }),
      'not_found',
    );
  });
});

describe('the restart sweep (FR-016)', () => {
  it('turns every open run interrupted (service_restart); none shows as finished', () => {
    const open = d.rows<{ id: string; item_id: string }>(
      "SELECT id, item_id FROM runs WHERE state IN ('open', 'needs_input')",
    );
    expect(open.length).toBeGreaterThan(0);
    const statuses = Object.fromEntries(open.map((r) => [r.item_id, status(r.item_id)]));
    const { interrupted } = restartSweep(d.server.runtime);
    expect(interrupted.sort()).toEqual(open.map((r) => r.id).sort());
    for (const r of open) {
      expect(run(r.id)).toMatchObject({ state: 'interrupted', end_reason: 'service_restart' });
      // The item keeps its status: the work is resumable.
      expect(status(r.item_id)).toBe(statuses[r.item_id]);
    }
    expect(d.rows("SELECT id FROM runs WHERE state IN ('open', 'needs_input')")).toEqual([]);
  });

  it('leaves parked runs alone (they keep their claim)', () => {
    const lead = d.row<{ id: string }>(
      "SELECT id FROM runs WHERE item_id = 'RCP-14' AND is_lead = 1 AND state = 'open'",
    ).id;
    d.sql.prepare("UPDATE runs SET state = 'parked' WHERE id = ?").run(lead);
    restartSweep(d.server.runtime);
    expect(run(lead).state).toBe('parked');
  });

  it('does nothing on a quiet database', () => {
    restartSweep(d.server.runtime);
    const n = d.row<{ n: number }>('SELECT count(*) AS n FROM events').n;
    expect(restartSweep(d.server.runtime).interrupted).toEqual([]);
    expect(d.row<{ n: number }>('SELECT count(*) AS n FROM events').n).toBe(n);
  });
});

describe('ToolError shape', () => {
  it('conflict errors are ToolErrors', () => {
    let caught: unknown;
    try {
      claim('RCP-14', codex);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolError);
  });
});
