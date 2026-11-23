/** Unit tests for the CI planner and gates: `node --test .github/ci/ci.test.mjs`. */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { checkShardCoverage, decideGate, GATE_JOBS } from './gate.mjs';
import { buildMatrix, classify, findPassedTree } from './plan.mjs';
import { affectedAreas, assignShards, buildWebGraph, selectSpecs, specUrls } from './select.mjs';
import { summarize } from './shard-report.mjs';

const REPO = 'owner/repo';
const results = (jobs, result) => Object.fromEntries(jobs.map((job) => [job, { result }]));
const planned = (mode, extra = {}) => ({
  plan: {
    result: 'success',
    outputs: { mode, run_e2e: 'true', run_system: 'true', reason: 'test', ...extra },
  },
});

describe('gates', () => {
  for (const gate of ['build', 'e2e']) {
    it(`${gate} passes only when every job succeeded`, () => {
      const needs = { ...planned('queue'), ...results(GATE_JOBS[gate], 'success') };
      assert.equal(decideGate(gate, needs).ok, true);
    });

    for (const job of GATE_JOBS[gate]) {
      for (const bad of ['failure', 'cancelled', 'skipped']) {
        it(`${gate} fails when ${job} is ${bad}`, () => {
          const needs = {
            ...planned('queue'),
            ...results(GATE_JOBS[gate], 'success'),
            [job]: { result: bad },
          };
          assert.equal(decideGate(gate, needs).ok, false);
        });
      }
      it(`${gate} fails when ${job} is missing`, () => {
        const needs = { ...planned('queue'), ...results(GATE_JOBS[gate], 'success') };
        delete needs[job];
        assert.equal(decideGate(gate, needs).ok, false);
      });
    }

    for (const bad of ['failure', 'cancelled', 'skipped']) {
      it(`${gate} fails when plan is ${bad}`, () => {
        const needs = {
          plan: { result: bad, outputs: {} },
          ...results(GATE_JOBS[gate], 'success'),
        };
        assert.equal(decideGate(gate, needs).ok, false);
      });
    }

    it(`${gate} accepts skipped jobs only for a proven tree match`, () => {
      const skipped = results(GATE_JOBS[gate], 'skipped');
      const match = planned('tree-match', { run_e2e: 'false', run_system: 'false' });
      assert.equal(decideGate(gate, { ...match, ...skipped }).ok, true);
      assert.equal(decideGate(gate, { ...planned('full'), ...skipped }).ok, false);
      assert.equal(decideGate(gate, { ...planned('queue'), ...skipped }).ok, false);
    });

    it(`${gate} fails a tree match where a job ran and failed`, () => {
      const match = planned('tree-match', { run_e2e: 'false', run_system: 'false' });
      const needs = { ...match, ...results(GATE_JOBS[gate], 'skipped') };
      needs[GATE_JOBS[gate][0]] = { result: 'failure' };
      assert.equal(decideGate(gate, needs).ok, false);
    });
  }

  it('e2e on a PR accepts skipped browser jobs only when the plan skipped them', () => {
    const none = planned('pr', { run_e2e: 'false', run_system: 'false' });
    const needs = {
      ...none,
      image: { result: 'success' },
      'e2e-shard': { result: 'skipped' },
      'e2e-system': { result: 'skipped' },
    };
    assert.equal(decideGate('e2e', needs).ok, true);
    const wanted = { ...needs, ...planned('pr', { run_e2e: 'true', run_system: 'false' }) };
    assert.equal(decideGate('e2e', wanted).ok, false);
  });

  it('a queue or full run that planned no browser jobs fails', () => {
    for (const mode of ['queue', 'full']) {
      const needs = {
        ...planned(mode, { run_e2e: 'false' }),
        ...results(GATE_JOBS.e2e, 'skipped'),
      };
      assert.equal(decideGate('e2e', needs).ok, false);
    }
  });

  it('full-suite never passes on a partial PR run', () => {
    const needs = { ...planned('pr'), build: { result: 'success' }, e2e: { result: 'success' } };
    assert.equal(decideGate('full-suite', needs).ok, false);
  });

  it('full-suite needs both aggregates', () => {
    for (const mode of ['queue', 'full']) {
      const good = { ...planned(mode), build: { result: 'success' }, e2e: { result: 'success' } };
      assert.equal(decideGate('full-suite', good).ok, true);
      for (const job of ['build', 'e2e']) {
        for (const bad of ['failure', 'cancelled', 'skipped']) {
          assert.equal(decideGate('full-suite', { ...good, [job]: { result: bad } }).ok, false);
        }
      }
    }
  });

  it('an unknown mode fails', () => {
    const needs = { ...planned('surprise'), ...results(GATE_JOBS.build, 'success') };
    assert.equal(decideGate('build', needs).ok, false);
  });
});

