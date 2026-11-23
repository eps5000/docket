/**
 * docket-relay (owner decision 46), against a fake change feed on loopback and
 * a fake `orca` executable. No test can reach a real Orca: the relay is given
 * the fake's full path, and the fake only writes down what it was asked.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TOOL = join(ROOT, 'tools', 'docket-relay');
const lib = (name: string) =>
  import(/* @vite-ignore */ pathToFileURL(join(TOOL, 'lib', name)).href);

const { classifyEvent, buildMessage } = await lib('classify.mjs');
const { liveLead, resolveTarget } = await lib('target.mjs');
const { childEnv, createOrca, findOrca, requestIdFor } = await lib('orca.mjs');
const { createDocket } = await lib('docket.mjs');
const { acquireLock, openStore } = await lib('store.mjs');
const { createRelay } = await lib('relay.mjs');

const SECRET = 'PRIVATE-OWNER-TEXT';
const START = Date.parse('2026-11-23T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

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
      dispatch: { status: d.status, runId: d.runId, capabilityRevokedAt: d.revoked ?? null },
      worker: d.workerState ? { state: d.workerState } : null,
    } }, 0);
  }
  if (args[0] === 'send') {
    const to = flag('--to');
    const fail = plan.fail?.[to];
    const count = prior.filter((c) => c.args[0] === 'send' && c.args[c.args.indexOf('--to') + 1] === to).length;
    const code = Array.isArray(fail) ? fail[count] : fail;
    if (code) refuse(code);
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

/** The two Docket routes the relay reads. Its item reply is full of private text on purpose. */
class FakeDocket {
  rows: Row[] = [];
  runs = new Map<string, FakeRun[]>();
  itemReads = 0;
  otherRequests: string[] = [];
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
      const next = events.length > 0 ? events[events.length - 1]!.cursor : String(cursor);
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
    last_delivery: { role: string; latency_ms: number } | null;
  };
}

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
  it('points at the item and names kinds, in the owner-side wording', () => {
    expect(
      buildMessage({ item: 'GF-243', kinds: ['decision', 'acceptance'], role: 'implementer' }),
    ).toEqual({
      subject: 'Docket: GF-243 updated',
      body: 'GF-243 was updated from the owner side in Docket (decision, acceptance). Call get_context GF-243 and get_item GF-243.',
    });
  });

  it('says a wait cleared without claiming the owner did it', () => {
    const { subject, body } = buildMessage({
      item: 'GF-243',
      kinds: ['resume'],
      role: 'implementer',
    });
    expect(subject).toBe('Docket: GF-243 can resume');
    expect(body).toBe(
      'What GF-243 was waiting for has cleared in Docket. Call get_context GF-243 and get_item GF-243.',
    );
  });

  it('tells a coordinator who to pass it to, and not to read it itself', () => {
    const { body } = buildMessage({
      item: 'GF-243',
      kinds: ['answer'],
      role: 'coordinator',
      implementer: 'dispatch ctx_old',
    });
    expect(body).toContain('(dispatch ctx_old)');
    expect(body).toContain('Tell that session to call get_context GF-243 and get_item GF-243.');
    expect(body).toContain("don't call get_item yourself");
  });
});

