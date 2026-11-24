/**
 * Drift (owner decision 30; BUILD_SPEC §5.19; FR-131–FR-133; tasks.md T161):
 * instruction reports from `claim_lead` and the scheduled push-folder check,
 * drift records against each install's manifest, and the remedies (*Adopt*,
 * *Restore*, *Keep local*).
 *
 * **Reports.** An agent's report is the installed `docket-check` script's
 * output, passed as `claim_lead.instructions`; it is stored on the run inside
 * the claim's write. The push check reads every push install's location
 * through B24's guarded reader (`inspectPushInstall`) and never writes there.
 * Hashes are compared lowercased; text is kept only for files that differ.
 * A report without a known install is stored and shown on the run, but
 * raises nothing.
 *
 * **Drift.** Against the install's manifest, each file is:
 * - *edited*: reported with another hash;
 * - *missing*: in the manifest but not reported;
 * - *extra*: a `docket-*` skill the install didn't write, or an old
 *   `tasklite-*` folder the manifest doesn't list (B28: one an install kept
 *   because it was edited locally, "old name, edited locally");
 * - otherwise as sent. Any other key the install didn't write is *unknown*:
 *   listed on the run, never a problem on its own.
 * One open record per install and file. A later report updates it when the
 * hash or the kind of change moved on, and resolves it (`restored`) when the
 * file matches what was sent again. A record the owner resolved with *Keep
 * local* or *Adopt* accepts that hash: the same hash raises nothing, a new
 * one raises a new record. A newer install at the same location supersedes
 * an older one's open records.
 *
 * **Remedies** go through the existing owner write paths: *Adopt* saves the
 * local text as the project's copy (the default for a user-wide install) with
 * `saveAgentFileEdit`, undoable; *Restore* reinstalls through B24 (push
 * writes the files; a command install returns the command); *Keep local*
 * accepts the hash. Only *Adopt* is undoable.
 */
import { explain } from './problems.js';
import {
  CONNECTION_KEY,
  INSTALL_CLIENT_LABELS,
  INSTALLED_FILE_KEY_RE,
  isScriptKey,
  isSkillReferenceKey,
  ToolError,
  findSecret,
  isLegacySkillKey,
  mapLegacySkillKey,
  type Drift,
  type DriftChange,
  type DriftState,
  type InstallClient,
  type InstallMethod,
  type InstallTargetKind,
  type InstructionReportSource,
  type Problem,
  type RunInstructions,
} from '@docket/shared';
import type { Db } from '../db/client.js';
import { agentFileName, isShippedKey, saveAgentFileEdit } from './agent-files.js';
import type {
  DriftService,
  InstructionReportInput,
  PreparedRestore,
  ServiceDeps,
} from './contracts.js';
import { newId } from './ids.js';
import {
  INSTALL_COLUMNS,
  inspectPushInstall,
  isPendingUpdate,
  markUpdateLanded,
  type InstallDbRow,
  type ManifestMap,
} from './installs.js';
import { actorName } from './model.js';
import { PushRoot } from './push-root.js';
import type { InverseOp, WriteContext } from './write.js';

/** The longest text kept for a diff or *Adopt* (BUILD_SPEC §4 agent file versions). */
const MAX_CONTENT = 50_000;
const MAX_LOCATION = 1_000;

interface DriftRow {
  id: string;
  install_id: string;
  project_key: string | null;
  file_key: string;
  change: DriftChange;
  state: DriftState;
  local_sha256: string | null;
  report_id: string | null;
  detected_at: string;
  resolved_at: string | null;
}

interface ReportRow {
  id: string;
  source: InstructionReportSource;
  run_id: string | null;
  install_id: string | null;
  project_key: string | null;
  location: string | null;
  files: string;
  at: string;
}

/** A report's files: key → the reported hash (lowercase) and, for a file that differs, its text. */
type ReportFiles = Record<string, { sha256: string; content?: string; withheld?: 'secret' }>;

interface Difference {
  key: string;
  change: DriftChange;
  /** Null when missing. */
  local: string | null;
}

const installById = (db: Db, id: string) =>
  db.sqlite.prepare(`SELECT ${INSTALL_COLUMNS} FROM installs WHERE id = ?`).get(id) as
    InstallDbRow | undefined;

