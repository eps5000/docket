/**
 * Token use on the server (owner decision 48; B63; BUILD_SPEC §5.30): off by
 * default, attribution that never guesses, overhead and unlinked, missing
 * prices, rollups, and that a sync can carry nothing but numbers and identifiers.
 * All fixture text is made up.
 */
import {
  API_ROUTES,
  MODEL_PRICES,
  USAGE_PRICES_AS_OF,
  estimateCost,
  modelPrice,
  type UsageRecord,
} from '@docket/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attribute, type Attribution } from '../../src/domain/usage.js';
import { OWNER_ACTOR, type Actor } from '../../src/domain/write.js';
import { addProject, minutes, startDomain, type Domain } from '../us1-helpers.js';

const FOLDER = 'c:/work/feature-a';
const FOLDER_B = 'c:/work/feature-b';
const COORD = 'c:/work/coordinator';

let d: Domain;
let claude: Actor;

beforeEach(() => {
  d = startDomain({ seed: false });
  addProject(d, 'OV');
  addProject(d, 'OW');
  claude = d.agent('claude', { label: 'w1' });
});
afterEach(async () => {
  await d?.cleanup();
});

const ticket = (title: string, over: { project?: string; epic_id?: string; epic?: boolean } = {}) =>
  d.write(OWNER_ACTOR, (w, s) =>
    s.items.create(w, {
      project: over.project ?? 'OV',
      type: over.epic ? 'Epic' : 'Task',
      title,
      priority: 2,
      status: 'planning',
      ...(over.epic_id ? { epic: over.epic_id } : {}),
    }),
  ).id;

function claim(id: string, path: string | null = FOLDER, agent = claude) {
  d.sql.prepare("UPDATE items SET status = 'ready' WHERE id = ?").run(id);
  return d.write(agent, (w, s) =>
    s.runs.claim(w, {
      id,
      agent_label: 'w1',
      ...(path ? { workspace: { path, branch: 'feat/x' } } : {}),
    }),
  ).run_id;
}

const finish = (run_id: string) =>
  d.write({ ...claude, run_id }, (w, s) =>
    s.runs.finish(w, { run_id, result: 'finished', summary: 'Finished the slice.' }),
  );

const turnOn = (folders: { project: string; path: string }[] = []) =>
  d.write(OWNER_ACTOR, (w, s) =>
    s.usage.setSettings(w, { enabled: true, coordinator_folders: folders }),
  );

let serial = 0;
const record = (over: Partial<UsageRecord> = {}): UsageRecord => {
  serial += 1;
  return {
    key: `claude-code:msg_${serial}`,
    client: 'claude-code',
    session_id: 'sess-1',
    at: d.clock.now().toISOString(),
    workspace: FOLDER,
    model: 'claude-opus-5-5',
    fresh_input: 100,
    cached_input: 9000,
    cache_write: 500,
    cache_write_1h: 0,
    output: 200,
    ...over,
  };
};
const ingest = (...records: UsageRecord[]) => d.services.usage.ingest(d.read(), records);
const summary = (scope = 'OV', window: '24h' | '7d' | '30d' = '7d') =>
  d.services.usage.summary(d.read(), { scope, window });
const itemUsage = (id: string) => d.services.usage.item(d.read(), { id });

