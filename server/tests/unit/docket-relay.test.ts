/**
 * docket-relay (owner decision 46), against a fake change feed on loopback and
 * a fake `orca` executable. No test can reach a real Orca: the relay is given
 * the fake's full path, and the fake only writes down what it was asked.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TOOL = join(ROOT, 'tools', 'docket-relay');
const lib = (name: string) =>
  import(/* @vite-ignore */ pathToFileURL(join(TOOL, 'lib', name)).href);

const { classifyEvent, buildMessage } = await lib('classify.mjs');
const { isCoordinatorAddress, liveLead, partialLead, resolveCoordinator } = await lib('target.mjs');
const { childEnv, createOrca, findOrca, requestIdFor } = await lib('orca.mjs');
const { createDocket } = await lib('docket.mjs');
const { acquireLock, openStore, requestStop } = await lib('store.mjs');
const { reconcileDeliver, reconcileSkip } = await lib('hold.mjs');
const { createRelay } = await lib('relay.mjs');
const { scanContinuations, continuationProblem, loadContinuationConfig } =
  await lib('continuation.mjs');

const SECRET = 'PRIVATE-OWNER-TEXT';
const START = Date.parse('2026-11-23T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const POWERSHELL = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const hasPowerShell =
  spawnSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
    stdio: 'ignore',
    timeout: 30_000,
  }).status === 0;

/** Runs before Node would load a script, so the copied binary acts as `orca`. */
const FAKE_ORCA = `
const fs = require('node:fs');
const path = require('node:path');
if (path.basename(process.argv[1] ?? '') === 'orchestration') {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
  const logPath = process.env.FAKE_ORCA_LOG;
  const plan = JSON.parse(fs.readFileSync(process.env.FAKE_ORCA_PLAN, 'utf8'));
  const prior = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const orcaEnv = Object.keys(process.env).filter((k) => /^ORCA_/i.test(k));
  fs.appendFileSync(logPath, JSON.stringify({ at: Date.now(), args, orcaEnv }) + '\\n');
  const reply = (body, code) => { fs.writeSync(1, JSON.stringify(body)); process.exit(code); };
  const refuse = (code) => reply({ ok: false, error: { code } }, 1);
  if (plan.down) refuse('runtime_unavailable');
  if (args[0] === 'worker-show') {
    const d = plan.dispatches?.[flag('--dispatch')];
    if (!d) refuse('dispatch_not_found');
    // As the real CLI: without --full, a concise view with no dispatch record.
    if (plan.conciseOnly || !args.includes('--full')) {
      reply({ ok: true, result: { dispatchId: flag('--dispatch'), runId: d.runId, state: d.workerState } }, 0);
    }
    reply({ ok: true, result: {
      dispatch: { status: d.status, runId: d.runId, capabilityRevokedAt: d.revoked ?? null,
        dispatchedAt: d.dispatchedAt ?? null, creatorDispatchId: d.creatorDispatchId ?? null },
      worker: d.workerState ? { state: d.workerState, worktreeId: d.worktreeId ?? null,
        startOptions: { launch: { effective: { agent: d.agent ?? 'codex' } } } } : null,
      projection: { resource: { state: d.resourceState ?? 'absent' } },
      terminal: null,
      terminalResource: null,
    } }, 0);
  }
  if (args[0] === 'worker-list') {
    reply({ ok: true, result: { workers: plan.workers ?? [], nextCursor: null } }, 0);
  }
  if (args[0] === 'worker-start') {
    if (plan.startFails) refuse('runtime_unavailable');
    reply({ ok: true, result: { dispatchId: plan.startDispatch ?? 'ctx_fresh' } }, 0);
  }
  if (args[0] === 'send') {
    const to = flag('--to');
    const fail = plan.fail?.[to];
    const count = prior.filter((c) => c.args[0] === 'send' && c.args[c.args.indexOf('--to') + 1] === to).length;
    const code = Array.isArray(fail) ? fail[count] : fail;
    if (code) refuse(code);
    const rid = flag('--retry-request');
    const same = prior.find((c) => c.args[0] === 'send' && c.args[c.args.indexOf('--retry-request') + 1] === rid);
    if (same && same.args[same.args.indexOf('--body') + 1] !== flag('--body')) refuse('request_mismatch');
    // Stays in the send until told, so a test can kill the relay here.
    const until = Date.now() + 30000;
    while (plan.blockSendUntil && !fs.existsSync(plan.blockSendUntil) && Date.now() < until) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    reply({ ok: true, result: { message: { id: 'msg_fake' } } }, 0);
  }
  refuse('unknown_command');
}
`;

interface Row {
  cursor: string;
  at: string;
  actor: string;
  item_id: string | null;
  type: string;
  summary: string;
  kind: string;
}

interface FakeRun {
  run_id: string;
  is_lead: boolean;
  run_state: string;
  orchestrator: { name: string; dispatch_id: string | null; run_id: string | null } | null;
  /** Decision 61: how it finished, as the item read carries it. */
  exit?: { outcome: 'complete' | 'partial'; at: string; left?: unknown[] };
}

const lead = (o: { dispatch?: string; runId?: string; state?: string } = {}): FakeRun => ({
  run_id: 'r_lead1',
  is_lead: true,
  run_state: o.state ?? 'live',
  orchestrator:
    o.dispatch || o.runId
      ? { name: 'producer-x', dispatch_id: o.dispatch ?? null, run_id: o.runId ?? null }
      : null,
});

describe('DKT-38 durable completed-dispatch continuation', () => {
  it('interprets the live bootstrap pause shape and holds malformed pause data', async () => {
    let pause: unknown = undefined;
    const docket = createDocket({
      baseUrl: 'http://127.0.0.1:7420',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            projects: [{ key: 'DKT', ...(pause === undefined ? {} : { paused: pause }) }],
          }),
          {
            headers: { 'content-type': 'application/json' },
          },
        ),
    });
    expect(await docket.readDocketPause()).toBe(false);
    pause = {
      decision_id: 'dec_pause',
      reason: 'hold',
      paused_by: 'owner',
      paused_at: '2026-11-28T03:00:00Z',
    };
    expect(await docket.readDocketPause()).toBe(true);
    pause = false;
    await expect(docket.readDocketPause()).rejects.toMatchObject({ code: 'bad_response' });
  });

  const workspacePath = 'C:/Users/erics/orca/workspaces/task-lite/dkt-1-producer';
  const workspaceId = `48ca27d0-4847-4d2e-a2e5-6c6c74a2133e::${workspacePath}`;
  const mapping = {
    epic: 'DKT-1',
    docket_run_id: 'run_01M8DNKW8E2W15YRMX2B77MCFZ',
    dispatch_id: 'ctx_03f5c492b73c',
    orca_run_id: 'run_8cc91a814db8',
    workspace_id: workspaceId,
    agent: 'codex',
  };
  const due = '2026-11-28T03:00:00.000Z';
  const original = {
    found: true,
    runId: mapping.orca_run_id,
    status: 'completed',
    capabilityRevokedAt: '2026-11-27T05:02:39.183Z',
    workspaceId,
    workerState: 'succeeded',
    resourceState: 'absent',
    terminalAbsent: true,
    terminalResourceAbsent: true,
  };

  function continuationHarness() {
    let time = Date.parse('2026-11-28T04:00:00.000Z');
    let paused = false;
    const saves: string[] = [];
    const requests: { requestId: string; body: string; to: string }[] = [];
    const escalations: { type: string; body: string; requestId: string }[] = [];
    let workers: unknown[] = [];
    let workerListFails = false;
    let driftOnList = false;
    let requestResult: { ok: boolean } = { ok: true };
    const freshReceipt = {
      found: true,
      runId: mapping.orca_run_id,
      status: 'dispatched',
      capabilityRevokedAt: null,
      workerState: 'ready',
      workspaceId,
      creatorDispatchId: null,
      agent: 'codex',
      dispatchedAt: '2026-11-28 04:00:01',
    };
    const state = {
      continuations: {} as Record<
        string,
        {
          state: string;
          attempts: number;
          dispatch_id?: string;
          [key: string]: unknown;
        }
      >,
    };
    const row = {
      row_kind: 'run',
      run_id: mapping.docket_run_id,
      item_id: mapping.epic,
      project: 'DKT',
      run_state: 'parked',
      lease: 'paused',
      lead_parked: {
        since: '2026-11-27T04:53:28.974Z',
        waiting_on: {
          orchestrator: true,
          wake: { actor: 'orca-coordinator', event: 'bounded producer wake', due_at: due },
        },
      },
    };
    const detail = {
      item: {
        id: mapping.epic,
        project: 'DKT',
        type: 'Epic',
        open_question: null,
        runs: [
          {
            run_id: mapping.docket_run_id,
            run_state: 'parked',
            is_lead: true,
            orchestrator: {
              dispatch_id: mapping.dispatch_id,
              run_id: mapping.orca_run_id as string | null,
            },
            workspace: { path: workspacePath },
          },
        ],
      },
      decisions: [],
    };
    const docket = {
      readAgents: async () => ({ rows: [row] }),
      readDocketPause: async () => paused,
      readContinuationItem: async () => detail,
    };
    const orca = {
      showDispatch: async (id: string) => (id === mapping.dispatch_id ? original : freshReceipt),
      listWorkers: async () => {
        if (workerListFails) throw new Error('unavailable');
        if (driftOnList) {
          driftOnList = false;
          row.lead_parked.waiting_on.wake.due_at = '2026-11-28T05:00:00Z';
        }
        return workers;
      },
      send: async (input: { type: string; body: string; requestId: string; to: string }) => {
        if (input.type === 'status') {
          requests.push(input);
          return requestResult;
        }
        escalations.push(input);
        return { ok: true };
      },
    };
    const scan = () =>
      scanContinuations({
        mappings: [mapping],
        state,
        docket,
        orca,
        save: () => saves.push(JSON.stringify(state)),
        now: () => time,
      });
    return {
      mapping,
      state,
      row,
      detail,
      starts: requests,
      escalations,
      saves,
      scan,
      advance: (ms: number) => {
        time += ms;
      },
      setWorkers: (rows: unknown[]) => {
        workers = rows;
      },
      setStartResult: (result: typeof requestResult) => {
        requestResult = result;
      },
      setFreshReceipt: (patch: Partial<typeof freshReceipt>) => {
        Object.assign(freshReceipt, patch);
      },
      handoff: () => {
        detail.item.runs[0]!.orchestrator.dispatch_id = 'ctx_fresh';
        detail.item.runs[0]!.run_state = 'reported';
        row.run_state = 'reported';
      },
      setPaused: (value: boolean) => {
        paused = value;
      },
      setWorkerListFails: (value: boolean) => {
        workerListFails = value;
      },
      setDriftOnList: () => {
        driftOnList = true;
      },
    };
  }

  it('requests one exact coordinator follow-up for the completed dispatch, then verifies its receipt', async () => {
    const h = continuationHarness();
    await h.scan();
    expect(h.starts).toHaveLength(1);
    expect(h.starts[0]).toMatchObject({
      to: `run:${mapping.orca_run_id}`,
      requestId: expect.any(String),
    });
    expect(h.starts[0]!.body).toContain(mapping.dispatch_id);
    expect(h.state.continuations[mapping.docket_run_id]).toMatchObject({
      state: 'requested',
      attempts: 1,
    });
    await h.scan();
    expect(h.starts).toHaveLength(1);
    h.handoff();
    h.advance(1000);
    await h.scan();
    expect(h.state.continuations[mapping.docket_run_id]).toMatchObject({
      state: 'acknowledged',
      dispatch_id: 'ctx_fresh',
      current_dispatch_id: 'ctx_fresh',
    });
    const restarted = continuationHarness();
    Object.assign(restarted.state.continuations, JSON.parse(JSON.stringify(h.state.continuations)));
    await restarted.scan();
    expect(restarted.starts).toHaveLength(0);
    expect(h.saves.length).toBeGreaterThanOrEqual(4); // intent, attempt, request, verified handoff
  });

  it('retries one stable request id, then escalates after bounded failed sends', async () => {
    const h = continuationHarness();
    h.setStartResult({ ok: false });
    await h.scan();
    h.advance(60_000);
    await h.scan();
    h.advance(120_000);
    await h.scan();
    expect(h.starts).toHaveLength(3);
    expect(new Set(h.starts.map((x) => x.requestId)).size).toBe(1);
    expect(h.state.continuations[mapping.docket_run_id]).toMatchObject({
      state: 'escalated',
      attempts: 3,
    });
    expect(h.escalations).toHaveLength(1);
    expect(h.escalations[0]).toMatchObject({ type: 'escalation', requestId: expect.any(String) });
    expect(h.escalations[0]!.body).not.toContain(SECRET);
    h.advance(10 * MINUTE);
    await h.scan();
    expect(h.starts).toHaveLength(3);
    expect(h.escalations).toHaveLength(2);
  });

  it('does not start a second worker while the exact producer worktree is active or the wake is not due', async () => {
    const h = continuationHarness();
    h.row.lead_parked.waiting_on.wake.due_at = '2026-11-28T05:00:00Z';
    await h.scan();
    expect(h.starts).toHaveLength(0);
    h.setPaused(true);
    h.setWorkers([]);
    await h.scan();
    expect(h.starts).toHaveLength(0);
    h.row.lead_parked.waiting_on.wake.due_at = due;
    h.setPaused(false);
    h.setWorkers([
      { workspace: workspaceId, host: 'local', outcome: 'in_progress', state: 'ready' },
    ]);
    await h.scan();
    expect(h.starts).toHaveLength(0);
  });

  it('holds an unverifiable unsettled producer instead of treating it as exited', async () => {
    const h = continuationHarness();
    h.setWorkers([
      { workspace: workspaceId, host: 'local', state: 'failed', liveness: 'unverifiable' },
    ]);
    await h.scan();
    expect(h.starts).toHaveLength(0);
    expect(h.state.continuations[mapping.docket_run_id]).toMatchObject({
      state: 'escalated',
      reason: 'worker_custody_unknown',
    });
  });

  it('proves settled unverifiable history has no retained Orca resource before starting', async () => {
    const h = continuationHarness();
    h.setWorkers([
      {
        dispatchId: mapping.dispatch_id,
        workspace: workspaceId,
        host: 'local',
        state: 'succeeded',
        liveness: 'unverifiable',
      },
    ]);
    await h.scan();
    expect(h.starts).toHaveLength(1);
  });

  it('holds live settled and unidentified worker custody, then escalates an active producer overdue wake', async () => {
    const live = continuationHarness();
    live.setWorkers([{ workspace: workspaceId, host: 'local', state: 'failed', liveness: 'live' }]);
    await live.scan();
    expect(live.starts).toHaveLength(0);
    live.advance(5 * MINUTE);
    await live.scan();
    expect(live.starts).toHaveLength(0);
    expect(live.escalations).toHaveLength(1);
    expect(live.state.continuations[mapping.docket_run_id]?.reason).toBe('active_producer_no_ack');

    const unidentified = continuationHarness();
    unidentified.setWorkers([{ state: 'failed', liveness: 'unverifiable' }]);
    await unidentified.scan();
    expect(unidentified.starts).toHaveLength(0);
    expect(unidentified.state.continuations[mapping.docket_run_id]?.reason).toBe(
      'worker_custody_unknown',
    );
  });

  it('escalates a delivered request that receives no verified Dispatch or Docket transition', async () => {
    const h = continuationHarness();
    await h.scan();
    expect(h.starts).toHaveLength(1);
    h.advance(5 * MINUTE);
    await h.scan();
    expect(h.starts).toHaveLength(1);
    expect(h.escalations).toHaveLength(1);
    expect(h.state.continuations[mapping.docket_run_id]).toMatchObject({
      state: 'escalated',
      attempts: 1,
      reason: 'coordinator_no_handoff',
    });
  });

  it('does not acknowledge a Docket transition backed by the wrong Orca agent', async () => {
    const h = continuationHarness();
    await h.scan();
    h.setFreshReceipt({ agent: 'claude' });
    h.handoff();
    h.advance(5 * MINUTE);
    await h.scan();
    expect(h.state.continuations[mapping.docket_run_id]).toMatchObject({
      state: 'escalated',
      reason: 'coordinator_no_handoff',
    });
    expect(h.escalations).toHaveLength(1);
  });

  it('acknowledges a verified same-Run follow-up that re-parks on a new future wait', async () => {
    const h = continuationHarness();
    await h.scan();
    h.handoff();
    h.row.run_state = 'parked';
    h.detail.item.runs[0]!.run_state = 'parked';
    h.row.lead_parked.since = '2026-11-28T04:00:02Z';
    h.row.lead_parked.waiting_on.wake.due_at = '2026-11-28T05:00:00Z';
    h.advance(2000);
    await h.scan();
    expect(h.state.continuations[mapping.docket_run_id]).toMatchObject({
      state: 'acknowledged',
      current_dispatch_id: 'ctx_fresh',
    });
  });

  it('accepts a null legacy Docket Orca Run id only with exact Orca proof and same-second dispatch time', async () => {
    const h = continuationHarness();
    h.detail.item.runs[0]!.orchestrator.run_id = null;
    h.advance(500);
    await h.scan();
    h.setFreshReceipt({ dispatchedAt: '2026-11-28 04:00:00' });
    h.handoff();
    h.advance(100);
    await h.scan();
    expect(h.state.continuations[mapping.docket_run_id]).toMatchObject({
      state: 'acknowledged',
      dispatch_id: 'ctx_fresh',
    });
  });

  it('acknowledges a verified handoff when Docket derives the open run as live', async () => {
    const h = continuationHarness();
    await h.scan();
    h.handoff();
    h.detail.item.runs[0]!.run_state = 'live';
    h.row.run_state = 'live';
    h.advance(1000);
    await h.scan();
    expect(h.state.continuations[mapping.docket_run_id]).toMatchObject({
      state: 'acknowledged',
      dispatch_id: 'ctx_fresh',
    });
  });

  it('keeps a delivered request idempotent across relay restart until coordinator handoff', async () => {
    const h = continuationHarness();
    await h.scan();
    const restarted = continuationHarness();
    Object.assign(restarted.state.continuations, JSON.parse(JSON.stringify(h.state.continuations)));
    restarted.advance(MINUTE);
    await restarted.scan();
    expect(restarted.starts).toHaveLength(0);
    expect(restarted.state.continuations[mapping.docket_run_id]?.state).toBe('requested');
  });

  it('holds owner choices and malformed state rather than manufacturing a producer', async () => {
    const h = continuationHarness();
    h.detail.decisions.push({ authority: 'owner', status: 'active' } as never);
    await h.scan();
    expect(h.starts).toHaveLength(0);
    expect(h.state.continuations[mapping.docket_run_id]?.state).toBe('escalated');
    expect(continuationProblem({ [mapping.docket_run_id]: { key: 'broken' } })).toBe(
      'continuations_shape',
    );
  });

  it('does not interpret one due external wake as clearing additional wait conditions', async () => {
    const h = continuationHarness();
    (h.row.lead_parked.waiting_on as { items?: string[] }).items = ['DKT-2'];
    await h.scan();
    expect(h.starts).toHaveLength(0);
    expect(h.state.continuations[mapping.docket_run_id]).toBeUndefined();
  });

  it('escalates after three unavailable Orca custody reads without starting', async () => {
    const h = continuationHarness();
    h.setWorkerListFails(true);
    await h.scan();
    h.advance(MINUTE);
    await h.scan();
    h.advance(MINUTE);
    await h.scan();
    expect(h.starts).toHaveLength(0);
    expect(h.state.continuations[mapping.docket_run_id]).toMatchObject({
      state: 'escalated',
      read_failures: 3,
      reason: 'read_or_start_unknown',
    });
    expect(h.escalations).toHaveLength(1);
  });

  it('re-reads the due wait immediately before worker start and holds on drift', async () => {
    const h = continuationHarness();
    h.setDriftOnList();
    await h.scan();
    expect(h.starts).toHaveLength(0);
  });

  it('loads only exact Docket Epic mappings and rejects duplicate or Gameflow scope', () => {
    const dir = mkdtempSync(join(tmpdir(), 'docket-continuation-config-'));
    try {
      const path = join(dir, 'continuation-config.json');
      expect(loadContinuationConfig(dir)).toEqual([]);
      writeFileSync(path, JSON.stringify({ version: 1, mappings: [mapping] }));
      expect(loadContinuationConfig(dir)).toEqual([mapping]);
      writeFileSync(path, JSON.stringify({ version: 1, mappings: [mapping, mapping] }));
      expect(() => loadContinuationConfig(dir)).toThrow('continuation_config_invalid');
      writeFileSync(
        path,
        JSON.stringify({ version: 1, mappings: [{ ...mapping, epic: 'GF-231' }] }),
      );
      expect(() => loadContinuationConfig(dir)).toThrow('continuation_config_invalid');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** The two Docket routes the relay reads. Its item reply is full of private text on purpose. */
class FakeDocket {
  rows: Row[] = [];
  runs = new Map<string, FakeRun[]>();
  itemReads = 0;
  otherRequests: string[] = [];
  /** The next page reports a cursor one past its last event. */
  skipNextCursor = false;
  port = 0;
  private server: Server | null = null;
  private waiting = new Set<() => void>();

  async start(): Promise<void> {
    this.server = createServer(
      (req, res) => void this.handle(req.method ?? '', req.url ?? '', res),
    );
    await new Promise<void>((resolve) => this.server!.listen(this.port, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const wake of [...this.waiting]) wake();
    if (!server) return;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  push(e: Partial<Row> & { type: string }, at: number): Row {
    const actor = e.actor ?? 'owner';
    const row: Row = {
      cursor: String(this.rows.length + 1),
      at: new Date(at).toISOString(),
      actor,
      item_id: e.item_id === undefined ? 'GF-243' : e.item_id,
      type: e.type,
      summary: e.summary ?? `You did something: ${SECRET}`,
      kind:
        e.kind ?? (actor.startsWith('owner') ? 'owner' : actor === 'system' ? 'system' : 'agent'),
    };
    this.rows.push(row);
    for (const wake of [...this.waiting]) wake();
    return row;
  }

  private json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private async handle(method: string, url: string, res: ServerResponse) {
    const parsed = new URL(url, 'http://x');
    if (method === 'GET' && parsed.pathname === '/agent/changes/wait') {
      const latest = this.rows.length;
      const raw = parsed.searchParams.get('cursor');
      const cursor = Math.min(raw === null ? latest : Number(raw), latest);
      const limit = Number(parsed.searchParams.get('limit') ?? 20);
      const timeoutMs = Number(parsed.searchParams.get('timeout_s') ?? 60) * 1000;
      if (this.rows.length <= cursor && timeoutMs > 0) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            this.waiting.delete(done);
            resolve();
          };
          const timer = setTimeout(done, timeoutMs);
          this.waiting.add(done);
        });
      }
      if (res.destroyed) return;
      const events = this.rows.slice(cursor, cursor + limit).map(({ kind: _kind, ...row }) => row);
      let next = events.length > 0 ? events[events.length - 1]!.cursor : String(cursor);
      if (this.skipNextCursor && events.length > 0) {
        this.skipNextCursor = false;
        next = String(Number(next) + 1);
      }
      this.json(res, 200, {
        status: events.length > 0 ? 'changed' : 'timeout',
        next_cursor: next,
        events,
      });
      return;
    }
    const item = /^\/api\/items\/([^/]+)$/.exec(parsed.pathname)?.[1];
    if (method === 'GET' && item) {
      this.itemReads += 1;
      if (!this.runs.has(item)) {
        this.json(res, 404, { error: { code: 'not_found' } });
        return;
      }
      this.json(res, 200, {
        item: {
          id: item,
          description_md: SECRET,
          open_question: { text: SECRET, answer: SECRET },
          unread_owner_notes: [{ id: 'n', text: SECRET }],
          runs: this.runs.get(item),
        },
        activity: this.rows
          .filter((row) => row.item_id === item)
          .map((row) => ({ cursor: row.cursor, actor_kind: row.kind, summary: row.summary })),
      });
      return;
    }
    this.otherRequests.push(`${method} ${parsed.pathname}`);
    this.json(res, 404, { error: { code: 'not_found' } });
  }
}

let base: string;
let fakeExe: string;
let preload: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'docket-relay-test-'));
  const bin = join(base, 'bin');
  mkdirSync(bin);
  fakeExe = join(bin, process.platform === 'win32' ? 'orca.exe' : 'orca');
  try {
    linkSync(process.execPath, fakeExe);
  } catch {
    if (process.platform === 'win32') copyFileSync(process.execPath, fakeExe);
    else symlinkSync(process.execPath, fakeExe);
  }
  preload = join(base, 'fake-orca.cjs');
  writeFileSync(preload, FAKE_ORCA);
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