/** Decision 50: only a repo install still in place can drift. */
const canDrift = (row: InstallDbRow | undefined): row is InstallDbRow =>
  !!row && row.target_kind === 'repo' && !row.removed_at;

const manifestOf = (row: InstallDbRow): ManifestMap => JSON.parse(row.manifest) as ManifestMap;

function reportById(db: Db, id: string | null): ReportRow | undefined {
  if (!id) return undefined;
  return db.sqlite.prepare('SELECT * FROM instruction_reports WHERE id = ?').get(id) as
    ReportRow | undefined;
}

const filesOf = (r: ReportRow | undefined): ReportFiles =>
  r ? (JSON.parse(r.files) as ReportFiles) : {};

/** An extra skill folder the install didn't write, by Docket's naming (old or new). */
const isDocketSkill = (key: string) => key.startsWith('skill:docket-') || isLegacySkillKey(key);

/**
 * Old `skill:tasklite-*` keys in a report (B28), from an old check script or a
 * folder kept under its old name. With a known install, mapped to
 * `skill:docket-*` only when that is the file the install wrote under the
 * old name (`installed_as`, from the migration); any other old folder stays
 * itself, so it shows as extra. Without one, mapped unless the report also
 * has the new key.
 */
export function mapReportKeys<T extends { key: string }>(
  files: readonly T[],
  manifest: ManifestMap | undefined,
): T[] {
  const reported = new Set(files.map((f) => f.key));
  return files.map((f) => {
    if (!isLegacySkillKey(f.key)) return f;
    const mapped = mapLegacySkillKey(f.key);
    const sent = manifest?.[mapped];
    const oldName = f.key.slice('skill:'.length);
    if (manifest ? sent?.installed_as === oldName : !reported.has(mapped))
      return { ...f, key: mapped };
    return f;
  });
}

/**
 * Compare a report with the install's manifest: edited, missing and extra
 * files. Unknown keys (not Docket's) aren't differences.
 */
export function differences(
  manifest: ManifestMap,
  files: ReportFiles,
  /** False for an agent's report: it never carries the connection file (decision 32). */
  coversConnection = true,
): Difference[] {
  const out: Difference[] = [];
  for (const [key, sent] of Object.entries(manifest)) {
    if ((key === CONNECTION_KEY || isScriptKey(key)) && !coversConnection) continue;
    const got = files[key];
    // Decision 66: an agent's report names a skill reference only when it differs, so one
    // left out is as sent. The push check and the check command still see a missing one.
    if (!got && !coversConnection && isSkillReferenceKey(key)) continue;
    if (!got) out.push({ key, change: 'missing', local: null });
    else if (got.sha256 !== sent.sha256.toLowerCase()) {
      out.push({ key, change: 'edited', local: got.sha256 });
    }
  }
  for (const [key, got] of Object.entries(files)) {
    if (!(key in manifest) && isDocketSkill(key)) {
      out.push({ key, change: 'extra', local: got.sha256 });
    }
  }
  return out;
}

/** The reported files, normalised: lowercase hashes, text only where it differs from what was sent. */
function normalise(
  files: InstructionReportInput['files'],
  manifest: ManifestMap | undefined,
): ReportFiles {
  const out: ReportFiles = {};
  for (const f of files) {
    const sha256 = f.sha256.trim().toLowerCase();
    const sent = manifest?.[f.key]?.sha256.toLowerCase();
    const keep = f.content !== undefined && f.content.length <= MAX_CONTENT && sent !== sha256;
    const withheld = f.withheld === 'secret' && sent !== sha256;
    out[f.key] = keep
      ? { sha256, content: f.content }
      : withheld
        ? { sha256, withheld: 'secret' }
        : { sha256 };
  }
  return out;
}

/** "docket-worker edited", "AGENTS.md block missing", "docket-old added", "tasklite-planner (old name, edited locally)". */
function changeText(key: string, change: DriftChange): string {
  const name = agentFileName(key);
  if (change === 'extra' && isLegacySkillKey(key)) return `${name} (old name, edited locally)`;
  if (change === 'missing') return `${name} missing`;
  if (change === 'extra') return `${name} added`;
  return `${name} edited`;
}

function projectName(db: Db, key: string | null): string {
  if (!key) return 'user-wide';
  const p = db.sqlite.prepare('SELECT short_name AS name FROM projects WHERE key = ?').get(key) as
    { name: string } | undefined;
  return p?.name ?? key;
}

