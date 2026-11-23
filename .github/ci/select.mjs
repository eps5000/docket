/**
 * Which browser specs a pull request needs (owner decision 51). This only makes PR feedback
 * faster: the merge queue always runs every spec. When in doubt it answers "all".
 */
import { posix } from 'node:path';

/** Paths that never reach the container or the browser tests. */
const NO_BROWSER_IMPACT = [
  /^docs\/(?!help\/|templates\/)/,
  /^specs\//,
  /^\.specify\//,
  /^\.claude\//,
  /^design\/(?!sample-data\.json$)/,
  /^[^/]+\.md$/,
];

/** `web/src/routes/<area>` to the URLs that show it. Areas not listed follow their importers. */
export const AREA_URLS = {
  overview: ['/', '/overview', '/needs-you'],
  'needs-you': ['/', '/needs-you'],
  work: ['/work'],
  items: ['/items'],
  review: ['/review'],
  labels: ['/labels'],
  decisions: ['/projects'],
  agents: ['/agents'],
  settings: ['/settings'],
  'agent-files': ['/agent-files'],
  brief: ['/brief'],
  help: ['/help'],
  unlock: ['/unlock'],
  dev: ['/dev'],
};

const ROUTER = 'web/src/app/router.tsx';
const SHELL = [/^web\/src\/app\//, /^web\/src\/main\.tsx$/, /^web\/src\/App\.tsx$/];
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const IMPORT =
  /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g;
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.css', '/index.ts', '/index.tsx'];

export function areaOf(file) {
  const match = /^web\/src\/routes\/([^/]+)\//.exec(file);
  return match && AREA_URLS[match[1]] ? match[1] : null;
}

/** File to the set of files that import it, for non-test sources under web/src. */
export function buildWebGraph(sources) {
  const graph = new Map();
  for (const file of sources.keys()) if (!TEST_FILE.test(file)) graph.set(file, new Set());
  for (const [file, source] of sources) {
    if (TEST_FILE.test(file)) continue;
    for (const match of source.matchAll(IMPORT)) {
      const spec = (match[1] ?? match[2] ?? match[3]).split('?')[0];
      if (!spec.startsWith('.')) continue;
      const base = posix.normalize(posix.join(posix.dirname(file), spec));
      const target = RESOLVE_SUFFIXES.map((suffix) => base + suffix).find((p) => graph.has(p));
      if (target) graph.get(target).add(file);
    }
  }
  return graph;
}

/** The route areas a file reaches, or null when it reaches the shell or can't be placed. */
export function affectedAreas(file, graph) {
  if (!graph.has(file)) return null;
  const areas = new Set();
  const seen = new Set([file]);
  const queue = [file];
  while (queue.length > 0) {
    const current = queue.shift();
    const area = areaOf(current);
    if (area) areas.add(area);
    const importers = graph.get(current);
    if (importers.size === 0 && !area) return null;
    for (const importer of importers) {
      if (importer === ROUTER) {
        if (!area) return null;
        continue;
      }
      if (SHELL.some((pattern) => pattern.test(importer))) return null;
      if (!seen.has(importer)) {
        seen.add(importer);
        queue.push(importer);
      }
    }
  }
  return areas.size > 0 ? areas : null;
}

/** The URL roots a spec opens, or null when any navigation isn't a plain literal path. */
export function specUrls(source) {
  const total = source.match(/\.goto\(/g)?.length ?? 0;
  if (total === 0) return null;
  const literals = [...source.matchAll(/\.goto\(\s*(['"`])(\/[^'"`$?#]*)/g)];
  if (literals.length !== total) return null;
  return new Set(literals.map((m) => (m[2] === '/' ? '/' : `/${m[2].split('/')[1]}`)));
}

/**
 * @param changed repo-relative paths the PR changes
 * @param specs spec file names in web/e2e
 * @param specSources spec file name to source
 * @param webGraph result of buildWebGraph
 * @returns {{ scope: 'all' | 'some' | 'none', specs: string[], reason: string }}
 */
export function selectSpecs({ changed, specs, specSources, webGraph }) {
  const all = (reason) => ({ scope: 'all', specs: [...specs], reason });
  if (!changed || changed.length === 0) return all('the changed files could not be read');

  const chosen = new Set();
  const areas = new Set();
  for (const file of changed) {
    if (NO_BROWSER_IMPACT.some((pattern) => pattern.test(file))) continue;
    const spec = /^web\/e2e\/([^/]+\.spec\.ts)$/.exec(file);
    if (spec) {
      if (specs.includes(spec[1])) chosen.add(spec[1]);
      continue;
    }
    if (file.startsWith('docs/help/')) {
      areas.add('help');
      continue;
    }
    if (file.startsWith('web/src/')) {
      if (TEST_FILE.test(file)) continue;
      const hit = affectedAreas(file, webGraph);
      if (!hit) return all(`${file} reaches the app shell or can't be placed`);
      for (const area of hit) areas.add(area);
      continue;
    }
    return all(`${file} can affect every screen`);
  }

  if (areas.size > 0) {
    const urls = new Set([...areas].flatMap((area) => AREA_URLS[area]));
    for (const name of specs) {
      const opened = specUrls(specSources.get(name) ?? '');
      if (name === 'smoke.spec.ts' || !opened || [...opened].some((url) => urls.has(url))) {
        chosen.add(name);
      }
    }
  }

  const selected = specs.filter((name) => chosen.has(name));
  if (selected.length === 0) {
    return { scope: 'none', specs: [], reason: 'no change reaches a browser spec' };
  }
  if (selected.length === specs.length) return all('the change reaches every spec');
  return {
    scope: 'some',
    specs: selected,
    reason: areas.size > 0 ? `areas: ${[...areas].sort().join(', ')}` : 'only spec files changed',
  };
}

/** Longest-first assignment to the least-loaded shard, using real per-file seconds. */
export function assignShards(specs, timings, shardCount) {
  const known = Object.values(timings)
    .filter((seconds) => seconds > 0)
    .sort((a, b) => a - b);
  const typical = known.length > 0 ? known[Math.floor(known.length / 2)] : 15;
  const cost = (spec) => (timings[spec] ?? typical) + 2;
  const shards = Array.from({ length: shardCount }, () => ({ specs: [], seconds: 0 }));
  const ordered = [...specs].sort((a, b) => cost(b) - cost(a) || a.localeCompare(b));
  for (const spec of ordered) {
    const lightest = shards.reduce((best, shard) => (shard.seconds < best.seconds ? shard : best));
    lightest.specs.push(spec);
    lightest.seconds += cost(spec);
  }
  return shards.filter((shard) => shard.specs.length > 0);
}