interface Harness {
  home: string;
  docket: FakeDocket;
  clock: { t: number };
  env: NodeJS.ProcessEnv;
  plan: (value: Record<string, unknown>) => void;
  calls: () => { at: number; args: string[]; orcaEnv: string[] }[];
  sends: () => { to: string; subject: string; body: string; requestId: string; args: string[] }[];
  make: (options?: Record<string, unknown>) => Relay;
  step: (relay: Relay) => Promise<void>;
  files: () => string;
}

interface Relay {
  pollOnce: (signal?: AbortSignal, timeoutS?: number) => Promise<unknown>;
  flushDue: (signal?: AbortSignal) => Promise<void>;
  run: (signal: AbortSignal) => Promise<void>;
  state: {
    cursor: string | null;
    batches: Record<string, unknown>;
    undelivered: { item: string; reason: string; kinds: string[] }[];
    counters: Record<string, number>;
    last_delivery: { to: string; latency_ms: number } | null;
    last_failure: { reason: string } | null;
    hold: { state: string; reason: string; detail?: string } | null;
    reconciles: Record<string, unknown>[];
  };
}

type Json = Record<string, unknown>;

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});

async function harness(): Promise<Harness> {
  const dir = mkdtempSync(join(base, 'h-'));
  const home = join(dir, 'home');
  const logPath = join(dir, 'orca-calls.jsonl');
  const planPath = join(dir, 'orca-plan.json');
  const docket = new FakeDocket();
  await docket.start();
  cleanups.push(() => docket.stop());
  const clock = { t: START };
  const plan = (value: Record<string, unknown>) => writeFileSync(planPath, JSON.stringify(value));
  plan({
    dispatches: { ctx_live: { status: 'dispatched', runId: 'run_coord', workerState: 'ready' } },
  });
  docket.runs.set('GF-243', [lead({ dispatch: 'ctx_live' })]);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_OPTIONS: `--require "${preload.replaceAll('\\', '/')}"`,
    FAKE_ORCA_LOG: logPath,
    FAKE_ORCA_PLAN: planPath,
    ORCA_AGENT_SESSION_ID: 'must-not-reach-the-cli',
    ORCA_TERMINAL_HANDLE: 'must-not-reach-the-cli',
  };
  const calls = () =>
    existsSync(logPath)
      ? readFileSync(logPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { at: number; args: string[]; orcaEnv: string[] })
      : [];
  const sends = () =>
    calls()
      .filter((call) => call.args[0] === 'send')
      .map(({ args }) => {
        const flag = (name: string) => args[args.indexOf(name) + 1]!;
        return {
          to: flag('--to'),
          subject: flag('--subject'),
          body: flag('--body'),
          requestId: flag('--retry-request'),
          args,
        };
      });
  const make = (options: Record<string, unknown> = {}): Relay =>
    createRelay({
      docket: createDocket({ baseUrl: docket.url }),
      orca: createOrca({ exe: fakeExe, env }),
      store: openStore(home),
      now: () => clock.t,
      sleep: async () => {},
      options,
    });
  const step = async (relay: Relay) => {
    await relay.pollOnce(undefined, 0);
    await relay.flushDue();
  };
  const files = () =>
    readdirSync(home)
      .map((name) => readFileSync(join(home, name), 'utf8'))
      .join('\n');
  return { home, docket, clock, env, plan, calls, sends, make, step, files };
}

/** A relay that has already taken its first-run cursor. */
async function started(h: Harness, options?: Record<string, unknown>): Promise<Relay> {
  const relay = h.make(options);
  await h.step(relay);
  return relay;
}

const currentPlan = (h: Harness) =>
  JSON.parse(readFileSync(h.env.FAKE_ORCA_PLAN!, 'utf8')) as Record<string, unknown>;

const orchestratorWith = (stored: string | null) => ({
  name: 'producer-x',
  dispatch_id: 'ctx_live',
  run_id: stored,
});

const ANSWER = { type: 'question.answered', summary: `You answered codex: “${SECRET}”` };
const ACCEPTANCE = { type: 'item.updated', summary: 'You edited the acceptance criteria' };
const NOTE = { type: 'owner_note.added', summary: `You left a note: ${SECRET}` };

describe('which events count', () => {
  const owner = (type: string, summary: string, extra: Record<string, unknown> = {}) =>
    classifyEvent({ type, summary, actor: 'owner', item_id: 'GF-243', ...extra });

  it.each([
    ['question.answered', 'You answered codex: “x”', ['answer']],
    ['owner_note.added', 'You left a note: x', ['note']],
    ['review.decided', 'You reviewed round 1 of GF-243: approved', ['review']],
    ['design_review.decided', "You approved GF-243's design change: x", ['design review']],
    ['design_review.decided', "You sent back GF-243's design change: x", ['design review']],
    ['resolution.decided', "You approved codex's proposal", ['resolution']],
    ['overlap.decided', 'You overruled Docket: GF-1 and GF-2 run in parallel', ['overlap']],
    ['undeclared.decided', 'You kept the undeclared change', ['hold']],
    ['decision.published', 'owner recorded a decision: x', ['decision']],
    ['decision.confirmed', 'Owner confirmed a decision: x', ['decision']],
    ['item.updated', 'You edited the title', ['title']],
    ['item.updated', 'You edited the description and outcome', ['description', 'outcome']],
    ['item.updated', 'You edited the acceptance criteria and set GF-243 to P1', ['acceptance']],
    [
      'item.updated',
      'You edited the title, description, outcome and acceptance criteria',
      ['title', 'description', 'outcome', 'acceptance'],
    ],
    ['item.status_changed', 'You moved GF-243 from progress to review', ['status']],
    ['item.status_changed', 'You canceled GF-243 (was progress): x', ['canceled']],
    ['item.archived', 'You archived GF-243', ['archive']],
    ['item.unarchived', 'You restored GF-243', ['archive']],
    ['link.added', 'GF-1 blocks GF-243', ['blocker']],
    ['link.removed', 'Removed: GF-1 blocks GF-243 · GF-243 unblocked', ['blocker']],
  ])('%s "%s"', (type, summary, kinds) => {
    expect(owner(type, summary)?.kinds).toEqual(kinds);
  });

  it('counts an owner action made by a script', () => {
    expect(owner('owner_note.added', 'x', { actor: 'owner (script: curl/8.4.0)' })?.kinds).toEqual([
      'note',
    ]);
  });

  it.each([
    ['problem.acknowledged', 'You acknowledged a problem'],
    ['run.unpushed_handled', 'You marked it handled'],
    ['label.upserted', 'You added a label'],
    ['item.updated', 'You set GF-243 to P2'],
    ['link.added', 'GF-1 relates to GF-243'],
    ['link.removed', 'Removed: GF-1 relates to GF-243'],
    ['link.updated', 'GF-1 blocks GF-243 now clears when done'],
    ['design_review.decided', 'Design review of GF-243 withdrawn: edited'],
    ['question.asked', 'codex asks: x'],
  ])('leaves out %s "%s"', (type, summary) => {
    expect(owner(type, summary)).toBeNull();
  });

  it.each(['codex', 'codex · b55', 'claude-code', 'system', 'docket', 'ownerish'])(
    'ignores events by %s, so the relay cannot start a loop',
    (actor) => {
      for (const type of ['question.answered', 'owner_note.added', 'review.decided']) {
        expect(classifyEvent({ type, actor, item_id: 'GF-243', summary: 'x' })).toBeNull();
      }
    },
  );

  it('takes run.resume_ready by name, from Docket only', () => {
    const event = { type: 'run.resume_ready', item_id: 'GF-243', summary: 'can resume' };
    expect(classifyEvent({ ...event, actor: 'system' })).toMatchObject({
      kinds: ['resume'],
      immediate: true,
    });
    expect(classifyEvent({ ...event, actor: 'codex' })).toBeNull();
    expect(classifyEvent({ ...event, actor: 'owner' })).toBeNull();
  });

  it('needs an item, and reports an undo as an undo', () => {
    expect(owner('owner_note.added', 'x', { item_id: null })).toBeNull();
    expect(owner('item.updated', 'Undid: You edited the title')).toMatchObject({
      kinds: ['undo'],
      immediate: false,
    });
    expect(owner('question.answered', 'Undid: You answered codex: “x”')).toMatchObject({
      kinds: ['undo'],
      immediate: false,
    });
    expect(owner('item.updated', 'Undid: You set GF-243 to P2')).toBeNull();
  });

  it('only an answered question is immediate among owner changes', () => {
    expect(owner('question.answered', 'You answered x')?.immediate).toBe(true);
    expect(owner('review.decided', 'You reviewed')?.immediate).toBe(false);
    expect(owner('item.updated', 'You edited the title')?.immediate).toBe(false);
  });
});

