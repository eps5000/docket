/**
 * The aggregate checks Mergify reads (owner decision 51): `build`, `e2e` and `full-suite`.
 * Each passes only when every job it covers ended the way this run's plan says it must.
 * A failed, cancelled or unexpectedly skipped job fails the gate.
 *
 *   node .github/ci/gate.mjs <build|e2e|full-suite> [folder of shard summaries]
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const GATE_JOBS = {
  build: ['lint', 'unit', 'server-unit', 'server-integration', 'contract', 'image'],
  e2e: ['image', 'e2e-shard', 'e2e-system'],
  'full-suite': ['build', 'e2e'],
};

const FULL_MODES = new Set(['full', 'queue']);
const KNOWN_MODES = new Set(['full', 'queue', 'pr', 'tree-match']);

function expectedResult(job, gate, outputs) {
  const { mode, run_e2e: runE2e, run_system: runSystem } = outputs;
  if (gate === 'full-suite') return 'success';
  if (mode === 'tree-match') return 'skipped';
  if (mode === 'pr' && job === 'e2e-shard') return runE2e === 'true' ? 'success' : 'skipped';
  if (mode === 'pr' && job === 'e2e-system') return runSystem === 'true' ? 'success' : 'skipped';
  return 'success';
}

/** @returns {{ ok: boolean, lines: string[] }} */
export function decideGate(gate, needs) {
  const jobs = GATE_JOBS[gate];
  if (!jobs) return { ok: false, lines: [`Unknown gate "${gate}".`] };
  const plan = needs?.plan;
  if (plan?.result !== 'success') {
    return {
      ok: false,
      lines: [`plan ended as ${plan?.result ?? 'missing'}, so nothing is proven.`],
    };
  }
  const outputs = plan.outputs ?? {};
  const { mode } = outputs;
  if (!KNOWN_MODES.has(mode)) return { ok: false, lines: [`Unknown plan mode "${mode}".`] };
  if (gate === 'full-suite' && mode === 'pr') {
    return { ok: false, lines: ['A pull request run may be partial, so it proves no full suite.'] };
  }
  if (FULL_MODES.has(mode) && (outputs.run_e2e !== 'true' || outputs.run_system !== 'true')) {
    return { ok: false, lines: [`A ${mode} run must run every browser job.`] };
  }

  const lines = [`mode: ${mode}${outputs.reason ? ` (${outputs.reason})` : ''}`];
  let ok = true;
  for (const job of jobs) {
    const actual = needs[job]?.result ?? 'missing';
    const expected = expectedResult(job, gate, outputs);
    const good = actual === expected;
    if (!good) ok = false;
    lines.push(`${good ? 'ok  ' : 'FAIL'} ${job}: ${actual}${good ? '' : ` (needed ${expected})`}`);
  }
  return { ok, lines };
}

/** Every planned spec ran in exactly one shard, and none ended failed. */
export function checkShardCoverage(plannedSpecs, summaries) {
  const problems = [];
  const seen = new Map();
  let flaky = 0;
  let tests = 0;
  for (const summary of summaries) {
    for (const [file, counts] of Object.entries(summary.specs ?? {})) {
      if (seen.has(file)) {
        problems.push(`${file} ran in shards ${seen.get(file)} and ${summary.shard}`);
      }
      seen.set(file, summary.shard);
      flaky += counts.flaky ?? 0;
      tests += (counts.expected ?? 0) + (counts.flaky ?? 0) + (counts.skipped ?? 0);
      tests += counts.unexpected ?? 0;
      if ((counts.unexpected ?? 0) > 0) problems.push(`${file} has failed tests`);
    }
  }
  for (const file of plannedSpecs) if (!seen.has(file)) problems.push(`${file} never ran`);
  for (const file of seen.keys()) {
    if (!plannedSpecs.includes(file)) problems.push(`${file} ran but wasn't planned`);
  }
  return { ok: problems.length === 0, problems, flaky, tests };
}

function readSummaries(folder) {
  if (!folder || !existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(folder, name), 'utf8')));
}

function main() {
  const [gate, summaryFolder] = process.argv.slice(2);
  const needs = JSON.parse(process.env.NEEDS ?? '{}');
  const result = decideGate(gate, needs);
  const outputs = needs.plan?.outputs ?? {};
  if (result.ok && gate === 'e2e' && outputs.run_e2e === 'true') {
    const coverage = checkShardCoverage(
      JSON.parse(outputs.specs ?? '[]'),
      readSummaries(summaryFolder),
    );
    result.lines.push(
      `shards: ${coverage.tests} tests, ${coverage.flaky} passed only on retry (flaky)`,
    );
    for (const problem of coverage.problems) result.lines.push(`FAIL ${problem}`);
    if (!coverage.ok) result.ok = false;
  }
  const text = [`${gate}: ${result.ok ? 'passed' : 'FAILED'}`, ...result.lines].join('\n');
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\`\`\`\n${text}\n\`\`\`\n`);
  }
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
