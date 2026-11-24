/**
 * The git source (B76; BUILD_SPEC §5.35). Every git read Docket needs is made
 * here on the host, so Docket's container runs no git and needs no code folder
 * to read. Docket says what to read in this source's settings, and keeps all
 * the judging (findings, verdicts, Problems) on its side:
 *
 * - the conflict radar's trial merges, with each in-flight item's branches
 *   and main, and between items' branches that touch a common part or file;
 * - branch discovery for an item with no reported branch;
 * - commits on a run's branches since a time (commit activity);
 * - where a worktree's commit stands (the worktree check);
 * - Docket's own install manifest on the main branch.
 *
 * **Read-only** (lib/git.mjs): no fetch, no checkout, no lazy fetch, no
 * optional locks, nothing written to the repository. A trial merge writes its
 * trees into a throwaway object folder, removed after the pass.
 *
 * **Privacy.** What leaves this file: branch names, SHAs, times, counts,
 * booleans, Docket's own manifest identifiers, and one kind of file name: the
 * conflicting files a trial merge reports (`merge-tree --name-only`), only for
 * a real conflict, at most 50 per merge and 300 characters each. The files a
 * branch changed are read to decide which pairs to merge, and never kept past
 * the pass, sent or logged. No file contents and no `git status` names.
 *
 * **Bounded:** 30 seconds a call, two and a half minutes a pass, and after
 * three reads with no answer a project's pass stops asking. What it didn't
 * reach is left out, so Docket treats it as unknown and changes nothing
 * because of it.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGit } from '../lib/git.mjs';
import { lazyFetchRisk, linkCheck, safeHostPath, validBranch } from './worktrees.mjs';

export const name = 'git';
export const intervalMs = 3 * 60_000;
/** Conflict file lists make these records larger than most. */
export const batchSize = 50;

/** At least one project has a repository the host can reach. */
export const enabled = (settings) =>
  settings?.enabled === true && Array.isArray(settings.projects) && settings.projects.length > 0;

export const DEFAULT_LIMITS = Object.freeze({
  perCallMs: 30_000,
  passMs: 150_000,
  /** Reads with no answer before a project's pass stops asking. */
  maxUnknown: 3,
  maxItems: 200,
  branchesPerItem: 10,
  maxBranches: 200,
  /** Trial merges between two items' branches in one pass. */
  maxPairMerges: 300,
  maxCommitReads: 100,
  maxHeads: 200,
  maxFiles: 50,
  maxPath: 300,
  maxMatches: 20,
  commitsPerRef: 50,
  maxManifestBytes: 256 * 1024,
});

const SHA = /^[0-9a-f]{40,64}$/i;
const SHORT_SHA = /^[0-9a-f]{7,64}$/i;
const ITEM = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const CLIENTS = new Set(['claude', 'codex']);
const MANIFEST_PATH = /^[A-Za-z0-9._/-]{1,200}$/;
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const VERSION_ID = /^[A-Za-z0-9:._-]{1,80}$/;
const FILE_KEY = /^[A-Za-z0-9:._/-]{1,200}$/;

const hasControl = (text) =>
  [...text].some((c) => {
    const code = c.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });

const idOf = (...parts) =>
  createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 24);

const strings = (value, max) =>
  Array.isArray(value) ? value.filter((v) => typeof v === 'string').slice(0, max) : [];

/**
 * An item key (`GF-239`) or Jira key (`GAMEFLOW-239`) as a whole token of a
 * branch name, in any case, with or without the hyphen. The same rule as
 * Docket's radar (radar.ts `keyPattern`).
 */
export function keyPattern(key) {
  const m = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(String(key).trim());
  if (!m) return null;
  return new RegExp(`(?<![A-Za-z0-9])${m[1]}-?${m[2]}(?![A-Za-z0-9])`, 'i');
}

/** The branches whose names hold any of `keys` as a whole token, sorted. */
export function branchesNaming(keys, branches) {
  const patterns = keys.map(keyPattern).filter(Boolean);
  return branches.filter((b) => patterns.some((p) => p.test(b))).sort();
}

/**
 * The conflicting files from `git merge-tree --write-tree --name-only
 * --no-messages`: the first line is the tree, then one file per line. Capped;
 * `more` says some were left out.
 */
