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
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolError, type RadarResponse } from '@docket/shared';
import type { Db } from '../db/client.js';
import type { Config } from '../config.js';
import type { ReadContext } from './contracts.js';
import { newId } from './ids.js';
import { ms } from './model.js';
import { isInside, rootSegments } from './push-root.js';
import type { WriteContext } from './write.js';

/** How often the scheduler runs the radar (BUILD_SPEC §5.21: at least every 15 minutes). */
export const RADAR_INTERVAL_MS = 15 * 60_000;

export const RADAR_OFF_NO_REPO = 'Radar off: no repository';

const GIT_TIMEOUT_MS = 60_000;

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

interface GitResult {
  status: number | null;
  stdout: string;
  missing: boolean;
}

/** Run git read-only in `cwd`, with extra environment. */
function git(cwd: string, args: string[], env: Record<string, string> = {}): GitResult {
  const r = spawnSync(
    'git',
    ['-c', 'safe.directory=*', '-c', 'gc.auto=0', '-c', 'core.fsmonitor=false', ...args],
    {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C',
        ...env,
      },
    },
  );
  const missing = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
  return { status: r.status, stdout: r.stdout ?? '', missing };
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

/** The repository's shared objects folder (worktrees share one), or why there isn't one. */
export function probeRepo(dir: string): { ok: true; objects: string } | { ok: false } {
  const r = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (r.missing || r.status !== 0) return { ok: false };
  const common = r.stdout.trim();
  return common ? { ok: true, objects: join(common, 'objects') } : { ok: false };
}

/** A git session over one repository with a throwaway object directory. */
export class RadarGit {
  private readonly tmp: string;
  private readonly env: Record<string, string>;

  constructor(
    readonly dir: string,
    objects: string,
  ) {
    this.tmp = mkdtempSync(join(tmpdir(), 'docket-radar-'));
    this.env = { GIT_OBJECT_DIRECTORY: this.tmp, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects };
  }

  /** The full ref for a local branch (or, failing that, origin's copy), or null. */
  ref(branch: string): string | null {
    if (!validBranch(branch)) return null;
    for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
      const r = git(this.dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], this.env);
      if (r.status === 0) return ref;
    }
    return null;
  }

  /** Files changed on `ref` since it left `base` (`git diff --name-only base...ref`). */
  changed(base: string, ref: string): string[] {
    const r = git(this.dir, ['diff', '--name-only', '--no-renames', `${base}...${ref}`], this.env);
    if (r.status !== 0) return [];
    return r.stdout.split('\n').filter(Boolean);
  }

  /** Trial-merge two refs: the conflicting files (empty when clean), or null when git failed. */
  merge(a: string, b: string): string[] | null {
    const r = git(
      this.dir,
      ['merge-tree', '--write-tree', '--name-only', '--no-messages', a, b],
      this.env,
    );
    if (r.status === 0) return [];
    if (r.status !== 1) return null;
    const lines = r.stdout.split('\n');
    return [...new Set(lines.slice(1).filter(Boolean))].sort();
  }

  close(): void {
    rmSync(this.tmp, { recursive: true, force: true });
  }
}

// ---- Plan, record, finish ----

interface Check {
  branch_a: string;
  branch_b: string;
  item_a: string;
  /** Null when `branch_b` is the main branch. */
  item_b: string | null;
  /** Conflicting files; empty when the trial merge is clean. */
  files: string[];
}

export interface RadarPlan {
  project: string;
  /** Why the radar couldn't run ("Radar off: …"); null when it ran. */
  off: string | null;
  checks: Check[];
}

interface Flight {
  id: string;
  branch: string;
  ref: string;
  parts: Set<string>;
  files: Set<string>;
}

/**
 * The branch an in-flight item works on: its latest packet's, else its latest
 * lead run's workspace branch, else the branch its latest claim named.
 */