/** Where an install is: its path, else the reporting workspace, else how it was made. */
function whereOf(install: InstallDbRow, report: ReportRow | undefined): string {
  return install.path ?? report?.location ?? `a ${install.method} install (${install.id})`;
}

/** "reported by codex · orca-w3 on RCP-17" or "found by the scheduled check". */
function foundText(db: Db, report: ReportRow | undefined): string {
  if (!report || report.source === 'push_check') return 'found by the scheduled check';
  const run = report.run_id
    ? (db.sqlite
        .prepare('SELECT item_id, client, label FROM runs WHERE id = ?')
        .get(report.run_id) as
        { item_id: string; client: string; label: string | null } | undefined)
    : undefined;
  if (!run) return 'reported by an agent';
  return `reported by ${actorName({ kind: 'agent', client: run.client, label: run.label })} on ${run.item_id}`;
}

/** The local text for a record: from its report, else the latest report of the install with that hash. */
function localContent(db: Db, row: DriftRow): string | null {
  if (!row.local_sha256) return null;
  const own = filesOf(reportById(db, row.report_id))[row.file_key];
  if (own?.sha256 === row.local_sha256 && own.content !== undefined) return own.content;
  const reports = db.sqlite
    .prepare(
      `SELECT * FROM instruction_reports WHERE install_id = ? ORDER BY at DESC, id DESC LIMIT 50`,
    )
    .all(row.install_id) as ReportRow[];
  for (const r of reports) {
    const f = filesOf(r)[row.file_key];
    if (f?.sha256 === row.local_sha256 && f.content !== undefined) return f.content;
  }
  return null;
}

/**
 * Why the local text is missing: `secret` when the latest report of this hash
 * withheld it because it looked like a secret (it was never stored).
 */
function contentWithheld(db: Db, row: DriftRow): 'secret' | null {
  if (!row.local_sha256) return null;
  const reports = db.sqlite
    .prepare(
      `SELECT * FROM instruction_reports WHERE install_id = ? ORDER BY at DESC, id DESC LIMIT 50`,
    )
    .all(row.install_id) as ReportRow[];
  for (const r of reports) {
    const f = filesOf(r)[row.file_key];
    if (f?.sha256 !== row.local_sha256) continue;
    if (f.content !== undefined) return null;
    if (f.withheld === 'secret') return 'secret';
  }
  return null;
}

function toDrift(db: Db, row: DriftRow): Drift {
  const install = installById(db, row.install_id)!;
  const report = reportById(db, row.report_id);
  // A folder kept under its old name compares with the file it was renamed to (B28).
  const sent = manifestOf(install)[mapLegacySkillKey(row.file_key)];
  const run = report?.run_id
    ? (db.sqlite
        .prepare('SELECT item_id, client, label FROM runs WHERE id = ?')
        .get(report.run_id) as
        { item_id: string; client: string; label: string | null } | undefined)
    : undefined;
  return {
    id: row.id,
    install_id: row.install_id,
    install: {
      client: install.client,
      target_kind: install.target_kind,
      method: install.method,
      path: install.path ?? report?.location ?? null,
    },
    project: row.project_key,
    file_key: row.file_key,
    change: row.change,
    state: row.state,
    local_sha256: row.local_sha256,
    sent_version_id: sent?.version_id ?? null,
    sent_sha256: sent?.sha256 ?? null,
    local_content: localContent(db, row),
    content_withheld: contentWithheld(db, row),
    found_by: {
      source: report?.source ?? 'push_check',
      run_id: report?.run_id ?? null,
      item_id: run?.item_id ?? null,
      client: run?.client ?? null,
      label: run?.label ?? null,
      at: report?.at ?? row.detected_at,
    },
    detected_at: row.detected_at,
    resolved_at: row.resolved_at,
  };
}

function driftRow(db: Db, id: string): DriftRow {
  const row = db.sqlite.prepare('SELECT * FROM drift WHERE id = ?').get(id) as DriftRow | undefined;
  if (!row) throw new ToolError('not_found', `No drift record ${id}.`);
  return row;
}

function requireOpen(db: Db, id: string): DriftRow {
  const row = driftRow(db, id);
  if (row.state !== 'open') {
    throw new ToolError(
      'conflict',
      `This change was already resolved (${row.state.replace('_', ' ')}${row.resolved_at ? ` at ${row.resolved_at}` : ''}).`,
      { current: toDrift(db, row) as unknown as Record<string, unknown> },
    );
  }
  return row;
}

