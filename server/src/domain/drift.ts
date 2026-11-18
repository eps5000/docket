/**
 * Drift (owner decision 30; BUILD_SPEC §5.19; FR-131–FR-133; tasks.md T161):
 * instruction reports from `claim_lead` and the scheduled push-folder check,
 * drift records against each install's manifest, and the remedies (*Adopt*,
 * *Restore*, *Keep local*).
 *
 * **Reports.** An agent's report is the installed `tasklite-check` script's
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
 * - *extra*: a `tasklite-*` skill the install didn't write;
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
import {
  INSTALL_CLIENT_LABELS,
  INSTALLED_FILE_KEY_RE,
  ToolError,
  findSecret,
  type Drift,
  type DriftChange,
  type DriftState,
  type InstallClient,
  type InstallMethod,
  type InstallTargetKind,
  type InstructionReportSource,
  type Problem,
  type RunInstructions,
} from '@tasklite/shared';
import type { Db } from '../db/client.js';
import { agentFileName, isShippedKey, saveAgentFileEdit } from './agent-files.js';
import type {
  DriftService,
  InstructionReportInput,
  PreparedRestore,
  ServiceDeps,
} from './contracts.js';
import { newId } from './ids.js';
import { inspectPushInstall, type InstallDbRow, type ManifestMap } from './installs.js';
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
type ReportFiles = Record<string, { sha256: string; content?: string }>;

interface Difference {
  key: string;
  change: DriftChange;
  /** Null when missing. */
  local: string | null;
}

const installById = (db: Db, id: string) =>
  db.sqlite
    .prepare(
      `SELECT id, at, client, target_kind, project_key, path, method, manifest, token_used_at
       FROM installs WHERE id = ?`,
    )
    .get(id) as InstallDbRow | undefined;

const manifestOf = (row: InstallDbRow): ManifestMap => JSON.parse(row.manifest) as ManifestMap;

function reportById(db: Db, id: string | null): ReportRow | undefined {
  if (!id) return undefined;
  return db.sqlite.prepare('SELECT * FROM instruction_reports WHERE id = ?').get(id) as
    ReportRow | undefined;
}

const filesOf = (r: ReportRow | undefined): ReportFiles =>
  r ? (JSON.parse(r.files) as ReportFiles) : {};

/** An extra skill folder the install didn't write, by Task Lite's naming. */
const isTaskLiteSkill = (key: string) => key.startsWith('skill:tasklite-');

/**
 * Compare a report with the install's manifest: edited, missing and extra
 * files. Unknown keys (not Task Lite's) aren't differences.
 */