export function conflictFiles(stdout, limits = DEFAULT_LIMITS) {
  const names = [
    ...new Set(
      stdout
        .split('\n')
        .slice(1)
        .map((line) => line.replace(/\r$/, ''))
        .filter(Boolean),
    ),
  ].sort();
  const usable = names.filter((n) => n.length <= limits.maxPath && !hasControl(n));
  const files = usable.slice(0, limits.maxFiles);
  return { files, more: files.length < names.length };
}

/** Docket's install manifest, reduced to its identifiers and hashes; null if it isn't one. */
export function parseManifest(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.files)) return null;
  const files = [];
  for (const f of parsed.files.slice(0, 200)) {
    if (
      f &&
      typeof f.key === 'string' &&
      FILE_KEY.test(f.key) &&
      !f.key.includes('..') &&
      typeof f.version_id === 'string' &&
      VERSION_ID.test(f.version_id) &&
      typeof f.sha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(f.sha256)
    ) {
      files.push({ key: f.key, version_id: f.version_id, sha256: f.sha256 });
    }
  }
  const id = parsed.install_id;
  return { install_id: typeof id === 'string' && ID.test(id) ? id : null, files };
}

class NoAnswer extends Error {}

/** `fn` over `list` with at most `workers` at once, in order of the list. */
async function eachLimited(list, workers, fn) {
  let next = 0;
  const run = async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= list.length) return;
      await fn(list[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(workers, list.length) }, run));
}

