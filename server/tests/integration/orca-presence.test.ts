import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addProject, forceStatus, startDomain, type Domain } from '../us1-helpers.js';

const tool = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'tools',
  'docket-sync',
);
const source = await import(
  /* @vite-ignore */ pathToFileURL(join(tool, 'sources', 'orca-presence.mjs')).href
);
const session = 'b56ba7cc-27d3-43e8-b910-810e6230b9fd';
const path = 'C:/Users/sample/orca/workspaces/gameflow-app/gf-346-release';
const now = new Date('2026-11-26T06:45:00.000Z');

const raw = (over: Record<string, unknown> = {}) => ({
  orcaSessionId: session,
  kind: 'chat',
  agent: 'codex',
  state: 'working',
  hostId: 'local',
  worktreeId: `worktree-id::${path}`,
  title: 'Own exactly GF-346 Complete and review the deck editor release',
  lastAssistantMessage: 'private text never sent to Docket',
  ...over,
});
const reply = (agents: unknown[], over: Record<string, unknown> = {}) => ({
  ok: true,
  result: { agents, truncated: false, hostScope: { omittedHostIds: [] }, ...over },
});

describe('Orca host projection', () => {
  it('sends only an exact ticket, client, local worktree and session', () => {
    const records = source.projectWorkingAgents(reply([raw()]), now.toISOString());
    expect(records).toEqual([
      {
        key: `orca:${session}`,
        session,
        client: 'codex',
        item: 'GF-346',
        path,
        observed_at: now.toISOString(),
      },
    ]);
    expect(JSON.stringify(records)).not.toContain('private text');
  });

  it('drops idle, remote, ambiguous and titleless agents; incomplete lists fail', () => {
    expect(
      source.projectWorkingAgents(
        reply([
          raw({ state: 'idle' }),
          raw({ hostId: 'remote' }),
          raw({ title: 'GF-346 and GF-347' }),
          raw({ title: 'unrelated' }),
        ]),
        now.toISOString(),
      ),
    ).toEqual([]);
    expect(() =>
      source.projectWorkingAgents(reply([raw()], { truncated: true }), now.toISOString()),
    ).toThrow('incomplete');
  });
});

describe('Docket run presence', () => {
  let d: Domain;
  let id: string;
  let run: string;
  beforeEach(() => {
    d = startDomain({ seed: false, now });
    addProject(d, 'GF');
    d.sql.prepare('UPDATE projects SET next_seq = 346 WHERE key = ?').run('GF');
    id = d.write(d.agent('codex'), (w, s) =>
      s.items.create(w, {
        project: 'GF',
        type: 'Epic',
        title: 'Synthetic release',
        priority: 2,
        status: 'planning',
      }),
    ).id;
    forceStatus(d, id, 'progress');
    run = d.write(d.agent('codex'), (w, s) => s.runs.claim(w, { id })).run_id;
    d.sql
      .prepare('UPDATE runs SET workspace = ? WHERE id = ?')
      .run(JSON.stringify({ path, branch: 'release' }), run);
  });
  afterEach(async () => d.cleanup());

  const state = () => d.services.items.get(d.read(), { id, view: 'summary' }).item.lead?.run_state;
  const post = (records: unknown[]) =>
    d.services.sync.ingest(d.server.runtime.write, 'orca-presence', {
      records: records as never,
      run: { ok: true, interval_ms: 30_000 },
    });
  const record = (over: Record<string, unknown> = {}) => ({
    ...source.projectWorkingAgents(reply([raw()]), now.toISOString())[0],
    ...over,
  });

  it('shows a working matching Orca chat live despite report signals, then ages out', () => {
    expect(state()).toBe('reported');
    expect(post([record()])).toMatchObject({ accepted: 1, changed: 1, ignored: 0 });
    expect(state()).toBe('live');
    const firstLease = d.row<{ lease_expires_at: string }>(
      'SELECT lease_expires_at FROM runs WHERE id = ?',
      run,
    ).lease_expires_at;
    d.services.runs.recordSignal(d.read(), { run_id: run, kind: 'report', session_id: null });
    expect(state()).toBe('live');
    d.clock.advance(121_000);
    expect(state()).toBe('reported');
    expect(post([{ ...record(), observed_at: d.clock.now().toISOString() }]).changed).toBe(1);
    expect(state()).toBe('live');
    expect(
      d.row<{ lease_expires_at: string }>('SELECT lease_expires_at FROM runs WHERE id = ?', run)
        .lease_expires_at,
    ).not.toBe(firstLease);
  });

  it('does not infer presence from a different path, client, item or stale observation', () => {
    expect(
      post([
        record({ path: 'C:/other' }),
        record({ client: 'claude' }),
        record({ item: 'GF-999' }),
        record({ observed_at: '2026-11-26T06:40:00.000Z' }),
      ]),
    ).toMatchObject({ changed: 0, ignored: 4 });
    expect(state()).toBe('reported');
  });

  it('does not promote a parked run or ambiguous two-session match', () => {
    expect(
      post([
        record(),
        record({
          session: 'c56ba7cc-27d3-43e8-b910-810e6230b9fd',
          key: 'orca:c56ba7cc-27d3-43e8-b910-810e6230b9fd',
        }),
      ]).changed,
    ).toBe(0);
    expect(state()).toBe('reported');
    d.sql.prepare("UPDATE runs SET state = 'parked' WHERE id = ?").run(run);
    expect(post([record()]).changed).toBe(0);
    expect(state()).toBe('parked');
  });
});