describe('off by default', () => {
  it('reads as off, stores nothing and tells the collector not to read', () => {
    const id = ticket('A');
    claim(id);
    expect(d.services.usage.settings(d.read())).toMatchObject({
      enabled: false,
      helper: 'off',
      last_read_at: null,
      turns_stored: 0,
    });
    expect(d.services.usage.syncConfig(d.read())).toEqual({ enabled: false, workspaces: [] });
    expect(ingest(record())).toMatchObject({ accepted: 0, disabled: true });
    expect(d.row<{ n: number }>('SELECT COUNT(*) AS n FROM usage_turns').n).toBe(0);
    expect(summary()).toMatchObject({ enabled: false, linked_pct: null, models: [] });
    expect(itemUsage(id)).toMatchObject({ enabled: false, models: [], children: [] });
  });

  it('keeps counts when turned off, hides them, and stops taking more', () => {
    const id = ticket('A');
    claim(id);
    turnOn();
    d.clock.advance(minutes(1));
    expect(ingest(record()).accepted).toBe(1);
    d.write(OWNER_ACTOR, (w, s) => s.usage.setSettings(w, { enabled: false }));
    expect(summary().enabled).toBe(false);
    expect(summary().total.turns).toBe(0);
    expect(ingest(record()).disabled).toBe(true);
    expect(d.services.usage.settings(d.read())).toMatchObject({ helper: 'off', turns_stored: 1 });
    turnOn();
    expect(summary().total.turns).toBe(1);
  });

  it('records turning it on and off in the activity log, without folder paths', () => {
    turnOn([{ project: 'OV', path: 'C:\\work\\coordinator' }]);
    const event = d.row<{ summary: string; data: string }>(
      "SELECT summary, data FROM events WHERE type = 'project.updated' ORDER BY seq DESC LIMIT 1",
    );
    expect(event.summary).toMatch(/turned on measuring token use/);
    expect(event.data).not.toContain('coordinator"');
    expect(event.data).not.toContain('work');
  });
});

describe('the helper status', () => {
  it('is not running until it checks in, running after, and not running once silent', () => {
    turnOn();
    expect(d.services.usage.settings(d.read()).helper).toBe('not_running');
    d.services.usage.syncConfig(d.read());
    const running = d.services.usage.settings(d.read());
    expect(running.helper).toBe('running');
    expect(running.last_read_at).toBe(d.clock.now().toISOString());
    d.clock.advance(minutes(21));
    expect(d.services.usage.settings(d.read()).helper).toBe('not_running');
  });
});

describe('known workspaces', () => {
  it('lists run workspaces and coordinator folders in one form', () => {
    const id = ticket('A');
    claim(id, 'C:\\Work\\Feature-A\\');
    turnOn([{ project: 'OV', path: 'C:\\Work\\Coordinator' }]);
    expect(d.services.usage.syncConfig(d.read()).workspaces).toEqual([COORD, FOLDER]);
  });

  it('refuses a record for a folder Docket does not know', () => {
    claim(ticket('A'));
    turnOn();
    d.clock.advance(minutes(1));
    expect(ingest(record({ workspace: 'c:/private/other' }))).toMatchObject({
      accepted: 0,
      unknown_workspace: 1,
    });
    expect(d.row<{ n: number }>('SELECT COUNT(*) AS n FROM usage_turns').n).toBe(0);
  });
});