describe('the message', () => {
  const implementer = 'Docket run r_lead1, dispatch ctx_a';

  it('names the ticket, the kinds and the implementer, in the coordinator wording', () => {
    expect(
      buildMessage({ item: 'GF-243', kinds: ['decision', 'acceptance'], implementer }),
    ).toEqual({
      subject: 'Docket: GF-243 updated',
      body: "GF-243 was updated from the owner side in Docket (decision, acceptance). The implementer, for information only: Docket run r_lead1, dispatch ctx_a. You're told as its coordinator, and this notice carries no owner authority. Decide whether and when to relay it, under your own gates. Don't call get_item GF-243 on the implementer's behalf, because that uses up its one-time delivery.",
    });
  });

  it('says a wait cleared without claiming the owner did it', () => {
    const { subject, body } = buildMessage({ item: 'GF-243', kinds: ['resume'], implementer });
    expect(subject).toBe('Docket: GF-243 can resume');
    expect(body).toMatch(/^What GF-243 was waiting for has cleared in Docket\. /);
    expect(body).not.toContain('owner side');
  });

  it('never tells the coordinator to read it, and never writes an address', () => {
    const { body } = buildMessage({ item: 'GF-243', kinds: ['answer'], implementer });
    expect(body).not.toMatch(/call get_context|Tell that session/i);
    expect(body).toContain("Don't call get_item GF-243");
    expect(body).not.toContain('dispatch:');
  });
});

describe('finding the coordinator', () => {
  const show = (found: Record<string, { runId: string | null }>) => (id: string) =>
    Promise.resolve(found[id] ? { found: true, ...found[id] } : { found: false, runId: null });

  it('picks the live lead only', () => {
    const child = { ...lead(), run_id: 'r_child', is_lead: false };
    expect(liveLead([child, lead({ state: 'parked' })])?.run_id).toBe('r_lead1');
    for (const state of ['live', 'reported', 'stale', 'needs_input', 'parked']) {
      expect(liveLead([lead({ state })])).not.toBeNull();
    }
    for (const state of ['finished', 'failed', 'interrupted']) {
      expect(liveLead([lead({ state })])).toBeNull();
    }
    expect(liveLead([child])).toBeNull();
  });

  it('is the Run worker-show reports for the recorded dispatch', async () => {
    const target = await resolveCoordinator(
      lead({ dispatch: 'ctx_a', runId: 'run_stored' }),
      show({ ctx_a: { runId: 'run_home' } }),
    );
    expect(target).toEqual({
      coordinator: 'run:run_home',
      implementer: 'Docket run r_lead1, dispatch ctx_a',
    });
  });

  it('is nobody without that Run, whatever else is stored', async () => {
    for (const [run, found] of [
      [lead({ runId: 'run_stored' }), {}],
      [lead({ runId: 'orca_session_id:abc' }), {}],
      [lead({ dispatch: 'ctx_a', runId: 'run_stored' }), {}],
      [lead({ dispatch: 'ctx_a', runId: 'run_stored' }), { ctx_a: { runId: null } }],
      [lead({ dispatch: 'ctx_a', runId: 'run_stored' }), { ctx_a: { runId: 'not-a-run' } }],
      [lead({ dispatch: '--body=evil' }), {}],
      [lead({ dispatch: 'ctx_a b' }), {}],
      [{ ...lead(), orchestrator: { name: 'orca', dispatch_id: null, run_id: null } }, {}],
    ] as [FakeRun, Record<string, { runId: string | null }>][]) {
      expect((await resolveCoordinator(run, show(found))).coordinator).toBeNull();
    }
  });

  it('passes on an Orca failure, so the batch waits', async () => {
    await expect(
      resolveCoordinator(lead({ dispatch: 'ctx_a', runId: 'run_stored' }), () =>
        Promise.reject(new Error('runtime_unavailable')),
      ),
    ).rejects.toThrow('runtime_unavailable');
  });

  it('accepts only run addresses', () => {
    expect(isCoordinatorAddress('run:run_a-1')).toBe(true);
    for (const bad of [
      'orca_session_id:abc_1',
      'dispatch:ctx_a',
      'DISPATCH:ctx_a',
      ' dispatch:ctx_a',
      'run:dispatch:ctx_a',
      'orca_session_id:dispatch:ctx_a',
      'run:run_a\ndispatch:ctx_a',
      'run_a',
      '--to=run:run_a',
      '',
      null,
      undefined,
    ]) {
      expect(isCoordinatorAddress(bad)).toBe(false);
    }
  });
});

