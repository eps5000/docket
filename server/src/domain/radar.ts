/**
 * The conflict radar (owner decision 36; BUILD_SPEC §5.21 Conflict radar;
 * FR-163; tasks.md T184).
 *
 * Every 15 minutes (jobs/sweeper.ts `startRadar`), and on *Run radar now*,
 * Docket trial-merges each in-flight item's branch with the project's main
 * branch, and each pair of in-flight branches whose items declare a common
 * part or change a common file, with
 * `git merge-tree --write-tree --name-only`.
 *
 * **Read-only:** every git call that could write objects runs with
 * `GIT_OBJECT_DIRECTORY` set to a fresh temporary folder and the repository's
 * objects as `GIT_ALTERNATE_OBJECT_DIRECTORIES`, so the trees a trial merge
 * writes land in the temporary folder, which is removed afterwards. Nothing
 * else runs that writes: no fetch (local refs only, which worktrees share), no
 * checkout, no index (`GIT_OPTIONAL_LOCKS=0`), no gc. The tests hash the
 * fixture repository's `.git` before and after a run.
 *
 * A run is three steps, so the git work never holds the write transaction:
 * `plan` (read the database, run git), `record` (findings and their clearing,
 * with events `radar.found` and `radar.cleared`, through the write path), and
 * `finish` (the run's time and any "Radar off" reason on the project, which is
 * bookkeeping like a run's signal, not an event).
 *
 * `repo_path` must resolve inside `DOCKET_PUSH_ROOT` (push-root.ts rules: no
 * `..`, host paths mapped onto the root, symlinks followed only inside it).
 * Without git or a repository the radar is off ("Radar off: no repository")
 * and everything else works.
 *
 * **Branches (B40):** an item's branch is the latest one reported for it:
 * `declare_shared_changes`' `branch` or the owner's Shared changes section
 * (`items.branch`, which the owner may also clear), its latest packet's, its
 * lead run's or its latest claim's. An in-flight item with none gets one by
 * discovery: the local branches (`git for-each-ref refs/heads` and
 * `git worktree list --porcelain`) whose name holds the item's key, or its
 * Jira key, as a whole token, in any case and with or without the hyphen
 * (`gf-239`, `GF-239`, `gf239`, `gameflow-239`). One match is used (source
 * `discovered`); several are none ("several branches match"), and the run
 * records them on the item so the owner can report one. A reported branch
 * always wins over a discovered one.
 *
 * **Several branches (B41):** an item keeps a set of reported branches
 * (`items.branches`, up to 10). `declare_shared_changes` replaces it, the
 * owner adds or removes one, and `claim_lead`, `submit_packet` and
 * `set_status` add theirs. The radar trial-merges every reported branch of
 * every in-flight item with the main branch, and pairs of branches of
 * different items; two branches of the same item are not a cross-item
 * conflict and aren't checked. Discovery runs only for an item with none.
 *
 * **One root cause, one problem (B42; owner decision 37):** a branch that
 * conflicts with the main branch is one "out of date with main" finding. A
 * pair finding is kept only for the files that conflict beyond what either
 * branch's conflict with main explains; a pair whose every conflicting file
 * is explained is left out (`RadarPlan.suppressed`), and an open finding for
 * it clears. A finding clears as soon as its branch stops being reported
 * (`writeBranches`), not at the next run. A newly found conflict is posted
 * to each item it involves as one note ("Docket's conflict radar: …"), so
 * the items' leads read it on their next `get_item`.
 *
 * **Not an active branch stays out (B45):** that action is remembered in
 * `items.branches`, so discovery looks for another branch rather than
 * adopting the same one at its next run. Undo, or anyone reporting that name
 * again, brings it back. A plain Remove doesn't: the radar may find it again.
 *
 * **Text conflicts get a merge order (B46; owner decision 39):** a real
 * conflict between two in-flight branches stops neither agent. Docket picks
 * who merges first (the first to merge, or the earlier claim) and tells both
 * leads; the later one rebases. The radar answers only whether the *lines*
 * collide, and it sees committed local branches only. A clean trial merge
 * means git can combine them, not that they work together, so it never
 * overrides a sequence decided from the declarations (overlap-policy.ts).
 *
 * **Never freezes the server (B52):** git runs in async child processes,
 * bounded and timed (git-read.ts). A read with no answer is *unknown*: the
 * findings and discovery it would have decided stay as they are. One run per
 * project at a time (`RadarRuns`); *Run radar now* during a run joins it. The
 * plan keeps what it read the database against (`RadarBasis`), and `record`
 * applies nothing for an item or project that changed since, so a slow run
 * can't undo what the owner did meanwhile (B45's race).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  LIMITS,
  TEXT_LIMITS,
  ToolError,
  type BranchSource,
  type RadarResponse,
} from '@docket/shared';
import type { Db } from '../db/client.js';
import type { Config } from '../config.js';
import type { ReadContext } from './contracts.js';
import { git, GitUnknown, known } from './git-read.js';
import { newId } from './ids.js';
import { explain } from './problems.js';
import { callerName, ms } from './model.js';
import { isInside, rootSegments } from './push-root.js';
import type { InverseOp, WriteContext } from './write.js';

/** How often the scheduler runs the radar (BUILD_SPEC §5.21: at least every 15 minutes). */
export const RADAR_INTERVAL_MS = 15 * 60_000;
/** Decision 39: how soon after a reported branch or commit the radar runs. */
export const RADAR_DEBOUNCE_MS = 10_000;
/** Decision 39: a project's radar runs at most this often on reports. */
export const RADAR_MIN_GAP_MS = 60_000;

/** B52: how long after the listener is up the first scheduled radar pass starts. */
export const RADAR_FIRST_MS = 15_000;
/** B52: after this many reads with no answer, a run stops asking git and keeps what it has. */
const RADAR_MAX_UNKNOWN_READS = 3;

export const RADAR_OFF_NO_REPO = 'Radar off: no repository';