const openRowsOf = (db: Db, installId: string) =>
  db.sqlite
    .prepare(`SELECT * FROM drift WHERE install_id = ? AND state = 'open'`)
    .all(installId) as DriftRow[];

/** The latest record the owner accepted for this install and file (*Keep local*, *Adopt*). */
const acceptedOf = (db: Db, installId: string, key: string) =>
  db.sqlite
    .prepare(
      `SELECT * FROM drift WHERE install_id = ? AND file_key = ? AND state IN ('kept_local', 'adopted')
       ORDER BY resolved_at DESC, created_at DESC, id DESC LIMIT 1`,
    )
    .get(installId, key) as DriftRow | undefined;

/** Resolve an open record (a later report says it matches again, or a newer install replaced it). */
function resolve(
  w: WriteContext,
  row: DriftRow,
  state: Exclude<DriftState, 'open'>,
  summary: string,
  extra: { item_id?: string | null; inverse?: InverseOp[] | null } = {},
): InverseOp {
  const inverse = w.update('drift', row.id, { state, resolved_at: w.now });
  w.event({
    type: 'drift.resolved',
    summary,
    project_key: row.project_key,
    item_id: extra.item_id ?? null,
    data: { drift_id: row.id, install_id: row.install_id, key: row.file_key, state },
    objects: [{ kind: 'drift', id: row.id }],
    inverse: extra.inverse === undefined ? null : extra.inverse && [...extra.inverse, inverse],
  });
  return inverse;
}

/**
 * Store a report and raise, update or resolve drift. `ifChanged` (the push
 * check): store nothing when nothing would change, so a quiet check writes
 * nothing at all.
 */