describe('finding the target', () => {
  const show = (found: Record<string, { live: boolean; runId: string | null }>) => (id: string) =>
    Promise.resolve(
      found[id] ? { found: true, ...found[id] } : { found: false, live: false, runId: null },
    );

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

  it('uses a live dispatch, with its Run as the fallback', async () => {
    const target = await resolveTarget(
      lead({ dispatch: 'ctx_a', runId: 'orca_session_id:coord' }),
      show({ ctx_a: { live: true, runId: 'run_home' } }),
    );
    expect(target).toMatchObject({ implementer: 'dispatch:ctx_a', coordinator: 'run:run_home' });
  });

  it('never treats a closed dispatch as reachable', async () => {
    const target = await resolveTarget(
      lead({ dispatch: 'ctx_a' }),
      show({ ctx_a: { live: false, runId: 'run_home' } }),
    );
    expect(target).toMatchObject({ implementer: null, coordinator: 'run:run_home' });
  });

  it('never presents orchestrator.run_id as the implementer', async () => {
    for (const runId of ['orca_session_id:abc', 'run_abc']) {
      const target = await resolveTarget(lead({ runId }), show({}));
      expect(target.implementer).toBeNull();
      expect(target.coordinator).toBe(runId.startsWith('run_') ? 'run:run_abc' : runId);
    }
  });

  it('ignores a bare UUID, a name, and anything that could be an option', async () => {
    for (const run of [
      lead({ runId: '4f22790a-dd53-4c2b-bf0e-fa9bceb755b8' }),
      lead({ runId: '--to=dispatch:evil' }),
      lead({ dispatch: '--body=evil' }),
      lead({ dispatch: 'ctx_a b' }),
      { ...lead(), orchestrator: { name: 'orca', dispatch_id: null, run_id: null } },
    ]) {
      expect(await resolveTarget(run, show({}))).toMatchObject({
        implementer: null,
        coordinator: null,
      });
    }
  });

  it('passes on an Orca failure instead of calling the dispatch closed', async () => {
    await expect(
      resolveTarget(lead({ dispatch: 'ctx_a' }), () =>
        Promise.reject(new Error('runtime_unavailable')),
      ),
    ).rejects.toThrow('runtime_unavailable');
  });
});