/** A branch name the radar will pass to git: no option-like or path-escaping names. */
export function validBranch(name: string): boolean {
  return (
    /^[A-Za-z0-9._/@+-]+$/.test(name) &&
    !name.startsWith('-') &&
    !name.includes('..') &&
    !name.startsWith('/') &&
    !name.endsWith('/') &&
    !name.endsWith('.lock')
  );
}

/** The repository folder `repo_path` names, inside the push root; throws `validation`. */
export function resolveRepoPath(config: Config, repoPath: string): string {
  if (!config.pushRoot) {
    throw new ToolError(
      'validation',
      'The radar reads a repository inside the push folder, and DOCKET_PUSH_ROOT isn’t set. Mount a folder and set DOCKET_PUSH_ROOT first.',
    );
  }
  let root: string;
  try {
    root = realpathSync(config.pushRoot);
  } catch {
    throw new ToolError(
      'validation',
      `The push folder ${config.pushRoot} isn't mounted. Check the volume in docker/compose.yaml.`,
    );
  }
  const segs = rootSegments(repoPath, config.pushRoot, config.pushHostPath);
  const joined = join(root, ...segs);
  if (!isInside(root, joined)) {
    throw new ToolError(
      'validation',
      'That folder is outside the push folder. Choose one inside it.',
    );
  }
  let real: string;
  try {
    real = realpathSync(joined);
  } catch {
    throw new ToolError('validation', `There's no folder at ${repoPath} in the push folder.`);
  }
  if (!isInside(root, real)) {
    throw new ToolError(
      'validation',
      `${repoPath} links outside the push folder; Docket won't follow it.`,
    );
  }
  if (!statSync(real).isDirectory()) {
    throw new ToolError('validation', `${repoPath} isn't a folder.`);
  }
  return real;
}

/**
 * The repository's shared objects folder (worktrees share one), or why there
 * isn't one. `unknown` means the read had no answer, which isn't "no repository".
 */
export async function probeRepo(
  dir: string,
  signal?: AbortSignal,
): Promise<{ ok: true; objects: string } | { ok: false; unknown?: boolean }> {
  const r = await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], {}, signal);
  if (r.unknown) return { ok: false, unknown: true };
  if (r.missing || r.status !== 0) return { ok: false };
  const common = r.stdout.trim();
  return common ? { ok: true, objects: join(common, 'objects') } : { ok: false };
}

/**
 * A git session over one repository with a throwaway object directory. A read
 * with no answer (timed out, cancelled) throws `GitUnknown`.
 */
export class RadarGit {
  private constructor(
    readonly dir: string,
    private readonly tmp: string,
    private readonly env: Record<string, string>,
    private readonly signal?: AbortSignal,
  ) {}

  static async open(dir: string, objects: string, signal?: AbortSignal): Promise<RadarGit> {
    const tmp = await mkdtemp(join(tmpdir(), 'docket-radar-'));
    const env = { GIT_OBJECT_DIRECTORY: tmp, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects };
    return new RadarGit(dir, tmp, env, signal);
  }

  private async read(args: string[]) {
    return known(await git(this.dir, args, this.env, this.signal));
  }

  /** The full ref for a local branch (or, failing that, origin's copy), or null. */
  async ref(branch: string): Promise<string | null> {
    if (!validBranch(branch)) return null;
    for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
      const r = await this.read(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      if (r.status === 0) return ref;
    }
    return null;
  }

  /**
   * The local branches (B40): `refs/heads`, plus the branch each worktree has
   * checked out (worktrees share `refs/heads`, so this only adds one the
   * first list missed). Names git wouldn't take are left out.
   */
  async branches(): Promise<string[]> {
    const out = new Set<string>();
    const heads = await this.read(['for-each-ref', '--format=%(refname)', 'refs/heads']);
    if (heads.status === 0) {
      for (const line of heads.stdout.split('\n')) {
        if (line.startsWith('refs/heads/')) out.add(line.slice('refs/heads/'.length));
      }
    }
    const trees = await this.read(['worktree', 'list', '--porcelain']);
    if (trees.status === 0) {
      for (const line of trees.stdout.split('\n')) {
        if (line.startsWith('branch refs/heads/')) out.add(line.slice('branch refs/heads/'.length));
      }
    }
    return [...out].filter(validBranch).sort();
  }

  /** Files changed on `ref` since it left `base` (`git diff --name-only base...ref`). */
  async changed(base: string, ref: string): Promise<string[]> {
    const r = await this.read(['diff', '--name-only', '--no-renames', `${base}...${ref}`]);
    if (r.status !== 0) return [];
    return r.stdout.split('\n').filter(Boolean);
  }

  /** Decision 39: whether `ref`'s commits are already on `base` (the branch has merged). */
  async merged(ref: string, base: string): Promise<boolean> {
    return (await this.read(['merge-base', '--is-ancestor', ref, base])).status === 0;
  }

  /** Trial-merge two refs: the conflicting files (empty when clean), or null when git failed. */
  async merge(a: string, b: string): Promise<string[] | null> {
    const r = await this.read(['merge-tree', '--write-tree', '--name-only', '--no-messages', a, b]);
    if (r.status === 0) return [];
    if (r.status !== 1) return null;
    const lines = r.stdout.split('\n');
    return [...new Set(lines.slice(1).filter(Boolean))].sort();
  }

  async close(): Promise<void> {
    await rm(this.tmp, { recursive: true, force: true, maxRetries: 2 });
  }
}

// ---- Plan, record, finish ----

interface Check {
  branch_a: string;
  branch_b: string;
  item_a: string;
  /** Null when `branch_b` is the main branch. */
  item_b: string | null;
  source_a: BranchSource;
  /** Null for the main branch. */
  source_b: BranchSource | null;
  /** Conflicting files; empty when the trial merge is clean. */
  files: string[];
  /** Decision 39: for two items' branches, which item merges first. Null with main. */
  merge_first?: string | null;
}

