/**
 * Turns one shard's Playwright JSON report into the summary the `e2e` gate reads, so the gate
 * can prove every planned spec ran exactly once (owner decision 51).
 *
 *   node .github/ci/shard-report.mjs <playwright json> <shard number> <output file>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export function summarize(report, shard) {
  const specs = {};
  const visit = (suite) => {
    for (const spec of suite.specs ?? []) {
      const file = basename(spec.file ?? suite.file);
      specs[file] ??= { expected: 0, unexpected: 0, flaky: 0, skipped: 0 };
      for (const test of spec.tests ?? []) {
        specs[file][test.status] = (specs[file][test.status] ?? 0) + 1;
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites ?? []) visit(suite);
  return { shard, specs, durationMs: report.stats?.duration ?? null };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [input, shard, output] = process.argv.slice(2);
  const summary = summarize(JSON.parse(readFileSync(input, 'utf8')), Number(shard));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(summary));
  const counts = Object.values(summary.specs);
  const total = (key) => counts.reduce((sum, c) => sum + (c[key] ?? 0), 0);
  console.log(
    `Shard ${shard}: ${counts.length} spec files, ${total('expected')} passed, ` +
      `${total('flaky')} flaky, ${total('unexpected')} failed, ${total('skipped')} skipped`,
  );
}
