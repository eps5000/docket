/**
 * The UI sweep (docker/smoke/ui-sweep.mjs, B35) runs clean against the
 * disposable e2e instance, and each of its checks can fail (its self-test).
 *
 * It only ever runs against a disposable instance: the spec resets the seed
 * first, and `assertDisposable` refuses a container on your real `docket-data`
 * volume (or one not started with DOCKET_SEED=sample), even with
 * DOCKET_E2E_NO_RESET=1. Never point it at your own Docket from a test.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseURL } from './container';
import { assertDisposable } from './fixtures/container';
import { expect, test, useSeededContainer } from './fixtures';

useSeededContainer();

const SCRIPT = fileURLToPath(new URL('../../docker/smoke/ui-sweep.mjs', import.meta.url));

interface SweepRow {
  screen: string;
  view: string;
  error?: string;
}

function run(args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env } });
    let out = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (out += String(d)));
    child.on('close', (code) => resolve({ code, out }));
  });
}

test('each check can fail (the self-test page)', async () => {
  const { code, out } = await run(['--self-test']);
  console.log(out);
  expect(code, out).toBe(0);
  expect(out.match(/^PASS/gm)).toHaveLength(5);
});

test('the sweep is clean on the seeded instance, at 1024 dark and 1440 light', async () => {
  test.setTimeout(300_000);
  assertDisposable();
  const json = join(test.info().outputDir, 'sweep.json');
  const { code, out } = await run(['--base', baseURL, '--items', '2', '--json', json]);
  console.log(out);
  expect(code, out).toBe(0);
  const report = JSON.parse(readFileSync(json, 'utf8')) as {
    results: SweepRow[];
    blocked: string[];
  };
  // Read-only: the pages sent no writes for the sweep to block.
  expect(report.blocked).toEqual([]);
  for (const view of ['1024 dark', '1440 light']) {
    const screens = report.results.filter((r) => r.view === view).map((r) => r.screen);
    for (const s of [
      'Needs you',
      'Work board',
      'Work list',
      'Work map',
      'Work timeline',
      'Agents',
      'Agent files',
      'Settings',
      'Help',
      'Palette',
    ]) {
      expect(screens, `${view} visits ${s}`).toContain(s);
    }
    expect(screens.some((s) => s.endsWith('· step dialog'))).toBe(true);
    // Two sample items, each on more than one tab.
    expect(
      screens.filter((s) => / · /.test(s) && !s.endsWith('step dialog')).length,
    ).toBeGreaterThan(4);
  }
});