/** What discovery found for an in-flight item with no reported branch (B40). */
export interface Discovery {
  item: string;
  /** The one matching branch; null with none or several. */
  branch: string | null;
  /** Every matching branch when there are several; empty otherwise. */
  matches: string[];
}

export interface RadarPlan {
  project: string;
  /** Why the radar couldn't run ("Radar off: …"); null when it ran. */
  off: string | null;
  checks: Check[];
  /**
   * B42: pairs that conflict only in files either branch's conflict with the
   * main branch already explains; not findings (their checks are clean).
   */
  suppressed: { branch_a: string; branch_b: string; files: string[] }[];
  /** B40: one per in-flight item without a reported branch. */
  discovered: Discovery[];
  /** B52: what the database said when the run began. */
  basis: RadarBasis;
  /** B52: what git couldn't answer this run. Nothing about these changes. */
  unknown: RadarUnknown;
}

/** B52: the reads with no answer (timed out or cancelled). */
export interface RadarUnknown {
  /** The repository or its main branch: the run changes nothing. */
  all: boolean;
  /** Items whose branch discovery had no answer. */
  items: string[];
  branches: string[];
  /** Branch pairs, in finding order (`branch_a`, `branch_b`). */
  pairs: [string, string][];
}

/** B52: fingerprints of what a run read, to tell whether it's still current. */
export interface RadarBasis {
  project: string;
  /** Per in-flight item at the start of the run. */
  items: Record<string, string>;
}

/** B52: what `recordRadar` did with a plan. */
export interface RadarApplied {
  /** The project's radar settings changed during the run: nothing was applied. */
  discarded: boolean;
  /** Items that changed during the run: left as they are until the next run. */
  stale: string[];
}

interface Flight {
  id: string;
  branch: string;
  source: BranchSource;
  ref: string;
  parts: Set<string>;
  files: Set<string>;
}

/** A branch reported for an item (B41: one entry of `items.branches`). */
export interface Reported {
  name: string;
  /** `owner` or the agent (`claude · orca-w3`); null when not known (migrated). */
  by: string | null;
  at: string;
  /**
   * B45: the owner said it isn't active (*Not an active branch*). Kept in `items.branches`
   * so discovery doesn't adopt it again; reporting the name again lifts it.
   */
  removed?: boolean;
}

/** Every entry of `items.branches`, including those marked not active (B45). */
function storedBranches(db: Db, itemId: string): Reported[] {
  const row = db.sqlite.prepare('SELECT branches FROM items WHERE id = ?').get(itemId) as
    { branches: string | null } | undefined;
  if (!row?.branches) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.branches);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (b): b is Reported =>
      typeof b === 'object' &&
      b !== null &&
      typeof (b as Reported).name === 'string' &&
      typeof (b as Reported).at === 'string',
  );
}

/** The item's reported branches, oldest first (B41); empty when none. */
export function reportedBranches(db: Db, itemId: string): Reported[] {
  return storedBranches(db, itemId).filter((b) => !b.removed);
}

/**
 * Store the item's reported branches (B41) outside its version, like a
 * declaration, and clear at once the item's open findings for a branch the
 * radar no longer checks (B42); returns the inverses for an undoable owner
 * change (the branches, and each cleared finding).
 *
 * `removed` (B45) is a branch the owner just said isn't active: it is
 * remembered so discovery doesn't adopt it again, and dropped from what the
 * radar last discovered, in the same write, so the next run has nothing to
 * record and the owner's Undo still applies.
 */
export function writeBranches(
  w: WriteContext,
  itemId: string,
  list: Reported[],
  removed?: string,
): InverseOp[] {
  const before = w.db.sqlite
    .prepare('SELECT branches, radar_branch, radar_branch_matches FROM items WHERE id = ?')
    .get(itemId) as {
    branches: string | null;
    radar_branch: string | null;
    radar_branch_matches: string | null;
  };
  const names = new Set(list.map((b) => b.name));
  const kept = storedBranches(w.db, itemId).filter(
    (b) => b.removed && !names.has(b.name) && b.name !== removed,
  );
  const gone: Reported[] = removed
    ? [{ name: removed, by: callerName(w.db, w.actor), at: w.now, removed: true }]
    : [];
  const stored = [...list, ...[...kept, ...gone].slice(-LIMITS.item_branches_max)];
  w.db.sqlite
    .prepare('UPDATE items SET branches = ? WHERE id = ?')
    .run(stored.length > 0 ? JSON.stringify(stored) : null, itemId);
  const set: Record<string, unknown> = { branches: before.branches };
  if (removed) {
    set.radar_branch = before.radar_branch;
    set.radar_branch_matches = before.radar_branch_matches;
    const matches = (
      before.radar_branch_matches ? (JSON.parse(before.radar_branch_matches) as string[]) : []
    ).filter((m) => m !== removed);
    w.db.sqlite
      .prepare('UPDATE items SET radar_branch = ?, radar_branch_matches = ? WHERE id = ?')
      .run(
        before.radar_branch === removed ? null : before.radar_branch,
        matches.length > 0 ? JSON.stringify(matches) : null,
        itemId,
      );
  }
  return [{ op: 'update', table: 'items', id: itemId, set }, ...clearUncheckedFindings(w, itemId)];
}

/**
 * B42: clear the item's open findings whose branch on the item's side the
 * radar no longer checks: not among its reported branches, or, with none
 * reported, not the branch the radar found by name. Returns the inverses.
 */
export function clearUncheckedFindings(w: WriteContext, itemId: string): InverseOp[] {
  const reported = reportedBranches(w.db, itemId).map((b) => b.name);
  const found = (
    w.db.sqlite.prepare('SELECT radar_branch FROM items WHERE id = ?').get(itemId) as
      { radar_branch: string | null } | undefined
  )?.radar_branch;
  const checked = new Set(reported.length > 0 ? reported : found ? [found] : []);
  const out: InverseOp[] = [];
  for (const f of w.db.sqlite
    .prepare('SELECT * FROM radar_findings WHERE (item_a = ? OR item_b = ?) AND cleared_at IS NULL')
    .all(itemId, itemId) as Record<string, unknown>[]) {
    const own = f.item_a === itemId ? f.branch_a : f.branch_b;
    if (checked.has(own as string)) continue;
    out.push(clearFinding(w, f, { undoable: true }));
  }
  return out;
}

