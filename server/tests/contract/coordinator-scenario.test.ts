/**
 * The coordinator scenario (owner decision 40): the same deterministic run on
 * a Gameflow-sized fixture (the 300-item STR project), the old way and the
 * new way. A coordinator starts, finds work, dispatches 3 workers, waits 30
 * minutes for their events, and handles one parked worker.
 *
 * Every tool result is a real call against the real server. What's modelled:
 * - a fresh coordinator's context, 30k tokens (the pilot's fresh agents: 24–30k);
 * - the old wait: one `get_changes` a minute, each a model wake-up;
 * - the new wait: `docket-wait`, which wakes the model once per relevant event.
 *
 * "Context resent" adds, for every model wake-up, what the model is sent:
 * the base context, the tool definitions and every tool result so far. It
 * ignores prompt caching, which discounts the resend but doesn't remove it.
 *
 * Set DOCKET_SCENARIO_OUT=<file> to write the table as Markdown.
 */
import { writeFileSync } from 'node:fs';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PRODUCT_RESULT_MODES,
  expectOk,
  startHarness,
  textOf,
  tokens,
  type ContractHarness,
} from './harness.js';
import { askForm } from '../helpers.js';

const BASE_CONTEXT = 30_000;
const WAIT_MINUTES = 30;
/** Measured on main before decision 40 (token-budget.test.ts). */
const BEFORE_DEFS = { claude: 12_990, codex: 39_545 };
const WATCH = ['run.parked', 'question.asked', 'run.ended'];

/** One path's bill: results so far, wake-ups, and what each wake-up resends. */
class Ledger {
  wakeups = 0;
  results = 0;
  /** The sum, over wake-ups, of the tool results already in context. */
  private carried = 0;

  wake(resultText = ''): void {
    this.wakeups += 1;
    this.carried += this.results;
    this.results += tokens(resultText);
  }

  resent(defs: number): number {
    return this.wakeups * (BASE_CONTEXT + defs) + this.carried;
  }
}