export function differences(manifest: ManifestMap, files: ReportFiles): Difference[] {
  const out: Difference[] = [];
  for (const [key, sent] of Object.entries(manifest)) {
    const got = files[key];
    if (!got) out.push({ key, change: 'missing', local: null });
    else if (got.sha256 !== sent.sha256.toLowerCase()) {
      out.push({ key, change: 'edited', local: got.sha256 });
    }
  }
  for (const [key, got] of Object.entries(files)) {
    if (!(key in manifest) && isTaskLiteSkill(key)) {
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
    out[f.key] = keep ? { sha256, content: f.content } : { sha256 };
  }
  return out;
}

/** "tasklite-worker edited", "AGENTS.md block missing", "tasklite-old added". */
function changeText(key: string, change: DriftChange): string {
  const name = agentFileName(key);
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

function toDrift(db: Db, row: DriftRow): Drift {
  const install = installById(db, row.install_id)!;
  const report = reportById(db, row.report_id);
  const sent = manifestOf(install)[row.file_key];
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
  const install = input.install_id ? installById(db, input.install_id) : undefined;
  const manifest = install ? manifestOf(install) : undefined;
  const files = normalise(input.files, manifest);
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

  // Plan first, so a quiet push check writes nothing.
  const diffs = differences(manifest, files);
  const open = new Map(openRowsOf(db, install.id).map((r) => [r.file_key, r]));
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
      summary: `${changeText(d.key, d.change)} outside Task Lite · ${pname} · ${where} · ${found}`,
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
      summary: `${changeText(d.key, d.change)} outside Task Lite again · ${pname} · ${where} · ${found}`,
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
      `${agentFileName(row.file_key)} matches what Task Lite sent again · ${pname} · ${where} · ${found}`,
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
    out.push({
      kind: 'agent_files_drift',
      item_id: null,
      title: null,
      reason: `${changeText(row.file_key, row.change)} outside Task Lite · ${projectName(db, row.project_key)} · ${whereOf(install, report)} · ${foundText(db, report)}`,
      related: [],
      link_id: null,
      run_id: report?.run_id ?? null,
      resource_ids: [],
      drift_id: row.id,
    });
  }
  return out;
}

/**
 * "Instructions: tasklite-worker · Recipe App's copy v2" for each run of an
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
    const keys = [...new Set([...Object.keys(manifest), ...Object.keys(files)])].sort(
      (a, b) =>
        (a === 'skill:tasklite-worker' ? -1 : 0) - (b === 'skill:tasklite-worker' ? -1 : 0) ||
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
        const edited = !!sent && (!got || got.sha256 !== sent.sha256.toLowerCase());
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
          edited_locally: edited || (!sent && !!install && isTaskLiteSkill(key)),
          drift_id: edited || (!sent && install) ? (drift?.id ?? null) : null,
        };
      }),
    });
  }
  return out;
}

// ---- The service ----

/** Why a report's text was left out: too long, or it looks like a secret (never stored). */
function safeText(text: string | null): string | undefined {
  if (text === null || text.length > MAX_CONTENT) return undefined;
  return findSecret(text) ? undefined : text;
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
            `SELECT id, at, client, target_kind, project_key, path, method, manifest, token_used_at
             FROM installs WHERE method = 'push' AND path IS NOT NULL ORDER BY at DESC, id DESC`,
          )
          .all() as InstallDbRow[]
      ).filter(
        (row, i, all) =>
          all.findIndex(
            (o) =>
              o.client === row.client &&
              o.target_kind === row.target_kind &&
              o.path!.toLowerCase() === row.path!.toLowerCase(),
          ) === i,
      );
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
              .filter((f) => f.state !== 'missing' && f.sha256 && INSTALLED_FILE_KEY_RE.test(f.key))
              .map((f) => {
                const content = f.state === 'ok' ? undefined : safeText(f.text);
                return {
                  key: f.key,
                  sha256: f.sha256!,
                  ...(content !== undefined ? { content } : {}),
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
      const where: string[] = ['(d.project_key IS NULL OR p.deleted_at IS NULL)'];
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
      if (!isShippedKey(w.db, row.file_key)) {
        throw new ToolError(
          'validation',
          `${name} isn't one of the files Task Lite ships, so it can't be adopted. Keep it local, or remove the folder.`,
        );
      }
      const content = localContent(w.db, row);
      if (content === null || content.trim() === '') {
        throw new ToolError(
          'validation',
          `Task Lite doesn't have the local text of ${name}. Run tasklite-check on that machine to send the text: the next agent claim there does it.`,
        );
      }
      const install = installById(w.db, row.install_id)!;
      const where = whereOf(install, reportById(w.db, row.report_id));
      const saved = saveAgentFileEdit(w, {
        key: row.file_key,
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
      if (row.change === 'extra') {
        throw new ToolError(
          'validation',
          `Task Lite never deletes files, so restoring can't remove the extra ${agentFileName(row.file_key)} folder. Remove it yourself, or Keep local.`,
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
          `You restored Task Lite's version of ${agentFileName(open.file_key)} · ${projectName(w.db, open.project_key)} · ${where} · ${how} (${INSTALL_CLIENT_LABELS[old.client]})`,
        );
      }
      return { drift: toDrift(w.db, driftRow(w.db, p.drift_id)), install: result };
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