/** One project's pass. Returns its records, the closing `pass` record last. */
async function readProject(git, project, limits, signal, deadline, nowMs) {
  const checked_at = new Date(nowMs()).toISOString();
  const pass_id = `${nowMs().toString(36)}-${randomBytes(4).toString('hex')}`;
  const keyOf = (kind, id) => `${kind}:${project.key}:${pass_id}${id ? `:${id}` : ''}`;
  const base = (kind, id) => ({ key: keyOf(kind, id), kind, project: project.key, pass_id });
  const records = [];
  const close = (status, extra = {}) => ({
    ...base('pass'),
    repo_path: project.repo_path,
    main_branch: project.main_branch,
    status,
    main_ref: null,
    checked_at,
    complete: false,
    pairs_done: false,
    pairs: 0,
    ...extra,
  });
  const dir = project.host_path;
  // B76 review: a path through a link could read a repository outside the one named.
  if (
    !safeHostPath(dir) ||
    typeof project.main_branch !== 'string' ||
    (await linkCheck(dir)) !== 'ok'
  ) {
    return [close('unreadable')];
  }

  // After a few reads with no answer, or past the pass's time, the rest are unknown at once.
  const giveUp = new AbortController();
  const stop = signal ? AbortSignal.any([signal, giveUp.signal]) : giveUp.signal;
  let noAnswers = 0;
  let complete = true;
  const late = () => nowMs() >= deadline;
  const read = async (args, extra = {}) => {
    if (late()) giveUp.abort();
    const r = await git.read(dir, args, { signal: stop, timeoutMs: limits.perCallMs, ...extra });
    if (r.unknown) {
      noAnswers += 1;
      complete = false;
      if (noAnswers >= limits.maxUnknown) giveUp.abort();
      throw new NoAnswer();
    }
    return r;
  };
  const answer = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof NoAnswer) return undefined;
      throw err;
    }
  };

  const common = await answer(() =>
    read(['rev-parse', '--path-format=absolute', '--git-common-dir']),
  );
  if (common === undefined) return [close('unknown')];
  const commonDir = common.status === 0 ? common.stdout.trim() : '';
  if (!commonDir) return [close('unreadable')];
  if (await lazyFetchRisk(git, dir, { signal: stop, timeoutMs: limits.perCallMs })) {
    return [close('unreadable')];
  }

  // The main branch: local first for the radar, both for "is it on main".
  const mainRefs = [];
  if (validBranch(project.main_branch)) {
    for (const ref of [
      `refs/heads/${project.main_branch}`,
      `refs/remotes/origin/${project.main_branch}`,
    ]) {
      const r = await answer(() => read(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]));
      if (r === undefined) return [close('unknown')];
      if (r.status === 0) mainRefs.push(ref);
    }
  }
  const mainRef = mainRefs[0] ?? null;
  const main_ref = !mainRef ? null : mainRef.startsWith('refs/heads/') ? 'heads' : 'origin';

  const tmp = await mkdtemp(join(tmpdir(), 'docket-git-'));
  const objects = {
    GIT_OBJECT_DIRECTORY: tmp,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(commonDir, 'objects'),
  };
  let pairsDone = false;
  let pairCount = 0;
  try {
    if (mainRef) {
      const radar = await readRadar();
      pairsDone = radar.pairsDone;
      pairCount = radar.pairs;
    }
    await readCommits();
    await readHeads();
    await readManifests();
  } finally {
    await rm(tmp, { recursive: true, force: true, maxRetries: 2 });
  }
  records.push(
    close('ok', {
      main_ref,
      complete: complete && !late() && !signal?.aborted,
      pairs_done: pairsDone,
      pairs: pairCount,
    }),
  );
  return records;

  // ---- The radar: discovery, each branch with main, related pairs ----
  async function readRadar() {
    const items = (Array.isArray(project.items) ? project.items : [])
      .filter((i) => i && typeof i.id === 'string' && ITEM.test(i.id))
      .slice(0, limits.maxItems);
    if (Array.isArray(project.items) && project.items.length > items.length) complete = false;
    let local = null;
    const localBranches = async () => {
      if (local) return local;
      const out = new Set();
      const heads = await read(['for-each-ref', '--format=%(refname)', 'refs/heads']);
      if (heads.status === 0) {
        for (const line of heads.stdout.split('\n')) {
          const name = line.replace(/\r$/, '');
          if (name.startsWith('refs/heads/')) out.add(name.slice(11));
        }
      }
      const trees = await read(['worktree', 'list', '--porcelain']);
      if (trees.status === 0) {
        for (const line of trees.stdout.split('\n')) {
          const name = line.replace(/\r$/, '');
          if (name.startsWith('branch refs/heads/')) out.add(name.slice(18));
        }
      }
      local = [...out].filter((b) => validBranch(b) && b !== project.main_branch).sort();
      return local;
    };

    const flights = [];
    for (const item of items) {
      let names = strings(item.branches, limits.branchesPerItem).filter(validBranch);
      if (names.length === 0) {
        const all = await answer(localBranches);
        if (all === undefined) {
          records.push({ ...base('item', item.id), item: item.id, read: 'unknown', matches: [] });
          continue;
        }
        const removed = new Set(strings(item.removed, 50));
        const keys = [item.id, ...strings(item.keys, 5)];
        const matches = branchesNaming(keys, all).filter((b) => !removed.has(b));
        records.push({
          ...base('item', item.id),
          item: item.id,
          read: 'ok',
          matches: matches.slice(0, limits.maxMatches),
        });
        names = matches.length === 1 ? matches : [];
      }
      const parts = new Set(strings(item.parts, 100));
      const handed = strings(item.files, 500);
      for (const branch of names) {
        if (branch !== project.main_branch) flights.push({ item: item.id, branch, parts, handed });
      }
    }

    // Each branch once, even when two items report it.
    const branches = [...new Set(flights.map((f) => f.branch))];
    if (branches.length > limits.maxBranches) complete = false;
    const facts = new Map();
    await eachLimited(branches.slice(0, limits.maxBranches), 2, async (branch) => {
      const fact = await readBranch(branch);
      facts.set(branch, fact);
      records.push(fact.record);
    });

    // Pairs of different items' branches that touch a common part or file.
    let merges = 0;
    let pairs = 0;
    const seen = new Set();
    for (let i = 0; i < flights.length; i += 1) {
      for (let j = i + 1; j < flights.length; j += 1) {
        const [x, y] = [flights[i], flights[j]];
        if (x.item === y.item || x.branch === y.branch) continue;
        const fx = facts.get(x.branch);
        const fy = facts.get(y.branch);
        if (!fx?.usable || !fy?.usable) continue;
        const [a, b] = x.branch < y.branch ? [x, y] : [y, x];
        const k = `${a.branch}\u0000${b.branch}`;
        if (seen.has(k)) continue;
        const files = (f, own) => new Set([...f.handed, ...own.changed]);
        const filesA = files(a, facts.get(a.branch));
        // A branch whose changed files couldn't be listed can't be called unrelated: merge it.
        const related =
          !facts.get(a.branch).changedKnown ||
          !facts.get(b.branch).changedKnown ||
          [...a.parts].some((p) => b.parts.has(p)) ||
          [...files(b, facts.get(b.branch))].some((f) => filesA.has(f));
        // B76 review: another item pair on the same two branches may still be related.
        if (!related) continue;
        seen.add(k);
        if (merges >= limits.maxPairMerges || late() || stop.aborted) {
          complete = false;
          return { pairsDone: false, pairs };
        }
        merges += 1;
        const r = await answer(() =>
          read(['merge-tree', '--write-tree', '--name-only', '--no-messages', a.ref, b.ref], {
            objects,
          }),
        );
        pairs += 1;
        records.push({
          ...base('pair', idOf(a.branch, b.branch)),
          a: a.branch,
          b: b.branch,
          ...mergeResult(r),
        });
      }
    }
    return { pairsDone: true, pairs };

    async function readBranch(branch) {
      const record = {
        ...base('branch', idOf(branch)),
        name: branch,
        read: 'unknown',
        ref: null,
        merged: null,
        main: 'unknown',
        files: [],
        more: false,
      };
      const asMain = ({ state, ...rest }) => ({ main: state, ...rest });
      try {
        let ref = null;
        for (const candidate of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
          const r = await read(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
          if (r.status === 0) {
            ref = candidate;
            break;
          }
        }
        if (!ref) return { record: { ...record, read: 'missing' }, usable: false };
        const diff = await read(['diff', '--name-only', '--no-renames', `${mainRef}...${ref}`]);
        // Held only for this pass, to judge which pairs are related. Never sent.
        const changed = diff.status === 0 ? diff.stdout.split('\n').filter(Boolean) : [];
        const changedKnown = diff.status === 0;
        const merge = await read(
          ['merge-tree', '--write-tree', '--name-only', '--no-messages', mainRef, ref],
          { objects },
        );
        const merged = await answer(() => read(['merge-base', '--is-ancestor', ref, mainRef]));
        for (const f of flights) if (f.branch === branch) f.ref = ref;
        return {
          record: {
            ...record,
            read: 'ok',
            ref: ref.startsWith('refs/heads/') ? 'heads' : 'origin',
            merged:
              merged === undefined
                ? null
                : merged.status === 0
                  ? true
                  : merged.status === 1
                    ? false
                    : null,
            ...asMain(mergeResult(merge)),
          },
          usable: true,
          changed,
          changedKnown,
        };
      } catch (err) {
        if (err instanceof NoAnswer) return { record, usable: false };
        throw err;
      }
    }
  }

  // ---- Commit activity ----
  async function readCommits() {
    const asked = (Array.isArray(project.commits) ? project.commits : []).filter(
      (c) => c && validBranch(String(c.branch ?? '')) && !Number.isNaN(Date.parse(c.since)),
    );
    if (asked.length > limits.maxCommitReads) complete = false;
    for (const { branch, since } of asked.slice(0, limits.maxCommitReads)) {
      const after = Date.parse(since);
      const record = { ...base('commits', idOf(branch)), branch, since, read: 'ok', commits: [] };
      const seen = new Map();
      try {
        for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
          const r = await read([
            'log',
            '--format=%H %ct',
            '-n',
            String(limits.commitsPerRef),
            `--since=${since}`,
            ref,
            '--',
          ]);
          if (r.status !== 0) continue;
          for (const line of r.stdout.split('\n')) {
            const [sha, ct] = line.trim().split(' ');
            const at = Number(ct) * 1000;
            if (!sha || !SHA.test(sha) || !Number.isFinite(at) || at <= after) continue;
            if (!seen.has(sha)) seen.set(sha, at);
          }
        }
        record.commits = [...seen]
          .sort((x, y) => y[1] - x[1])
          .slice(0, limits.commitsPerRef)
          .map(([sha, at]) => ({ sha: sha.toLowerCase(), at: new Date(at).toISOString() }));
      } catch (err) {
        if (!(err instanceof NoAnswer)) throw err;
        record.read = 'unknown';
        record.commits = [];
      }
      records.push(record);
    }
  }

  // ---- Where each worktree's commit stands ----
  async function readHeads() {
    const asked = [...new Set(strings(project.heads, 10_000).filter((s) => SHORT_SHA.test(s)))];
    if (asked.length > limits.maxHeads) complete = false;
    for (const sha of asked.slice(0, limits.maxHeads)) {
      const record = {
        ...base('head', idOf(sha.toLowerCase())),
        sha,
        head: null,
        read: 'unknown',
        on_main: null,
        on_remote: null,
        unpushed: null,
      };
      try {
        const resolved = await read(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
        const full = resolved.stdout.trim().toLowerCase();
        if (resolved.status !== 0 || !SHA.test(full)) {
          records.push({ ...record, read: 'missing' });
          continue;
        }
        let onMain = false;
        for (const ref of mainRefs) {
          if ((await read(['merge-base', '--is-ancestor', full, ref])).status === 0) {
            onMain = true;
            break;
          }
        }
        const remote = await read([
          'for-each-ref',
          '--count=1',
          '--format=%(refname)',
          `--contains=${full}`,
          'refs/remotes',
        ]);
        const count = await read(['rev-list', '--count', full, '--not', '--remotes', ...mainRefs]);
        const unpushed = count.status === 0 ? Number(count.stdout.trim()) : Number.NaN;
        records.push({
          ...record,
          head: full,
          read: 'ok',
          on_main: onMain,
          on_remote: remote.status === 0 ? remote.stdout.trim() !== '' : null,
          unpushed:
            Number.isInteger(unpushed) && unpushed >= 0 ? Math.min(unpushed, 1_000_000) : null,
        });
      } catch (err) {
        if (!(err instanceof NoAnswer)) throw err;
        records.push(record);
      }
    }
  }

  // ---- Docket's install manifest on main (owner decision 56) ----
  async function readManifests() {
    const asked = (Array.isArray(project.manifests) ? project.manifests : []).filter(
      (m) => m && CLIENTS.has(m.client),
    );
    // origin's copy first: it's what has landed.
    const ref = mainRefs.find((r) => r.startsWith('refs/remotes/')) ?? mainRefs[0] ?? null;
    for (const { client, paths } of asked) {
      const record = {
        ...base('manifest', client),
        client,
        state: 'unknown',
        install_id: null,
        files: [],
      };
      const usable = strings(paths, 4).filter(
        (p) => MANIFEST_PATH.test(p) && !p.split('/').includes('..') && !p.startsWith('/'),
      );
      if (!ref || usable.length === 0) {
        records.push(record);
        continue;
      }
      try {
        let found = { ...record, state: 'absent' };
        for (const path of usable) {
          const r = await read(['show', `${ref}:${path}`]);
          if (r.status !== 0) continue;
          const parsed =
            r.stdout.length <= limits.maxManifestBytes ? parseManifest(r.stdout) : null;
          found = parsed ? { ...record, state: 'present', ...parsed } : record;
          break;
        }
        records.push(found);
      } catch (err) {
        if (!(err instanceof NoAnswer)) throw err;
        records.push(record);
      }
    }
  }
}

