/**
 * Decides what this CI run must prove (owner decision 51), as job outputs:
 *   mode        pr | queue | full | tree-match
 *   sha         the exact commit every job checks out
 *   run_e2e, run_system, matrix, specs, reason
 *
 * - A pull request runs every non-browser job and the browser specs its change reaches.
 * - Mergify's queue draft (head branch mergify/merge-queue/*, same repository) runs everything
 *   on the draft's own head commit, whose tree is what lands on main.
 * - A push to main is skipped only if a run of this workflow already passed `full-suite` on a
 *   commit with the identical tree. Anything else runs everything.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assignShards, buildWebGraph, selectSpecs } from './select.mjs';

export const QUEUE_PREFIX = 'mergify/merge-queue/';
export const SHARDS = 4;
/** How many recent runs of this workflow to look through for a matching tree. */
const RUNS_TO_SEARCH = 100;
const COMMITS_TO_COMPARE = 40;

export function classify(eventName, event, repository) {
  if (eventName === 'push')
    return { kind: /^refs\/heads\/(main$|b65-proof\/main-)/.test(event.ref) ? 'main' : 'other' };
  if (eventName !== 'pull_request') return { kind: 'other' };
  const head = event.pull_request?.head;
  const sameRepo = head?.repo?.full_name === repository;
  if (sameRepo && head?.ref?.startsWith(QUEUE_PREFIX)) return { kind: 'queue', sha: head.sha };
  return { kind: 'pr' };
}

/**
 * A completed `full-suite` success from this workflow, in this repository, on a queue draft or
 * main, for a commit with exactly this tree. `api(path)` returns parsed JSON.
 */
export async function findPassedTree({ api, repository, tree, currentRunId }) {
  const { workflow_runs: runs = [] } = await api(
    `/repos/${repository}/actions/workflows/ci.yml/runs?per_page=${RUNS_TO_SEARCH}`,
  );
  const treeOf = new Map();
  for (const run of runs) {
    if (String(run.id) === String(currentRunId)) continue;
    if (run.head_repository?.full_name !== repository) continue;
    const trusted =
      (run.event === 'pull_request' && run.head_branch?.startsWith(QUEUE_PREFIX)) ||
      (run.event === 'push' && run.head_branch === 'main');
    if (!trusted) continue;
    if (!treeOf.has(run.head_sha)) {
      if (treeOf.size >= COMMITS_TO_COMPARE) break;
      const commit = await api(`/repos/${repository}/git/commits/${run.head_sha}`);
      treeOf.set(run.head_sha, commit.tree?.sha);
    }
    if (treeOf.get(run.head_sha) !== tree) continue;
    const { jobs = [] } = await api(
      `/repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
    );
    const gate = jobs.find((job) => job.name === 'full-suite');
    if (gate?.status === 'completed' && gate.conclusion === 'success') {
      return { runId: run.id, sha: run.head_sha };
    }
  }
  return null;
}

export function buildMatrix(specs, timings, maxShards) {
  const seconds = specs.reduce((sum, spec) => sum + (timings[spec] ?? 15) + 2, 0);
  const count = Math.min(maxShards, Math.max(1, Math.ceil(seconds / 90)));
  const shards = assignShards(specs, timings, specs.length === 0 ? 1 : count);
  return shards.map((shard, index) => ({
    shard: index + 1,
    of: shards.length,
    specs: shard.specs.map((spec) => `e2e/${spec}`).join(' '),
    kit: shard.specs.includes('kit.spec.ts'),
    planned_seconds: Math.round(shard.seconds),
  }));
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function walk(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(folder, entry.name)) : [join(folder, entry.name)],
  );
}

function readWebSources() {
  const sources = new Map();
  for (const file of walk('web/src')) {
    if (/\.(tsx?|jsx?|css)$/.test(file)) {
      sources.set(relative('.', file).split(sep).join('/'), readFileSync(file, 'utf8'));
    }
  }
  return sources;
}

function readSpecs() {
  const names = readdirSync('web/e2e')
    .filter((name) => name.endsWith('.spec.ts'))
    .sort();
  return { names, sources: new Map(names.map((n) => [n, readFileSync(`web/e2e/${n}`, 'utf8')])) };
}

async function api(path) {
  const response = await fetch(`${process.env.GITHUB_API_URL}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${path}: ${response.status}`);
  return response.json();
}

async function plan() {
  const { GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_RUN_ID } =
    process.env;
  const event = JSON.parse(readFileSync(GITHUB_EVENT_PATH, 'utf8'));
  const type = classify(GITHUB_EVENT_NAME, event, GITHUB_REPOSITORY);
  const { names, sources } = readSpecs();
  const timings = JSON.parse(readFileSync('.github/ci/e2e-timings.json', 'utf8'));
  const everything = (mode, sha, reason) => ({
    mode,
    sha,
    reason,
    run_e2e: true,
    run_system: true,
    specs: names,
    matrix: buildMatrix(names, timings, SHARDS),
  });

  if (type.kind === 'queue') {
    return everything('queue', type.sha, 'merge queue: the full suite on the exact combined code');
  }
  if (type.kind === 'main') {
    const tree = git('rev-parse', 'HEAD^{tree}');
    try {
      const match = await findPassedTree({
        api,
        repository: GITHUB_REPOSITORY,
        tree,
        currentRunId: GITHUB_RUN_ID,
      });
      if (match) {
        return {
          mode: 'tree-match',
          sha: GITHUB_SHA,
          reason: `tree ${tree} already passed the full suite on ${match.sha} (run ${match.runId})`,
          run_e2e: false,
          run_system: false,
          specs: [],
          matrix: [],
        };
      }
    } catch (error) {
      console.log(`Tree lookup failed, so running everything: ${error.message}`);
    }
    return everything('full', GITHUB_SHA, `no passed run has tree ${tree}`);
  }
  if (type.kind !== 'pr') return everything('full', GITHUB_SHA, 'not a pull request');

  let selection;
  try {
    // A pull_request checkout is the test merge: its first parent is the base branch.
    const changed = git('diff', '--name-only', '--no-renames', 'HEAD^1', 'HEAD')
      .split('\n')
      .filter(Boolean);
    selection = selectSpecs({
      changed,
      specs: names,
      specSources: sources,
      webGraph: buildWebGraph(readWebSources()),
    });
  } catch (error) {
    selection = { scope: 'all', specs: names, reason: `selector failed: ${error.message}` };
  }
  return {
    mode: 'pr',
    sha: GITHUB_SHA,
    reason: `${selection.scope}: ${selection.reason}`,
    run_e2e: selection.specs.length > 0,
    run_system: selection.scope === 'all',
    specs: selection.specs,
    matrix: buildMatrix(selection.specs, timings, SHARDS),
  };
}

async function main() {
  const result = await plan();
  const outputs = {
    ...result,
    run_e2e: String(result.run_e2e),
    run_system: String(result.run_system),
    specs: JSON.stringify(result.specs),
    matrix: JSON.stringify(result.matrix),
  };
  const text = Object.entries(outputs)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  console.log(text);
  appendFileSync(process.env.GITHUB_OUTPUT, `${text}\n`);
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `**CI plan: ${result.mode}.** ${result.reason}. Browser specs: ${result.specs.length}.\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
