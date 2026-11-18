import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CallLog, type CallLogEntry } from '../../src/jobs/logs.js';
import { TestClock, tempDir, type TempDir } from '../helpers.js';

let tmp: TempDir;
let clock: TestClock;
let log: CallLog;
const DAY = 86_400_000;

const entry: CallLogEntry = {
  tool: 'claim_lead',
  client: 'claude',
  label: 'orca-w3',
  run: 'run_01JATEST',
  duration_ms: 12.4,
  result: 'ok',
};

beforeEach(() => {
  tmp = tempDir('docket-logs-');
  clock = new TestClock(new Date('2026-11-14T10:00:00.000Z'));
  log = new CallLog({ dir: join(tmp.dir, 'logs'), clock: clock.now });
});
afterEach(() => tmp.cleanup());

describe('diagnostic call log', () => {
  it('writes one JSON line per call to calls-YYYYMMDD.jsonl with metadata only', () => {
    log.record(entry);
    log.record({ ...entry, tool: 'set_plan', result: 'conflict', duration_ms: 3 });
    const lines = readFileSync(join(tmp.dir, 'logs', 'calls-20261114.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      {
        time: '2026-11-14T10:00:00.000Z',
        tool: 'claim_lead',
        client: 'claude',
        label: 'orca-w3',
        run: 'run_01JATEST',
        duration_ms: 12,
        result: 'ok',
      },
      {
        time: '2026-11-14T10:00:00.000Z',
        tool: 'set_plan',
        client: 'claude',
        label: 'orca-w3',
        run: 'run_01JATEST',
        duration_ms: 3,
        result: 'conflict',
      },
    ]);
  });

  it('never writes arguments or results, even if a caller passes them', () => {
    const sneaky = {
      ...entry,
      arguments: { text: 'secret plan' },
      result_body: 'x',
    } as CallLogEntry;
    log.record(sneaky);
    const text = readFileSync(log.fileFor(clock.now()), 'utf8');
    expect(text).not.toContain('secret plan');
    expect(Object.keys(JSON.parse(text))).toEqual([
      'time',
      'tool',
      'client',
      'label',
      'run',
      'duration_ms',
      'result',
    ]);
  });

  it('rotates daily and keeps 7 days', () => {
    const dir = join(tmp.dir, 'logs');
    log.record(entry);
    // Old files from earlier days.
    for (const day of ['20261101', '20261108', '20261109']) {
      writeFileSync(join(dir, `calls-${day}.jsonl`), '{}\n');
    }
    writeFileSync(join(dir, 'unrelated.txt'), 'keep me');
    clock.advance(DAY);
    log.record(entry);
    // On Nov 15, the 7 days kept are Nov 9 to Nov 15.
    expect(readdirSync(dir).sort()).toEqual([
      'calls-20261109.jsonl',
      'calls-20261114.jsonl',
      'calls-20261115.jsonl',
      'unrelated.txt',
    ]);
    expect(existsSync(join(dir, 'calls-20261108.jsonl'))).toBe(false);
  });

  it('reads back the last N days in order', () => {
    log.record({ ...entry, tool: 'a' });
    clock.advance(DAY);
    log.record({ ...entry, tool: 'b' });
    const tools = log
      .read(7)
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { tool: string }).tool);
    expect(tools).toEqual(['a', 'b']);
    expect(log.read(1).trim().split('\n')).toHaveLength(1);
  });
});