/**
 * Add the one branch `claim_lead`, `submit_packet` or `set_status` named
 * to the item's reported branches (B41), as reported by the caller. A branch
 * already there stays as it is; a name git wouldn't take is left out; past
 * 10, the oldest makes room. Writes no event: the call's own event carries
 * the branch.
 */
export function addReportedBranch(
  w: WriteContext,
  itemId: string,
  branch: string | null | undefined,
): void {
  const name = branch?.trim();
  if (!name || !validBranch(name)) return;
  const list = reportedBranches(w.db, itemId);
  if (list.some((b) => b.name === name)) return;
  const next = [...list, { name, by: callerName(w.db, w.actor), at: w.now }];
  void writeBranches(w, itemId, next.slice(-LIMITS.item_branches_max));
}

/**
 * A pattern for an item key (`GF-239`) or Jira key (`GAMEFLOW-239`) as a
 * whole token of a branch name (B40), in any case, with or without the
 * hyphen: `eps5000/gf-239-visual-shell` and `GF239` match; `gf-2390` and
 * `xgf-239` don't. Null for a key of another shape.
 */
export function keyPattern(key: string): RegExp | null {
  const m = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(key.trim());
  if (!m) return null;
  return new RegExp(`(?<![A-Za-z0-9])${m[1]}-?${m[2]}(?![A-Za-z0-9])`, 'i');
}

/** The branches whose names hold any of `keys` as a whole token (B40), sorted. */
export function branchesNaming(keys: (string | null)[], branches: string[]): string[] {
  const patterns = keys.flatMap((k) => {
    const p = k ? keyPattern(k) : null;
    return p ? [p] : [];
  });
  return branches.filter((b) => patterns.some((p) => p.test(b))).sort();
}

/** When the item's current lead claimed it (its latest lead run), for "claimed first". */
export function claimedAt(db: Db, itemId: string): string {
  const row = db.sqlite
    .prepare('SELECT max(created_at) AS at FROM runs WHERE item_id = ? AND is_lead = 1')
    .get(itemId) as { at: string | null };
  return row.at ?? '9999';
}

/**
 * Decision 39: which of two conflicting items merges first. The first to
 * merge wins; if neither has, the earlier claim; the item ID settles a tie,
 * so a repeat run gives the same order.
 */
export function mergeOrder(
  db: Db,
  a: { id: string; merged: boolean },
  b: { id: string; merged: boolean },
): string {
  if (a.merged !== b.merged) return a.merged ? a.id : b.id;
  const [atA, atB] = [claimedAt(db, a.id), claimedAt(db, b.id)];
  if (atA !== atB) return atA < atB ? a.id : b.id;
  return a.id < b.id ? a.id : b.id;
}

function reportedFiles(db: Db, itemId: string): string[] {
  const row = db.sqlite
    .prepare(
      `SELECT changed_files FROM packets WHERE item_id = ? AND changed_files IS NOT NULL
       ORDER BY round DESC LIMIT 1`,
    )
    .get(itemId) as { changed_files: string } | undefined;
  return row ? (JSON.parse(row.changed_files) as string[]) : [];
}

const projectBasis = (db: Db, project: string) =>
  JSON.stringify(
    db.sqlite
      .prepare('SELECT repo_path, main_branch, deleted_at FROM projects WHERE key = ?')
      .get(project) ?? null,
  );

/** Everything about an item that decides what the radar checks for it. */
function itemBasis(db: Db, id: string): string {
  const row = db.sqlite
    .prepare(
      `SELECT status, archived_at, jira_key, branches, radar_branch, radar_branch_matches
       FROM items WHERE id = ?`,
    )
    .get(id);
  if (!row) return 'null';
  const parts = (
    db.sqlite
      .prepare('SELECT part_key FROM item_shared_changes WHERE item_id = ? ORDER BY part_key')
      .all(id) as { part_key: string }[]
  ).map((x) => x.part_key);
  return JSON.stringify([row, parts, reportedFiles(db, id)]);
}

const inFlightItems = (db: Db, project: string) =>
  db.sqlite
    .prepare(
      `SELECT id, jira_key FROM items WHERE project_key = ? AND status IN ('progress', 'review')
       AND archived_at IS NULL ORDER BY length(id), id`,
    )
    .all(project) as { id: string; jira_key: string | null }[];

function isInFlight(db: Db, id: string): boolean {
  return !!db.sqlite
    .prepare(
      `SELECT 1 FROM items WHERE id = ? AND status IN ('progress', 'review') AND archived_at IS NULL`,
    )
    .get(id);
}

/**
 * Read the project and run the trial merges. Writes nothing anywhere. A read
 * with no answer lands in `plan.unknown`, never in a finding or its clearing.
 */