function branchOf(db: Db, itemId: string): string | null {
  const packet = db.sqlite
    .prepare(
      `SELECT branch FROM packets WHERE item_id = ? AND branch IS NOT NULL
       ORDER BY round DESC LIMIT 1`,
    )
    .get(itemId) as { branch: string } | undefined;
  if (packet) return packet.branch;
  const run = db.sqlite
    .prepare(
      `SELECT json_extract(workspace, '$.branch') AS branch FROM runs
       WHERE item_id = ? AND is_lead = 1 AND json_extract(workspace, '$.branch') IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(itemId) as { branch: string } | undefined;
  if (run) return run.branch;
  const claim = db.sqlite
    .prepare(
      `SELECT json_extract(data, '$.branch') AS branch FROM events
       WHERE item_id = ? AND type = 'claim.granted' AND json_extract(data, '$.branch') IS NOT NULL
       ORDER BY seq DESC LIMIT 1`,
    )
    .get(itemId) as { branch: string } | undefined;
  return claim?.branch ?? null;
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

/** Read the project and run the trial merges. Writes nothing anywhere. */
export function planRadar(r: ReadContext, config: Config, project: string): RadarPlan {
  const db = r.db;
  const p = db.sqlite
    .prepare('SELECT repo_path, main_branch FROM projects WHERE key = ? AND deleted_at IS NULL')
    .get(project) as { repo_path: string | null; main_branch: string } | undefined;
  if (!p)
    throw new ToolError('not_found', `No project ${project}. Check the key with list_projects.`);
  const off = (reason: string): RadarPlan => ({ project, off: reason, checks: [] });
  if (!p.repo_path) return off(RADAR_OFF_NO_REPO);
  let dir: string;
  try {
    dir = resolveRepoPath(config, p.repo_path);
  } catch {
    return off(RADAR_OFF_NO_REPO);
  }
  const probe = probeRepo(dir);
  if (!probe.ok) return off(RADAR_OFF_NO_REPO);
  const g = new RadarGit(dir, probe.objects);
  try {
    const main = g.ref(p.main_branch);
    if (!main) return off(`Radar off: no branch ${p.main_branch}`);
    const items = db.sqlite
      .prepare(
        `SELECT id FROM items WHERE project_key = ? AND status IN ('progress', 'review')
         AND archived_at IS NULL ORDER BY length(id), id`,
      )
      .all(project) as { id: string }[];
    const flights: Flight[] = [];
    for (const { id } of items) {
      const branch = branchOf(db, id);
      if (!branch || branch === p.main_branch) continue;
      const ref = g.ref(branch);
      if (!ref) continue;
      const parts = new Set(
        (
          db.sqlite
            .prepare('SELECT part_key FROM item_shared_changes WHERE item_id = ?')
            .all(id) as {
            part_key: string;
          }[]
        ).map((x) => x.part_key),
      );
      const files = new Set([...reportedFiles(db, id), ...g.changed(main, ref)]);
      flights.push({ id, branch, ref, parts, files });
    }
    const checks: Check[] = [];
    for (const f of flights) {
      const files = g.merge(main, f.ref);
      if (files === null) continue;
      checks.push({
        branch_a: f.branch,
        branch_b: p.main_branch,
        item_a: f.id,
        item_b: null,
        files,
      });
    }
    for (let i = 0; i < flights.length; i++) {
      for (let j = i + 1; j < flights.length; j++) {
        const [x, y] = [flights[i]!, flights[j]!];
        if (x.branch === y.branch) continue;
        const related =
          [...x.parts].some((k) => y.parts.has(k)) || [...x.files].some((k) => y.files.has(k));
        if (!related) continue;
        const files = g.merge(x.ref, y.ref);
        if (files === null) continue;
        const [a, b] = x.branch < y.branch ? [x, y] : [y, x];
        checks.push({ branch_a: a.branch, branch_b: b.branch, item_a: a.id, item_b: b.id, files });
      }
    }
    return { project, off: null, checks };
  } finally {
    g.close();
  }
}

const fileCount = (n: number) => `${n} file${n === 1 ? '' : 's'}`;

/**
 * Record a plan: a conflicting pair opens (or keeps current) a finding with
 * `radar.found` on each item; an open finding the run found clean, or no
 * longer checks, clears with `radar.cleared`. A plan from an "off" run
 * changes no finding.
 */
export function recordRadar(w: WriteContext, plan: RadarPlan): void {
  if (plan.off) return;
  const open = w.db.sqlite
    .prepare('SELECT * FROM radar_findings WHERE project_key = ? AND cleared_at IS NULL')
    .all(plan.project) as Record<string, unknown>[];
  const key = (a: unknown, b: unknown) => `${String(a)}\u0000${String(b)}`;
  const byPair = new Map(open.map((f) => [key(f.branch_a, f.branch_b), f]));
  const still = new Set<string>();
  for (const c of plan.checks) {
    if (c.files.length === 0) continue;
    const k = key(c.branch_a, c.branch_b);
    still.add(k);
    const existing = byPair.get(k);
    const sameFiles =
      existing && JSON.stringify(JSON.parse(existing.files as string)) === JSON.stringify(c.files);
    if (existing && sameFiles) continue;
    let id: string;
    if (existing) {
      id = existing.id as string;
      w.update('radar_findings', id, {
        files: c.files,
        item_a: c.item_a,
        item_b: c.item_b,
        seen_at: w.now,
      });
    } else {
      id = newId('rdf', ms(w.now));
      w.insert('radar_findings', {
        id,
        project_key: plan.project,
        branch_a: c.branch_a,
        branch_b: c.branch_b,
        item_a: c.item_a,
        item_b: c.item_b,
        files: c.files,
        seen_at: w.now,
        cleared_at: null,
      });
    }
    for (const [self, other, otherBranch] of [
      [c.item_a, c.item_b, c.branch_b],
      ...(c.item_b ? [[c.item_b, c.item_a, c.branch_a] as const] : []),
    ] as const) {
      w.event({
        type: 'radar.found',
        summary: `Heading for a conflict with ${other ?? otherBranch}: ${fileCount(c.files.length)}`,
        item_id: self,
        project_key: plan.project,
        data: {
          finding_id: id,
          branch_a: c.branch_a,
          branch_b: c.branch_b,
          with: other,
          files: c.files.slice(0, 50),
        },
        objects: [{ kind: 'radar_finding', id }],
      });
    }
  }
  for (const f of open) {
    if (still.has(key(f.branch_a, f.branch_b))) continue;
    clearFinding(w, f);
  }
}

/** Clear an open finding: `radar.cleared` on each of its items. */
export function clearFinding(w: WriteContext, f: Record<string, unknown>): void {
  w.update('radar_findings', f.id as string, { cleared_at: w.now });
  const items = [f.item_a, f.item_b].filter((x): x is string => typeof x === 'string');
  const other = (self: string) =>
    self === f.item_a
      ? ((f.item_b as string | null) ?? (f.branch_b as string))
      : (f.item_a as string);
  for (const self of items) {
    w.event({
      type: 'radar.cleared',
      summary: `No longer heading for a conflict with ${other(self)}`,
      item_id: self,
      project_key: f.project_key as string,
      data: { finding_id: f.id, branch_a: f.branch_a, branch_b: f.branch_b },
      objects: [{ kind: 'radar_finding', id: f.id as string }],
    });
  }
  if (items.length === 0) {
    w.event({
      type: 'radar.cleared',
      summary: `Radar finding between ${String(f.branch_a)} and ${String(f.branch_b)} cleared`,
      project_key: f.project_key as string,
      data: { finding_id: f.id },
      objects: [{ kind: 'radar_finding', id: f.id as string }],
    });
  }
}

/** The run's time and its "off" reason on the project: bookkeeping, not an event. */
export function finishRadar(r: ReadContext, plan: RadarPlan): void {
  r.db.sqlite
    .prepare(
      `UPDATE projects SET radar_last_run_at = coalesce(?, radar_last_run_at), radar_off_reason = ?
       WHERE key = ? AND deleted_at IS NULL`,
    )
    .run(plan.off ? null : r.now, plan.off, plan.project);
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