interface Scene {
  h: ContractHarness;
  coordinator: Client;
  workers: Client[];
  ledger: Ledger;
  call(name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

async function scene(): Promise<Scene> {
  const h = await startHarness({ stress: true, env: PRODUCT_RESULT_MODES });
  const coordinator = await h.connect({ name: 'scenario-coordinator', version: '1.0.0' });
  const workers = await Promise.all(
    [1, 2, 3].map((n) => h.connect({ name: `scenario-worker-${n}`, version: '1.0.0' })),
  );
  const ledger = new Ledger();
  return {
    h,
    coordinator,
    workers,
    ledger,
    call: async (name, args = {}) => {
      const r = await h.call(name, args, coordinator);
      ledger.wake(textOf(r));
      return expectOk(r).structured;
    },
  };
}

/** Dispatching a worker is one model turn; the worker claims with its own context. */
async function dispatch(s: Scene, ids: string[]): Promise<string[]> {
  const runs: string[] = [];
  for (const [i, id] of ids.entries()) {
    s.ledger.wake();
    const r = expectOk(
      await s.h.call('claim_lead', { id, agent_label: `orca-w${i + 1}` }, s.workers[i]!),
    );
    runs.push(r.structured.run_id as string);
  }
  return runs;
}

/** The three events the coordinator is waiting for, at minutes 10, 20 and 30. */
async function workerEvent(s: Scene, n: 0 | 1 | 2, ids: string[], runs: string[]) {
  const worker = s.workers[n]!;
  if (n === 0) {
    expectOk(
      await s.h.call(
        'park_run',
        {
          run_id: runs[0],
          reason: 'Waiting for the coordinator to send more work',
          waiting_on: { orchestrator: true },
        },
        worker,
      ),
    );
  } else if (n === 1) {
    expectOk(
      await s.h.call(
        'ask_owner',
        { id: ids[1], run_id: runs[1], ...askForm('Keep the old save format?') },
        worker,
      ),
    );
  } else {
    expectOk(
      await s.h.call(
        'finish_run',
        { run_id: runs[2], result: 'finished', summary: 'Stopped at a clean point.' },
        worker,
      ),
    );
  }
}

const EVENT_MINUTES: Record<number, 0 | 1 | 2> = { 10: 0, 20: 1, 30: 2 };

/** The old path: the previous skill's start, then one `get_changes` a minute. */
async function oldPath(): Promise<Ledger> {
  const s = await scene();
  try {
    await s.call('whoami');
    await s.call('list_projects');
    await s.call('recovery_report');
    let cursor = (await s.call('get_changes')).next_cursor as string;
    const ready = (await s.call('search_items', { project: 'STR', filter: 'ready_to_start' }))
      .items as { id: string }[];
    await s.call('search_items', { project: 'STR', filter: 'resumable' });
    await s.call('search_items', { project: 'STR', filter: 'waiting_for_review' });
    const ids = ready.slice(0, 3).map((x) => x.id);
    const runs = await dispatch(s, ids);
    for (let minute = 1; minute <= WAIT_MINUTES; minute += 1) {
      const n = EVENT_MINUTES[minute];
      if (n !== undefined) await workerEvent(s, n, ids, runs);
      const page = await s.call('get_changes', { cursor, types: WATCH });
      cursor = page.next_cursor as string;
      if (n === 0) {
        // The parked worker: read the restart list and the item.
        await s.call('recovery_report');
        await s.call('get_item', { id: ids[0], view: 'summary' });
      }
    }
    return s.ledger;
  } finally {
    await s.h.close();
  }
}

/** The new path: `get_digest`, then `docket-wait` (the long-poll) between events. */
async function newPath(): Promise<Ledger> {
  const s = await scene();
  try {
    await s.call('recovery_report');
    const digest = await s.call('get_digest', { project: 'STR' });
    let cursor = digest.cursor as string;
    const ids = (digest.ready as { rows: { id: string }[] }).rows.slice(0, 3).map((x) => x.id);
    const runs = await dispatch(s, ids);
    for (const n of [0, 1, 2] as const) {
      // The script blocks here: no model tokens until the event lands.
      const waiting = s.h.server.request(
        `/agent/changes/wait?cursor=${cursor}&project=STR&types=${WATCH.join(',')}&timeout_s=20&format=text`,
      );
      await vi.waitFor(() => expect(s.h.server.runtime.changes.size).toBe(1));
      await workerEvent(s, n, ids, runs);
      const printed = await (await waiting).text();
      expect(printed).toMatch(/^changed cursor=\d+ events=1\n/);
      s.ledger.wake(printed);
      cursor = /cursor=(\d+)/.exec(printed)![1]!;
      if (n === 0) {
        const since = digest.cursor as string;
        const update = await s.call('get_digest', { project: 'STR', cursor: since });
        const parked = (update.runs as { rows: { state: string }[] }).rows;
        expect(parked.some((r) => r.state === 'parked')).toBe(true);
      }
    }
    return s.ledger;
  } finally {
    await s.h.close();
  }
}

const k = (n: number) => `${(n / 1000).toFixed(1)}k`;
const less = (a: number, b: number) => `${Math.round((1 - b / a) * 100)}%`;

let h: ContractHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('coordinator scenario: old path vs new path (decision 40)', () => {
  it('needs far fewer wake-ups, results and resent context', async () => {
    h = await startHarness({ seed: false, env: PRODUCT_RESULT_MODES });
    const text = (await h.a.listTools()).tools as Tool[];
    const defs = tokens(JSON.stringify(text));

    const before = await oldPath();
    const after = await newPath();

    const rows: [string, string, string, string][] = [
      [
        'Tool definitions, Claude Code',
        k(BEFORE_DEFS.claude),
        k(defs),
        less(BEFORE_DEFS.claude, defs),
      ],
      ['Tool definitions, Codex', k(BEFORE_DEFS.codex), k(defs), less(BEFORE_DEFS.codex, defs)],
      [
        'Tool-result tokens',
        k(before.results),
        k(after.results),
        less(before.results, after.results),
      ],
      [
        'Model wake-ups',
        String(before.wakeups),
        String(after.wakeups),
        less(before.wakeups, after.wakeups),
      ],
      [
        'Context resent, Claude Code',
        k(before.resent(BEFORE_DEFS.claude)),
        k(after.resent(defs)),
        less(before.resent(BEFORE_DEFS.claude), after.resent(defs)),
      ],
      [
        'Context resent, Codex',
        k(before.resent(BEFORE_DEFS.codex)),
        k(after.resent(defs)),
        less(before.resent(BEFORE_DEFS.codex), after.resent(defs)),
      ],
    ];
    const table = [
      '| Coordinator scenario | Old path | New path | Less |',
      '|---|---:|---:|---:|',
      ...rows.map((r) => `| ${r.join(' | ')} |`),
    ].join('\n');
    console.log(table);
    if (process.env.DOCKET_SCENARIO_OUT)
      writeFileSync(process.env.DOCKET_SCENARIO_OUT, `${table}\n`);

    expect(after.wakeups).toBeLessThan(before.wakeups / 3);
    expect(after.results).toBeLessThan(before.results);
    expect(after.resent(defs)).toBeLessThan(before.resent(BEFORE_DEFS.claude) * 0.4);
    expect(after.resent(defs)).toBeLessThan(before.resent(BEFORE_DEFS.codex) * 0.3);
  }, 60_000);
});