function record(
  w: WriteContext,
  input: InstructionReportInput,
  ifChanged: boolean,
): { report_id: string | null; drift_ids: string[] } {
  const db = w.db;
  // Decision 50: a report from a legacy user-wide or removed install is kept, and raises nothing.
  const reported = input.install_id ? installById(db, input.install_id) : undefined;
  const install = canDrift(reported) ? reported : undefined;
  const manifest = install ? manifestOf(install) : undefined;
  const files = normalise(mapReportKeys(input.files, manifest), manifest);
  const runItem = input.run_id
    ? ((
        db.sqlite.prepare('SELECT item_id FROM runs WHERE id = ?').get(input.run_id) as
          { item_id: string } | undefined
      )?.item_id ?? null)
    : null;
  const project = install ? install.project_key : (input.project ?? null);
  const rawLocation = input.location ?? install?.path ?? null;
  const location = rawLocation ? rawLocation.slice(0, MAX_LOCATION) : null;
  const reportId = newId('irp', Date.parse(w.now));
  const report: ReportRow = {
    id: reportId,
    source: input.source,
    run_id: input.run_id ?? null,
    install_id: install?.id ?? null,
    project_key: project,
    location,
    files: JSON.stringify(files),
    at: w.now,
  };
  const store = () => w.insert('instruction_reports', { ...report });

  if (!install || !manifest) {
    if (ifChanged) return { report_id: null, drift_ids: [] };
    store();
    return { report_id: reportId, drift_ids: [] };
  }

  // Decision 56: an agent running on the main branch shows a fetched update got there.
  if (input.source === 'agent' && input.run_id) {
    const stored = db.sqlite
      .prepare('SELECT token_sha256 FROM installs WHERE id = ?')
      .get(install.id) as { token_sha256: string | null };
    if (isPendingUpdate({ ...install, token_sha256: stored.token_sha256 })) {
      const on = db.sqlite
        .prepare(
          `SELECT json_extract(u.workspace, '$.branch') AS branch, p.main_branch AS main
           FROM runs u JOIN projects p ON p.key = ? WHERE u.id = ?`,
        )
        .get(install.project_key, input.run_id) as
        { branch: string | null; main: string } | undefined;
      if (on?.branch && on.branch === on.main) markUpdateLanded(w, install);
    }
  }

  // Plan first, so a quiet push check writes nothing.
  // Only the push check reads the connection file; an agent's report leaves its records alone.
  const coversConnection = input.source === 'push_check';
  const diffs = differences(manifest, files, coversConnection);
  const open = new Map(
    openRowsOf(db, install.id)
      .filter(
        (r) =>
          coversConnection ||
          (r.file_key !== CONNECTION_KEY &&
            !isScriptKey(r.file_key) &&
            // An agent's report can't tell a missing reference from an unchanged one.
            !(isSkillReferenceKey(r.file_key) && r.change === 'missing')),
      )
      .map((r) => [r.file_key, r]),
  );
  const inserts: Difference[] = [];
  const updates: { row: DriftRow; d: Difference }[] = [];
  const matched: DriftRow[] = [];
  for (const d of diffs) {
    const row = open.get(d.key);
    if (row) {
      if (row.change !== d.change || row.local_sha256 !== d.local) updates.push({ row, d });
      continue;
    }
    const accepted = acceptedOf(db, install.id, d.key);
    if (accepted && accepted.change === d.change && accepted.local_sha256 === d.local) continue;
    inserts.push(d);
  }
  const differing = new Set(diffs.map((d) => d.key));
  for (const row of open.values()) if (!differing.has(row.file_key)) matched.push(row);
  // A newer install at the same location replaces an older one's records.
  const superseded = install.path
    ? (db.sqlite
        .prepare(
          `SELECT d.* FROM drift d JOIN installs i ON i.id = d.install_id
           WHERE d.state = 'open' AND i.id <> ? AND i.client = ? AND i.target_kind = ?
             AND lower(i.path) = lower(?) AND i.at < ?`,
        )
        .all(
          install.id,
          install.client,
          install.target_kind,
          install.path,
          install.at,
        ) as DriftRow[])
    : [];
  if (ifChanged && inserts.length + updates.length + matched.length + superseded.length === 0) {
    return { report_id: null, drift_ids: [] };
  }

  store();
  const where = whereOf(install, report);
  const found = foundText(db, report);
  const pname = projectName(db, project);
  const ids: string[] = [];
  for (const d of inserts) {
    const id = newId('dft', Date.parse(w.now));
    w.insert('drift', {
      id,
      install_id: install.id,
      project_key: project,
      file_key: d.key,
      change: d.change,
      state: 'open',
      local_sha256: d.local,
      report_id: reportId,
      detected_at: w.now,
    });
    w.event({
      type: 'drift.detected',
      summary: `${changeText(d.key, d.change)} outside Docket · ${pname} · ${where} · ${found}`,
      project_key: project,
      item_id: runItem,
      data: { drift_id: id, install_id: install.id, key: d.key, change: d.change },
      objects: [
        { kind: 'drift', id },
        { kind: 'install', id: install.id },
      ],
    });
    ids.push(id);
  }
  for (const { row, d } of updates) {
    w.update('drift', row.id, {
      change: d.change,
      local_sha256: d.local,
      report_id: reportId,
      detected_at: w.now,
    });
    w.event({
      type: 'drift.detected',
      summary: `${changeText(d.key, d.change)} outside Docket again · ${pname} · ${where} · ${found}`,
      project_key: project,
      item_id: runItem,
      data: { drift_id: row.id, install_id: install.id, key: d.key, change: d.change, again: true },
      objects: [{ kind: 'drift', id: row.id }],
    });
    ids.push(row.id);
  }
  for (const row of matched) {
    resolve(
      w,
      row,
      'restored',
      `${agentFileName(row.file_key)} matches what Docket sent again · ${pname} · ${where} · ${found}`,
      { item_id: runItem },
    );
  }
  for (const row of superseded) {
    resolve(
      w,
      row,
      'restored',
      `${agentFileName(row.file_key)}: a newer install replaced the one that changed · ${projectName(db, row.project_key)} · ${where}`,
    );
  }
  return { report_id: reportId, drift_ids: ids };
}

// ---- Read models for other screens (Needs you, the ticket) ----