export async function planRadar(
  r: ReadContext,
  config: Config,
  project: string,
  signal?: AbortSignal,
): Promise<RadarPlan> {
  const db = r.db;
  const p = db.sqlite
    .prepare('SELECT repo_path, main_branch FROM projects WHERE key = ? AND deleted_at IS NULL')
    .get(project) as { repo_path: string | null; main_branch: string } | undefined;
  if (!p)
    throw new ToolError('not_found', `No project ${project}. Check the key with list_projects.`);
  // Read before git, so anything that changes during the run differs from it.
  const items = inFlightItems(db, project);
  const basis: RadarBasis = {
    project: projectBasis(db, project),
    items: Object.fromEntries(items.map(({ id }) => [id, itemBasis(db, id)])),
  };
  const empty = { checks: [], suppressed: [], discovered: [], basis };
  const off = (reason: string): RadarPlan => ({
    project,
    off: reason,
    ...empty,
    unknown: { all: false, items: [], branches: [], pairs: [] },
  });
  const unread = (): RadarPlan => ({
    project,
    off: null,
    ...empty,
    unknown: { all: true, items: [], branches: [], pairs: [] },
  });
  if (!p.repo_path) return off(RADAR_OFF_NO_REPO);
  let dir: string;
  try {
    dir = resolveRepoPath(config, p.repo_path);
  } catch {
    return off(RADAR_OFF_NO_REPO);
  }
  const probe = await probeRepo(dir, signal);
  if (!probe.ok) return probe.unknown ? unread() : off(RADAR_OFF_NO_REPO);
  // A repository that keeps timing out ends the run's reads early: the rest are unknown.
  const giveUp = new AbortController();
  const reads = signal ? AbortSignal.any([signal, giveUp.signal]) : giveUp.signal;
  const g = await RadarGit.open(dir, probe.objects, reads);
  const unknownItems = new Set<string>();
  const unknownBranches = new Set<string>();
  const unknownPairs: [string, string][] = [];
  let noAnswers = 0;
  /** The answer, or undefined when git had none. */
  const answer = async <T>(read: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await read();
    } catch (err) {
      if (!(err instanceof GitUnknown)) throw err;
      noAnswers += 1;
      if (noAnswers >= RADAR_MAX_UNKNOWN_READS) giveUp.abort();
      return undefined;
    }
  };
  try {
    const main = await answer(() => g.ref(p.main_branch));
    if (main === undefined) return unread();
    if (!main) return off(`Radar off: no branch ${p.main_branch}`);
    const flights: Flight[] = [];
    const discovered: Discovery[] = [];
    let local: string[] | null | undefined = null;
    for (const { id, jira_key } of items) {
      // B41: every reported branch; with none, a local branch that names the item (B40).
      const reported = reportedBranches(db, id).map((b) => b.name);
      let branches: { name: string; source: BranchSource }[];
      if (reported.length > 0) {
        branches = reported.map((name) => ({ name, source: 'reported' }));
      } else {
        // Several matches is none.
        if (local === null) {
          const all = await answer(() => g.branches());
          local = all?.filter((b) => b !== p.main_branch);
        }
        if (local === undefined) {
          // The list had no answer: this item's discovery and findings stay.
          unknownItems.add(id);
          continue;
        }
        // B45: never a branch the owner said isn't active.
        const removed = new Set(
          storedBranches(db, id)
            .filter((b) => b.removed)
            .map((b) => b.name),
        );
        const matches = branchesNaming([id, jira_key], local).filter((b) => !removed.has(b));
        const one = matches.length === 1 ? matches[0]! : null;
        discovered.push({ item: id, branch: one, matches: one ? [] : matches });
        branches = one ? [{ name: one, source: 'discovered' }] : [];
      }
      const parts = new Set(
        (
          db.sqlite
            .prepare('SELECT part_key FROM item_shared_changes WHERE item_id = ?')
            .all(id) as {
            part_key: string;
          }[]
        ).map((x) => x.part_key),
      );
      const handed = reportedFiles(db, id);
      for (const { name: branch, source } of branches) {
        if (branch === p.main_branch) continue;
        const ref = await answer(() => g.ref(branch));
        if (ref === undefined) {
          unknownBranches.add(branch);
          continue;
        }
        if (!ref) continue;
        const changed = await answer(() => g.changed(main, ref));
        if (changed === undefined) {
          unknownBranches.add(branch);
          continue;
        }
        const files = new Set([...handed, ...changed]);
        flights.push({ id, branch, source, ref, parts, files });
      }
    }
    const checks: Check[] = [];
    const suppressed: RadarPlan['suppressed'] = [];
    // B42: each branch's files in conflict with the main branch.
    const withMain = new Map<string, Set<string>>();
    // One check per branch pair, even when two items report the same branch.
    const pairs = new Set<string>();
    const fresh = (a: string, b: string) => {
      const k = `${a}\u0000${b}`;
      if (pairs.has(k)) return false;
      pairs.add(k);
      return true;
    };
    for (const f of flights) {
      if (!fresh(f.branch, p.main_branch)) continue;
      const files = await answer(() => g.merge(main, f.ref));
      if (files === undefined) {
        // B42 needs this answer to judge the branch's pairs, so they wait too.
        unknownBranches.add(f.branch);
        continue;
      }
      if (files === null) continue;
      withMain.set(f.branch, new Set(files));
      checks.push({
        branch_a: f.branch,
        branch_b: p.main_branch,
        item_a: f.id,
        item_b: null,
        source_a: f.source,
        source_b: null,
        files,
      });
    }
    for (let i = 0; i < flights.length; i++) {
      for (let j = i + 1; j < flights.length; j++) {
        const [x, y] = [flights[i]!, flights[j]!];
        // B41: two branches of one item aren't a cross-item conflict; not checked.
        if (x.id === y.id || x.branch === y.branch) continue;
        if (unknownBranches.has(x.branch) || unknownBranches.has(y.branch)) continue;
        const related =
          [...x.parts].some((k) => y.parts.has(k)) || [...x.files].some((k) => y.files.has(k));
        if (!related) continue;
        const [a, b] = x.branch < y.branch ? [x, y] : [y, x];
        if (!fresh(a.branch, b.branch)) continue;
        const all = await answer(() => g.merge(x.ref, y.ref));
        if (all === undefined) {
          unknownPairs.push([a.branch, b.branch]);
          continue;
        }
        if (all === null) continue;
        // B42: only files beyond what either branch's conflict with main explains.
        const explained = (file: string) =>
          !!withMain.get(a.branch)?.has(file) || !!withMain.get(b.branch)?.has(file);
        const files = all.filter((file) => !explained(file));
        // Decision 39: a real text conflict gets a merge order; it stops neither agent.
        let merge_first: string | null = null;
        if (files.length > 0) {
          const order = await answer(async () => ({
            a: await g.merged(a.ref, main),
            b: await g.merged(b.ref, main),
          }));
          if (!order) {
            unknownPairs.push([a.branch, b.branch]);
            continue;
          }
          merge_first = mergeOrder(
            db,
            { id: a.id, merged: order.a },
            { id: b.id, merged: order.b },
          );
        }
        if (all.length > 0 && files.length === 0) {
          suppressed.push({ branch_a: a.branch, branch_b: b.branch, files: all });
        }
        checks.push({
          branch_a: a.branch,
          branch_b: b.branch,
          item_a: a.id,
          item_b: b.id,
          source_a: a.source,
          source_b: b.source,
          files,
          merge_first,
        });
      }
    }
    return {
      project,
      off: null,
      checks,
      suppressed,
      discovered,
      basis,
      unknown: {
        all: false,
        items: [...unknownItems],
        branches: [...unknownBranches],
        pairs: unknownPairs,
      },
    };
  } finally {
    await g.close();
  }
}