describe('shard coverage', () => {
  const spec = (over = {}) => ({ expected: 2, unexpected: 0, flaky: 0, skipped: 0, ...over });

  it('passes when each planned spec ran once', () => {
    const result = checkShardCoverage(
      ['a.spec.ts', 'b.spec.ts'],
      [
        { shard: 1, specs: { 'a.spec.ts': spec() } },
        { shard: 2, specs: { 'b.spec.ts': spec({ flaky: 1 }) } },
      ],
    );
    assert.equal(result.ok, true);
    assert.equal(result.flaky, 1);
  });

  it('fails on a missing, duplicated, unplanned or failed spec', () => {
    const planned = ['a.spec.ts', 'b.spec.ts'];
    const a = { shard: 1, specs: { 'a.spec.ts': spec() } };
    assert.equal(checkShardCoverage(planned, [a]).ok, false);
    assert.equal(
      checkShardCoverage(planned, [
        a,
        { shard: 2, specs: { 'a.spec.ts': spec(), 'b.spec.ts': spec() } },
      ]).ok,
      false,
    );
    assert.equal(
      checkShardCoverage(['a.spec.ts'], [a, { shard: 2, specs: { 'c.spec.ts': spec() } }]).ok,
      false,
    );
    assert.equal(
      checkShardCoverage(
        ['a.spec.ts'],
        [{ shard: 1, specs: { 'a.spec.ts': spec({ unexpected: 1 }) } }],
      ).ok,
      false,
    );
  });

  it('reads a Playwright JSON report', () => {
    const summary = summarize(
      {
        stats: { duration: 10 },
        suites: [
          {
            file: 'a.spec.ts',
            specs: [{ file: 'a.spec.ts', tests: [{ status: 'expected' }, { status: 'flaky' }] }],
            suites: [{ specs: [{ file: 'a.spec.ts', tests: [{ status: 'unexpected' }] }] }],
          },
        ],
      },
      3,
    );
    assert.deepEqual(summary.specs['a.spec.ts'], {
      expected: 1,
      unexpected: 1,
      flaky: 1,
      skipped: 0,
    });
  });
});