describe('no code path can send to a dispatch', () => {
  const toolFiles = () => [
    join(TOOL, 'docket-relay.mjs'),
    ...readdirSync(join(TOOL, 'lib')).map((name) => join(TOOL, 'lib', name)),
  ];

  it('the real send refuses a dispatch before Orca runs', async () => {
    const h = await harness();
    const orca = createOrca({ exe: fakeExe, env: h.env });
    for (const to of [
      'dispatch:ctx_live',
      'DISPATCH:ctx_live',
      'run:dispatch:ctx_live',
      'orca_session_id:abc-1',
    ]) {
      expect(
        await orca.send({ to, subject: 's', body: 'b', requestId: requestIdFor('x') }),
      ).toEqual({ ok: false, code: 'address_refused', transient: false });
    }
    expect(h.calls()).toEqual([]);
  });

  it('builds --to in one place and never spells a dispatch address', () => {
    const uses = toolFiles().flatMap((file) =>
      (readFileSync(file, 'utf8').match(/'--to'/g) ?? []).map(() => file),
    );
    expect(uses).toEqual([join(TOOL, 'lib', 'orca.mjs')]);
    for (const file of toolFiles().filter((path) => path.includes(`${sep}lib${sep}`))) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/[`'"]dispatch:/);
    }
  });

  const DISPATCHES = [
    ['live', { status: 'dispatched', runId: 'run_coord', workerState: 'ready' }],
    ['finished', { status: 'completed', runId: 'run_coord', workerState: 'succeeded' }],
    ['failed', { status: 'failed', runId: 'run_coord', workerState: 'failed' }],
    ['broken', { status: 'circuit_broken', runId: 'run_coord', workerState: null }],
    ['released', { status: 'dispatched', runId: 'run_coord', workerState: 'stopped' }],
    ['no Run', { status: 'dispatched', runId: null, workerState: 'ready' }],
    ['a hostile Run', { status: 'dispatched', runId: 'dispatch:ctx_live', workerState: 'ready' }],
    ['unknown', null],
  ] as const;
  const STORED = [
    null,
    'run_stored',
    'orca_session_id:stored-1',
    'dispatch:ctx_live',
    'ctx_live',
    'run:dispatch:ctx_live',
  ];

  it.each(DISPATCHES)(
    'a %s dispatch, with every stored fallback',
    async (_name, dispatch) => {
      const h = await harness();
      h.plan({ dispatches: dispatch ? { ctx_live: dispatch } : {} });
      for (const [index, stored] of STORED.entries()) {
        const item = `GF-${index + 1}`;
        h.docket.runs.set(item, [
          { ...lead({ dispatch: 'ctx_live' }), orchestrator: orchestratorWith(stored) },
        ]);
      }
      const relay = await started(h, { rateLimit: 1000 });
      for (const index of STORED.keys()) {
        h.docket.push({ ...ANSWER, item_id: `GF-${index + 1}` }, h.clock.t);
      }
      await h.step(relay);
      for (const send of h.sends()) expect(send.to).toMatch(/^run:run_/);
      expect(JSON.stringify(h.calls().filter((c) => c.args[0] === 'send'))).not.toContain(
        '"--to","dispatch:',
      );
      expect(relay.state.batches).toEqual({});
    },
    30_000,
  );
});

describe('delivery', () => {
  it('sends an answer at once to the coordinator, through the exact command', async () => {
    const h = await harness();
    const relay = await started(h);
    h.docket.push(ANSWER, h.clock.t);
    await h.step(relay);

    const [send, ...rest] = h.sends();
    expect(rest).toEqual([]);
    expect(send!.to).toBe('run:run_coord');
    expect(send!.body).toContain('GF-243 was updated from the owner side in Docket (answer).');
    expect(send!.body).toContain('Docket run r_lead1, dispatch ctx_live');
    expect(send!.args.slice(0, 8)).toEqual([
      'send',
      '--to',
      'run:run_coord',
      '--from',
      'docket-relay',
      '--type',
      'status',
      '--subject',
    ]);
    expect(relay.state.last_delivery?.to).toBe('run:run_coord');
  });

  it('never puts private text in a message, the state or the log', async () => {
    const h = await harness();
    const relay = await started(h);
    h.docket.push(ANSWER, h.clock.t);
    h.docket.push(NOTE, h.clock.t);
    await h.step(relay);
    h.clock.t += 2 * MINUTE;
    await h.step(relay);
    expect(h.sends().length).toBeGreaterThan(0);
    expect(JSON.stringify(h.calls())).not.toContain(SECRET);
    expect(h.files()).not.toContain(SECRET);
  });

  it('only reads Docket: no write, no MCP', async () => {
    const h = await harness();
    const relay = await started(h);
    h.docket.push(ANSWER, h.clock.t);
    await h.step(relay);
    expect(h.docket.itemReads).toBe(1);
    expect(h.docket.otherRequests).toEqual([]);
  });

  it('waits for a ticket to go quiet for 60 seconds', async () => {
    const h = await harness();
    const relay = await started(h);
    h.docket.push(ACCEPTANCE, h.clock.t);
    await h.step(relay);
    h.clock.t += 30_000;
    h.docket.push({ type: 'item.updated', summary: 'You edited the title' }, h.clock.t);
    await h.step(relay);
    h.clock.t += 59_000;
    await h.step(relay);
    expect(h.sends()).toHaveLength(0);
    h.clock.t += 1_000;
    await h.step(relay);
    expect(h.sends()).toHaveLength(1);
    expect(h.sends()[0]!.body).toContain('(title, acceptance)');
  });

  it('sends within 2 minutes of the first change, however long the burst', async () => {
    const h = await harness();
    const relay = await started(h);
    const first = h.clock.t;
    for (let i = 0; i < 12; i += 1) {
      h.docket.push(ACCEPTANCE, h.clock.t);
      await h.step(relay);
      if (h.clock.t - first >= 2 * MINUTE) break;
      expect(h.sends()).toHaveLength(0);
      h.clock.t += 20_000;
    }
    expect(h.clock.t - first).toBe(2 * MINUTE);
    expect(h.sends()).toHaveLength(1);
  });

  it('an answer goes at once and carries the changes waiting with it', async () => {
    const h = await harness();
    const relay = await started(h);
    h.docket.push(ACCEPTANCE, h.clock.t);
    h.docket.push(NOTE, h.clock.t);
    await h.step(relay);
    expect(h.sends()).toHaveLength(0);
    h.clock.t += 5_000;
    h.docket.push(ANSWER, h.clock.t);
    await h.step(relay);
    expect(h.sends()).toHaveLength(1);
    expect(h.sends()[0]!.body).toContain('(answer, note, acceptance)');
    h.clock.t += 5 * MINUTE;
    await h.step(relay);
    expect(h.sends()).toHaveLength(1);
  });

  it('keeps tickets apart', async () => {
    const h = await harness();
    h.docket.runs.set('GF-9', [lead({ dispatch: 'ctx_live' })]);
    const relay = await started(h);
    h.docket.push(ANSWER, h.clock.t);
    h.docket.push({ ...ANSWER, item_id: 'GF-9' }, h.clock.t);
    await h.step(relay);
    expect(
      h
        .sends()
        .map((send) => send.subject)
        .sort(),
    ).toEqual(['Docket: GF-243 updated', 'Docket: GF-9 updated']);
  });

  it.each(['finished', 'failed', 'interrupted'])(
    'sends nothing when the lead has %s',
    async (state) => {
      const h = await harness();
      h.docket.runs.set('GF-243', [lead({ dispatch: 'ctx_live', state })]);
      const relay = await started(h);
      h.docket.push(ANSWER, h.clock.t);
      await h.step(relay);
      expect(h.sends()).toHaveLength(0);
      expect(relay.state.counters.no_live_lead).toBe(1);
      expect(relay.state.undelivered).toEqual([]);
      expect(relay.state.batches).toEqual({});
    },
  );

  it('sends nothing for a ticket with no runs, or one that is gone', async () => {
    const h = await harness();
    h.docket.runs.set('GF-1', []);
    const relay = await started(h);
    h.docket.push({ ...ANSWER, item_id: 'GF-1' }, h.clock.t);
    h.docket.push({ ...ANSWER, item_id: 'GF-404' }, h.clock.t);
    await h.step(relay);
    expect(h.sends()).toHaveLength(0);
    expect(relay.state.undelivered).toEqual([]);
  });

  it('drops an event the item shows was not the owner, whatever the feed called it', async () => {
    const h = await harness();
    const relay = await started(h);
    h.docket.push({ ...ANSWER, actor: 'owner', kind: 'agent' }, h.clock.t);
    await h.step(relay);
    expect(h.sends()).toHaveLength(0);
    expect(relay.state.counters.not_owner).toBe(1);
  });

  it('ignores housekeeping and agent events', async () => {
    const h = await harness();
    const relay = await started(h);
    h.docket.push({ type: 'problem.acknowledged' }, h.clock.t);
    h.docket.push({ type: 'run.unpushed_handled' }, h.clock.t);
    h.docket.push({ ...NOTE, actor: 'codex · b55' }, h.clock.t);
    h.docket.push({ ...NOTE, actor: 'system' }, h.clock.t);
    await h.step(relay);
    h.clock.t += 5 * MINUTE;
    await h.step(relay);
    expect(h.sends()).toHaveLength(0);
    expect(h.docket.itemReads).toBe(0);
  });

  it('delivers run.resume_ready at once to a parked lead', async () => {
    const h = await harness();
    h.docket.runs.set('GF-243', [lead({ dispatch: 'ctx_live', state: 'parked' })]);
    const relay = await started(h);
    h.docket.push({ type: 'run.resume_ready', actor: 'system', summary: 'can resume' }, h.clock.t);
    await h.step(relay);
    expect(h.sends()[0]!.subject).toBe('Docket: GF-243 can resume');
  });

  it('limits messages per session and sends the rest later', async () => {
    const h = await harness();
    const relay = await started(h, { rateLimit: 2 });
    for (let i = 0; i < 3; i += 1) {
      h.docket.push(ANSWER, h.clock.t);
      await h.step(relay);
      h.clock.t += 1_000;
    }
    expect(h.sends()).toHaveLength(2);
    expect(Object.keys(relay.state.batches)).toEqual(['GF-243']);
    h.clock.t += 10 * MINUTE;
    await h.step(relay);
    expect(h.sends()).toHaveLength(3);
  });
});

describe('fallbacks', () => {
  it.each([
    ['completed', 'succeeded'],
    ['failed', 'failed'],
    ['circuit_broken', null],
    ['dispatched', 'stopped'],
    ['dispatched', 'ready'],
  ])('a %s dispatch (worker %s) still goes to its Run', async (status, workerState) => {
    const h = await harness();
    h.plan({ dispatches: { ctx_live: { status, runId: 'run_coord', workerState } } });
    const relay = await started(h);
    h.docket.push(ANSWER, h.clock.t);
    await h.step(relay);
    expect(h.sends().map((send) => send.to)).toEqual(['run:run_coord']);
    expect(h.sends()[0]!.body).toContain('Docket run r_lead1, dispatch ctx_live');
    expect(relay.state.last_delivery?.to).toBe('run:run_coord');
  });

  it.each([
    ['a stored Run, with an unknown dispatch', { dispatch: 'ctx_gone', runId: 'run_stored' }],
    ['a stored Run, with no dispatch', { runId: 'run_stored' }],
    ['a stored session address', { runId: 'orca_session_id:abc-1' }],
    ['no dispatch and no Run', {}],
  ])('records undelivered for %s, with no send', async (_name, stored) => {
    const h = await harness();
    h.docket.runs.set('GF-243', [lead(stored)]);
    const relay = await started(h);
    h.docket.push(ANSWER, h.clock.t);
    await h.step(relay);
    expect(h.sends()).toEqual([]);
    expect(h.calls().map((call) => call.args[0])).not.toContain('run-show');
    expect(relay.state.undelivered).toMatchObject([{ item: 'GF-243', reason: 'no_target' }]);
    expect(relay.state.batches).toEqual({});
  });

  it('retries with one request ID, then holds it while Orca is busy', async () => {
    const h = await harness();
    h.plan({
      dispatches: { ctx_live: { status: 'dispatched', runId: 'run_coord', workerState: 'ready' } },
      fail: { 'run:run_coord': 'runtime_unavailable' },
    });
    const relay = await started(h);
    h.docket.push(ANSWER, h.clock.t);
    await h.step(relay);
    expect(h.sends().map((send) => send.to)).toEqual([
      'run:run_coord',
      'run:run_coord',
      'run:run_coord',
    ]);
    expect(new Set(h.sends().map((send) => send.requestId)).size).toBe(1);
    expect(Object.keys(relay.state.batches)).toEqual(['GF-243']);
  });

  it('does not retry a refusal, and records it', async () => {
    const h = await harness();
    h.plan({
      dispatches: { ctx_live: { status: 'dispatched', runId: 'run_coord', workerState: 'ready' } },
      fail: { 'run:run_coord': 'run_not_found' },
    });
    const relay = await started(h);
    h.docket.push(ANSWER, h.clock.t);
    await h.step(relay);
    expect(h.sends()).toHaveLength(1);
    expect(relay.state.undelivered).toMatchObject([{ reason: 'send_failed' }]);
    expect(relay.state.batches).toEqual({});
  });

  it('records undelivered when there is no coordinator', async () => {
    const h = await harness();
    h.docket.runs.set('GF-243', [lead()]);
    const relay = await started(h);
    h.docket.push(ANSWER, h.clock.t);
    await h.step(relay);
    expect(h.sends()).toHaveLength(0);
    expect(relay.state.undelivered).toMatchObject([
      { item: 'GF-243', reason: 'no_target', kinds: ['answer'] },
    ]);
  });

  it('records undelivered for an unknown dispatch with nothing stored', async () => {
    const h = await harness();
    h.docket.runs.set('GF-243', [lead({ dispatch: 'ctx_gone' })]);
    const relay = await started(h);
    h.docket.push(ANSWER, h.clock.t);
    await h.step(relay);
    expect(h.sends()).toHaveLength(0);
    expect(relay.state.undelivered).toMatchObject([{ reason: 'no_target' }]);
  });

  it('holds a message while Orca is down and sends it when Orca is back', async () => {
    const h = await harness();
    const relay = await started(h);
    const working = currentPlan(h);
    h.plan({ ...working, down: true });
    h.docket.push(ANSWER, h.clock.t);
    await h.step(relay);
    expect(h.sends()).toHaveLength(0);
    expect(Object.keys(relay.state.batches)).toEqual(['GF-243']);
    h.plan(working);
    h.clock.t += 1_000;
    await h.step(relay);
    expect(h.sends()).toHaveLength(0);
    h.clock.t += 5_000;
    await h.step(relay);
    expect(h.sends()).toHaveLength(1);
  });

  it('holds a message when it cannot read Orca, rather than skip to a lower rule', async () => {
    const h = await harness();
    h.docket.runs.set('GF-243', [lead({ dispatch: 'ctx_live', runId: 'run_stored' })]);
    const relay = await started(h);
    const working = currentPlan(h);
    h.plan({ ...working, conciseOnly: true });
    h.docket.push(ANSWER, h.clock.t);
    await h.step(relay);
    expect(h.sends()).toHaveLength(0);
    expect(Object.keys(relay.state.batches)).toEqual(['GF-243']);
    h.plan(working);
    h.clock.t += 5_000;
    await h.step(relay);
    expect(h.sends().map((send) => send.to)).toEqual(['run:run_coord']);
  });
});

describe('hold_reconcile', () => {
  /** A relay that read the feed at START, then stopped. */
  const stopped = async (h: Harness) => {
    await started(h);
    return readFileSync(join(h.home, 'state.json'), 'utf8');
  };
  const saved = (h: Harness) =>
    JSON.parse(readFileSync(join(h.home, 'state.json'), 'utf8')) as Relay['state'];
  const reconcileArgs = (h: Harness) => ({
    store: openStore(h.home),
    docket: createDocket({ baseUrl: h.docket.url }),
    log: () => {},
    now: () => h.clock.t,
  });

  it('does not hold just under 24 hours, and catches up', async () => {
    const h = await harness();
    await stopped(h);
    h.clock.t += DAY - 1;
    h.docket.push(ANSWER, h.clock.t - HOUR);
    const relay = h.make();
    await h.step(relay);
    expect(relay.state.hold).toBeNull();
    expect(h.sends()).toHaveLength(1);
  });

  it.each([
    ['exactly 24 hours', DAY],
    ['over 24 hours', DAY + 1],
    ['many days', 30 * DAY],
  ])('holds after %s, sending nothing and keeping the cursor', async (_name, gap) => {
    const h = await harness();
    await stopped(h);
    h.docket.push(ANSWER, h.clock.t + HOUR);
    h.docket.push(NOTE, h.clock.t + gap - MINUTE);
    h.clock.t += gap;
    const before = saved(h).cursor;
    const reads = h.docket.itemReads;
    const relay = h.make();
    await h.step(relay);
    h.clock.t += HOUR;
    await h.step(relay);
    expect(relay.state.hold).toMatchObject({ state: 'hold_reconcile', reason: 'stale' });
    expect(relay.state.cursor).toBe(before);
    expect(saved(h).cursor).toBe(before);
    expect(h.sends()).toHaveLength(0);
    expect(h.docket.itemReads).toBe(reads);
    expect(relay.state.batches).toEqual({});
  });

  it('holds when the host sleeps through a running relay', async () => {
    const h = await harness();
    const relay = await started(h);
    h.docket.push(ANSWER, h.clock.t);
    h.clock.t += DAY;
    await h.step(relay);
    expect(relay.state.hold?.reason).toBe('stale');
    expect(relay.state.cursor).toBe('0');
    expect(h.sends()).toHaveLength(0);
  });

  it('nothing leaves the hold on its own', async () => {
    const h = await harness();
    await stopped(h);
    h.clock.t += DAY;
    for (let i = 0; i < 3; i += 1) {
      h.docket.push(ANSWER, h.clock.t);
      const relay = h.make();
      await h.step(relay);
      h.clock.t += HOUR;
      expect(relay.state.hold?.reason).toBe('stale');
    }
    expect(saved(h).cursor).toBe('0');
    expect(h.sends()).toHaveLength(0);
  });

  it('a corrupt state file holds and is kept, and a restart stays in the hold', async () => {
    const h = await harness();
    mkdirSync(h.home, { recursive: true });
    writeFileSync(join(h.home, 'state.json'), '{not json');
    h.docket.push(ANSWER, h.clock.t);
    const relay = h.make();
    await h.step(relay);
    expect(relay.state.hold?.reason).toBe('state_unreadable');
    expect(relay.state.cursor).toBeNull();
    expect(h.sends()).toHaveLength(0);
    const kept = readdirSync(h.home).filter((name) => name.startsWith('state.json.corrupt-'));
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(h.home, kept[0]!), 'utf8')).toBe('{not json');

    const again = h.make();
    await h.step(again);
    expect(again.state.hold?.reason).toBe('state_unreadable');
    expect(again.state.cursor).toBeNull();
  });

  it.each<[string, (s: Json) => Json]>([
    ['another version', (s: Json) => ({ ...s, version: 99 })],
    ['a bad cursor', (s: Json) => ({ ...s, cursor: 12 })],
    ['a bad batch', (s: Json) => ({ ...s, batches: { 'GF-1': { events: 'x' } } })],
    ['no seen map', (s: Json) => ({ ...s, seen: [] })],
  ])('a state with %s holds', async (_name, change) => {
    const h = await harness();
    await stopped(h);
    writeFileSync(join(h.home, 'state.json'), JSON.stringify(change(saved(h) as Json)));
    const relay = h.make();
    await h.step(relay);
    expect(relay.state.hold?.reason).toBe('state_unreadable');
    expect(h.sends()).toHaveLength(0);
  });

  it.each<[string, (s: Json) => Json]>([
    ['no activity time', (s: Json) => ({ ...s, active_at: null })],
    ['an activity time in the future', (s: Json) => ({ ...s, active_at: START + HOUR })],
    ['a cursor with no anchor', (s: Json) => ({ ...s, cursor: '5', anchor: null })],
  ])('a state with %s is untrusted', async (_name, change) => {
    const h = await harness();
    await stopped(h);
    writeFileSync(join(h.home, 'state.json'), JSON.stringify(change(saved(h) as Json)));
    const before = saved(h).cursor;
    h.docket.push(ANSWER, h.clock.t);
    const relay = h.make();
    await h.step(relay);
    expect(relay.state.hold?.reason).toBe('state_untrusted');
    expect(relay.state.cursor).toBe(before);
    expect(h.sends()).toHaveLength(0);
  });

  it('a cursor ahead of the feed holds at start', async () => {
    const h = await harness();
    h.docket.push(NOTE, h.clock.t);
    h.docket.push(NOTE, h.clock.t);
    await started(h);
    h.docket.rows = h.docket.rows.slice(0, 1);
    const relay = h.make();
    await h.step(relay);
    expect(relay.state.hold?.reason).toBe('cursor_ahead');
    expect(relay.state.cursor).toBe('2');
    expect(h.sends()).toHaveLength(0);
  });

  it('a feed that shrinks under a running relay holds', async () => {
    const h = await harness();
    const relay = await started(h);
    h.docket.push(NOTE, h.clock.t);
    h.docket.push(NOTE, h.clock.t);
    await h.step(relay);
    h.docket.rows = [];
    await h.step(relay);
    expect(relay.state.hold?.reason).toBe('cursor_ahead');
    expect(relay.state.cursor).toBe('2');
  });

  it('a replaced feed that has grown past the cursor holds as a reset', async () => {
    const h = await harness();
    h.docket.push(NOTE, h.clock.t - HOUR);
    h.docket.push(NOTE, h.clock.t - HOUR);
    await started(h);
    h.docket.rows = [];
    h.docket.push(ANSWER, h.clock.t - MINUTE);
    h.docket.push(ANSWER, h.clock.t - 30_000);
    h.docket.push(ANSWER, h.clock.t);
    const relay = h.make();
    await h.step(relay);
    expect(relay.state.hold?.reason).toBe('feed_reset');
    expect(relay.state.cursor).toBe('2');
    expect(h.sends()).toHaveLength(0);
  });

  it('a batch past the window holds, is kept, and is never expired', async () => {
    const h = await harness();
    const relay = await started(h);
    const working = currentPlan(h);
    h.plan({ ...working, down: true });
    h.docket.push(ANSWER, h.clock.t);
    await h.step(relay);
    for (let i = 1; i < 24; i += 1) {
      h.clock.t += HOUR;
      await h.step(relay);
    }
    expect(relay.state.hold).toBeNull();
    h.clock.t += HOUR;
    await h.step(relay);
    expect(relay.state.hold?.reason).toBe('batch_past_window');
    expect(Object.keys(relay.state.batches)).toEqual(['GF-243']);
    expect(relay.state.undelivered).toEqual([]);
    expect(saved(h).hold).toMatchObject({ reason: 'batch_past_window' });
  });

  it('--deliver queues the backlog per ticket and the next start sends it once', async () => {
    const h = await harness();
    h.docket.runs.set('GF-9', [lead({ dispatch: 'ctx_live' })]);
    await stopped(h);
    h.docket.push(ACCEPTANCE, h.clock.t + HOUR);
    h.docket.push(NOTE, h.clock.t + 2 * HOUR);
    h.docket.push(ANSWER, h.clock.t + 3 * HOUR);
    h.docket.push({ ...NOTE, item_id: 'GF-9' }, h.clock.t + 4 * HOUR);
    h.docket.push({ type: 'plan.updated', actor: 'codex' }, h.clock.t + 5 * HOUR);
    h.clock.t += 2 * DAY;
    await h.step(h.make());
    expect(h.sends()).toHaveLength(0);

    const result = await reconcileDeliver(reconcileArgs(h));
    expect(result).toMatchObject({ ok: true, events: 4, tickets: 2 });
    expect(h.sends()).toHaveLength(0);
    expect(saved(h)).toMatchObject({ hold: null, cursor: '5' });
    expect(saved(h).reconciles.at(-1)).toMatchObject({
      action: 'deliver',
      hold_reason: 'stale',
      from_cursor: '0',
      to_cursor: '5',
      events: 4,
    });
    expect(h.files()).not.toContain(SECRET);

    const relay = h.make();
    await h.step(relay);
    expect(h.sends().map((send) => send.subject)).toEqual(['Docket: GF-243 updated']);
    expect(h.sends()[0]!.body).toContain('(answer, note, acceptance)');
    h.clock.t += MINUTE;
    await h.step(relay);
    expect(
      h
        .sends()
        .map((send) => send.subject)
        .sort(),
    ).toEqual(['Docket: GF-243 updated', 'Docket: GF-9 updated']);
    h.clock.t += HOUR;
    await h.step(relay);
    expect(h.sends()).toHaveLength(2);
  });

  it('--deliver keeps to the rate limit', async () => {
    const h = await harness();
    for (let i = 1; i <= 3; i += 1) h.docket.runs.set(`GF-${i}`, [lead({ dispatch: 'ctx_live' })]);
    await stopped(h);
    for (let i = 1; i <= 3; i += 1) h.docket.push({ ...ANSWER, item_id: `GF-${i}` }, h.clock.t);
    h.clock.t += DAY;
    await h.step(h.make());
    await reconcileDeliver(reconcileArgs(h));
    const relay = h.make({ rateLimit: 2 });
    await h.step(relay);
    expect(h.sends()).toHaveLength(2);
    expect(Object.keys(relay.state.batches)).toHaveLength(1);
    h.clock.t += 10 * MINUTE;
    await h.step(relay);
    expect(h.sends()).toHaveLength(3);
  });

  it('--deliver re-queues a batch past the window', async () => {
    const h = await harness();
    const relay = await started(h);
    const working = currentPlan(h);
    h.plan({ ...working, down: true });
    h.docket.push(ANSWER, h.clock.t);
    await h.step(relay);
    h.clock.t += DAY - HOUR;
    await h.step(relay);
    h.clock.t += HOUR;
    await h.step(relay);
    expect(relay.state.hold?.reason).toBe('batch_past_window');
    h.plan(working);
    expect(await reconcileDeliver(reconcileArgs(h))).toMatchObject({ ok: true, events: 1 });
    await h.step(h.make());
    expect(h.sends()).toHaveLength(1);
  });

  it.each<[string, (h: Harness) => void]>([
    ['cursor_ahead', (h: Harness) => void (h.docket.rows = h.docket.rows.slice(0, 1))],
    [
      'feed_reset',
      (h: Harness) => {
        h.docket.rows = [];
        h.docket.push(NOTE, h.clock.t - 5);
        h.docket.push(NOTE, h.clock.t - 4);
      },
    ],
  ])('--deliver refuses after %s, and --skip-to-end leaves it', async (reason, breakFeed) => {
    const h = await harness();
    h.docket.push(NOTE, h.clock.t - HOUR);
    h.docket.push(NOTE, h.clock.t - HOUR);
    await started(h);
    breakFeed(h);
    await h.step(h.make());
    expect(saved(h).hold?.reason).toBe(reason);

    expect(await reconcileDeliver(reconcileArgs(h))).toMatchObject({
      ok: false,
      code: 'needs_skip',
    });
    expect(saved(h).hold?.reason).toBe(reason);
    expect(saved(h).cursor).toBe('2');

    expect(await reconcileSkip({ ...reconcileArgs(h), reason: 'Feed restored' })).toMatchObject({
      ok: true,
      backlog_known: false,
    });
    expect(saved(h).hold).toBeNull();
    expect(saved(h).cursor).toBe(String(h.docket.rows.length));
    expect(h.sends()).toHaveLength(0);
  });

  it('--skip-to-end records what it skipped, in the state, the audit and the log', async () => {
    const h = await harness();
    const lines: [string, Record<string, unknown>][] = [];
    h.docket.runs.set('GF-9', [lead({ dispatch: 'ctx_live' })]);
    await stopped(h);
    const firstAt = h.clock.t + HOUR;
    const lastAt = h.clock.t + 2 * HOUR;
    h.docket.push(ANSWER, firstAt);
    h.docket.push({ ...NOTE, item_id: 'GF-9' }, lastAt);
    h.clock.t += DAY;
    await h.step(h.make());

    const result = await reconcileSkip({
      ...reconcileArgs(h),
      log: (event: string, fields: Record<string, unknown>) => lines.push([event, fields]),
      reason: 'Owner reviewed the backlog',
    });
    expect(result).toMatchObject({ ok: true, events: 2, tickets: 2, backlog_known: true });
    const state = saved(h);
    expect(state).toMatchObject({ hold: null, cursor: '2', batches: {} });
    expect(state.counters.skipped).toBe(2);
    expect(state.reconciles.at(-1)).toMatchObject({
      action: 'skip',
      reason: 'Owner reviewed the backlog',
      hold_reason: 'stale',
      from_cursor: '0',
      to_cursor: '2',
      events: 2,
      tickets: 2,
      first_at: new Date(firstAt).toISOString(),
      last_at: new Date(lastAt).toISOString(),
    });
    const audit = JSON.parse(readFileSync(join(h.home, 'reconcile-audit.jsonl'), 'utf8')) as Json;
    expect(audit.items).toEqual([
      { item: 'GF-243', kinds: ['answer'], events: 1 },
      { item: 'GF-9', kinds: ['note'], events: 1 },
    ]);
    expect(lines[0]![0]).toBe('reconcile_skip');
    expect(lines[0]![1]).toMatchObject({
      reason: 'Owner reviewed the backlog',
      events: 2,
      audit_id: audit.audit_id,
    });
    expect(JSON.stringify(lines)).not.toContain(SECRET);
    expect(h.files()).not.toContain(SECRET);

    const relay = h.make();
    await h.step(relay);
    h.clock.t += HOUR;
    await h.step(relay);
    expect(h.sends()).toHaveLength(0);
    h.docket.push(ANSWER, h.clock.t);
    await h.step(relay);
    expect(h.sends()).toHaveLength(1);
  });

  it('--skip-to-end records a held batch', async () => {
    const h = await harness();
    const relay = await started(h);
    h.plan({ ...currentPlan(h), down: true });
    h.docket.push(ANSWER, h.clock.t);
    await h.step(relay);
    h.clock.t += DAY - HOUR;
    await h.step(relay);
    h.clock.t += HOUR;
    await h.step(relay);
    expect(await reconcileSkip({ ...reconcileArgs(h), reason: 'Orca was replaced' })).toMatchObject(
      { ok: true, events: 1, tickets: 1 },
    );
    expect(saved(h).batches).toEqual({});
    expect(saved(h).reconciles.at(-1)).toMatchObject({ hold_reason: 'batch_past_window' });
    const audit = JSON.parse(readFileSync(join(h.home, 'reconcile-audit.jsonl'), 'utf8')) as Json;
    expect(audit.items).toEqual([{ item: 'GF-243', kinds: ['answer'], events: 1 }]);
  });

  it.each(['', '   ', 'two\nlines', 'x'.repeat(201), undefined])(
    '--skip-to-end needs a one-line reason (%j)',
    async (reason) => {
      const h = await harness();
      await stopped(h);
      h.clock.t += DAY;
      await h.step(h.make());
      expect(await reconcileSkip({ ...reconcileArgs(h), reason })).toEqual({
        ok: false,
        code: 'reason_required',
      });
      expect(saved(h).hold?.reason).toBe('stale');
    },
  );

  it('an anchor that differs from the cursor is untrusted, and --deliver refuses', async () => {
    const h = await harness();
    h.docket.push(NOTE, h.clock.t);
    h.docket.push(NOTE, h.clock.t);
    await started(h);
    const state = saved(h) as unknown as Json;
    writeFileSync(
      join(h.home, 'state.json'),
      JSON.stringify({ ...state, anchor: { cursor: '1', at: h.docket.rows[0]!.at } }),
    );
    h.docket.push(ANSWER, h.clock.t);
    const relay = h.make();
    await h.step(relay);
    expect(relay.state.hold).toMatchObject({
      reason: 'state_untrusted',
      detail: 'anchor_mismatch',
    });
    expect(relay.state.cursor).toBe('2');
    expect(h.sends()).toEqual([]);
    expect(await reconcileDeliver(reconcileArgs(h))).toMatchObject({
      ok: false,
      code: 'needs_skip',
    });
    expect(saved(h).cursor).toBe('2');
  });

  const goodBatch = (): Json => ({
    id: '11111111-1111-4111-8111-111111111111',
    item_id: 'GF-243',
    events: [
      {
        key: '1:2026-11-23T12:00:00.000Z',
        cursor: '1',
        kinds: ['answer'],
        immediate: true,
        expect: 'owner',
        event_ms: START,
      },
    ],
    first_at: START,
    last_at: START,
    next_attempt_at: 0,
    defers: 0,
  });
  const goodEvent = () => (goodBatch().events as Json[])[0]!;

  it.each<[string, string, (batch: Json) => Json]>([
    ['a batch under the wrong ticket', 'batch_item', (b) => ({ ...b, item_id: 'GF-9' })],
    ['a bad batch ID', 'batch_id', (b) => ({ ...b, id: 'nope' })],
    ['an empty batch', 'batch_events', (b) => ({ ...b, events: [] })],
    [
      'an event past the cursor',
      'event_past_cursor',
      (b) => ({ ...b, events: [{ ...goodEvent(), key: '9:x', cursor: '9' }] }),
    ],
    [
      'a kind that does not exist',
      'event_kinds',
      (b) => ({ ...b, events: [{ ...goodEvent(), kinds: [`text ${SECRET}`] }] }),
    ],
    ['a repeated event', 'event_repeated', (b) => ({ ...b, events: [goodEvent(), goodEvent()] })],
    ['clocks out of order', 'batch_clock', (b) => ({ ...b, first_at: START + 1 })],
    [
      'an in-flight key it does not hold',
      'in_flight',
      (b) => ({ ...b, in_flight: { keys: ['2:other'] } }),
    ],
  ])('%s is untrusted, and is not sent', async (_name, detail, change) => {
    const h = await harness();
    h.docket.push(NOTE, START - HOUR);
    await started(h);
    const state = saved(h) as unknown as Json;
    writeFileSync(
      join(h.home, 'state.json'),
      JSON.stringify({ ...state, batches: { 'GF-243': change(goodBatch()) } }),
    );
    const relay = h.make();
    await h.step(relay);
    expect(relay.state.hold).toMatchObject({ reason: 'state_untrusted', detail });
    expect(h.sends()).toEqual([]);
    expect(await reconcileDeliver(reconcileArgs(h))).toMatchObject({ code: 'needs_skip' });
    expect(await reconcileSkip({ ...reconcileArgs(h), reason: 'Bad state' })).toMatchObject({
      ok: true,
    });
    expect(readFileSync(join(h.home, 'reconcile-audit.jsonl'), 'utf8')).not.toContain(SECRET);
  });

  it('a seen key ahead of the cursor is invalid state', async () => {
    const h = await harness();
    h.docket.push(NOTE, h.clock.t);
    await started(h);
    const state = saved(h) as unknown as Json;
    writeFileSync(
      join(h.home, 'state.json'),
      JSON.stringify({ ...state, seen: { [`2:${h.docket.rows[0]!.at}`]: START } }),
    );
    h.docket.push(ANSWER, h.clock.t);
    const relay = h.make();
    await h.step(relay);
    expect(relay.state.hold).toMatchObject({ reason: 'state_untrusted', detail: 'seen_ahead' });
    expect(relay.state.cursor).toBe('1');
    expect(h.sends()).toEqual([]);
    expect(await reconcileDeliver(reconcileArgs(h))).toMatchObject({ code: 'needs_skip' });
  });

  it('a skip to a lower feed end forgets later seen keys, so a restart runs', async () => {
    const h = await harness();
    const first = await started(h);
    h.docket.push(NOTE, h.clock.t);
    h.docket.push(NOTE, h.clock.t);
    await h.step(first);
    h.docket.rows = h.docket.rows.slice(0, 1);
    await h.step(h.make());
    expect(saved(h).hold?.reason).toBe('cursor_ahead');
    expect(await reconcileSkip({ ...reconcileArgs(h), reason: 'Feed restored' })).toMatchObject({
      ok: true,
    });
    const relay = h.make();
    await h.step(relay);
    expect(relay.state.hold).toBeNull();
    expect(relay.state.cursor).toBe('1');
  });

  it('a page that does not continue from the cursor holds, and moves nothing', async () => {
    const h = await harness();
    const relay = await started(h);
    const wait = relay as unknown as { pollOnce: Relay['pollOnce'] };
    h.docket.push(NOTE, h.clock.t);
    h.docket.skipNextCursor = true;
    await wait.pollOnce(undefined, 0);
    expect(relay.state.hold).toMatchObject({ reason: 'feed_reset', detail: 'incoherent_page' });
    expect(relay.state.cursor).toBe('0');
    expect(relay.state.batches).toEqual({});
  });

  /** A relay whose send stays open until the test finishes it. */
  const holdingSend = async (h: Harness) => {
    h.docket.runs.set('GF-9', [lead({ dispatch: 'ctx_live' })]);
    const sent: string[] = [];
    let finish: (result: Record<string, unknown>) => void = () => {};
    const real = createOrca({ exe: fakeExe, env: h.env });
    const store = openStore(h.home);
    const relay = createRelay({
      docket: createDocket({ baseUrl: h.docket.url }),
      orca: {
        showDispatch: (id: string) => real.showDispatch(id),
        showRun: (id: string) => real.showRun(id),
        send: (message: { to: string }) => {
          sent.push(message.to);
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
      store,
      now: () => h.clock.t,
      sleep: async () => {},
    }) as Relay;
    await h.step(relay);
    h.docket.push(ANSWER, h.clock.t);
    h.docket.push({ ...ANSWER, item_id: 'GF-9' }, h.clock.t);
    await relay.pollOnce(undefined, 0);
    const flushing = relay.flushDue();
    await until(() => sent.length === 1);
    return { relay, sent, flushing, finish: (r: Record<string, unknown>) => finish(r) };
  };

  it('a hold waits for the send in flight, whose result is saved first', async () => {
    const h = await harness();
    const { relay, sent, flushing, finish } = await holdingSend(h);
    const cursor = relay.state.cursor;
    h.docket.push(NOTE, h.clock.t);
    h.clock.t += DAY;
    await relay.pollOnce(undefined, 0);

    // Pending: not reported, and neither the cursor nor the file has moved.
    expect(relay.state.hold).toBeNull();
    expect(saved(h).hold).toBeNull();
    expect(relay.state.cursor).toBe(cursor);

    finish({ ok: true });
    await flushing;
    expect(sent).toEqual(['run:run_coord']);
    const after = saved(h);
    expect(after.hold?.reason).toBe('stale');
    expect(after.counters.delivered).toBe(1);
    expect(after.cursor).toBe(cursor);
    expect(Object.keys(after.batches)).toEqual(['GF-9']);
  });

  it('nothing settles, sends or moves the cursor once the hold is written', async () => {
    const h = await harness();
    const { relay, sent, flushing, finish } = await holdingSend(h);
    h.clock.t += DAY;
    await relay.pollOnce(undefined, 0);
    finish({ ok: true });
    await flushing;
    const before = readFileSync(join(h.home, 'state.json'), 'utf8');

    h.docket.push(ANSWER, h.clock.t);
    await relay.pollOnce(undefined, 0);
    await relay.flushDue();
    (relay as unknown as { ingest: (page: unknown) => void }).ingest({
      next_cursor: '99',
      events: [],
    });
    expect(sent).toHaveLength(1);
    expect(readFileSync(join(h.home, 'state.json'), 'utf8')).toBe(before);
  });

  it('a send that fails during a pending hold is recorded and not retried', async () => {
    const h = await harness();
    const { relay, sent, flushing, finish } = await holdingSend(h);
    h.clock.t += DAY;
    await relay.pollOnce(undefined, 0);
    finish({ ok: false, code: 'runtime_unavailable', transient: true });
    await flushing;
    expect(sent).toHaveLength(1);
    const after = saved(h);
    expect(after.hold?.reason).toBe('stale');
    expect(after.last_failure).toMatchObject({ reason: 'orca_unavailable' });
    expect(after.counters.send_failures).toBe(1);
    expect(Object.keys(after.batches).sort()).toEqual(['GF-243', 'GF-9']);
  });

  it('run() reports the hold only after the send in flight has been recorded', async () => {
    const h = await harness();
    const { relay, flushing, finish } = await holdingSend(h);
    h.clock.t += DAY;
    const controller = new AbortController();
    let reported = false;
    const running = relay.run(controller.signal).then((hold) => {
      reported = true;
      return hold;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(reported).toBe(false);
    finish({ ok: true });
    await flushing;
    expect(await running).toMatchObject({ reason: 'stale' });
    expect(saved(h).counters.delivered).toBe(1);
  });

  it('--skip-to-end audits every ticket and its kinds, with no cap and no content', async () => {
    const h = await harness();
    await stopped(h);
    const tickets = 150;
    for (let i = 1; i <= tickets; i += 1) {
      h.docket.push({ ...ANSWER, item_id: `GF-${i}` }, h.clock.t + i);
      h.docket.push({ ...NOTE, item_id: `GF-${i}` }, h.clock.t + i);
    }
    h.clock.t += DAY;
    await h.step(h.make());
    const result = await reconcileSkip({ ...reconcileArgs(h), reason: 'Reviewed' });
    expect(result).toMatchObject({ ok: true, events: 300, tickets });

    const text = readFileSync(join(h.home, 'reconcile-audit.jsonl'), 'utf8');
    expect(text).not.toContain(SECRET);
    const [record, ...rest] = text.trim().split('\n');
    expect(rest).toEqual([]);
    const audit = JSON.parse(record!) as {
      audit_id: string;
      reason: string;
      items: { item: string; kinds: string[]; events: number }[];
    };
    expect(audit.reason).toBe('Reviewed');
    expect(audit.audit_id).toBe((result as { audit_id: string }).audit_id);
    expect(audit.items).toHaveLength(tickets);
    expect(audit.items[149]).toEqual({ item: 'GF-150', kinds: ['answer', 'note'], events: 2 });
    expect(saved(h).reconciles.at(-1)).toMatchObject({ audit_id: audit.audit_id, tickets });
  });

  it('the audit is append-only across skips', async () => {
    const h = await harness();
    await stopped(h);
    for (const reason of ['First', 'Second']) {
      h.docket.push(ANSWER, h.clock.t);
      h.clock.t += DAY;
      await h.step(h.make());
      expect(await reconcileSkip({ ...reconcileArgs(h), reason })).toMatchObject({ ok: true });
    }
    const lines = readFileSync(join(h.home, 'reconcile-audit.jsonl'), 'utf8').trim().split('\n');
    expect(lines.map((line) => (JSON.parse(line) as { reason: string }).reason)).toEqual([
      'First',
      'Second',
    ]);
  });

  it('a skip that cannot write its audit changes nothing', async () => {
    const h = await harness();
    await stopped(h);
    h.docket.push(ANSWER, h.clock.t);
    h.clock.t += DAY;
    await h.step(h.make());
    mkdirSync(join(h.home, 'reconcile-audit.jsonl'));
    const before = readFileSync(join(h.home, 'state.json'), 'utf8');
    await expect(reconcileSkip({ ...reconcileArgs(h), reason: 'No audit' })).rejects.toThrow();
    expect(readFileSync(join(h.home, 'state.json'), 'utf8')).toBe(before);
  });

  it('reconcile needs a hold', async () => {
    const h = await harness();
    await stopped(h);
    expect(await reconcileDeliver(reconcileArgs(h))).toEqual({ ok: false, code: 'not_in_hold' });
    expect(await reconcileSkip({ ...reconcileArgs(h), reason: 'x' })).toEqual({
      ok: false,
      code: 'not_in_hold',
    });
  });

  it('a failed read leaves the hold and the cursor as they were', async () => {
    const h = await harness();
    await stopped(h);
    h.docket.push(ANSWER, h.clock.t);
    h.clock.t += DAY;
    await h.step(h.make());
    const before = readFileSync(join(h.home, 'state.json'), 'utf8');
    await h.docket.stop();
    await expect(reconcileDeliver(reconcileArgs(h))).rejects.toMatchObject({
      code: 'unreachable',
    });
    await expect(
      reconcileSkip({ ...reconcileArgs(h), reason: 'Docket is down' }),
    ).rejects.toMatchObject({ code: 'unreachable' });
    expect(readFileSync(join(h.home, 'state.json'), 'utf8')).toBe(before);
  });
});

describe('reliability', () => {
  it('starts at the end of the feed on its first run', async () => {
    const h = await harness();
    h.docket.push(ANSWER, h.clock.t - MINUTE);
    h.docket.push(NOTE, h.clock.t - MINUTE);
    const relay = h.make();
    await h.step(relay);
    h.clock.t += 5 * MINUTE;
    await h.step(relay);
    expect(relay.state.cursor).toBe('2');
    expect(h.sends()).toHaveLength(0);
  });

  it('does not repeat a delivery after a restart', async () => {
    const h = await harness();
    const first = await started(h);
    h.docket.push(ANSWER, h.clock.t);
    await h.step(first);
    expect(h.sends()).toHaveLength(1);
    const second = h.make();
    await h.step(second);
    h.clock.t += 5 * MINUTE;
    await h.step(second);
    expect(h.sends()).toHaveLength(1);
  });

  it('keeps a batch across a restart', async () => {
    const h = await harness();
    const first = await started(h);
    h.docket.push(ACCEPTANCE, h.clock.t);
    await h.step(first);
    expect(h.sends()).toHaveLength(0);
    const second = h.make();
    h.clock.t += MINUTE;
    await h.step(second);
    expect(h.sends()).toHaveLength(1);
    expect(h.sends()[0]!.body).toContain('(acceptance)');
  });

  it('a crash between send and save retries with the same request ID', async () => {
    const h = await harness();
    const first = await started(h);
    h.docket.push(ACCEPTANCE, h.clock.t);
    await h.step(first);
    const before = readFileSync(join(h.home, 'state.json'), 'utf8');
    h.clock.t += MINUTE;
    await h.step(first);
    writeFileSync(join(h.home, 'state.json'), before);
    const second = h.make();
    await h.step(second);
    const sends = h.sends();
    expect(sends).toHaveLength(2);
    // Orca replays a repeated request ID instead of delivering it again.
    expect(sends[1]!.requestId).toBe(sends[0]!.requestId);
  });

  /** The state a hard kill leaves: the answer is recorded as in flight, outcome unknown. */
  const cutOff = async (h: Harness, extra: Record<string, unknown> = {}) => {
    const first = await started(h);
    const row = h.docket.push(ANSWER, h.clock.t);
    await first.pollOnce(undefined, 0);
    const state = JSON.parse(readFileSync(join(h.home, 'state.json'), 'utf8')) as Json;
    const batch = (state.batches as Record<string, Json>)['GF-243']!;
    batch.in_flight = { keys: [`${row.cursor}:${row.at}`] };
    Object.assign(batch, extra);
    writeFileSync(join(h.home, 'state.json'), JSON.stringify(state));
  };

  it('a send cut off is rebuilt from Docket and Orca, under the same request ID', async () => {
    const h = await harness();
    const control = await harness();
    await cutOff(h);
    const batchId = (
      JSON.parse(readFileSync(join(h.home, 'state.json'), 'utf8')) as {
        batches: Record<string, { id: string }>;
      }
    ).batches['GF-243']!.id;

    const relay = h.make();
    await h.step(relay);
    const [send] = h.sends();
    expect(h.sends()).toHaveLength(1);
    expect(send!.to).toBe('run:run_coord');
    const fixed = buildMessage({
      item: 'GF-243',
      kinds: ['answer'],
      implementer: 'Docket run r_lead1, dispatch ctx_live',
    });
    expect(send).toMatchObject(fixed);
    expect(send!.requestId).toBe(requestIdFor(batchId, send!.to));
    expect(relay.state.batches).toEqual({});
    expect(control.sends()).toEqual([]);
  });

  it('does not send the old message when the coordinator has changed', async () => {
    const h = await harness();
    await cutOff(h);
    h.plan({
      dispatches: { ctx_live: { status: 'dispatched', runId: 'run_new', workerState: 'ready' } },
    });
    const relay = h.make();
    await h.step(relay);
    expect(h.sends().map((send) => send.to)).toEqual(['run:run_new']);
  });

  it('a rebuilt message with different text is not delivered a second time', async () => {
    const h = await harness();
    const first = await started(h);
    h.docket.push(ANSWER, h.clock.t);
    await first.pollOnce(undefined, 0);
    const path = join(h.home, 'state.json');
    const before = readFileSync(path, 'utf8');
    await first.flushDue();
    expect(h.sends()).toHaveLength(1);

    // A crash before the result was saved, and the text would now differ.
    writeFileSync(path, before);
    h.docket.runs.set('GF-243', [{ ...lead({ dispatch: 'ctx_live' }), run_id: 'r_lead2' }]);
    const second = h.make();
    await h.step(second);

    const [one, two] = h.sends();
    expect(two!.body).not.toBe(one!.body);
    expect(two!.requestId).toBe(one!.requestId);
    // Orca refuses the changed text under a used ID, which proves the first send landed.
    expect(second.state.batches).toEqual({});
    expect(second.state.undelivered).toEqual([]);
    expect(second.state.counters.delivered).toBe(1);
  });

  it('does not send when the lead is gone or no longer proven', async () => {
    const gone = await harness();
    await cutOff(gone);
    gone.docket.runs.set('GF-243', [lead({ dispatch: 'ctx_live', state: 'finished' })]);
    const first = gone.make();
    await gone.step(first);
    expect(gone.sends()).toEqual([]);
    expect(first.state.batches).toEqual({});

    const unproven = await harness();
    await cutOff(unproven);
    unproven.plan({ dispatches: {} });
    const second = unproven.make();
    await unproven.step(second);
    expect(unproven.sends()).toEqual([]);
    expect(second.state.undelivered).toMatchObject([{ reason: 'no_target' }]);
  });

  it('a send cut off keeps its own events, and new ones go separately', async () => {
    const h = await harness();
    await cutOff(h);
    h.docket.push(NOTE, h.clock.t);
    const relay = h.make();
    await h.step(relay);
    expect(h.sends()).toHaveLength(1);
    expect(h.sends()[0]!.body).toContain('(answer)');
    h.clock.t += MINUTE;
    await h.step(relay);
    expect(h.sends()).toHaveLength(2);
    expect(h.sends()[1]!.body).toContain('(note)');
    expect(h.sends()[1]!.requestId).not.toBe(h.sends()[0]!.requestId);
    expect(relay.state.batches).toEqual({});
  });

  it('a restart inside the window catches up once, per ticket, within the rate limit', async () => {
    const h = await harness();
    for (let i = 1; i <= 3; i += 1) h.docket.runs.set(`GF-${i}`, [lead({ dispatch: 'ctx_live' })]);
    const first = await started(h);
    h.docket.push({ ...ACCEPTANCE, item_id: 'GF-1' }, h.clock.t);
    await h.step(first);
    expect(h.sends()).toHaveLength(0);

    h.clock.t += 23 * HOUR;
    h.docket.push({ ...NOTE, item_id: 'GF-1' }, h.clock.t - HOUR);
    h.docket.push({ ...ANSWER, item_id: 'GF-1' }, h.clock.t - MINUTE);
    h.docket.push({ ...ANSWER, item_id: 'GF-2' }, h.clock.t - MINUTE);
    h.docket.push({ ...ANSWER, item_id: 'GF-3' }, h.clock.t - MINUTE);

    const second = h.make({ rateLimit: 2 });
    await h.step(second);
    expect(second.state.hold).toBeNull();
    expect(h.sends()).toHaveLength(2);
    expect(h.sends()[0]!.body).toContain('GF-1 was updated');
    expect(h.sends()[0]!.body).toContain('(answer, note, acceptance)');

    h.clock.t += 10 * MINUTE;
    await h.step(second);
    expect(h.sends()).toHaveLength(3);

    const third = h.make({ rateLimit: 2 });
    h.clock.t += HOUR;
    await h.step(third);
    expect(h.sends()).toHaveLength(3);
    expect(third.state.batches).toEqual({});
  });

  it('coalesces a catch-up that spans several pages into one message', async () => {
    const h = await harness();
    const first = await started(h);
    h.clock.t += HOUR;
    h.docket.push(ANSWER, h.clock.t);
    for (let i = 0; i < 250; i += 1) {
      h.docket.push({ type: 'plan.updated', actor: 'codex' }, h.clock.t);
    }
    h.docket.push(NOTE, h.clock.t);
    expect(first).toBeDefined();

    const second = h.make();
    await second.pollOnce(undefined, 0);
    await second.flushDue();
    expect(h.sends()).toHaveLength(0);
    await h.step(second);
    expect(h.sends()).toHaveLength(1);
    expect(h.sends()[0]!.body).toContain('(answer, note)');
  });

  it('delivers an event whose time cannot be read, rather than dropping it', async () => {
    const h = await harness();
    const relay = await started(h);
    const row = h.docket.push(ANSWER, h.clock.t);
    row.at = 'not-a-time';
    await h.step(relay);
    expect(h.sends()).toHaveLength(1);
  });

  it('reads a long backlog page by page', async () => {
    const h = await harness();
    const relay = await started(h);
    for (let i = 0; i < 450; i += 1)
      h.docket.push({ type: 'plan.updated', actor: 'codex' }, h.clock.t);
    h.docket.push(ANSWER, h.clock.t);
    await relay.pollOnce(undefined, 0);
    expect(relay.state.cursor).toBe('200');
    await relay.pollOnce(undefined, 0);
    await h.step(relay);
    expect(relay.state.cursor).toBe('451');
    expect(h.sends()).toHaveLength(1);
  });

  it('leaves no temp file behind', async () => {
    const h = await harness();
    const relay = await started(h);
    h.docket.push(ANSWER, h.clock.t);
    await h.step(relay);
    expect(readdirSync(h.home).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('survives being started before Docket, and Docket going down and back', async () => {
    const h = await harness();
    await h.docket.stop();
    const relay = createRelay({
      docket: createDocket({ baseUrl: h.docket.url }),
      orca: createOrca({ exe: fakeExe, env: h.env }),
      store: openStore(h.home),
      options: { backoffMinMs: 10, backoffMaxMs: 40, tickMs: 10, pollTimeoutS: 1 },
    }) as Relay;
    const controller = new AbortController();
    const running = relay.run(controller.signal);
    cleanups.push(async () => {
      controller.abort();
      await running;
    });

    await until(() => openStoreCursor(h.home) === null && relay.state.counters !== undefined);
    await h.docket.start();
    await until(() => relay.state.cursor !== null);

    h.docket.push(ANSWER, Date.now());
    await until(() => h.sends().length === 1);

    await h.docket.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await h.docket.start();
    h.docket.push(NOTE, Date.now());
    h.docket.push(ANSWER, Date.now());
    await until(() => h.sends().length === 2);
    expect(h.sends()[1]!.body).toContain('(answer, note)');
  }, 20_000);
});

const openStoreCursor = (home: string): string | null => {
  try {
    return (JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')) as { cursor: string | null })
      .cursor;
  } catch {
    return null;
  }
};

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the condition.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('running it', () => {
  const cli = (h: Harness, args: string[]) =>
    spawn(process.execPath, [join(TOOL, 'docket-relay.mjs'), ...args], {
      env: {
        ...h.env,
        DOCKET_RELAY_HOME: h.home,
        DOCKET_RELAY_URL: h.docket.url,
        DOCKET_RELAY_ORCA: fakeExe,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  const finish = (child: ChildProcess) =>
    new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      let out = '';
      let err = '';
      child.stdout?.on('data', (chunk) => (out += String(chunk)));
      child.stderr?.on('data', (chunk) => (err += String(chunk)));
      child.once('close', (code) => resolve({ code, out, err }));
    });

  it('runs one instance, reports status with no content, and frees the lock', async () => {
    const h = await harness();
    const first = cli(h, ['start']);
    const firstDone = finish(first);
    cleanups.push(async () => {
      first.kill();
      await firstDone;
    });
    await until(() => openStoreCursor(h.home) !== null, 15_000);

    const second = await finish(cli(h, ['start']));
    expect(second.code).toBe(2);
    expect(second.err).toContain('already running');

    h.docket.push(ANSWER, Date.now());
    await until(() => h.sends().length === 1, 15_000);
    await until(() =>
      readFileSync(join(h.home, 'state.json'), 'utf8').includes('last_delivery":{'),
    );

    const text = await finish(cli(h, ['status']));
    expect(text.code).toBe(0);
    expect(text.out).toContain('docket-relay: running');
    expect(text.out).toContain('GF-243 to run:run_coord (answer)');
    expect(text.out).not.toContain(SECRET);

    const json = await finish(cli(h, ['status', '--json']));
    expect(JSON.parse(json.out)).toMatchObject({ running: true, counters: { delivered: 1 } });

    first.kill();
    await firstDone;
    const after = await finish(cli(h, ['status']));
    expect(after.out).toContain('docket-relay: stopped');
    expect(h.files()).not.toContain(SECRET);
  }, 40_000);

  it('the lock can be taken again once released', async () => {
    const home = mkdtempSync(join(base, 'lock-'));
    const release = await acquireLock(home);
    expect(release).toBeTypeOf('function');
    expect(await acquireLock(home)).toBeNull();
    await release();
    const again = await acquireLock(home);
    expect(again).toBeTypeOf('function');
    await again();
  });

  /** A state file for a relay that stopped `ageMs` ago at the end of the feed. */
  const stoppedState = (h: Harness, ageMs: number) => {
    const last = h.docket.rows.at(-1);
    mkdirSync(h.home, { recursive: true });
    writeFileSync(
      join(h.home, 'state.json'),
      JSON.stringify({
        version: 1,
        cursor: String(h.docket.rows.length),
        anchor: last ? { cursor: last.cursor, at: last.at } : null,
        active_at: Date.now() - ageMs,
        hold: null,
        reconciles: [],
        seen: {},
        batches: {},
        rate: {},
        undelivered: [],
        counters: {},
        docket: { connected: false, at: null, error: null },
        last_event: null,
        last_delivery: null,
        last_failure: null,
      }),
    );
  };
  const savedState = (h: Harness) =>
    JSON.parse(readFileSync(join(h.home, 'state.json'), 'utf8')) as Relay['state'];

  it('start exits clearly in a hold, and status shows the count and range only', async () => {
    const h = await harness();
    stoppedState(h, 2 * DAY);
    const firstAt = Date.now() - DAY;
    const lastAt = Date.now() - HOUR;
    h.docket.push(ANSWER, firstAt);
    h.docket.push(NOTE, lastAt);

    const run = await finish(cli(h, ['start']));
    expect(run.code).toBe(3);
    expect(run.err).toContain('hold_reconcile (stale)');
    expect(run.err).toContain('reconcile --deliver');
    expect(h.calls()).toEqual([]);
    expect(savedState(h).cursor).toBe('0');

    const text = await finish(cli(h, ['status']));
    expect(text.code).toBe(0);
    expect(text.out).toContain('HOLD: hold_reconcile (stale)');
    expect(text.out).toContain(
      `waiting: 2 event(s) on 1 ticket(s), from ${new Date(firstAt).toISOString()} to ${new Date(lastAt).toISOString()}`,
    );
    expect(text.out).not.toContain(SECRET);

    const json = JSON.parse((await finish(cli(h, ['status', '--json']))).out) as {
      hold: { reason: string; waiting: Record<string, unknown> };
    };
    expect(json.hold).toMatchObject({
      state: 'hold_reconcile',
      reason: 'stale',
      waiting: { events: 2, tickets: 1, complete: true },
    });
    expect(JSON.stringify(json)).not.toContain(SECRET);
    expect(savedState(h).cursor).toBe('0');
  }, 30_000);

  it('status says when Docket cannot be counted, and when the state is unreadable', async () => {
    const h = await harness();
    stoppedState(h, 2 * DAY);
    await finish(cli(h, ['start']));
    await h.docket.stop();
    const down = await finish(cli(h, ['status']));
    expect(down.out).toContain('waiting: at least 0 event(s)');

    writeFileSync(join(h.home, 'state.json'), '{not json');
    const broken = await finish(cli(h, ['status']));
    expect(broken.out).toContain('HOLD: hold_reconcile (state_unreadable)');
    // Status is read-only, so the damaged file is still there for the next start.
    expect(readFileSync(join(h.home, 'state.json'), 'utf8')).toBe('{not json');
  }, 30_000);

  it('reconcile --deliver through the CLI, then start sends it', async () => {
    const h = await harness();
    stoppedState(h, 2 * DAY);
    h.docket.push(ANSWER, Date.now() - HOUR);
    expect((await finish(cli(h, ['start']))).code).toBe(3);

    const left = await finish(cli(h, ['reconcile', '--deliver']));
    expect(left.code).toBe(0);
    expect(left.out).toContain('1 event(s) on 1 ticket(s) are queued');
    expect(h.calls()).toEqual([]);

    const child = cli(h, ['start']);
    const done = finish(child);
    cleanups.push(async () => {
      child.kill();
      await done;
    });
    await until(() => h.sends().length === 1, 15_000);
    expect(h.sends()[0]!.to).toBe('run:run_coord');
  }, 40_000);

  it('reconcile --skip-to-end through the CLI, and its refusals', async () => {
    const h = await harness();
    stoppedState(h, 2 * DAY);
    h.docket.push(ANSWER, Date.now() - HOUR);
    await finish(cli(h, ['start']));

    for (const bad of [
      ['reconcile'],
      ['reconcile', '--deliver', '--skip-to-end'],
      ['reconcile', '--deliver', '--reason', 'x'],
      ['reconcile', '--skip-to-end', '--force'],
    ]) {
      expect((await finish(cli(h, bad))).code).toBe(1);
    }
    expect((await finish(cli(h, ['reconcile', '--skip-to-end']))).code).toBe(1);
    expect(savedState(h).hold?.reason).toBe('stale');

    const left = await finish(
      cli(h, ['reconcile', '--skip-to-end', '--reason', 'Owner read the backlog']),
    );
    expect(left.code).toBe(0);
    expect(left.out).toContain('Skipped 1 event(s) on 1 ticket(s)');
    expect(savedState(h)).toMatchObject({ hold: null, cursor: '1' });
    expect(h.calls()).toEqual([]);
    const log = readFileSync(join(h.home, 'relay.log'), 'utf8');
    expect(log).toMatch(/reconcile_skip audit_id=\S+ reason=Owner read the backlog/);
    expect(log).not.toContain(SECRET);
  }, 40_000);

  it('reconcile refuses while the relay is running', async () => {
    const h = await harness();
    const child = cli(h, ['start']);
    const done = finish(child);
    cleanups.push(async () => {
      child.kill();
      await done;
    });
    await until(() => openStoreCursor(h.home) !== null, 15_000);
    const refused = await finish(cli(h, ['reconcile', '--deliver']));
    expect(refused.code).toBe(2);
    expect(refused.err).toContain('Stop it first');
  }, 30_000);

  it('a hard kill mid-send resends the same message once on restart', async () => {
    const h = await harness();
    const release = join(h.home, '..', 'release-send');
    const working = currentPlan(h);
    h.plan({ ...working, blockSendUntil: release });
    const first = cli(h, ['start']);
    const firstDone = finish(first);
    cleanups.push(async () => {
      writeFileSync(release, '');
      first.kill('SIGKILL');
      await firstDone;
    });
    await until(() => openStoreCursor(h.home) !== null, 15_000);
    h.docket.push(ANSWER, Date.now());
    await until(() => h.sends().length === 1, 15_000);

    first.kill('SIGKILL');
    await firstDone;
    const cut = savedState(h).batches['GF-243'] as { in_flight?: { keys: string[] } };
    expect(cut.in_flight?.keys).toHaveLength(1);
    // Only which events were in flight is stored: never a recipient or text.
    expect(JSON.stringify(cut)).not.toContain('run:run_coord');
    expect(JSON.stringify(cut)).not.toContain('from the owner side');
    writeFileSync(release, '');
    h.plan(working);

    const second = cli(h, ['start']);
    const secondDone = finish(second);
    cleanups.push(async () => {
      second.kill();
      await secondDone;
    });
    await until(() => h.sends().length === 2, 15_000);
    await until(() => Object.keys(savedState(h).batches).length === 0, 15_000);
    expect(h.sends()[1]).toMatchObject({
      to: h.sends()[0]!.to,
      body: h.sends()[0]!.body,
      requestId: h.sends()[0]!.requestId,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(h.sends()).toHaveLength(2);
  }, 60_000);

  it('test-send goes to the Run named, with no other check', async () => {
    const h = await harness();
    h.plan({ runs: {} });
    const sent = await finish(cli(h, ['test-send', 'run:run_anything']));
    expect(sent.code).toBe(0);
    expect(h.sends()).toMatchObject([{ to: 'run:run_anything', subject: 'Docket relay test' }]);
    expect(h.calls()).toHaveLength(1);
    expect(h.calls()[0]!.orcaEnv).toEqual([]);
  });

  it.each([
    '--to=x',
    'run:bad id',
    'dispatch:ctx_live',
    'DISPATCH:ctx_live',
    'run:dispatch:ctx_live',
    'orca_session_id:abc-1',
  ])('test-send refuses %s without calling Orca', async (address) => {
    const h = await harness();
    const refused = await finish(cli(h, ['test-send', address]));
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('Any other address is refused');
    expect(h.calls()).toEqual([]);
  });

  it('records who it is at start, and forgets it on a clean exit', async () => {
    const h = await harness();
    const before = Date.now();
    const child = cli(h, ['start']);
    const done = finish(child);
    cleanups.push(async () => {
      child.kill();
      await done;
    });
    await until(() => openStoreCursor(h.home) !== null, 15_000);
    const instance = JSON.parse(readFileSync(join(h.home, 'instance.json'), 'utf8')) as {
      pid: number;
      started_ms: number;
      exe: string;
      script: string;
    };
    expect(instance.pid).toBe(child.pid);
    expect(instance.exe).toBe(process.execPath);
    expect(instance.script).toBe(join(TOOL, 'docket-relay.mjs'));
    expect(Math.abs(instance.started_ms - before)).toBeLessThan(30_000);

    const stopped = await finish(cli(h, ['stop']));
    expect(stopped.code).toBe(0);
    expect(stopped.out).toContain('docket-relay stopped');
    expect((await done).code).toBe(0);
    expect(existsSync(join(h.home, 'instance.json'))).toBe(false);
    expect((await finish(cli(h, ['status']))).out).toContain('docket-relay: stopped');
    expect((await finish(cli(h, ['stop']))).out).toContain('not running');
  }, 40_000);

  it('stop waits for the send in flight and records its result', async () => {
    const h = await harness();
    const release = join(h.home, '..', 'release-stop');
    h.plan({ ...currentPlan(h), blockSendUntil: release });
    const child = cli(h, ['start']);
    const done = finish(child);
    cleanups.push(async () => {
      writeFileSync(release, '');
      child.kill();
      await done;
    });
    await until(() => openStoreCursor(h.home) !== null, 15_000);
    h.docket.push(ANSWER, Date.now());
    await until(() => h.sends().length === 1, 15_000);

    const stopping = finish(cli(h, ['stop']));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(child.exitCode).toBeNull();
    writeFileSync(release, '');
    expect((await stopping).code).toBe(0);
    expect((await done).code).toBe(0);
    const state = savedState(h);
    expect(state.counters.delivered).toBe(1);
    expect(state.batches).toEqual({});
    expect(h.sends()).toHaveLength(1);
  }, 45_000);

  it('stop needs the token the instance recorded', async () => {
    const h = await harness();
    const child = cli(h, ['start']);
    const done = finish(child);
    cleanups.push(async () => {
      child.kill();
      await done;
    });
    await until(() => openStoreCursor(h.home) !== null, 15_000);
    const path = join(h.home, 'instance.json');
    const real = readFileSync(path, 'utf8');
    writeFileSync(path, JSON.stringify({ ...JSON.parse(real), stop_token: 'wrong-token' }));
    expect(await requestStop(h.home)).toBe('refused');
    expect((await finish(cli(h, ['stop']))).code).toBe(1);
    expect(child.exitCode).toBeNull();
    writeFileSync(path, real);
    expect(await requestStop(h.home)).toBe('stopping');
    expect((await done).code).toBe(0);
  }, 40_000);

  describe.runIf(hasPowerShell || process.env.CI)('the launcher and task steps', () => {
    const launch = (h: Harness, node: string = process.execPath) =>
      spawn(
        POWERSHELL,
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(TOOL, 'launch.ps1'),
          '-Node',
          node,
        ],
        {
          env: {
            ...h.env,
            DOCKET_RELAY_HOME: h.home,
            DOCKET_RELAY_URL: h.docket.url,
            DOCKET_RELAY_ORCA: fakeExe,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );

    it('returns the exit code of a relay in a hold', async () => {
      const h = await harness();
      stoppedState(h, 2 * DAY);
      expect((await finish(launch(h))).code).toBe(3);
      expect(h.calls()).toEqual([]);
    }, 40_000);

    it('returns 0 after a graceful stop', async () => {
      const h = await harness();
      const child = launch(h);
      const done = finish(child);
      cleanups.push(async () => {
        child.kill();
        await done;
      });
      await until(() => openStoreCursor(h.home) !== null, 20_000);
      expect((await finish(cli(h, ['stop']))).code).toBe(0);
      expect((await done).code).toBe(0);
    }, 45_000);

    it('fails when Node cannot be run', async () => {
      const h = await harness();
      expect((await finish(launch(h, join(base, 'no-such-node')))).code).toBe(1);
    }, 30_000);

    interface Proc {
      Name: string;
      ProcessId: number;
      ExecutablePath: string | null;
      CommandLine: string | null;
      creation_ms: number | null;
    }
    interface Scenario {
      tasks?: { TaskName: string; TaskPath: string; State: string }[];
      processes?: Proc[];
      taskReadFails?: boolean;
      processReadFails?: boolean;
      exitAfterSleeps?: number;
      removeFails?: boolean;
    }

    const TASK = 'Docket Relay Test Harness';
    const RELAY_PID = 4242;
    const NODE_EXE = 'C:\\Program Files\\nodejs\\node.exe';
    const task = (State: string) => [{ TaskName: TASK, TaskPath: '\\', State }];
    const FORBIDDEN = ['Stop-Process', 'Stop-ScheduledTask'];

    function managed() {
      const dir = mkdtempSync(join(base, 'm-'));
      const local = join(dir, 'local');
      const root = join(local, 'docket-relay');
      const app = join(root, 'app');
      const relayPath = join(app, 'docket-relay.mjs');
      mkdirSync(local);
      const callsPath = join(dir, 'calls.log');
      const run = async (action: string, scenario: Scenario, want = 'Stopped') => {
        const scenarioPath = join(dir, 'scenario.json');
        writeFileSync(
          scenarioPath,
          JSON.stringify({ tasks: [], processes: [], ...scenario }, null, 1),
        );
        const child = spawn(
          POWERSHELL,
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            join(ROOT, 'server', 'tests', 'fixtures', 'docket-relay-manage-harness.ps1'),
            '-Do',
            action,
            '-Want',
            want,
          ],
          {
            env: {
              ...process.env,
              NODE_OPTIONS: '',
              LOCALAPPDATA: local,
              MANAGE_SCENARIO: scenarioPath,
              MANAGE_CALLS: callsPath,
              MANAGE_SCRIPT: join(TOOL, 'manage.ps1'),
              MANAGE_NODE: process.execPath,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        return finish(child);
      };
      const calls = () => (existsSync(callsPath) ? readFileSync(callsPath, 'utf8') : '');
      /** The record a running relay leaves in its state folder. */
      const record = () => {
        mkdirSync(root, { recursive: true });
        writeFileSync(
          join(root, 'instance.json'),
          JSON.stringify({
            pid: RELAY_PID,
            started_ms: START,
            exe: NODE_EXE,
            script: relayPath,
            stop_token: 't',
          }),
        );
      };
      const relay = (over: Partial<Proc> = {}): Proc => ({
        Name: 'node.exe',
        ProcessId: RELAY_PID,
        ExecutablePath: NODE_EXE,
        CommandLine: `"${NODE_EXE}" "${relayPath}" start`,
        creation_ms: START,
        ...over,
      });
      /** A stand-in for the installed CLI: `stop` exits with the given code. */
      const installed = (stopCode = 0) => {
        mkdirSync(app, { recursive: true });
        writeFileSync(
          relayPath,
          `const c = process.argv[2];
process.exit(c === 'stop' ? ${stopCode} : 0);
`,
        );
      };
      const noKills = () => {
        for (const name of FORBIDDEN) expect(calls()).not.toContain(name);
      };
      return { local, root, app, relayPath, run, calls, record, relay, installed, noKills };
    }

    it('never kills a process and never deletes recursively', () => {
      const text = readFileSync(join(TOOL, 'manage.ps1'), 'utf8');
      expect(text).not.toMatch(/Stop-Process|Stop-ScheduledTask|taskkill|\.Kill\(/i);
      expect(text).not.toMatch(/-Recurse/);
      expect(text).not.toMatch(/orca\.exe'|\$isOrca/);
      expect(text).not.toMatch(/-Force\b.*\[switch\]|\[switch\]\$Force/);
    });

    it('lists every file it installs and removes', () => {
      const text = readFileSync(join(TOOL, 'manage.ps1'), 'utf8');
      for (const name of readdirSync(join(TOOL, 'lib'))) expect(text).toContain(`'${name}'`);
      for (const name of readdirSync(TOOL).filter((entry) => entry !== 'lib')) {
        expect(text).toContain(`'${name}'`);
      }
    });

    it('proves stopped when the recorded relay is gone', async () => {
      const m = managed();
      m.record();
      const result = await m.run('Verify', { tasks: task('Ready') });
      expect(result.out).toContain('PROVEN');
      expect(result.code).toBe(0);
    }, 30_000);

    it.each<[string, Partial<Proc>]>([
      ['a reused PID, by start time', { creation_ms: START + 10 * MINUTE }],
      ['another executable', { ExecutablePath: 'C:\\other\\node.exe' }],
      ['another script', { CommandLine: `"${NODE_EXE}" "C:\\other\\docket-relay.mjs" start` }],
      ['a process it cannot read', { ExecutablePath: null, CommandLine: null, creation_ms: null }],
    ])(
      'is not blocked by %s at the recorded PID',
      async (_name, over) => {
        const m = managed();
        m.record();
        const result = await m.run('Verify', { tasks: task('Ready'), processes: [m.relay(over)] });
        expect(result.out).toContain('PROVEN');
        expect(result.code).toBe(0);
      },
      30_000,
    );

    it('ignores every other process, even with the relay path in its command line', async () => {
      const m = managed();
      m.record();
      const result = await m.run('Verify', {
        tasks: task('Ready'),
        processes: [
          m.relay({ ProcessId: 10 }),
          m.relay({ ProcessId: 11, Name: 'powershell.exe' }),
          m.relay({
            ProcessId: 12,
            Name: 'orca.exe',
            CommandLine: 'orca orchestration send --to run:run_a --from docket-relay',
          }),
          m.relay({ ProcessId: 13, CommandLine: null }),
        ],
      });
      expect(result.out).toContain('PROVEN');
      expect(result.code).toBe(0);
    }, 30_000);

    it('a recorded relay still running is a failed proof', async () => {
      const m = managed();
      m.record();
      const result = await m.run('Verify', { tasks: task('Ready'), processes: [m.relay()] });
      expect(result.code).toBe(1);
      expect(result.out).toContain(`FAILED: the relay is still running (PID ${RELAY_PID})`);
    }, 30_000);

    it.each([
      ['Stopped', 'Running', 'the task is Running'],
      ['Disabled', 'Ready', 'the task is Ready'],
      ['Removed', 'Disabled', 'the task still exists'],
    ])(
      'expecting %s with the task %s fails',
      async (want, state, text) => {
        const m = managed();
        const result = await m.run('Verify', { tasks: task(state) }, want);
        expect(result.code).toBe(1);
        expect(result.out).toContain(text);
      },
      30_000,
    );

    it('being unable to read the task or the recorded process is a failed proof', async () => {
      const m = managed();
      expect((await m.run('Verify', { taskReadFails: true })).code).toBe(1);
      m.record();
      const noProcesses = await m.run('Verify', { processReadFails: true });
      expect(noProcesses.code).toBe(1);
      expect(noProcesses.out).toContain('could not check the relay');
    }, 30_000);

    it('Stop asks over the pipe, waits for the PID and the child timeout, and kills nothing', async () => {
      const m = managed();
      m.installed();
      m.record();
      const result = await m.run('Stop', {
        tasks: task('Running'),
        processes: [m.relay()],
        exitAfterSleeps: 2,
      });
      expect(result.out).toContain('PROVEN');
      expect(result.code).toBe(0);
      expect(m.calls()).toContain('Start-Sleep -Seconds 20');
      m.noKills();
    }, 30_000);

    it('Stop reports a relay that does not exit, and changes nothing else', async () => {
      const m = managed();
      m.installed();
      m.record();
      const result = await m.run('Stop', { tasks: task('Running'), processes: [m.relay()] });
      expect(result.code).toBe(1);
      expect(result.out).toContain('did not exit in time');
      expect(m.calls()).not.toContain('Disable-ScheduledTask');
      expect(m.calls()).not.toContain('Unregister-ScheduledTask');
      m.noKills();
    }, 60_000);

    it('Stop reports a refused pipe command, and changes nothing else', async () => {
      const m = managed();
      m.installed(1);
      m.record();
      const result = await m.run('Disable', { tasks: task('Running'), processes: [m.relay()] });
      expect(result.code).toBe(1);
      expect(result.out).toContain('the relay did not stop');
      expect(m.calls()).not.toContain('Disable-ScheduledTask');
      m.noKills();
    }, 30_000);

    it('Disable stops first, then disables and proves it', async () => {
      const m = managed();
      m.installed();
      m.record();
      const result = await m.run('Disable', {
        tasks: task('Running'),
        processes: [m.relay()],
        exitAfterSleeps: 1,
      });
      expect(result.out).toContain('PROVEN: task Disabled');
      expect(result.code).toBe(0);
      expect(m.calls().indexOf('Start-Sleep -Seconds 20')).toBeLessThan(
        m.calls().indexOf('Disable-ScheduledTask'),
      );
      m.noKills();
    }, 30_000);

    it('Install runs the hidden launcher, unelevated and interactive, and does not start', async () => {
      const m = managed();
      const result = await m.run('Install', {});
      expect(result.code).toBe(0);
      expect(existsSync(m.relayPath)).toBe(true);
      expect(existsSync(join(m.app, 'launch.ps1'))).toBe(true);
      const help = spawn(process.execPath, [m.relayPath, 'help'], {
        env: { ...process.env, NODE_OPTIONS: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect((await finish(help)).code).toBe(0);
      const calls = m.calls();
      expect(calls).not.toMatch(/conhost/i);
      expect(calls).toMatch(
        /New-ScheduledTaskAction -Execute \S*powershell\.exe -Argument -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "[^"]*launch\.ps1" -Node "/,
      );
      expect(calls).toContain('-LogonType Interactive -RunLevel Limited');
      expect(calls).toContain('Register-ScheduledTask');
      expect(calls).not.toContain('Start-ScheduledTask');
    }, 40_000);

    it('Install can update a plain earlier install', async () => {
      const m = managed();
      expect((await m.run('Install', {})).code).toBe(0);
      const again = await m.run('Install', {});
      expect(again.out).toContain('Installed to');
      expect(again.code).toBe(0);
    }, 40_000);

    /** Every entry under `dir`, without following a link. */
    const snapshot = (dir: string): string[] =>
      readdirSync(dir)
        .sort()
        .flatMap((name) => {
          const path = join(dir, name);
          const info = lstatSync(path);
          if (info.isSymbolicLink()) return [`${path} -> ${readlinkSync(path)}`];
          if (info.isDirectory()) return [`${path}/`, ...snapshot(path)];
          return [`${path}: ${readFileSync(path, 'utf8')}`];
        });

    const INSTALL_TARGETS: [string, string, boolean][] = [
      ['the root folder', '', true],
      ['the app folder', 'app', true],
      ['the lib folder', join('app', 'lib'), true],
      ...readdirSync(TOOL)
        .filter((name) => name !== 'lib')
        .map((name): [string, string, boolean] => [`app file ${name}`, join('app', name), false]),
      ...readdirSync(join(TOOL, 'lib')).map((name): [string, string, boolean] => [
        `lib file ${name}`,
        join('app', 'lib', name),
        false,
      ]),
    ];

    const expectInstallRefused = async (m: ReturnType<typeof managed>, path: string) => {
      // Windows PowerShell keeps its own cache under LOCALAPPDATA.
      const relayEntries = () =>
        snapshot(m.local).filter((entry) => !entry.startsWith(join(m.local, 'Microsoft')));
      const before = relayEntries();
      const result = await m.run('Install', {});
      expect(result.code).toBe(1);
      expect(result.out).toContain('Install changed nothing');
      expect(result.out).toContain(path);
      expect(relayEntries()).toEqual(before);
      expect(m.calls()).not.toContain('Register-ScheduledTask');
    };

    it.each(INSTALL_TARGETS)(
      'Install refuses a link at %s',
      async (_name, where, isFolder) => {
        const m = managed();
        const outside = join(m.local, 'outside');
        const keep = join(outside, 'keep.txt');
        mkdirSync(outside);
        writeFileSync(keep, 'keep');
        const path = join(m.root, where);
        mkdirSync(dirname(path), { recursive: true });
        if (isFolder) symlinkSync(outside, path, 'junction');
        else symlinkSync(keep, path, process.platform === 'win32' ? 'junction' : 'file');
        await expectInstallRefused(m, path);
        expect(readFileSync(keep, 'utf8')).toBe('keep');
      },
      30_000,
    );

    it.each(INSTALL_TARGETS)(
      'Install refuses the wrong type at %s',
      async (_name, where, isFolder) => {
        const m = managed();
        const path = join(m.root, where);
        mkdirSync(dirname(path), { recursive: true });
        if (isFolder) writeFileSync(path, 'keep');
        else mkdirSync(path);
        await expectInstallRefused(m, path);
      },
      30_000,
    );

    it('Remove deletes only the known files, then the empty folders', async () => {
      const m = managed();
      expect((await m.run('Install', {})).code).toBe(0);
      for (const name of [
        'state.json',
        'relay.log',
        'relay.log.1',
        'reconcile-audit.jsonl',
        'state.json.corrupt-123',
        'state.json.99.tmp',
      ]) {
        writeFileSync(join(m.root, name), '{}');
      }
      const neighbour = join(m.local, 'docket-relay-other');
      mkdirSync(neighbour);
      writeFileSync(join(neighbour, 'keep.txt'), 'keep');

      const result = await m.run('Remove', { tasks: task('Ready') });
      expect(result.out).toContain('PROVEN: removed the task');
      expect(result.code).toBe(0);
      expect(m.calls()).toContain('Unregister-ScheduledTask');
      expect(existsSync(m.root)).toBe(false);
      expect(readFileSync(join(neighbour, 'keep.txt'), 'utf8')).toBe('keep');
    }, 45_000);

    it('Remove removes nothing while the recorded relay runs', async () => {
      const m = managed();
      m.installed();
      m.record();
      const result = await m.run('Remove', { tasks: task('Ready'), processes: [m.relay()] });
      expect(result.code).toBe(1);
      expect(result.out).toContain('nothing was removed');
      expect(m.calls()).not.toContain('Unregister-ScheduledTask');
      expect(existsSync(m.relayPath)).toBe(true);
    }, 60_000);

    it.each<[string, (m: ReturnType<typeof managed>) => string]>([
      [
        'an unexpected file',
        (m) => {
          const path = join(m.app, 'notes.txt');
          writeFileSync(path, 'keep');
          return path;
        },
      ],
      [
        'an unexpected folder',
        (m) => {
          const path = join(m.root, 'backup');
          mkdirSync(path);
          writeFileSync(join(path, 'keep.txt'), 'keep');
          return path;
        },
      ],
      [
        'a link in the app folder',
        (m) => {
          const target = join(m.local, 'elsewhere');
          mkdirSync(target);
          writeFileSync(join(target, 'keep.txt'), 'keep');
          const path = join(m.app, 'lib');
          symlinkSync(target, path, 'junction');
          return path;
        },
      ],
    ])(
      'Remove stops at %s and deletes no file',
      async (_name, plant) => {
        const m = managed();
        m.installed();
        writeFileSync(join(m.root, 'state.json'), '{}');
        const path = plant(m);
        const result = await m.run('Remove', { tasks: task('Ready') });
        expect(result.code).toBe(1);
        expect(result.out).toContain('not known relay files');
        expect(result.out).toContain(path);
        expect(existsSync(path)).toBe(true);
        expect(existsSync(join(m.root, 'state.json'))).toBe(true);
        expect(existsSync(m.relayPath)).toBe(true);
      },
      40_000,
    );

    it('Remove will not follow a link at the folder', async () => {
      const m = managed();
      const target = join(m.local, 'elsewhere');
      mkdirSync(target);
      writeFileSync(join(target, 'keep.txt'), 'keep');
      symlinkSync(target, m.root, 'junction');
      const result = await m.run('Remove', { tasks: task('Ready') });
      expect(result.code).toBe(1);
      expect(result.out).toContain('not known relay files');
      expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('keep');
    }, 40_000);

    it('Remove reports what it could not delete', async () => {
      const m = managed();
      m.installed();
      writeFileSync(join(m.root, 'state.json'), '{}');
      const result = await m.run('Remove', { tasks: task('Ready'), removeFails: true });
      expect(result.code).toBe(1);
      expect(result.out).toContain('could not remove');
      expect(result.out).toContain('state.json');
    }, 40_000);
  });

  it('prints help and refuses an unknown command', async () => {
    const h = await harness();
    expect((await finish(cli(h, ['help']))).out).toContain('docket-relay');
    expect((await finish(cli(h, ['nope']))).code).toBe(1);
  });
});

describe('calling Orca safely', () => {
  it('requires a full settled worker receipt with absent terminal and resource', async () => {
    const h = await harness();
    h.plan({
      dispatches: {
        ctx_old: {
          status: 'completed',
          runId: 'run_8cc91a814db8',
          revoked: '2026-11-27T05:02:39Z',
          workerState: 'succeeded',
          worktreeId: '48ca27d0-4847-4d2e-a2e5-6c6c74a2133e::C:/exact/worktree',
        },
      },
    });
    const receipt = await createOrca({ exe: fakeExe, env: h.env }).showDispatch('ctx_old');
    expect(receipt).toMatchObject({
      found: true,
      resourceState: 'absent',
      terminalAbsent: true,
      terminalResourceAbsent: true,
      capabilityRevokedAt: '2026-11-27T05:02:39Z',
    });
  });

  it('routes a stable wake request to the real Run coordinator without claiming worker-start authority', async () => {
    const h = await harness();
    const orca = createOrca({ exe: fakeExe, env: h.env });
    const id = requestIdFor('continuation', 'due-key');
    expect(
      await orca.send({
        to: 'run:run_8cc91a814db8',
        subject: 'Due wake',
        body: 'Bounded Docket wake',
        requestId: id,
      }),
    ).toEqual({ ok: true });
    expect(h.calls().some((entry) => entry.args[0] === 'worker-start')).toBe(false);
    const call = h.calls().find((entry) => entry.args[0] === 'send')!;
    expect(call.args).toContain('--retry-request');
    expect(call.args[call.args.indexOf('--retry-request') + 1]).toBe(id);
    expect(call.args[call.args.indexOf('--to') + 1]).toBe('run:run_8cc91a814db8');
    expect(call.orcaEnv).toEqual([]);
  });

  it('passes awkward text as one argument, with no shell', async () => {
    const h = await harness();
    const orca = createOrca({ exe: fakeExe, env: h.env });
    const body = `a "quoted" & b | c > d ^e %PATH% $(whoami) \`x\` 'y' (z) ; é`;
    expect(
      (await orca.send({ to: 'run:run_x', subject: 'S & T', body, requestId: requestIdFor('x') }))
        .ok,
    ).toBe(true);
    expect(h.sends()[0]).toMatchObject({ to: 'run:run_x', subject: 'S & T', body });
  });

  it('runs the CLI without the session identity of whoever started the relay', async () => {
    const h = await harness();
    const relay = await started(h);
    h.docket.push(ANSWER, h.clock.t);
    await h.step(relay);
    expect(h.calls().length).toBeGreaterThan(0);
    for (const call of h.calls()) expect(call.orcaEnv).toEqual([]);
    expect(Object.keys(childEnv({ ORCA_PANE_KEY: 'x', orca_other: 'y', PATH: 'p' }))).toEqual([
      'PATH',
    ]);
  });

  it('makes stable request IDs in the form Orca accepts', () => {
    const id = requestIdFor('batch', 'run:run_b');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(requestIdFor('batch', 'run:run_b')).toBe(id);
    expect(requestIdFor('batch', 'run:run_a')).not.toBe(id);
  });

  it('never picks orca.cmd on Windows, which refuses to send', () => {
    const dir = mkdtempSync(join(base, 'path-'));
    writeFileSync(join(dir, 'orca.cmd'), '@echo off');
    expect(findOrca({ PATH: dir }, 'win32')).toBeNull();
    writeFileSync(join(dir, 'orca.exe'), '');
    expect(findOrca({ PATH: dir }, 'win32')).toBe(join(dir, 'orca.exe'));
  });

  it('uses an explicit path, and only if it exists', () => {
    expect(findOrca({ DOCKET_RELAY_ORCA: fakeExe, PATH: '' })).toBe(fakeExe);
    expect(findOrca({ DOCKET_RELAY_ORCA: join(base, 'missing'), PATH: '' })).toBeNull();
  });

  it('reports a missing CLI as something to retry', async () => {
    const orca = createOrca({ exe: null, env: {} });
    expect(
      await orca.send({ to: 'run:run_x', subject: 's', body: 'b', requestId: requestIdFor('m') }),
    ).toMatchObject({
      ok: false,
      code: 'spawn_failed',
      transient: true,
    });
  });
});

describe('latency', () => {
  it('measures the time from an answer to the send', async () => {
    const h = await harness();
    const relay = createRelay({
      docket: createDocket({ baseUrl: h.docket.url }),
      orca: createOrca({ exe: fakeExe, env: h.env }),
      store: openStore(h.home),
      options: { tickMs: 1_000, pollTimeoutS: 5, rateLimit: 1000 },
    }) as Relay;
    const controller = new AbortController();
    const running = relay.run(controller.signal);
    cleanups.push(async () => {
      controller.abort();
      await running;
    });
    await until(() => relay.state.cursor !== null);

    const samples: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const at = Date.now();
      h.docket.push(ANSWER, at);
      await until(() => h.sends().length === i + 1);
      samples.push(h.calls().filter((call) => call.args[0] === 'send')[i]!.at - at);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const worst = sorted[sorted.length - 1]!;
    console.info(`docket-relay event-to-send: n=20 median=${median}ms max=${worst}ms`);
    expect(worst).toBeLessThan(5_000);
  }, 30_000);
});

// Decision 61 (B78): a run that finished partly is mailed to its producer, as a pointer.
describe('a partial exit reaches the producer', () => {
  const PARTLY = {
    type: 'run.finished_partly',
    actor: 'claude · w3',
    summary: `claude · w3 finished partly: 1 item left on GF-243: ${SECRET}`,
  };
  const ended = (o: { dispatch?: string; at?: string; outcome?: 'complete' | 'partial' } = {}) => ({
    ...lead({ dispatch: o.dispatch ?? 'ctx_live', state: 'finished' }),
    exit: {
      outcome: o.outcome ?? 'partial',
      at: o.at ?? '2026-11-23T12:00:00.000Z',
      left: [{ text: SECRET, why: SECRET, needs: SECRET, item: null }],
    },
  });

  it('counts run.finished_partly from an agent only, at once', () => {
    const event = { type: 'run.finished_partly', item_id: 'GF-243', summary: 'x' };
    expect(classifyEvent({ ...event, actor: 'claude · w3' })).toEqual({
      kinds: ['partial'],
      immediate: true,
      expect: 'agent',
    });
    expect(classifyEvent({ ...event, actor: 'owner' })).toBeNull();
    expect(classifyEvent({ ...event, actor: 'system' })).toBeNull();
    expect(classifyEvent({ ...event, actor: '' })).toBeNull();
  });

  it('words a pointer for the producer, never the items', () => {
    const { subject, body } = buildMessage({
      item: 'GF-243',
      kinds: ['partial'],
      implementer: 'Docket run r_lead1, dispatch ctx_a',
    });
    expect(subject).toBe('Docket: GF-243 finished partly');
    expect(body).toMatch(/^GF-243 finished partly in Docket: /);
    expect(body).toContain('Finished partly in get_digest');
    expect(body).toContain("You're told as its coordinator");
    expect(body).not.toContain('owner side');
  });

  it('targets the newest lead that finished partly, even after it ended', () => {
    const older = { ...ended({ at: '2026-11-23T10:00:00.000Z' }), run_id: 'r_old' };
    const newer = { ...ended({ at: '2026-11-23T11:00:00.000Z' }), run_id: 'r_new' };
    const complete = { ...ended({ outcome: 'complete' }), run_id: 'r_done' };
    expect(partialLead([older, newer, complete])?.run_id).toBe('r_new');
    expect(partialLead([complete, lead()])).toBeNull();
    expect(partialLead([{ ...newer, is_lead: false }])).toBeNull();
  });

  it('mails the coordinator of the run that finished partly, with no private text', async () => {
    const h = await harness();
    h.docket.runs.set('GF-243', [ended()]);
    const relay = await started(h);
    h.docket.push(PARTLY, h.clock.t);
    await h.step(relay);
    const [send, ...rest] = h.sends();
    expect(rest).toHaveLength(0);
    expect(send).toMatchObject({ to: 'run:run_coord', subject: 'Docket: GF-243 finished partly' });
    expect(send!.body).not.toContain(SECRET);
    expect(JSON.stringify(relay.state)).not.toContain(SECRET);
  });

  it('records it undelivered when the run has no dispatch to reach', async () => {
    const h = await harness();
    h.docket.runs.set('GF-243', [{ ...ended(), orchestrator: null }]);
    const relay = await started(h);
    h.docket.push(PARTLY, h.clock.t);
    await h.step(relay);
    expect(h.sends()).toHaveLength(0);
    expect(relay.state.undelivered).toMatchObject([
      { item: 'GF-243', reason: 'no_target', kinds: ['partial'] },
    ]);
  });
});