const fileCount = (n: number) => `${n} file${n === 1 ? '' : 's'}`;

/** "gf-217-api vs gf-240-x", with "(found by the radar)" after a discovered branch (B41). */
export const branchPair = (own: string, source: BranchSource | null, other: string) =>
  `${own}${source === 'discovered' ? ' (found by the radar)' : ''} vs ${other}`;

/**
 * Record a plan: a conflicting pair opens (or keeps current) a finding with
 * `radar.found` on each item; an open finding the run found clean, or no
 * longer checks, clears with `radar.cleared`. A plan from an "off" run
 * changes no finding.
 *
 * B52: inside the write transaction, the plan is compared with the database.
 * If the project's radar settings changed, nothing applies. An item that
 * changed since the plan began keeps its discovery and findings, and so does
 * anything git had no answer for; the next run decides them.
 */
export function recordRadar(w: WriteContext, plan: RadarPlan): RadarApplied {
  if (projectBasis(w.db, plan.project) !== plan.basis.project) {
    return { discarded: true, stale: [] };
  }
  if (plan.off || plan.unknown.all) return { discarded: false, stale: [] };
  const seen = new Map<string, boolean>();
  const changed = (id: string) => {
    let c = seen.get(id);
    if (c === undefined) {
      const was = plan.basis.items[id];
      c = was === undefined ? isInFlight(w.db, id) : itemBasis(w.db, id) !== was;
      seen.set(id, c);
    }
    return c;
  };
  // Before anything below writes: discovery changes an item's own fingerprint.
  for (const id of Object.keys(plan.basis.items)) changed(id);
  const key = (a: unknown, b: unknown) => `${String(a)}\u0000${String(b)}`;
  const unknownItems = new Set(plan.unknown.items);
  const unknownBranches = new Set(plan.unknown.branches);
  const unknownPairs = new Set(plan.unknown.pairs.map(([a, b]) => key(a, b)));
  for (const d of plan.discovered) {
    if (!changed(d.item)) recordDiscovery(w, plan.project, d);
  }
  const open = w.db.sqlite
    .prepare('SELECT * FROM radar_findings WHERE project_key = ? AND cleared_at IS NULL')
    .all(plan.project) as Record<string, unknown>[];
  const byPair = new Map(open.map((f) => [key(f.branch_a, f.branch_b), f]));
  const still = new Set<string>();
  // B42: what each item's lead should read, one note per item for the run's new findings.
  const notes = new Map<string, string[]>();
  for (const c of plan.checks) {
    if (changed(c.item_a) || (c.item_b && changed(c.item_b))) continue;
    if (c.files.length === 0) continue;
    const k = key(c.branch_a, c.branch_b);
    still.add(k);
    const existing = byPair.get(k);
    // A finding from before B40 has no sources: its branches were all reported.
    const same =
      existing &&
      JSON.stringify(JSON.parse(existing.files as string)) === JSON.stringify(c.files) &&
      (existing.source_a ?? 'reported') === c.source_a &&
      (existing.source_b ?? (existing.item_b ? 'reported' : null)) === c.source_b;
    if (existing && same) continue;
    let id: string;
    if (existing) {
      id = existing.id as string;
      w.update('radar_findings', id, {
        files: c.files,
        item_a: c.item_a,
        item_b: c.item_b,
        source_a: c.source_a,
        source_b: c.source_b,
        seen_at: w.now,
        merge_first: c.merge_first ?? null,
      });
    } else {
      id = newId('rdf', ms(w.now));
      const e = explain.radar(
        {
          id,
          project: plan.project,
          branch_a: c.branch_a,
          branch_b: c.branch_b,
          item_a: { id: c.item_a, title: '', status: 'progress' },
          item_b: c.item_b ? { id: c.item_b, title: '', status: 'progress' } : null,
          source_a: c.source_a,
          source_b: c.source_b,
          files: c.files,
          seen_at: w.now,
          cleared_at: null,
          merge_first: c.merge_first ?? null,
        },
        new Set(),
      );
      for (const item of [c.item_a, ...(c.item_b ? [c.item_b] : [])]) {
        notes.set(item, [...(notes.get(item) ?? []), `${e.what} ${e.fix}`]);
      }
      w.insert('radar_findings', {
        id,
        project_key: plan.project,
        branch_a: c.branch_a,
        branch_b: c.branch_b,
        item_a: c.item_a,
        item_b: c.item_b,
        source_a: c.source_a,
        source_b: c.source_b,
        files: c.files,
        seen_at: w.now,
        cleared_at: null,
        merge_first: c.merge_first ?? null,
      });
    }
    // Decision 39: the live overlap between the two items, if any, shows the real conflict.
    if (c.item_b) noteTextConflict(w, c.item_a, c.item_b, c.files);
    for (const [self, other, otherBranch, ownBranch, source] of [
      [c.item_a, c.item_b, c.branch_b, c.branch_a, c.source_a],
      ...(c.item_b ? [[c.item_b, c.item_a, c.branch_a, c.branch_b, c.source_b] as const] : []),
    ] as const) {
      w.event({
        type: 'radar.found',
        // B41: the summary names both branches (an item may report several).
        summary: `Heading for a conflict with ${other ?? otherBranch}: ${fileCount(c.files.length)} · ${branchPair(ownBranch, source, otherBranch)}`,
        item_id: self,
        project_key: plan.project,
        data: {
          finding_id: id,
          branch_a: c.branch_a,
          branch_b: c.branch_b,
          with: other,
          // B40: how the radar knew this item's branch, and each side's.
          source,
          source_a: c.source_a,
          source_b: c.source_b,
          files: c.files.slice(0, 50),
          merge_first: c.merge_first ?? null,
        },
        objects: [{ kind: 'radar_finding', id }],
      });
    }
  }
  for (const f of open) {
    if (still.has(key(f.branch_a, f.branch_b))) continue;
    // B52: no answer, or an item that moved during the run, is no reason to clear it.
    const items = [f.item_a, f.item_b].filter((x): x is string => typeof x === 'string');
    if (
      items.some((id) => changed(id) || unknownItems.has(id)) ||
      unknownBranches.has(f.branch_a as string) ||
      unknownBranches.has(f.branch_b as string) ||
      unknownPairs.has(key(f.branch_a, f.branch_b))
    ) {
      continue;
    }
    clearFinding(w, f);
    if (f.item_a && f.item_b) noteTextConflict(w, f.item_a as string, f.item_b as string, []);
  }
  for (const [item, lines] of notes) postRadarNote(w, plan.project, item, lines);
  return { discarded: false, stale: [...seen].filter(([, c]) => c).map(([id]) => id) };
}