describe('spec selection', () => {
  const specs = ['a11y.spec.ts', 'smoke.spec.ts', 'us7-work.spec.ts', 'us3-review.spec.ts'];
  const specSources = new Map([
    ['a11y.spec.ts', 'await page.goto(path);'],
    ['smoke.spec.ts', "await page.goto('/');"],
    ['us7-work.spec.ts', "await page.goto('/work?layout=list');"],
    ['us3-review.spec.ts', "await page.goto('/review/1');"],
  ]);
  const webGraph = buildWebGraph(
    new Map([
      ['web/src/main.tsx', "import './app/router';"],
      [
        'web/src/app/router.tsx',
        "import { Work } from '../routes/work/Work';\nimport { R } from '../routes/review/R';",
      ],
      ['web/src/app/Header.tsx', "import { Logo } from '../components/Logo';"],
      ['web/src/components/Logo.tsx', ''],
      ['web/src/components/Chip.tsx', ''],
      ['web/src/routes/work/Work.tsx', "import { Chip } from '../../components/Chip';"],
      ['web/src/routes/work/Work.test.tsx', "import { Work } from './Work';"],
      ['web/src/routes/review/R.tsx', ''],
      ['web/src/lib/orphan.ts', ''],
    ]),
  );
  const select = (...changed) => selectSpecs({ changed, specs, specSources, webGraph });

  for (const file of [
    'shared/src/index.ts',
    'server/src/app.ts',
    'package.json',
    'pnpm-lock.yaml',
    '.github/workflows/ci.yml',
    '.github/ci/plan.mjs',
    '.mergify.yml',
    'docker/Dockerfile',
    'web/playwright.config.ts',
    'web/package.json',
    'web/e2e/fixtures/index.ts',
    'web/e2e/global-setup.ts',
    'docs/templates/AGENTS-docket.md',
    'design/sample-data.json',
    'skills/docket-worker/SKILL.md',
    'tools/docket-relay/x.ps1',
    'web/src/main.tsx',
    'web/src/app/Header.tsx',
    'web/src/components/Logo.tsx',
    'web/src/lib/orphan.ts',
    'web/src/routes/work/Deleted.tsx',
    'something/new.txt',
  ]) {
    it(`falls back to everything for ${file}`, () => {
      const result = select('docs/README.md', file);
      assert.equal(result.scope, 'all');
      assert.deepEqual(result.specs, specs);
    });
  }

  it('falls back to everything when the changed files are unknown', () => {
    assert.equal(select().scope, 'all');
    assert.equal(selectSpecs({ changed: null, specs, specSources, webGraph }).scope, 'all');
  });

  it('runs no browser spec for documents only', () => {
    const result = select('docs/BUILD_SPEC.md', 'README.md', 'specs/001/spec.md');
    assert.equal(result.scope, 'none');
  });

  it('runs no browser spec for a web unit test', () => {
    assert.equal(select('web/src/routes/work/Work.test.tsx').scope, 'none');
  });

  it('runs just the spec that changed', () => {
    assert.deepEqual(select('web/e2e/us3-review.spec.ts').specs, ['us3-review.spec.ts']);
  });

  it('follows imports to the route, plus smoke and specs it cannot read', () => {
    const result = select('web/src/components/Chip.tsx');
    assert.equal(result.scope, 'some');
    assert.deepEqual(result.specs, ['a11y.spec.ts', 'smoke.spec.ts', 'us7-work.spec.ts']);
  });

  it('reads literal goto targets, and refuses dynamic ones', () => {
    assert.deepEqual([...specUrls("a.goto('/work?x=1'); a.goto('/')")].sort(), ['/', '/work']);
    assert.equal(specUrls('a.goto(path)'), null);
    assert.equal(specUrls("a.goto('/work'); a.goto(path)"), null);
    assert.equal(specUrls('no navigation'), null);
  });

  it('treats a shell import as reaching everything', () => {
    assert.equal(affectedAreas('web/src/components/Logo.tsx', webGraph), null);
  });
});