/** Open drift as Problems rows (UI_SPEC §6.1, §6.7b-1): the key fact first. */
export function driftProblems(
  db: Db,
  inScope: (project: string | null) => boolean,
  all: boolean,
): Problem[] {
  const rows = db.sqlite
    .prepare(
      `SELECT d.* FROM drift d LEFT JOIN projects p ON p.key = d.project_key
       JOIN installs i ON i.id = d.install_id AND i.target_kind = 'repo' AND i.removed_at IS NULL
       WHERE d.state = 'open' AND (d.project_key IS NULL OR p.deleted_at IS NULL)
       ORDER BY d.detected_at DESC, d.id DESC`,
    )
    .all() as DriftRow[];
  const out: Problem[] = [];
  for (const row of rows) {
    if (row.project_key ? !inScope(row.project_key) : !all) continue;
    const install = installById(db, row.install_id);
    if (!install) continue;
    const report = reportById(db, row.report_id);
    const change = changeText(row.file_key, row.change);
    const project = projectName(db, row.project_key);
    const where = whereOf(install, report);
    out.push({
      kind: 'agent_files_drift',
      item_id: null,
      title: null,
      reason: `${change} outside Docket · ${project} · ${where} · ${foundText(db, report)}`,
      related: [],
      link_id: null,
      run_id: report?.run_id ?? null,
      resource_ids: [],
      drift_id: row.id,
      // Decision 37 (B42): an ID for acknowledging it, and what to do.
      id: `agent_files_drift:${row.id}`,
      explanation: explain.agent_files_drift({ change, project, where }),
    });
  }
  return out;
}

/**
 * "Instructions: docket-worker · Recipe App's copy v2" for each run of an
 * item that reported them (FR-133): which version each file was sent at,
 * and ⚠ "edited locally" when the report differs from it.
 */
export function runInstructions(db: Db, itemId: string): RunInstructions[] {
  const reports = db.sqlite
    .prepare(
      `SELECT r.* FROM instruction_reports r JOIN runs u ON u.id = r.run_id
       WHERE u.item_id = ? AND r.source = 'agent' ORDER BY r.at DESC, r.id DESC`,
    )
    .all(itemId) as ReportRow[];
  const seen = new Set<string>();
  const out: RunInstructions[] = [];
  for (const r of reports) {
    // The latest report per run.
    if (!r.run_id || seen.has(r.run_id)) continue;
    seen.add(r.run_id);
    const files = filesOf(r);
    const install = r.install_id ? installById(db, r.install_id) : undefined;
    const manifest = install ? manifestOf(install) : {};
    // An agent never reports the connection file (decision 32): the run lists the instruction files only.
    const sentKeys = Object.keys(manifest).filter((k) => k !== CONNECTION_KEY && !isScriptKey(k));
    const keys = [...new Set([...sentKeys, ...Object.keys(files)])].sort(
      (a, b) =>
        (a === 'skill:docket-worker' ? -1 : 0) - (b === 'skill:docket-worker' ? -1 : 0) ||
        (a.startsWith('skill:') ? 0 : 1) - (b.startsWith('skill:') ? 0 : 1) ||
        a.localeCompare(b),
    );
    out.push({
      run_id: r.run_id,
      install_id: install?.id ?? null,
      files: keys.map((key) => {
        const sent = manifest[key];
        const got = files[key];
        const version = sent
          ? (db.sqlite
              .prepare(
                `SELECT v.version_no, f.layer FROM agent_file_versions v JOIN agent_files f ON f.id = v.file_id WHERE v.id = ?`,
              )
              .get(sent.version_id) as { version_no: number; layer: string } | undefined)
          : undefined;
        // A skill reference left out of an agent's report is as sent (decision 66).
        const edited =
          !!sent && (got ? got.sha256 !== sent.sha256.toLowerCase() : !isSkillReferenceKey(key));
        const drift = install
          ? (db.sqlite
              .prepare(
                `SELECT id FROM drift WHERE install_id = ? AND file_key = ?
                 ORDER BY (state = 'open') DESC, detected_at DESC LIMIT 1`,
              )
              .get(install.id, key) as { id: string } | undefined)
          : undefined;
        return {
          key,
          name: agentFileName(key),
          source: version ? (version.layer === 'project' ? 'project' : 'default') : null,
          version_no: version?.version_no ?? null,
          edited_locally: edited || (!sent && !!install && isDocketSkill(key)),
          drift_id: edited || (!sent && install) ? (drift?.id ?? null) : null,
        };
      }),
    });
  }
  return out;
}

/**
 * Adopting a folder kept under its old name (B28): its frontmatter `name:`
 * line takes the new name, so the adopted file installs as a working skill.
 * Nothing else in the text changes.
 */
function renameSkillFrontmatter(text: string, oldKey: string, newKey: string): string {
  const from = oldKey.slice('skill:'.length);
  const to = newKey.slice('skill:'.length);
  const m = /^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/.exec(text);
  if (!m) return text;
  const head = m[0].replace(new RegExp(`^name:[ \\t]*${from}[ \\t]*$`, 'm'), `name: ${to}`);
  return head + text.slice(m[0].length);
}