describe('attribution', () => {
  it('links a turn in the run’s workspace during the run', () => {
    const id = ticket('A');
    claim(id);
    turnOn();
    d.clock.advance(minutes(5));
    ingest(record());
    const s = summary();
    expect(s.linked.turns).toBe(1);
    expect(s.unlinked.turns).toBe(0);
    expect(s.linked_pct).toBe(100);
    expect(s.top_tickets.rows.map((r) => r.id)).toEqual([id]);
    expect(itemUsage(id).total.tokens).toEqual({
      fresh_input: 100,
      cached_input: 9000,
      cache_write: 500,
      output: 200,
    });
  });

  it('leaves a turn before the run or after it ended unlinked', () => {
    const id = ticket('A');
    const before = d.clock.now().toISOString();
    d.clock.advance(minutes(5));
    const run = claim(id);
    turnOn();
    d.clock.advance(minutes(5));
    finish(run);
    d.clock.advance(minutes(5));
    ingest(record({ at: before }), record());
    const s = summary();
    expect(s.linked.turns).toBe(0);
    expect(s.unlinked.turns).toBe(2);
    expect(s.linked_pct).toBe(0);
    expect(itemUsage(id).total.turns).toBe(0);
  });

  it('never picks between two tickets sharing a folder at that moment', () => {
    const a = ticket('A');
    const b = ticket('B');
    claim(a);
    claim(b, FOLDER, d.agent('codex', { label: 'w2' }));
    turnOn();
    d.clock.advance(minutes(1));
    ingest(record());
    expect(summary().unlinked.turns).toBe(1);
    expect(itemUsage(a).total.turns).toBe(0);
    expect(itemUsage(b).total.turns).toBe(0);
  });

  it('gives each ticket its own turns when they used one folder in turn', () => {
    const a = ticket('A');
    const runA = claim(a);
    turnOn();
    d.clock.advance(minutes(1));
    ingest(record());
    d.clock.advance(minutes(1));
    finish(runA);
    d.clock.advance(minutes(1));
    const b = ticket('B');
    claim(b);
    d.clock.advance(minutes(1));
    ingest(record());
    expect(itemUsage(a).total.turns).toBe(1);
    expect(itemUsage(b).total.turns).toBe(1);
  });

  it('shows a coordinator folder as overhead, even during a run there', () => {
    const id = ticket('A');
    claim(id, COORD);
    turnOn([{ project: 'OV', path: COORD }]);
    d.clock.advance(minutes(1));
    ingest(record({ workspace: COORD }));
    const s = summary();
    expect(s.overhead.turns).toBe(1);
    expect(s.linked.turns).toBe(0);
    expect(s.linked_pct).toBe(0);
    expect(itemUsage(id).total.turns).toBe(0);
  });

  it('reclassifies stored turns when the owner registers a coordinator folder', () => {
    const id = ticket('A');
    claim(id);
    turnOn();
    d.clock.advance(minutes(1));
    ingest(record());
    expect(summary().linked.turns).toBe(1);
    turnOn([{ project: 'OV', path: FOLDER }]);
    expect(summary()).toMatchObject({ linked: { turns: 0 }, overhead: { turns: 1 } });
    turnOn([]);
    expect(summary()).toMatchObject({ linked: { turns: 1 }, overhead: { turns: 0 } });
  });

  it('links an unlinked turn once a run’s workspace is recorded for that time', () => {
    const first = ticket('A');
    finish(claim(first));
    turnOn();
    const second = ticket('B');
    const run = claim(second, null);
    d.clock.advance(minutes(1));
    ingest(record());
    expect(summary().unlinked.turns).toBe(1);
    d.services.runs.heartbeat(d.read({ ...claude, run_id: run }), {
      run_id: run,
      workspace: { path: FOLDER, branch: 'feat/x' },
    });
    ingest(record({ key: 'claude-code:later' }));
    expect(itemUsage(second).total.turns).toBe(2);
    expect(summary().unlinked.turns).toBe(0);
  });

  it('keeps projects apart, and All adds them up', () => {
    claim(ticket('A'));
    claim(ticket('B', { project: 'OW' }), FOLDER_B);
    turnOn();
    d.clock.advance(minutes(1));
    ingest(record(), record({ workspace: FOLDER_B, session_id: 'sess-2' }));
    expect(summary('OV').total).toMatchObject({ turns: 1, sessions: 1 });
    expect(summary('OW').total).toMatchObject({ turns: 1, sessions: 1 });
    expect(summary('all').total).toMatchObject({ turns: 2, sessions: 2 });
  });

  it('has a pure rule for the empty and unknown cases', () => {
    const a: Attribution = { windows: new Map(), coordinators: new Map() };
    expect(attribute({ workspace: FOLDER, at: '2026-11-06T11:00:00.000Z' }, a)).toBeNull();
  });
});