/**
 * Decision 39: keep the pair's overlap evidence current with what the radar
 * sees. This is evidence only: a clean trial merge never makes a sequenced
 * pair safe, and a text conflict doesn't change the semantic outcome.
 */
function noteTextConflict(w: WriteContext, a: string, b: string, files: string[]): void {
  const [x, y] = a < b ? [a, b] : [b, a];
  const row = w.db.sqlite
    .prepare(
      `SELECT id, evidence FROM part_overlaps
       WHERE item_a = ? AND item_b = ? AND state <> 'resolved' AND evidence IS NOT NULL`,
    )
    .get(x, y) as { id: string; evidence: string } | undefined;
  if (!row) return;
  const evidence = JSON.parse(row.evidence) as { text_conflict: string[] };
  if (JSON.stringify(evidence.text_conflict) === JSON.stringify(files)) return;
  w.db.sqlite
    .prepare('UPDATE part_overlaps SET evidence = ? WHERE id = ?')
    .run(JSON.stringify({ ...evidence, text_conflict: files }), row.id);
}

/**
 * One note on the item with the run's new findings (B42; owner decision 37):
 * "Docket's conflict radar: <what's wrong> <what fixes it>". It is an owner
 * note, so the item's lead reads it on its next get_item.
 */
function postRadarNote(w: WriteContext, project: string, item: string, lines: string[]): void {
  const full = `Docket's conflict radar: ${lines.join(' Also: ')}`;
  const text = full.length > TEXT_LIMITS.note ? `${full.slice(0, TEXT_LIMITS.note - 1)}…` : full;
  const id = newId('note', ms(w.now));
  w.insert('owner_notes', { id, item_id: item, text });
  w.event({
    type: 'owner_note.added',
    summary: text,
    item_id: item,
    project_key: project,
    data: { note_id: id, text, from: 'radar' },
  });
}

/**
 * Store what discovery found for an item (B40) when it differs from the last
 * run: `items.radar_branch` and `items.radar_branch_matches`, outside the
 * item's version (like a declaration), with `branch.discovered` in Activity.
 */
function recordDiscovery(w: WriteContext, project: string, d: Discovery): void {
  const row = w.db.sqlite
    .prepare('SELECT radar_branch, radar_branch_matches FROM items WHERE id = ?')
    .get(d.item) as { radar_branch: string | null; radar_branch_matches: string | null };
  const before: string[] = row.radar_branch_matches
    ? (JSON.parse(row.radar_branch_matches) as string[])
    : [];
  if (row.radar_branch === d.branch && JSON.stringify(before) === JSON.stringify(d.matches)) {
    return;
  }
  w.db.sqlite
    .prepare('UPDATE items SET radar_branch = ?, radar_branch_matches = ? WHERE id = ?')
    .run(d.branch, d.matches.length > 0 ? JSON.stringify(d.matches) : null, d.item);
  w.event({
    type: 'branch.discovered',
    summary: d.branch
      ? `Branch found by the radar for ${d.item}: ${d.branch}`
      : d.matches.length > 0
        ? `Several branches match ${d.item}; report the branch: ${d.matches.join(', ')}`
        : `The radar no longer finds a branch for ${d.item}`,
    item_id: d.item,
    project_key: project,
    data: {
      source: 'discovered',
      branch: d.branch,
      matches: d.matches,
      previous: row.radar_branch,
    },
  });
}

/**
 * Clear an open finding: `radar.cleared` on each of its items. With
 * `undoable` (an owner's change cleared it, B42), each event carries the
 * inverse, which it also returns.
 */
export function clearFinding(
  w: WriteContext,
  f: Record<string, unknown>,
  opts: { undoable?: boolean } = {},
): InverseOp {
  const inverse = w.update('radar_findings', f.id as string, { cleared_at: w.now });
  const undo = opts.undoable ? { inverse: [inverse] } : {};
  const items = [f.item_a, f.item_b].filter((x): x is string => typeof x === 'string');
  const other = (self: string) =>
    self === f.item_a
      ? ((f.item_b as string | null) ?? (f.branch_b as string))
      : (f.item_a as string);
  // B41: name both branches, own first.
  const pair = (self: string) =>
    self === f.item_a
      ? `${String(f.branch_a)} vs ${String(f.branch_b)}`
      : `${String(f.branch_b)} vs ${String(f.branch_a)}`;
  for (const self of items) {
    w.event({
      type: 'radar.cleared',
      summary: `No longer heading for a conflict with ${other(self)} · ${pair(self)}`,
      item_id: self,
      project_key: f.project_key as string,
      data: { finding_id: f.id, branch_a: f.branch_a, branch_b: f.branch_b },
      objects: [{ kind: 'radar_finding', id: f.id as string }],
      ...undo,
    });
  }
  if (items.length === 0) {
    w.event({
      type: 'radar.cleared',
      summary: `Radar finding between ${String(f.branch_a)} and ${String(f.branch_b)} cleared`,
      project_key: f.project_key as string,
      data: { finding_id: f.id },
      objects: [{ kind: 'radar_finding', id: f.id as string }],
      ...undo,
    });
  }
  return inverse;
}

