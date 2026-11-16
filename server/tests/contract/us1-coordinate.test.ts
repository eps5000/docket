/**
 * US1 over MCP (tasks.md T068): the worked flows MCP_SPEC §7.1, §7.2, §7.6
 * and §7.7, the change feed (FR-023), every error code (FR-026), idempotent
 * replay and the two-client claim race (§10 items 3–6, 10, 12), all through
 * the official SDK client against a seeded server.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolHandlers } from '../../src/mcp/register.js';
import {
  expectConflict,
  expectForbidden,
  expectInternal,
  expectNotFound,
  expectOk,
  expectToolError,
  expectUnavailable,
  expectValidation,
  startHarness,
  type ContractHarness,
} from './harness.js';

let h: ContractHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

type S = Record<string, unknown>;
const ok = (r: CallToolResult) => expectOk(r).structured;
const ids = (r: CallToolResult) => (ok(r).items as { id: string }[]).map((i) => i.id);

describe('§7.1 start a session and pick up work', () => {
  it('whoami → search resumable → search ready_to_start → claim_lead', async () => {
    h = await startHarness();
    const me = ok(await h.call('whoami'));
    expect(me).toMatchObject({
      client: 'claude',
      limits: { page_max: 50, changes_max: 200, document_mcp_bytes: 26_214_400 },
      live_window_s: 120,
      stale_after_s: 1800,
      lease_s: 3600,
    });
    expect(me.session_id).toBeTruthy();

    // Resumable: In progress with no lead. Here only RCP-18 (its lead run failed); the epic
    // RCP-1 is In progress but was never claimed, so it is not work to resume.
    const resumable = ok(await h.call('search_items', { project: 'RCP', filter: 'resumable' }));
    for (const item of resumable.items as { status: string; lead: unknown }[]) {
      expect(item.status).toBe('progress');
      expect(item.lead).toBeNull();
    }
    expect(ids(await h.call('search_items', { project: 'RCP', filter: 'resumable' }))).toEqual([
      'RCP-18',
    ]);

    // Ready to start: Ready, unblocked, unclaimed; priority first.
    const ready = await h.call('search_items', {
      project: 'RCP',
      filter: 'ready_to_start',
      limit: 5,
    });
    expect(ids(ready)).toEqual(['RCP-17', 'RCP-25']);
    expect(expectOk(ready).text.split('\n')[1]).toMatch(/^RCP-17 .* · bug · P1 · ready · v\d+$/);

    const claim = ok(await h.call('claim_lead', { id: 'RCP-17', agent_label: 'orca-w3' }));
    expect(claim.run_id).toMatch(/^run_/);
    expect((claim.item as S).status).toBe('progress');
    expect(claim.lease_expires_at).toBe('2026-11-06T12:00:00.000Z');
    // It's no longer ready to start, and it is now "mine".
    expect(ids(await h.call('search_items', { project: 'RCP', filter: 'ready_to_start' }))).toEqual(
      ['RCP-25'],
    );
    expect(ids(await h.call('search_items', { filter: 'mine' }))).toContain('RCP-17');
    expect(
      ids(await h.call('search_items', { filter: 'mine', agent_label: 'other' })),
    ).not.toContain('RCP-17');
  });
});

describe('§7.2 plan, work, verify, close (no human review)', () => {
  it('runs end to end, and the plan patch changes nothing else', async () => {
    h = await startHarness();
    const { run_id } = ok(await h.call('claim_lead', { id: 'RCP-17', agent_label: 'orca-w3' })) as {
      run_id: string;
    };
    const v1 = ok(
      await h.call('set_plan', {
        id: 'RCP-17',
        run_id,
        steps: [
          { text: 'Reproduce the jump after reload' },
          { text: 'Persist the selected week in the URL' },
          { text: 'Add a regression test' },
        ],
      }),
    ) as { plan_version: number; work: { id: string; text: string; state: string }[] };
    expect(v1.plan_version).toBe(1);
    const [s1, s2, s3] = v1.work.map((s) => s.id) as [string, string, string];

    const c = ok(
      await h.call('set_checks', {
        id: 'RCP-17',
        run_id,
        checks: [{ text: 'Planner tests pass' }, { text: 'Reload keeps the week (e2e)' }],
      }),
    ) as { checks: { id: string }[] };
    const [c1] = c.checks.map((x) => x.id) as [string];

    expect(
      ok(await h.call('update_step', { id: 'RCP-17', run_id, step_id: s1, state: 'current' })),
    ).toMatchObject({
      step: { id: s1, state: 'current' },
    });
    const commit = await h.call('report_commit', {
      id: 'RCP-17',
      run_id,
      sha: '4be1c09',
      branch: 'rcp-17-week-reload',
    });
    expect(ok(commit)).toEqual({ recorded: true, stale_packets: [] });
    // Reporting the same SHA again is a no-op.
    expectOk(await h.call('report_commit', { id: 'RCP-17', run_id, sha: '4be1c09' }));
    const n = h.server.runtime.db.sqlite
      .prepare("SELECT count(*) AS n FROM commits WHERE item_id = 'RCP-17'")
      .get() as { n: number };
    expect(n.n).toBe(1);

    expect(
      ok(
        await h.call('update_check', {
          id: 'RCP-17',
          run_id,
          check_id: c1,
          state: 'pass',
          evidence: 'vitest: 212 passed',
        }),
      ),
    ).toMatchObject({ check: { id: c1, state: 'pass', evidence: 'vitest: 212 passed' } });
    for (const step_id of [s1, s2, s3]) {
      expectOk(await h.call('update_step', { id: 'RCP-17', run_id, step_id, state: 'done' }));
    }
    const v2 = ok(
      await h.call('set_plan', {
        id: 'RCP-17',
        run_id,
        reason: 'Found a second cause',
        steps: [{ text: 'Clear the stale cache key on reload', after: s2 }],
      }),
    ) as { plan_version: number; work: { id: string; text: string; state: string }[] };
    expect(v2.plan_version).toBe(2);
    expect(
      v2.work.map((s) => [s.id === s1 || s.id === s2 || s.id === s3 ? s.id : 'new', s.state]),
    ).toEqual([
      [s1, 'done'],
      [s2, 'done'],
      ['new', 'todo'],
      [s3, 'done'],
    ]);

    const done = ok(await h.call('set_status', { id: 'RCP-17', run_id, status: 'done' })) as {
      item: S;
    };
    expect(done.item).toMatchObject({ status: 'done', lead: null });
    const run = h.server.runtime.db.sqlite
      .prepare('SELECT state, end_reason FROM runs WHERE id = ?')
      .get(run_id);
    expect(run).toEqual({ state: 'finished', end_reason: 'finished' });

    const item = ok(await h.call('get_item', { id: 'RCP-17', view: 'full' })) as { item: S };
    expect(item.item).toMatchObject({ status: 'done', closed_by: 'agent' });
    expect((item.item.commits as { sha: string }[]).map((x) => x.sha)).toEqual(['4be1c09']);
  });
});

describe('§7.6 claim conflict', () => {
  it('names the current lead, its last signal and lease, and the owner sees the rejected claim', async () => {
    h = await startHarness();
    const err = expectConflict(await h.call('claim_lead', { id: 'RCP-15' }));
    expect(err.current).toMatchObject({
      lead_client: 'codex',
      lead_label: 'orca-w1',
      last_signal_at: '2026-11-06T10:13:00.000Z',
      lease_expires_at: '2026-11-06T11:13:00.000Z',
    });
    expect(err.message).toBe(
      'RCP-15 is led by codex · orca-w1 (lease until 11:13 UTC). Pick another item.',
    );
    const rejected = h.server.runtime.db.sqlite
      .prepare(
        "SELECT client, summary FROM events WHERE item_id = 'RCP-15' AND type = 'claim.rejected' ORDER BY seq DESC LIMIT 1",
      )
      .get() as { client: string; summary: string };
    expect(rejected.client).toBe('claude');
    expect(rejected.summary).toContain('codex · orca-w1');
  });

  it('two clients race: exactly one wins, the other gets conflict with current (§10 item 6)', async () => {
    h = await startHarness();
    const [ra, rb] = await Promise.all([
      h.call('claim_lead', { id: 'RCP-25' }, h.a),
      h.call('claim_lead', { id: 'RCP-25' }, h.b),
    ]);
    const results = [ra, rb];
    expect(results.filter((r) => !r.isError)).toHaveLength(1);
    const loser = results.find((r) => r.isError)!;
    const winner = results.find((r) => !r.isError)!;
    const err = expectConflict(loser);
    expect((err.current as { run_id: string }).run_id).toBe(
      (winner.structuredContent as { run_id: string }).run_id,
    );
  });
});

describe('§7.7 subagents', () => {
  it('a child run with its own connection, and a relayed log for one without', async () => {
    h = await startHarness();
    const lead = h.server.runtime.db.sqlite
      .prepare("SELECT id FROM runs WHERE item_id = 'RCP-14' AND is_lead = 1 AND state = 'open'")
      .get() as { id: string };
    const child = ok(
      await h.call('start_run', {
        id: 'RCP-14',
        parent_run_id: lead.id,
        agent_label: 'units-worker',
      }),
    ) as { run_id: string };
    expect(child.run_id).toMatch(/^run_/);

    const sub = await h.connect({ name: 'claude-code', version: '1.0.0' });
    const item = ok(await h.call('get_item', { id: 'RCP-14' })) as {
      item: { checklist: { checks: { id: string }[]; work: { id: string }[] } };
    };
    const check = item.item.checklist.checks[1]!.id;
    expect(
      ok(
        await h.call(
          'update_check',
          {
            id: 'RCP-14',
            run_id: child.run_id,
            check_id: check,
            state: 'pass',
            provenance: 'observed',
            evidence: '31 tests',
          },
          sub,
        ),
      ),
    ).toMatchObject({ check: { id: check, state: 'pass', provenance: 'observed' } });
    expect(
      ok(
        await h.call(
          'finish_run',
          { run_id: child.run_id, result: 'finished', summary: 'Conversion table + 31 tests' },
          sub,
        ),
      ),
    ).toEqual({ run_state: 'finished' });

    const step = item.item.checklist.work[1]!.id;
    expect(
      ok(
        await h.call('log_subagent', {
          id: 'RCP-14',
          run_id: lead.id,
          step_id: step,
          name: 'explorer',
          outcome: 'Mapped 214 ingredient units in sample recipes',
          provenance: 'relayed',
        }),
      ),
    ).toEqual({ logged: true });

    // start_run needs an open lead run on the item as its parent.
    expectValidation(await h.call('start_run', { id: 'RCP-14', parent_run_id: child.run_id }));
    expectValidation(await h.call('start_run', { id: 'RCP-17', parent_run_id: lead.id }));
  });
});

describe('get_changes (FR-023; §10 item 10)', () => {
  it('an empty cursor returns the latest; pages follow in order with no gaps', async () => {
    h = await startHarness();
    const db = h.server.runtime.db.sqlite;
    const latest = (db.prepare('SELECT max(seq) AS m FROM events').get() as { m: number }).m;
    const first = ok(await h.call('get_changes', {}));
    expect(first).toEqual({ events: [], next_cursor: String(latest) });

    const { run_id } = ok(await h.call('claim_lead', { id: 'RCP-17' })) as { run_id: string };
    await h.call('add_note', { id: 'RCP-17', run_id, text: 'Starting with the reload bug.' });
    await h.call('set_plan', { id: 'RCP-17', run_id, steps: [{ text: 'A' }, { text: 'B' }] });
    await h.call('add_note', { id: 'RCP-25', text: 'Looked at it; not today.' });

    const seen: number[] = [];
    let cursor = first.next_cursor as string;
    for (let i = 0; i < 20; i++) {
      const page = ok(await h.call('get_changes', { cursor, limit: 2 })) as {
        events: { cursor: string; type: string; actor: string }[];
        next_cursor: string;
      };
      seen.push(...page.events.map((e) => Number(e.cursor)));
      if (page.events.length === 0) break;
      cursor = page.next_cursor;
    }
    const all = (
      db.prepare('SELECT seq FROM events WHERE seq > ? ORDER BY seq').all(latest) as {
        seq: number;
      }[]
    ).map((r) => r.seq);
    expect(seen).toEqual(all);
    expect(all.length).toBeGreaterThan(3);

    // Filters: item and type.
    const notes = ok(
      await h.call('get_changes', {
        cursor: String(latest),
        item_id: 'RCP-17',
        types: ['note.added'],
      }),
    ) as {
      events: { item_id: string; type: string; actor: string; summary: string }[];
    };
    expect(notes.events).toEqual([
      expect.objectContaining({
        item_id: 'RCP-17',
        type: 'note.added',
        actor: 'claude',
        summary: 'Starting with the reload bug.',
      }),
    ]);
    const project = ok(
      await h.call('get_changes', {
        cursor: String(latest),
        project: 'RCP',
        types: ['note.added'],
      }),
    ) as {
      events: unknown[];
    };
    expect(project.events).toHaveLength(2);
    expectValidation(await h.call('get_changes', { cursor: 'not-a-cursor' }));
  });
});

describe('every error code is reachable and well-formed (FR-026; §10 item 4)', () => {
  it('validation: a disallowed transition lists the allowed ones', async () => {
    h = await startHarness();
    const err = expectValidation(await h.call('set_status', { id: 'RCP-20', status: 'done' }));
    expect(err.details?.allowed).toEqual(['planning', 'canceled']);
  });

  it('validation: limits and unknown step ids', async () => {
    h = await startHarness();
    expectValidation(
      await h.call('create_item', { project: 'RCP', type: 'Task', title: 'x'.repeat(201) }),
    );
    expectValidation(
      await h.call('set_plan', {
        id: 'RCP-14',
        reason: 'x',
        steps: [{ id: 'wst_nope', text: 'B' }],
      }),
    );
  });

  it('conflict: a stale version, a held claim, an ended run', async () => {
    h = await startHarness();
    const created = ok(
      await h.call('create_item', { project: 'RCP', type: 'Task', title: 'Versioned' }),
    ) as {
      item: { id: string; version: number };
    };
    const { id, version } = created.item;
    expectOk(await h.call('update_item', { id, expected_version: version, title: 'Versioned 2' }));
    const err = expectConflict(
      await h.call('update_item', { id, expected_version: version, title: 'Versioned 3' }),
    );
    expect(err.current).toMatchObject({ id, title: 'Versioned 2' });

    expectConflict(await h.call('claim_lead', { id: 'RCP-15' }));

    const { run_id } = ok(await h.call('claim_lead', { id: 'RCP-17' })) as { run_id: string };
    expectOk(await h.call('finish_run', { run_id, result: 'finished', summary: 'Stopping.' }));
    expectConflict(await h.call('finish_run', { run_id, result: 'finished', summary: 'Again.' }));
    expectConflict(await h.call('heartbeat', { run_id }));
  });

  it('not_found: an unknown item or run', async () => {
    h = await startHarness();
    const err = expectNotFound(await h.call('get_item', { id: 'RCP-99' }));
    expect(err.message).toBe('No item RCP-99. Check the ID with search_items.');
    expectNotFound(await h.call('heartbeat', { run_id: 'run_nope' }));
  });

  it("forbidden: someone else's run", async () => {
    h = await startHarness();
    const lead = h.server.runtime.db.sqlite
      .prepare("SELECT id FROM runs WHERE item_id = 'RCP-15' AND is_lead = 1 AND state = 'open'")
      .get() as { id: string };
    expectForbidden(
      await h.call('release_lead', { id: 'RCP-15', run_id: lead.id, reason: 'Taking over.' }),
    );
  });

  it('unavailable: the database is busy past the timeout (simulated lock)', async () => {
    h = await startHarness({
      services: {
        evidence: {
          addNote: () => {
            throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
          },
        },
      },
    });
    const err = expectUnavailable(await h.call('add_note', { id: 'RCP-14', text: 'Hello.' }));
    expect(err.details?.retry_after_s).toBeGreaterThan(0);
  });

  it('internal: a result that breaks its schema', async () => {
    h = await startHarness({
      toolHandlers: { whoami: (() => ({ client: 1 })) as unknown as ToolHandlers['whoami'] },
    });
    expectInternal(await h.call('whoami'));
  });
});

describe('idempotency on real writes (§10 item 5)', () => {
  it('create_item replayed with the same key creates one item; another payload is validation', async () => {
    h = await startHarness();
    const args = {
      project: 'RCP',
      type: 'Task',
      title: 'Low-stock alerts',
      idempotency_key: 'create-1',
    };
    const first = expectOk(await h.call('create_item', args));
    const again = expectOk(await h.call('create_item', args));
    expect(again.structured).toEqual({ ...first.structured, replayed: true });
    expect(again.text).toBe(`${first.text} · replayed`);
    const n = h.server.runtime.db.sqlite
      .prepare("SELECT count(*) AS n FROM items WHERE title = 'Low-stock alerts'")
      .get() as { n: number };
    expect(n.n).toBe(1);
    expectValidation(await h.call('create_item', { ...args, title: 'Something else' }));
  });

  it('a retried claim_lead returns the original claim, not a conflict', async () => {
    h = await startHarness();
    const args = { id: 'RCP-17', idempotency_key: 'claim-1' };
    const first = ok(await h.call('claim_lead', args));
    const again = ok(await h.call('claim_lead', args));
    expect(again).toEqual({ ...first, replayed: true });
  });
});

describe('patches (§10 item 12)', () => {
  it('update_item leaves absent fields alone', async () => {
    h = await startHarness();
    const before = ok(await h.call('get_item', { id: 'RCP-25', view: 'full' })) as { item: S };
    const out = ok(
      await h.call('update_item', {
        id: 'RCP-25',
        expected_version: before.item.version,
        priority: 1,
      }),
    ) as { item: S };
    expect(out.item.priority).toBe(1);
    const after = ok(await h.call('get_item', { id: 'RCP-25', view: 'full' })) as { item: S };
    for (const key of ['title', 'description_md', 'outcome_md', 'acceptance', 'labels', 'epic']) {
      expect(after.item[key], key).toEqual(before.item[key]);
    }
  });
});

describe('the run_id signal over MCP', () => {
  it('renews the lease on any call naming the run, reads included', async () => {
    h = await startHarness();
    const { run_id } = ok(await h.call('claim_lead', { id: 'RCP-17' })) as { run_id: string };
    // The SDK client holds its GET stream open, so its own run is live.
    const fresh = ok(await h.call('get_item', { id: 'RCP-17', view: 'summary', run_id })) as {
      item: { lead: { run_state: string } };
    };
    expect(fresh.item.lead.run_state).toBe('live');
    h.server.clock.advance(10 * 60_000);
    await h.call('get_item', { id: 'RCP-17', view: 'summary', run_id });
    const row = h.server.runtime.db.sqlite
      .prepare('SELECT lease_expires_at FROM runs WHERE id = ?')
      .get(run_id) as {
      lease_expires_at: string;
    };
    expect(row.lease_expires_at).toBe('2026-11-06T12:10:00.000Z');
  });

  it('a mutation naming an unknown run is not_found', async () => {
    h = await startHarness();
    expectToolError(
      await h.call('add_note', { id: 'RCP-14', text: 'x', run_id: 'run_nope' }),
      'not_found',
    );
  });
});

describe('the US1 independent test (spec.md User Story 1)', () => {
  it('one client finds, claims, plans, checks, commits and closes; a second client is refused naming the first', async () => {
    h = await startHarness();
    const transcript: string[] = [];
    const step = async (name: string, args: Record<string, unknown>, client = h!.a) => {
      const r = await h!.call(name, args, client);
      transcript.push(`> ${name} ${JSON.stringify(args)}\n${expectOk(r).text}`);
      return expectOk(r).structured;
    };
    await step('whoami', {});
    const ready = await step('search_items', { filter: 'ready_to_start' });
    const top = (ready.items as { id: string }[])[0]!.id;
    expect(top).toBe('RCP-17');
    const { run_id } = (await step('claim_lead', { id: top, agent_label: 'orca-w3' })) as {
      run_id: string;
    };

    const refused = await h.call('claim_lead', { id: top, agent_label: 'orca-w1' }, h.b);
    const err = expectConflict(refused);
    transcript.push(
      `> (codex) claim_lead {"id":"${top}"}\n${expectToolError(refused, 'conflict').message}`,
    );
    expect(err.current).toMatchObject({ lead_client: 'claude', lead_label: 'orca-w3', run_id });

    const plan = (await step('set_plan', {
      id: top,
      run_id,
      steps: [
        { text: 'Reproduce the jump after reload' },
        { text: 'Persist the week in the URL' },
        { text: 'Add a regression test' },
      ],
    })) as { work: { id: string }[] };
    const checks = (await step('set_checks', {
      id: top,
      run_id,
      checks: [{ text: 'Planner tests pass' }],
    })) as {
      checks: { id: string }[];
    };
    for (const s of plan.work)
      await step('update_step', { id: top, run_id, step_id: s.id, state: 'done' });
    await step('report_commit', {
      id: top,
      run_id,
      sha: '4be1c09',
      branch: 'rcp-17-week-reload',
      pushed: true,
    });
    await step('update_check', {
      id: top,
      run_id,
      check_id: checks.checks[0]!.id,
      state: 'pass',
      evidence: 'vitest: 212 passed',
    });
    const done = (await step('set_status', { id: top, run_id, status: 'done' })) as {
      item: { status: string };
    };
    expect(done.item.status).toBe('done');
    console.log(`\nUS1 independent test transcript:\n${transcript.join('\n')}\n`);
  });
});