describe('counting', () => {
  it('counts a repeated report once, and takes larger numbers', () => {
    claim(ticket('A'));
    turnOn();
    d.clock.advance(minutes(1));
    const r = record({ output: 10 });
    expect(ingest(r).accepted).toBe(1);
    expect(ingest(r)).toMatchObject({ accepted: 0, unchanged: 1 });
    expect(ingest({ ...r, output: 25 }).accepted).toBe(1);
    expect(ingest({ ...r, output: 5 }).unchanged).toBe(1);
    expect(summary().total).toMatchObject({ turns: 1, tokens: { output: 25 } });
  });

  it('counts only turns inside the window', () => {
    claim(ticket('A'));
    turnOn();
    d.clock.advance(minutes(1));
    ingest(record());
    d.clock.advance(minutes(60 * 25));
    expect(summary('OV', '24h').total.turns).toBe(0);
    expect(summary('OV', '7d').total.turns).toBe(1);
  });

  it('reads one day for the brief', () => {
    const id = ticket('A');
    claim(id);
    turnOn();
    d.clock.advance(minutes(1));
    ingest(record());
    const day = d.clock.now().toISOString().slice(0, 10);
    const on = d.services.usage.summary(d.read(), { scope: 'OV', day });
    expect(on.total.turns).toBe(1);
    const before = d.services.usage.summary(d.read(), { scope: 'OV', day: '2026-01-01' });
    expect(before.total.turns).toBe(0);
  });

  it('removes a project’s counts with the project', () => {
    claim(ticket('A'));
    turnOn();
    d.clock.advance(minutes(1));
    ingest(record());
    d.write(OWNER_ACTOR, (w, s) => s.projects.delete(w, { key: 'OV', confirm_key: 'OV' }));
    expect(d.row<{ n: number }>('SELECT COUNT(*) AS n FROM usage_turns').n).toBe(0);
  });
});

describe('rollups', () => {
  it('adds an epic’s own turns and its tickets’, and lists both sessions', () => {
    const epic = ticket('Epic', { epic: true });
    const a = ticket('A', { epic_id: epic });
    const b = ticket('B', { epic_id: epic });
    claim(a);
    claim(b, FOLDER_B, d.agent('codex', { label: 'w2' }));
    turnOn();
    d.clock.advance(minutes(1));
    ingest(
      record({ fresh_input: 10, output: 1, cached_input: 0, cache_write: 0 }),
      record({
        workspace: FOLDER_B,
        session_id: 'sess-2',
        client: 'codex',
        key: 'codex:sess-2:50',
        model: 'gpt-5.5',
        fresh_input: 40,
        output: 2,
        cached_input: 0,
        cache_write: 0,
      }),
    );
    const rollup = itemUsage(epic);
    expect(rollup.rollup).toBe(true);
    expect(rollup.total).toMatchObject({
      turns: 2,
      sessions: 2,
      tokens: { fresh_input: 50, output: 3 },
    });
    expect(rollup.children.map((c) => c.id)).toEqual([b, a]);
    expect(rollup.models.map((m) => m.model)).toEqual(['gpt-5.5', 'claude-opus-5-5']);
    expect(rollup.sessions.count).toBe(2);
    expect(itemUsage(a)).toMatchObject({ rollup: false, children: [], total: { turns: 1 } });
  });

  it('sums one session across models', () => {
    const id = ticket('A');
    claim(id);
    turnOn();
    d.clock.advance(minutes(1));
    ingest(record({ model: 'claude-opus-5-5' }), record({ model: 'claude-sonnet-5-5' }));
    const { sessions } = itemUsage(id);
    expect(sessions.count).toBe(1);
    expect(sessions.rows[0]).toMatchObject({
      turns: 2,
      models: ['claude-opus-5-5', 'claude-sonnet-5-5'],
    });
  });
});