/** A trial merge's answer as a record's fields. */
function mergeResult(r) {
  if (r === undefined) return { state: 'unknown', files: [], more: false };
  if (r.status === 0) return { state: 'clean', files: [], more: false };
  if (r.status === 1) return { state: 'conflict', ...conflictFiles(r.stdout) };
  return { state: 'failed', files: [], more: false };
}

/**
 * One pass over every project. `options` is for tests: `git`, `limits`, `now`,
 * `env`. Returns `{ records, state }`; the runner saves `state` once the
 * records are posted.
 */
export async function collect(ctx, options = {}) {
  const { state, log, signal, settings } = ctx;
  const previous = state?.v === 1 ? state : { v: 1, next: 0 };
  if (!enabled(settings)) return { records: [], state: previous };

  const git = options.git ?? createGit(options.env ? { env: options.env } : {});
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const nowMs = options.now ?? Date.now;
  const deadline = nowMs() + limits.passMs;
  const timed = AbortSignal.timeout(limits.passMs);
  const passSignal = signal ? AbortSignal.any([signal, timed]) : timed;
  const projects = settings.projects.filter((p) => p && typeof p.key === 'string');
  const first = projects.length > 0 ? (previous.next ?? 0) % projects.length : 0;
  const records = [];
  let done = 0;
  for (let i = 0; i < projects.length; i += 1) {
    if (passSignal.aborted || nowMs() >= deadline) break;
    const project = projects[(first + i) % projects.length];
    records.push(...(await readProject(git, project, limits, passSignal, deadline, nowMs)));
    done += 1;
  }
  // Counts only: no path, branch or file name reaches the log.
  log?.('git_read', {
    projects: done,
    branches: records.filter((r) => r.kind === 'branch').length,
    pairs: records.filter((r) => r.kind === 'pair').length,
  });
  return {
    records,
    state: { v: 1, next: done === projects.length ? 0 : (first + done) % projects.length },
  };
}

export default { name, intervalMs, batchSize, enabled, collect };