// ---- The service ----

/** A report keeps text up to the agent file limit; longer text is left out. */
function safeText(text: string | null): string | undefined {
  if (text === null || text.length > MAX_CONTENT) return undefined;
  return text;
}

export function createDriftService(deps: ServiceDeps): DriftService {
  const { config } = deps;
  return {
    recordReport(w, input) {
      const r = record(w, input, false);
      return { report_id: r.report_id!, drift_ids: r.drift_ids };
    },

    async checkPushInstalls(r) {
      if (!config.pushRoot) return [];
      // The latest push install at each location: an older one there was overwritten.
      const rows = (
        r.db.sqlite
          .prepare(
            `SELECT ${INSTALL_COLUMNS}
             FROM installs WHERE method = 'push' AND path IS NOT NULL ORDER BY at DESC, id DESC`,
          )
          .all() as InstallDbRow[]
      )
        .filter(
          (row, i, all) =>
            all.findIndex(
              (o) =>
                o.client === row.client &&
                o.target_kind === row.target_kind &&
                o.path!.toLowerCase() === row.path!.toLowerCase(),
            ) === i,
        )
        // Decision 50: picked after the latest, so a removed install doesn't revive an older one.
        .filter((row) => canDrift(row));
      if (rows.length === 0) return [];
      let root: PushRoot;
      try {
        root = await PushRoot.open(config.pushRoot, config.pushHostPath);
      } catch (err) {
        deps.log(`drift check: the push folder can't be read: ${(err as Error).message}`);
        return [];
      }
      const reports: InstructionReportInput[] = [];
      for (const row of rows) {
        try {
          const files = await inspectPushInstall(root, row);
          reports.push({
            source: 'push_check',
            install_id: row.id,
            ...(row.project_key ? { project: row.project_key } : {}),
            location: row.path!,
            files: files
              .filter(
                (f) =>
                  f.state !== 'missing' &&
                  f.sha256 &&
                  (INSTALLED_FILE_KEY_RE.test(f.key) ||
                    f.key === CONNECTION_KEY ||
                    isScriptKey(f.key)),
              )
              .map((f) => {
                const text = f.state === 'ok' ? null : f.text;
                const secret = text !== null && findSecret(text, { known: deps.secrets.known() });
                const content = secret ? undefined : safeText(text);
                return {
                  key: f.key,
                  sha256: f.sha256!,
                  ...(content !== undefined ? { content } : {}),
                  ...(secret ? { withheld: 'secret' as const } : {}),
                };
              }),
          });
        } catch (err) {
          deps.log(`drift check: couldn't read ${row.path} (${row.id}): ${(err as Error).message}`);
        }
      }
      return reports;
    },

    recordChecks(w, input) {
      const ids: string[] = [];
      for (const report of input.reports) ids.push(...record(w, report, true).drift_ids);
      return { drift_ids: ids };
    },

    list(r, input) {
      // Decision 50: a legacy user-wide install's records are history, not something to act on.
      const where: string[] = [
        '(d.project_key IS NULL OR p.deleted_at IS NULL)',
        `d.install_id IN (SELECT id FROM installs WHERE target_kind = 'repo')`,
      ];
      const args: unknown[] = [];
      if (input.project) {
        where.push('d.project_key = ?');
        args.push(input.project);
      }
      if (input.state) {
        where.push('d.state = ?');
        args.push(input.state);
      }
      const rows = r.db.sqlite
        .prepare(
          `SELECT d.* FROM drift d LEFT JOIN projects p ON p.key = d.project_key
           WHERE ${where.join(' AND ')}
           ORDER BY (d.state = 'open') DESC, d.detected_at DESC, d.id DESC LIMIT 200`,
        )
        .all(...args) as DriftRow[];
      return { drift: rows.map((row) => toDrift(r.db, row)) };
    },

    adopt(w, { id }) {
      const row = requireOpen(w.db, id);
      const name = agentFileName(row.file_key);
      if (row.change === 'missing') {
        throw new ToolError(
          'validation',
          `${name} is missing there, so there's nothing to adopt. Restore it, or keep it missing with Keep local.`,
        );
      }
      if (!isShippedKey(w.db, mapLegacySkillKey(row.file_key))) {
        throw new ToolError(
          'validation',
          `${name} isn't one of the files Docket ships, so it can't be adopted. Keep it local, or remove the folder.`,
        );
      }
      // A folder kept under its old name is adopted as the file it was renamed to (B28).
      const key = mapLegacySkillKey(row.file_key);
      const local = localContent(w.db, row);
      const content =
        local !== null && key !== row.file_key
          ? renameSkillFrontmatter(local, row.file_key, key)
          : local;
      if (content === null && contentWithheld(w.db, row) === 'secret') {
        throw new ToolError(
          'validation',
          `Content withheld: the local text of ${name} looked like a secret, so Docket didn't keep it. Remove the secret from the file there; the next docket-check report sends the text.`,
        );
      }
      if (content === null || content.trim() === '') {
        throw new ToolError(
          'validation',
          `Docket doesn't have the local text of ${name}. Run docket-check on that machine to send the text: the next agent claim there does it.`,
        );
      }
      const install = installById(w.db, row.install_id)!;
      const where = whereOf(install, reportById(w.db, row.report_id));
      const saved = saveAgentFileEdit(w, {
        key,
        project: row.project_key,
        content,
        note: `Adopted the local edit from ${where}`.slice(0, 500),
        author: 'owner',
        how: 'Adopted the local edit as',
      });
      resolve(
        w,
        row,
        'adopted',
        `You adopted the local ${name} as ${row.project_key ? `${projectName(w.db, row.project_key)}'s copy` : 'the default'} · ${where}`,
        { inverse: [] },
      );
      void saved;
      return toDrift(w.db, driftRow(w.db, id));
    },

    async restorePrepare(r, { id }): Promise<PreparedRestore> {
      const row = requireOpen(r.db, id);
      if (row.change === 'extra' && isLegacySkillKey(row.file_key)) {
        throw new ToolError(
          'validation',
          `Docket removes an old-name folder only while it is unmodified, and ${agentFileName(row.file_key)} was edited. Adopt it as ${agentFileName(mapLegacySkillKey(row.file_key))}, or Keep local.`,
        );
      }
      if (row.change === 'extra') {
        throw new ToolError(
          'validation',
          `Docket never deletes files, so restoring can't remove the extra ${agentFileName(row.file_key)} folder. Remove it yourself, or Keep local.`,
        );
      }
      const install = installById(r.db, row.install_id)!;
      const input = {
        client: install.client as InstallClient,
        target_kind: install.target_kind as InstallTargetKind,
        method: install.method as InstallMethod,
        ...(install.project_key ? { project: install.project_key } : {}),
        ...(install.path ? { path: install.path } : {}),
      };
      return { drift_id: id, install: await deps.services().installs.prepare(r, input) };
    },

    restoreRecord(w, p) {
      const row = driftRow(w.db, p.drift_id);
      const old = installById(w.db, row.install_id)!;
      const result = deps.services().installs.record(w, p.install);
      const where = whereOf(old, reportById(w.db, row.report_id));
      const how =
        p.install.input.method === 'push'
          ? 'reinstalled by push'
          : 'with a new install command to run there';
      for (const open of openRowsOf(w.db, old.id)) {
        resolve(
          w,
          open,
          'restored',
          `You restored Docket's version of ${agentFileName(open.file_key)} · ${projectName(w.db, open.project_key)} · ${where} · ${how} (${INSTALL_CLIENT_LABELS[old.client]})`,
        );
      }
      return { drift: toDrift(w.db, driftRow(w.db, p.drift_id)), install: result };
    },

    closeForRemovedInstall(w, installId) {
      for (const open of openRowsOf(w.db, installId)) {
        resolve(
          w,
          open,
          'restored',
          `${agentFileName(open.file_key)}: the install was removed · ${projectName(w.db, open.project_key)}`,
        );
      }
    },

    keepLocal(w, { id }) {
      const row = requireOpen(w.db, id);
      const install = installById(w.db, row.install_id)!;
      resolve(
        w,
        row,
        'kept_local',
        `You kept the local ${agentFileName(row.file_key)} · ${projectName(w.db, row.project_key)} · ${whereOf(install, reportById(w.db, row.report_id))}; a further change alerts again`,
      );
      return toDrift(w.db, driftRow(w.db, id));
    },
  };
}