describe('shards', () => {
  const timings = { 'a.spec.ts': 60, 'b.spec.ts': 50, 'c.spec.ts': 40, 'd.spec.ts': 30 };

  it('uses every spec exactly once and balances by time', () => {
    const shards = assignShards(Object.keys(timings), timings, 2);
    assert.deepEqual(shards.flatMap((s) => s.specs).sort(), Object.keys(timings).sort());
    assert.ok(Math.abs(shards[0].seconds - shards[1].seconds) <= 20);
  });

  it('gives a new spec a typical duration', () => {
    const matrix = buildMatrix(['new.spec.ts', ...Object.keys(timings)], timings, 4);
    const listed = matrix.flatMap((row) => row.specs.split(' '));
    assert.equal(listed.length, 5);
    assert.ok(listed.includes('e2e/new.spec.ts'));
  });

  it('marks only the shard holding the kit spec', () => {
    const matrix = buildMatrix(['kit.spec.ts', ...Object.keys(timings)], timings, 4);
    assert.equal(matrix.filter((row) => row.kit).length, 1);
  });

  it('every server test file is in a directory a CI job runs', () => {
    const covered = new Set(['unit', 'integration', 'contract', 'perf']);
    const dirs = readdirSync('server/tests', { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'fixtures')
      .map((entry) => entry.name);
    assert.deepEqual(
      dirs.filter((dir) => !covered.has(dir)),
      [],
    );
    const loose = readdirSync('server/tests').filter((name) => name.endsWith('.test.ts'));
    assert.deepEqual(loose, []);
  });
});

describe('event classification', () => {
  const pr = (ref, repo = REPO) => ({
    pull_request: { head: { ref, sha: 'head-sha', repo: { full_name: repo } } },
  });

  it('recognizes the queue draft, on its head commit', () => {
    assert.deepEqual(classify('pull_request', pr('mergify/merge-queue/abc'), REPO), {
      kind: 'queue',
      sha: 'head-sha',
    });
  });

  it('a fork cannot pose as the queue', () => {
    assert.equal(
      classify('pull_request', pr('mergify/merge-queue/abc', 'evil/repo'), REPO).kind,
      'pr',
    );
  });

  it('ordinary PRs and main', () => {
    assert.equal(classify('pull_request', pr('feature'), REPO).kind, 'pr');
    assert.equal(classify('push', { ref: 'refs/heads/main' }, REPO).kind, 'main');
    assert.equal(classify('push', { ref: 'refs/heads/other' }, REPO).kind, 'other');
  });
});

describe('tree match', () => {
  const run = (over = {}) => ({
    id: 1,
    event: 'pull_request',
    head_branch: 'mergify/merge-queue/abc',
    head_sha: 'draft',
    head_repository: { full_name: REPO },
    ...over,
  });
  const fakeApi =
    ({ runs, trees, jobs }) =>
    async (path) => {
      if (path.includes('/workflows/ci.yml/runs')) return { workflow_runs: runs };
      const commit = /git\/commits\/(.+)$/.exec(path);
      if (commit) return { tree: { sha: trees[commit[1]] } };
      const runJobs = /actions\/runs\/(\d+)\/jobs/.exec(path);
      if (runJobs) return { jobs: jobs[runJobs[1]] ?? [] };
      throw new Error(`unexpected ${path}`);
    };
  const passed = [{ name: 'full-suite', status: 'completed', conclusion: 'success' }];
  const find = (world, tree = 'T') =>
    findPassedTree({ api: fakeApi(world), repository: REPO, tree, currentRunId: 99 });

  it('finds an identical tree that passed the full suite', async () => {
    const match = await find({ runs: [run()], trees: { draft: 'T' }, jobs: { 1: passed } });
    assert.deepEqual(match, { runId: 1, sha: 'draft' });
  });

  it('refuses a different tree', async () => {
    assert.equal(await find({ runs: [run()], trees: { draft: 'U' }, jobs: { 1: passed } }), null);
  });

  for (const [label, jobs] of [
    ['failed', [{ name: 'full-suite', status: 'completed', conclusion: 'failure' }]],
    ['cancelled', [{ name: 'full-suite', status: 'completed', conclusion: 'cancelled' }]],
    ['skipped', [{ name: 'full-suite', status: 'completed', conclusion: 'skipped' }]],
    ['unfinished', [{ name: 'full-suite', status: 'in_progress', conclusion: null }]],
    ['absent', [{ name: 'build', status: 'completed', conclusion: 'success' }]],
  ]) {
    it(`refuses a run whose full-suite is ${label}`, async () => {
      assert.equal(await find({ runs: [run()], trees: { draft: 'T' }, jobs: { 1: jobs } }), null);
    });
  }

  it('refuses a fork, an ordinary PR branch, and this run itself', async () => {
    for (const over of [
      { head_repository: { full_name: 'evil/repo' } },
      { head_branch: 'feature' },
      { id: 99 },
      { event: 'push', head_branch: 'feature' },
    ]) {
      const id = over.id ?? 1;
      const match = await find({
        runs: [run(over)],
        trees: { draft: 'T' },
        jobs: { [id]: passed },
      });
      assert.equal(match, null);
    }
  });

  it('accepts an earlier main run with the same tree', async () => {
    const main = run({ event: 'push', head_branch: 'main', head_sha: 'old' });
    const match = await find({ runs: [main], trees: { old: 'T' }, jobs: { 1: passed } });
    assert.deepEqual(match, { runId: 1, sha: 'old' });
  });
});