/**
 * The run's time, how long it took (B52) and its "off" reason on the project:
 * bookkeeping, not an event. A discarded plan stamps nothing, and a run that
 * couldn't read the repository keeps the last time and reason.
 */
export function finishRadar(
  r: ReadContext,
  plan: RadarPlan,
  applied: RadarApplied,
  durationMs: number,
): void {
  if (applied.discarded) return;
  if (plan.unknown.all) {
    r.db.sqlite
      .prepare(
        'UPDATE projects SET radar_last_duration_ms = ? WHERE key = ? AND deleted_at IS NULL',
      )
      .run(durationMs, plan.project);
    return;
  }
  r.db.sqlite
    .prepare(
      `UPDATE projects SET radar_last_run_at = coalesce(?, radar_last_run_at), radar_off_reason = ?,
         radar_last_duration_ms = ?
       WHERE key = ? AND deleted_at IS NULL`,
    )
    .run(plan.off ? null : r.now, plan.off, durationMs, plan.project);
  // Decision 39: an open finding keeps its merge order current (the first branch to merge
  // takes the lead). Bookkeeping like the run's time, so an unchanged run writes no event.
  const order = r.db.sqlite.prepare(
    `UPDATE radar_findings SET merge_first = @first
     WHERE project_key = @project AND branch_a = @a AND branch_b = @b AND cleared_at IS NULL
       AND merge_first IS NOT @first`,
  );
  const stale = new Set(applied.stale);
  for (const c of plan.checks) {
    if (stale.has(c.item_a) || (c.item_b && stale.has(c.item_b))) continue;
    if (c.item_b && c.files.length > 0) {
      order.run({
        first: c.merge_first ?? null,
        project: plan.project,
        a: c.branch_a,
        b: c.branch_b,
      });
    }
  }
}

// ---- One run per project (B52) ----

export interface RadarRunInput {
  /** A read context at the current time; called for each step. */
  read: () => ReadContext;
  /** Run `fn` as one mutation through the write path. */
  record: <T>(fn: (w: WriteContext) => T) => { result: T; mutation_id: string };
  /** Cancels this run, if this caller started it. */
  signal?: AbortSignal;
}

export interface RadarRunResult {
  mutation_id: string;
  plan: RadarPlan;
  applied: RadarApplied;
  duration_ms: number;
  /** This caller joined a run already in flight. */
  joined: boolean;
}

/**
 * The radar's runs. A project has at most one at a time: a second caller gets
 * the run in flight. Git runs outside the write path; the write is one short
 * transaction at the end. `stop` cancels what's running and waits for it, so
 * the database can close after it.
 */
export class RadarRuns {
  private readonly live = new Map<string, Promise<RadarRunResult>>();
  private readonly stopping = new AbortController();
  private stopped = false;

  constructor(private readonly config: Config) {}

  isRunning(project: string): boolean {
    return this.live.has(project);
  }

  run(project: string, input: RadarRunInput): Promise<RadarRunResult> {
    const inFlight = this.live.get(project);
    if (inFlight) return inFlight.then((result) => ({ ...result, joined: true }));
    if (this.stopped) {
      return Promise.reject(new ToolError('unavailable', 'Docket is shutting down. Try again.'));
    }
    const run = this.execute(project, input).finally(() => this.live.delete(project));
    this.live.set(project, run);
    return run;
  }

  private async execute(project: string, input: RadarRunInput): Promise<RadarRunResult> {
    const signal = input.signal
      ? AbortSignal.any([this.stopping.signal, input.signal])
      : this.stopping.signal;
    const started = performance.now();
    const plan = await planRadar(input.read(), this.config, project, signal);
    // Cancelled: what it read is incomplete, and nothing may be written.
    if (signal.aborted) {
      throw new ToolError('unavailable', 'The radar run was cancelled because Docket is stopping.');
    }
    const { result: applied, mutation_id } = input.record((w) => recordRadar(w, plan));
    const duration_ms = Math.round(performance.now() - started);
    finishRadar(input.read(), plan, applied, duration_ms);
    return { mutation_id, plan, applied, duration_ms, joined: false };
  }

  /** Cancel every run and wait for them. No new run starts afterwards. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.stopping.abort();
    await Promise.allSettled(this.live.values());
  }
}

/**
 * Decision 39: the projects with a repository where one of these events
 * reported a branch or a commit, so the radar should run soon. The radar's
 * own events are not triggers, so a run can't schedule another.
 */
export function radarTriggers(db: Db, seqs: readonly number[]): string[] {
  if (seqs.length === 0) return [];
  const rows = db.sqlite
    .prepare(
      `SELECT DISTINCT e.project_key AS key FROM events e JOIN projects p ON p.key = e.project_key
       WHERE e.seq IN (${seqs.map(() => '?').join(', ')})
         AND e.type IN ('branch.reported', 'commit.reported', 'claim.granted', 'packet.submitted')
         AND p.repo_path IS NOT NULL AND p.deleted_at IS NULL`,
    )
    .all(...seqs) as { key: string }[];
  return rows.map((r) => r.key);
}

/** Projects whose radar has a repository set, for the scheduler. */
export function radarProjects(db: Db): string[] {
  return (
    db.sqlite
      .prepare(
        'SELECT key FROM projects WHERE repo_path IS NOT NULL AND deleted_at IS NULL ORDER BY key',
      )
      .all() as { key: string }[]
  ).map((p) => p.key);
}

export type { RadarResponse };