describe('delivery', () => {
  it('sends an answer at once, as a pointer through the exact command', async () => {
    const h = await harness();
    const relay = await started(h);
    h.docket.push(ANSWER, h.clock.t);
    await h.step(relay);

    const [send, ...rest] = h.sends();
    expect(rest).toEqual([]);
    expect(send!.to).toBe('dispatch:ctx_live');
    expect(send!.body).toBe(
      'GF-243 was updated from the owner side in Docket (answer). Call get_context GF-243 and get_item GF-243.',
    );
    expect(send!.args.slice(0, 8)).toEqual([
      'send',
      '--to',
      'dispatch:ctx_live',
      '--from',
      'docket-relay',
      '--type',
      'status',
      '--subject',
    ]);
    expect(relay.state.last_delivery?.role).toBe('implementer');
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
  it('goes to the coordinator for a closed dispatch, without mailing the dispatch', async () => {
    const h = await harness();
    h.plan({
      dispatches: {
        ctx_live: { status: 'completed', runId: 'run_coord', workerState: 'succeeded' },
      },
    });
    const relay = await started(h);
    h.docket.push(ANSWER, h.clock.t);
    await h.step(relay);
    expect(h.sends().map((send) => send.to)).toEqual(['run:run_coord']);
    expect(h.sends()[0]!.body).toContain('(dispatch ctx_live)');
    expect(relay.state.counters.via_coordinator).toBe(1);
  });

  it.each([
    ['failed', 'failed'],
    ['circuit_broken', null],
  ])('treats a %s dispatch as closed', async (status, workerState) => {
    const h = await harness();
    h.plan({ dispatches: { ctx_live: { status, runId: 'run_coord', workerState } } });
    const relay = await started(h);
    h.docket.push(ANSWER, h.clock.t);
    await h.step(relay);
    expect(h.sends().map((send) => send.to)).toEqual(['run:run_coord']);
  });

  it('treats a released worker as closed', async () => {
    const h = await harness();
    h.plan({
      dispatches: {
        ctx_live: { status: 'dispatched', runId: 'run_coord', workerState: 'stopped' },
      },
    });
    const relay = await started(h);
    h.docket.push(ANSWER, h.clock.t);
    await h.step(relay);
    expect(h.sends().map((send) => send.to)).toEqual(['run:run_coord']);
  });

  it('uses the stored Run when the dispatch is unknown', async () => {
    const h = await harness();
    h.docket.runs.set('GF-243', [lead({ dispatch: 'ctx_gone', runId: 'run_stored' })]);
    const relay = await started(h);
    h.docket.push(ANSWER, h.clock.t);
    await h.step(relay);
    expect(h.sends().map((send) => send.to)).toEqual(['run:run_stored']);
  });

  it('gives a session address the coordinator wording', async () => {
    const h = await harness();
    h.docket.runs.set('GF-243', [lead({ runId: 'orca_session_id:abc-1' })]);
    const relay = await started(h);
    h.docket.push(ANSWER, h.clock.t);
    await h.step(relay);
    const [send] = h.sends();
    expect(send!.to).toBe('orca_session_id:abc-1');
    expect(send!.body).toContain('(Docket run r_lead1)');
    expect(send!.body).toContain("don't call get_item yourself");
  });

  it('retries a few times, then tells the coordinator', async () => {
    const h = await harness();
    h.plan({
      dispatches: { ctx_live: { status: 'dispatched', runId: 'run_coord', workerState: 'ready' } },
      fail: { 'dispatch:ctx_live': 'runtime_unavailable' },
    });
    const relay = await started(h);
    h.docket.push(ANSWER, h.clock.t);
    await h.step(relay);
    expect(h.sends().map((send) => send.to)).toEqual([
      'dispatch:ctx_live',
      'dispatch:ctx_live',
      'dispatch:ctx_live',
      'run:run_coord',
    ]);
    expect(
      new Set(
        h
          .sends()
          .slice(0, 3)
          .map((send) => send.requestId),
      ).size,
    ).toBe(1);
    expect(relay.state.last_delivery?.role).toBe('coordinator');
  });

  it('does not retry a refusal', async () => {
    const h = await harness();
    h.plan({
      dispatches: { ctx_live: { status: 'dispatched', runId: 'run_coord', workerState: 'ready' } },
      fail: { 'dispatch:ctx_live': 'dispatch_inactive' },
    });
    const relay = await started(h);
    h.docket.push(ANSWER, h.clock.t);
    await h.step(relay);
    expect(h.sends().map((send) => send.to)).toEqual(['dispatch:ctx_live', 'run:run_coord']);
  });

  it('records undelivered when there is nobody to tell', async () => {
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

  it('records undelivered when every address refuses', async () => {
    const h = await harness();
    h.plan({
      dispatches: { ctx_live: { status: 'dispatched', runId: 'run_coord', workerState: 'ready' } },
      fail: { 'dispatch:ctx_live': 'dispatch_inactive', 'run:run_coord': 'run_not_found' },
    });
    const relay = await started(h);
    h.docket.push(ANSWER, h.clock.t);
    await h.step(relay);
    expect(relay.state.undelivered).toMatchObject([{ reason: 'send_failed' }]);
    expect(relay.state.batches).toEqual({});
  });

  it('holds a message while Orca is down and sends it when Orca is back', async () => {
    const h = await harness();
    const relay = await started(h);
    const working = JSON.parse(readFileSync(h.env.FAKE_ORCA_PLAN!, 'utf8')) as Record<
      string,
      unknown
    >;
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

  it('holds a message when it cannot read Orca, rather than calling the dispatch closed', async () => {
    const h = await harness();
    const relay = await started(h);
    const working = JSON.parse(readFileSync(h.env.FAKE_ORCA_PLAN!, 'utf8')) as Record<
      string,
      unknown
    >;
    h.plan({ ...working, conciseOnly: true });
    h.docket.push(ANSWER, h.clock.t);
    await h.step(relay);
    expect(h.sends()).toHaveLength(0);
    expect(Object.keys(relay.state.batches)).toEqual(['GF-243']);
    h.plan(working);
    h.clock.t += 5_000;
    await h.step(relay);
    expect(h.sends().map((send) => send.to)).toEqual(['dispatch:ctx_live']);
  });

  it('gives up on a held message after the 24-hour window', async () => {
    const h = await harness();
    const relay = await started(h);
    const working = JSON.parse(readFileSync(h.env.FAKE_ORCA_PLAN!, 'utf8')) as Record<
      string,
      unknown
    >;
    h.plan({ ...working, down: true });
    h.docket.push(ANSWER, h.clock.t);
    await h.step(relay);
    h.clock.t += 24 * HOUR;
    await h.step(relay);
    expect(relay.state.undelivered).toMatchObject([{ reason: 'orca_unavailable_expired' }]);
    expect(relay.state.batches).toEqual({});
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
    await second.flushDue();
    const sends = h.sends();
    expect(sends).toHaveLength(2);
    // Orca replays a repeated request ID instead of delivering it again.
    expect(sends[1]!.requestId).toBe(sends[0]!.requestId);
  });

  it('catches up after downtime, within 24 hours only', async () => {
    const h = await harness();
    h.docket.runs.set('GF-9', [lead({ dispatch: 'ctx_live' })]);
    const first = await started(h);
    h.clock.t += 30 * HOUR;
    h.docket.push({ ...ANSWER, item_id: 'GF-9' }, h.clock.t - 25 * HOUR);
    h.docket.push(ANSWER, h.clock.t - 23 * HOUR);
    const second = h.make();
    await h.step(second);
    expect(h.sends().map((send) => send.subject)).toEqual(['Docket: GF-243 updated']);
    expect(second.state.counters.expired).toBe(1);
    expect(first).toBeDefined();
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

  it('follows the feed when Docket comes back with an older database', async () => {
    const h = await harness();
    const relay = await started(h);
    h.docket.push(NOTE, h.clock.t);
    h.docket.push(NOTE, h.clock.t);
    await h.step(relay);
    expect(relay.state.cursor).toBe('2');
    h.docket.rows = [];
    await h.step(relay);
    expect(relay.state.cursor).toBe('0');
    h.clock.t += 1_000;
    h.docket.push(ANSWER, h.clock.t);
    await h.step(relay);
    expect(h.sends().some((send) => send.body.includes('answer'))).toBe(true);
  });

  it('survives a corrupt state file by starting at the end, without replay', async () => {
    const h = await harness();
    mkdirSync(h.home, { recursive: true });
    writeFileSync(join(h.home, 'state.json'), '{not json');
    h.docket.push(ANSWER, h.clock.t);
    const relay = h.make();
    await h.step(relay);
    expect(relay.state.cursor).toBe('1');
    expect(h.sends()).toHaveLength(0);
    expect(existsSync(join(h.home, 'state.json.corrupt'))).toBe(true);
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
    expect(text.out).toContain('GF-243 to implementer (answer)');
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

  it('test-send uses the same path, and only takes a real address', async () => {
    const h = await harness();
    const sent = await finish(cli(h, ['test-send', 'run:run_coord']));
    expect(sent.code).toBe(0);
    expect(h.sends()).toMatchObject([{ to: 'run:run_coord', subject: 'Docket relay test' }]);
    expect(h.calls()[0]!.orcaEnv).toEqual([]);
    for (const bad of ['--to=x', 'run:bad id', 'dispatch:nope']) {
      expect((await finish(cli(h, ['test-send', bad]))).code).toBe(1);
    }
    expect(h.sends()).toHaveLength(1);
  });

  it('prints help and refuses an unknown command', async () => {
    const h = await harness();
    expect((await finish(cli(h, ['help']))).out).toContain('docket-relay');
    expect((await finish(cli(h, ['nope']))).code).toBe(1);
  });
});

describe('calling Orca safely', () => {
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
    const id = requestIdFor('batch', 'dispatch:ctx_a', 'subject', 'body');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(requestIdFor('batch', 'dispatch:ctx_a', 'subject', 'body')).toBe(id);
    expect(requestIdFor('batch', 'run:run_a', 'subject', 'body')).not.toBe(id);
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
      await orca.send({ to: 'run:x', subject: 's', body: 'b', requestId: requestIdFor('m') }),
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