describe('prices', () => {
  it('cites a source for every model, and has a date', () => {
    expect(USAGE_PRICES_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const [model, price] of Object.entries(MODEL_PRICES)) {
      expect(price.source, model).toMatch(/^https:\/\//);
      expect(price.input, model).toBeGreaterThan(0);
      expect(price.output, model).toBeGreaterThan(0);
    }
  });

  it('prices the four kinds separately', () => {
    const cost = estimateCost('claude-opus-5-5', {
      fresh_input: 1_000_000,
      cached_input: 1_000_000,
      cache_write: 1_000_000,
      cache_write_1h: 250_000,
      output: 1_000_000,
    });
    expect(cost.unpriced_tokens).toBe(0);
    // $4 input + $0.20 read + 750k at $5 + 250k at $8 + $20 output.
    expect(cost.usd).toBeCloseTo(4 + 0.2 + 3.75 + 2 + 20, 6);
  });

  it('has no price for an unknown model or an inherited property name', () => {
    expect(modelPrice('claude-unreleased-9')).toBeNull();
    expect(modelPrice('constructor')).toBeNull();
    expect(modelPrice(null)).toBeNull();
    expect(
      estimateCost('claude-unreleased-9', {
        fresh_input: 5,
        cached_input: 6,
        cache_write: 7,
        cache_write_1h: 0,
        output: 8,
      }),
    ).toEqual({ usd: null, unpriced_tokens: 26 });
  });

  it('uses the long-context price only above the threshold', () => {
    const tokens = {
      fresh_input: 1_000_000,
      cached_input: 0,
      cache_write: 0,
      cache_write_1h: 0,
      output: 0,
    };
    expect(estimateCost('claude-haiku-5-5', tokens, 100_000).usd).toBeCloseTo(0.1, 6);
    expect(estimateCost('claude-haiku-5-5', tokens, 100_001).usd).toBeCloseTo(0.5, 6);
    expect(estimateCost('gpt-5.5', tokens, 272_000).usd).toBeCloseTo(5, 6);
    expect(estimateCost('gpt-5.5', tokens, 272_001).usd).toBeCloseTo(10, 6);
  });

  it('leaves OpenAI cache writes out of the estimate and says so', () => {
    const cost = estimateCost('gpt-5.5', {
      fresh_input: 1_000_000,
      cached_input: 0,
      cache_write: 400,
      cache_write_1h: 0,
      output: 0,
    });
    expect(cost.usd).toBeCloseTo(5, 6);
    expect(cost.unpriced_tokens).toBe(400);
  });

  it('shows tokens and no cost for a model without a price', () => {
    const id = ticket('A');
    claim(id);
    turnOn();
    d.clock.advance(minutes(1));
    ingest(record({ model: 'made-up-model' }), record({ model: null, key: 'claude-code:nomodel' }));
    const { total, models } = itemUsage(id);
    expect(total.cost.usd).toBeNull();
    expect(total.cost.unpriced_tokens).toBe(2 * 9800);
    expect(total.cost.unpriced_models).toEqual(['made-up-model', 'unknown model']);
    expect(models.every((m) => m.cost.usd === null)).toBe(true);
    expect(total.tokens.output).toBe(400);
  });

  it('prices what it can when only some models have a price', () => {
    const id = ticket('A');
    claim(id);
    turnOn();
    d.clock.advance(minutes(1));
    ingest(
      record({ fresh_input: 1_000_000, cached_input: 0, cache_write: 0, output: 0 }),
      record({ model: 'made-up-model', fresh_input: 7, cached_input: 0, cache_write: 0, output: 0 }),
    );
    const { cost } = itemUsage(id).total;
    expect(cost.usd).toBeCloseTo(4, 6);
    expect(cost.unpriced_tokens).toBe(7);
    expect(cost.unpriced_models).toEqual(['made-up-model']);
  });
});

describe('the sync contract', () => {
  const body = API_ROUTES['usageSync.post'].body!;

  it('refuses any field beyond numbers and identifiers', () => {
    const good = { records: [record()] };
    expect(body.safeParse(good).success).toBe(true);
    for (const extra of ['content', 'text', 'message', 'prompt', 'cwd', 'branch']) {
      const bad = { records: [{ ...record(), [extra]: 'PLANTED' }] };
      expect(body.safeParse(bad).success, extra).toBe(false);
    }
  });

  it('refuses free text in the identifier fields', () => {
    for (const over of [
      { key: 'has spaces in it' },
      { session_id: 'a secret sentence' },
      { model: 'a secret sentence' },
      { at: 'yesterday' },
    ]) {
      expect(body.safeParse({ records: [{ ...record(), ...over }] }).success).toBe(false);
    }
  });
});
