/**
 * Agent files and Workflow notes (owner decision 29; BUILD_SPEC §5.17;
 * FR-121–FR-123; tasks.md T153, T157).
 *
 * **Files.** Each skill (`skill:<name>`) and the AGENTS.md block
 * (`agents_block`) lives in up to three layers: `bundled` (the image's copy,
 * loaded at startup by `syncBundled`), `service` (the owner's service-wide
 * edit) and `project` (one project's override). Each layer is one
 * `agent_files` row whose versions are immutable `agent_file_versions` rows;
 * `current_version_id` points at the layer's current version, or is null
 * when the layer was reverted (its history stays).
 *
 * **Resolution.** For a project: its override, else the service-wide edit,
 * else bundled. Service-wide: the edit, else bundled.
 *
 * **Edits** (`put`) add a version to the service or project layer and
 * remember the bundled sha256 they were made against
 * (`bundled_hash_at_edit`). `expected_version` is the layer's current
 * `version_no`, 0 when it has none (B21 resolution 2). Only the shipped
 * files can be edited: a key needs a bundled layer.
 *
 * **Revert** turns the layer off (`current_version_id` = null), so the layer
 * below is effective again and later bundled upgrades reach it; the layer's
 * versions stay as history. ("Revert creates a version equal to the layer
 * below, or removes the override": removing it is the one that keeps
 * following upgrades.)
 *
 * **Bundled version updated** (FR-122): the effective layer is an edit whose
 * `bundled_hash_at_edit` differs from the current bundled version's sha256.
 * The owner's version is never overwritten; editing again (even with the
 * same text) re-bases it on the current bundled version and clears the flag.
 *
 * **Workflow notes** are per project, versioned (`project_workflows`, the
 * newest is current), 0–10,000 characters; an empty version clears them.
 * `get_context` delivers the current, non-empty version (context.ts).
 *
 * Every edit appends its event (`agent_file.updated`, `agent_file.reverted`,
 * `workflow.updated`) with the inverse operations, so the owner can undo
 * it from the toast (B21 resolution 8). The bundled load appends
 * `agent_file.updated` as the system, with no inverse.
 */
import { createHash } from 'node:crypto';
import {
  CONNECTION_KEY,
  ONBOARDING_GUIDE_KEY,
  ToolError,
  agentFileLabel,
  isScriptKey,
  scriptNameOf,
  skillKeyParts,
  type AgentFileDetail,
  type AgentFileLayer,
  type AgentFileRow,
  type AgentFileVersion,
  type AgentFileVersionRef,
  type EditableAgentFileLayer,
  type Workflow,
} from '@docket/shared';
import type { Db } from '../db/client.js';
import { APP_VERSION } from '../version.js';
import type { AgentFilesService, BundledAgentFile, ServiceDeps } from './contracts.js';
import { newId } from './ids.js';
import type { Actor, InverseOp, WriteContext } from './write.js';

// ---- Rows ----

interface FileRow {
  id: string;
  key: string;
  layer: AgentFileLayer;
  project_key: string | null;
  current_version_id: string | null;
  bundled_hash_at_edit: string | null;
}

interface VersionRow {
  id: string;
  file_id: string;
  version_no: number;
  content: string;
  sha256: string;
  author: string;
  note: string | null;
  created_at: string;
}

interface WorkflowRow {
  id: string;
  project_key: string;
  version_no: number;
  content_md: string;
  author: string;
  note: string | null;
  created_at: string;
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const LAYER_NAMES: Record<AgentFileLayer, string> = {
  bundled: 'bundled',
  service: 'service-wide edit',
  project: 'project override',
};

/**
 * `skill:docket-worker` → `docket-worker`; a reference (decision 66) →
 * `docket-worker/references/exit-reports.md`; `agents_block` → `AGENTS.md
 * block`; the guide → `Onboarding guide`.
 */
export function agentFileName(key: string): string {
  if (key === ONBOARDING_GUIDE_KEY) return 'Onboarding guide';
  // The project connection file (decision 32): .mcp.json or .codex/config.toml.
  if (key === CONNECTION_KEY) return 'Connection file';
  if (isScriptKey(key)) return scriptNameOf(key);
  return agentFileLabel(key);
}

const kindOf = (key: string): 'skill' | 'agents_block' | 'guide' =>
  key.startsWith('skill:') ? 'skill' : key === ONBOARDING_GUIDE_KEY ? 'guide' : 'agents_block';

const KIND_ORDER = { skill: 0, agents_block: 1, guide: 2 } as const;

/** Skills by name, then the AGENTS.md block, then the onboarding guide. */
function compareKeys(a: string, b: string): number {
  return KIND_ORDER[kindOf(a)] - KIND_ORDER[kindOf(b)] || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * Whether a key is installed into repos. The onboarding guide (decision 31) is
 * served by onboard_project and the `onboard` prompt instead: installs, drift,
 * the check script and get_agent_files leave it out, and it can't be proposed.
 */
export const isInstalledKey = (key: string): boolean => key !== ONBOARDING_GUIDE_KEY;

/** Who wrote a version: the owner, the system (bundled loads), or an agent's client. */
function authorOf(actor: Actor): string {
  if (actor.kind === 'agent') return actor.label ?? actor.client ?? 'agent';
  return actor.kind;
}

function requireProject(db: Db, key: string): void {
  const p = db.sqlite
    .prepare('SELECT key FROM projects WHERE key = ? AND deleted_at IS NULL')
    .get(key);
  if (!p) throw new ToolError('not_found', `No project ${key}. Check the key in Settings.`);
}

function fileRow(
  db: Db,
  key: string,
  layer: AgentFileLayer,
  project: string | null,
): FileRow | undefined {
  return db.sqlite
    .prepare(
      `SELECT id, key, layer, project_key, current_version_id, bundled_hash_at_edit FROM agent_files
       WHERE key = ? AND layer = ? AND project_key IS ?`,
    )
    .get(key, layer, project) as FileRow | undefined;
}

function versionById(db: Db, id: string | null): VersionRow | undefined {
  if (!id) return undefined;
  return db.sqlite
    .prepare(
      `SELECT id, file_id, version_no, content, sha256, author, note, created_at
       FROM agent_file_versions WHERE id = ?`,
    )
    .get(id) as VersionRow | undefined;
}

function versionsOf(db: Db, fileId: string): VersionRow[] {
  return db.sqlite
    .prepare(
      `SELECT id, file_id, version_no, content, sha256, author, note, created_at
       FROM agent_file_versions WHERE file_id = ? ORDER BY version_no DESC`,
    )
    .all(fileId) as VersionRow[];
}

const toVersion = (v: VersionRow): AgentFileVersion => ({
  id: v.id,
  version_no: v.version_no,
  sha256: v.sha256,
  author: v.author,
  note: v.note,
  created_at: v.created_at,
  content: v.content,
});

const toRef = (v: VersionRow): AgentFileVersionRef => ({
  id: v.id,
  version_no: v.version_no,
  sha256: v.sha256,
  author: v.author,
  note: v.note,
  created_at: v.created_at,
});

/** One key's three layer rows (the project row only when a project is given). */
interface Layers {
  bundled?: FileRow;
  service?: FileRow;
  project?: FileRow;
}

function layersOf(db: Db, key: string, project: string | null): Layers {
  return {
    bundled: fileRow(db, key, 'bundled', null),
    service: fileRow(db, key, 'service', null),
    project: project ? fileRow(db, key, 'project', project) : undefined,
  };
}

/** The layer that applies: the highest one with a current version. */
function effectiveLayer(layers: Layers): AgentFileLayer | null {
  if (layers.project?.current_version_id) return 'project';
  if (layers.service?.current_version_id) return 'service';
  if (layers.bundled?.current_version_id) return 'bundled';
  return null;
}

/**
 * The bundled-updated flag (BUILD_SPEC §5.17) for the effective layer: it is
 * an edit, made against a bundled sha256 that is no longer the current one.
 */
function bundledUpdated(
  db: Db,
  layers: Layers,
  effective: AgentFileLayer,
): AgentFileDetail['bundled_updated'] {
  if (effective === 'bundled') return null;
  const edited = layers[effective];
  const bundled = versionById(db, layers.bundled?.current_version_id ?? null);
  if (!edited || !bundled) return null;
  if (edited.bundled_hash_at_edit === bundled.sha256) return null;
  const from = edited.bundled_hash_at_edit
    ? (db.sqlite
        .prepare(
          `SELECT id FROM agent_file_versions WHERE file_id = ? AND sha256 = ?
           ORDER BY version_no DESC LIMIT 1`,
        )
        .get(bundled.file_id, edited.bundled_hash_at_edit) as { id: string } | undefined)
    : undefined;
  return { edited_layer: effective, from_version_id: from?.id ?? null, to_version_id: bundled.id };
}

/** Every key known service-wide or to `project`. */
function keysOf(db: Db, project: string | null): string[] {
  const rows = db.sqlite
    .prepare(`SELECT DISTINCT key FROM agent_files WHERE project_key IS NULL OR project_key IS ?`)
    .all(project) as { key: string }[];
  return rows.map((r) => r.key).sort(compareKeys);
}

function listRow(db: Db, key: string, project: string | null): AgentFileRow | null {
  const layers = layersOf(db, key, project);
  const effective = effectiveLayer(layers);
  if (!effective) return null;
  const ref = (row: FileRow | undefined) => {
    const v = versionById(db, row?.current_version_id ?? null);
    return v ? toRef(v) : null;
  };
  const refs = {
    bundled: ref(layers.bundled),
    service: ref(layers.service),
    project: ref(layers.project),
  };
  return {
    key,
    kind: kindOf(key),
    name: agentFileName(key),
    effective_layer: effective,
    effective: refs[effective]!,
    layers: refs,
    bundled_updated: bundledUpdated(db, layers, effective) !== null,
  };
}

/** One file with every layer, its history and the flag (the file view). */
export function agentFileDetail(db: Db, key: string, project: string | null): AgentFileDetail {
  if (project) requireProject(db, project);
  const layers = layersOf(db, key, project);
  const effective = effectiveLayer(layers);
  if (!effective) {
    throw new ToolError('not_found', `No agent file ${key}. Check the key in Agent files.`);
  }
  const detail = (row: FileRow | undefined) => {
    if (!row) return null;
    const versions = versionsOf(db, row.id);
    const current = versions.find((v) => v.id === row.current_version_id);
    return {
      file_id: row.id,
      current_version_no: current?.version_no ?? 0,
      versions: versions.map(toVersion),
    };
  };
  return {
    key,
    kind: kindOf(key),
    name: agentFileName(key),
    project,
    effective_layer: effective,
    layers: {
      bundled: detail(layers.bundled),
      service: detail(layers.service),
      project: detail(layers.project),
    },
    bundled_updated: bundledUpdated(db, layers, effective),
  };
}

/**
 * The effective version of each installed agent file for `project` (or
 * service-wide): what an install sends (B24) and what get_agent_files lists.
 * The onboarding guide isn't one (`isInstalledKey`; B30).
 */
export function effectiveAgentFiles(
  db: Db,
  project: string | null,
): { key: string; layer: AgentFileLayer; version: AgentFileVersion }[] {
  const out: { key: string; layer: AgentFileLayer; version: AgentFileVersion }[] = [];
  for (const key of keysOf(db, project).filter(isInstalledKey)) {
    const layers = layersOf(db, key, project);
    const layer = effectiveLayer(layers);
    const v = layer ? versionById(db, layers[layer]!.current_version_id) : undefined;
    if (layer && v) out.push({ key, layer, version: toVersion(v) });
  }
  return out;
}

/**
 * The effective text of one agent file for `project` (its override, else the
 * service-wide edit, else bundled), or null when it isn't loaded. A project
 * that doesn't exist yet gets the service-wide text (onboard_project on a
 * free key, or the `onboard` prompt).
 */
export function effectiveText(db: Db, key: string, project: string | null): string | null {
  const layers = layersOf(db, key, project);
  const layer = effectiveLayer(layers);
  return layer ? (versionById(db, layers[layer]!.current_version_id)?.content ?? null) : null;
}

const nextVersionNo = (db: Db, fileId: string): number =>
  (
    db.sqlite
      .prepare(
        'SELECT coalesce(max(version_no), 0) + 1 AS n FROM agent_file_versions WHERE file_id = ?',
      )
      .get(fileId) as { n: number }
  ).n;

/** "docket-worker (service-wide)" / "docket-worker (RCP)". */
const whereOf = (key: string, layer: EditableAgentFileLayer, project: string | null) =>
  `${agentFileName(key)} (${layer === 'project' ? project : 'service-wide'})`;

/** Add a version to `row` (inserting the row first when it's new); returns the version and inverses. */
function addVersion(
  w: WriteContext,
  target: { row?: FileRow; key: string; layer: AgentFileLayer; project: string | null },
  content: string,
  note: string | null,
  set: { bundled_hash_at_edit?: string | null } = {},
  author: string = authorOf(w.actor),
): { file_id: string; version: VersionRow; inverse: InverseOp[] } {
  const inverse: InverseOp[] = [];
  let fileId = target.row?.id;
  if (!fileId) {
    fileId = newId('af', Date.parse(w.now));
    inverse.push(
      w.insert('agent_files', {
        id: fileId,
        key: target.key,
        layer: target.layer,
        project_key: target.project,
        current_version_id: null,
        bundled_hash_at_edit: null,
      }),
    );
  }
  const version: VersionRow = {
    id: newId('afv', Date.parse(w.now)),
    file_id: fileId,
    version_no: nextVersionNo(w.db, fileId),
    content,
    sha256: sha256(content),
    author,
    note,
    created_at: w.now,
  };
  inverse.push(w.insert('agent_file_versions', { ...version }));
  inverse.push(w.update('agent_files', fileId, { current_version_id: version.id, ...set }));
  return { file_id: fileId, version, inverse };
}

/**
 * Save `content` as a new version of the default (the service-wide edit) or
 * of a project's copy, as an owner edit with undo: *Approve* on a proposal
 * and *Adopt* on drift (decision 30; BUILD_SPEC §5.19). It is `put` without
 * the version check (the caller decided on what it showed), with the author
 * given ("proposed by codex · orca-w3 · approved by owner"). It appends
 * `agent_file.updated` with its inverse.
 */
export function saveAgentFileEdit(
  w: WriteContext,
  input: {
    key: string;
    project: string | null;
    content: string;
    note: string | null;
    author: string;
    /** How the event says it: "Approved a proposed change to", "Adopted the local". */
    how: string;
  },
): { file_id: string; version: AgentFileVersion; inverse: InverseOp[] } {
  const layer: EditableAgentFileLayer = input.project ? 'project' : 'service';
  if (input.project) requireProject(w.db, input.project);
  const bundledRow = fileRow(w.db, input.key, 'bundled', null);
  const bundled = versionById(w.db, bundledRow?.current_version_id ?? null);
  if (!bundled) {
    throw new ToolError(
      'not_found',
      `No agent file ${input.key}. Only the files Docket ships can be edited.`,
    );
  }
  const row = fileRow(w.db, input.key, layer, input.project);
  const current = versionById(w.db, row?.current_version_id ?? null);
  const { file_id, version, inverse } = addVersion(
    w,
    { row, key: input.key, layer, project: input.project },
    input.content,
    input.note,
    { bundled_hash_at_edit: bundled.sha256 },
    input.author,
  );
  w.event({
    type: 'agent_file.updated',
    summary: `${input.how} ${whereOf(input.key, layer, input.project)}: v${version.version_no}`,
    project_key: input.project,
    data: {
      key: input.key,
      layer,
      project: input.project,
      version_no: { old: current?.version_no ?? 0, new: version.version_no },
      note: input.note,
      author: input.author,
    },
    objects: [{ kind: 'agent_file', id: file_id }],
    inverse,
  });
  return { file_id, version: toVersion(version), inverse };
}

/** Save new Workflow notes as an owner edit with undo (*Approve* on a Workflow proposal). */
export function saveWorkflowEdit(
  w: WriteContext,
  input: { project: string; content_md: string; note: string | null; author: string; how: string },
): { id: string; version_no: number } {
  requireProject(w.db, input.project);
  const before = workflowOf(w.db, input.project);
  const versionNo = before.version_no + 1;
  const id = newId('wf', Date.parse(w.now));
  const inverse = w.insert('project_workflows', {
    id,
    project_key: input.project,
    version_no: versionNo,
    content_md: input.content_md,
    author: input.author,
    note: input.note,
  });
  w.event({
    type: 'workflow.updated',
    summary: `${input.how} the Workflow notes of ${input.project}: v${versionNo}`,
    project_key: input.project,
    data: {
      project: input.project,
      version_no: { old: before.version_no, new: versionNo },
      note: input.note,
      author: input.author,
    },
    objects: [{ kind: 'project', id: input.project }],
    inverse: [inverse],
  });
  return { id, version_no: versionNo };
}

/**
 * What a change to `key` would replace now (decision 30): the project's
 * effective version (its copy, else the default) or, without a project, the
 * default; for `workflow`, the project's newest Workflow notes version.
 * Null when there is none (no notes yet, or a key Docket doesn't ship).
 */
export function currentTarget(
  db: Db,
  key: string,
  project: string | null,
): {
  id: string;
  content: string;
  sha256: string;
  version_no: number;
  source: 'default' | 'project';
} | null {
  if (key === 'workflow') {
    if (!project) return null;
    const row = workflowRows(db, project)[0];
    if (!row) return null;
    return {
      id: row.id,
      content: row.content_md,
      sha256: sha256(row.content_md),
      version_no: row.version_no,
      source: 'project',
    };
  }
  const layers = layersOf(db, key, project);
  const layer = effectiveLayer(layers);
  const v = layer ? versionById(db, layers[layer]!.current_version_id) : undefined;
  if (!layer || !v) return null;
  return {
    id: v.id,
    content: v.content,
    sha256: v.sha256,
    version_no: v.version_no,
    source: layer === 'project' ? 'project' : 'default',
  };
}

/** Whether `versionId` is a version of `key` (any layer) or, for `workflow`, of the project's notes. */
export function isVersionOf(
  db: Db,
  versionId: string,
  key: string,
  project: string | null,
): boolean {
  if (key === 'workflow') {
    return !!db.sqlite
      .prepare('SELECT 1 FROM project_workflows WHERE id = ? AND project_key IS ?')
      .get(versionId, project);
  }
  return !!db.sqlite
    .prepare(
      `SELECT 1 FROM agent_file_versions v JOIN agent_files f ON f.id = v.file_id
       WHERE v.id = ? AND f.key = ?`,
    )
    .get(versionId, key);
}

/** A version's text by ID: an agent file version or a Workflow notes version. */
export function versionText(db: Db, versionId: string): string | null {
  const row = (db.sqlite
    .prepare('SELECT content FROM agent_file_versions WHERE id = ?')
    .get(versionId) ??
    db.sqlite
      .prepare('SELECT content_md AS content FROM project_workflows WHERE id = ?')
      .get(versionId)) as { content: string } | undefined;
  return row?.content ?? null;
}

/** Whether Docket ships `key` (a bundled layer exists): only those can be edited. */
export function isShippedKey(db: Db, key: string): boolean {
  return !!fileRow(db, key, 'bundled', null)?.current_version_id;
}

// ---- Workflow notes ----

function workflowRows(db: Db, project: string): WorkflowRow[] {
  return db.sqlite
    .prepare(
      `SELECT id, project_key, version_no, content_md, author, note, created_at
       FROM project_workflows WHERE project_key = ? ORDER BY version_no DESC`,
    )
    .all(project) as WorkflowRow[];
}

function workflowOf(db: Db, project: string): Workflow {
  const rows = workflowRows(db, project);
  const current = rows[0];
  return {
    project,
    version_no: current?.version_no ?? 0,
    content_md: current?.content_md ?? '',
    versions: rows.map((r) => ({
      id: r.id,
      version_no: r.version_no,
      content_md: r.content_md,
      author: r.author,
      note: r.note,
      created_at: r.created_at,
    })),
  };
}

/**
 * The project's current Workflow notes for `get_context` (§5.15 section 5),
 * or null when it has none or the current version is empty (cleared).
 */
export function currentWorkflow(
  db: Db,
  project: string,
): { project: string; version_no: number; content_md: string } | null {
  const row = db.sqlite
    .prepare(
      `SELECT version_no, content_md FROM project_workflows WHERE project_key = ?
       ORDER BY version_no DESC LIMIT 1`,
    )
    .get(project) as { version_no: number; content_md: string } | undefined;
  if (!row || row.content_md.trim() === '') return null;
  return { project, version_no: row.version_no, content_md: row.content_md };
}

function conflict(what: string, current: number, sent: number, state: unknown): ToolError {
  return new ToolError(
    'conflict',
    `${what} changed since you opened it (now v${current}, you sent v${sent}). Reload it and make your change again.`,
    { current: state as Record<string, unknown> },
  );
}

// ---- The service ----

export function createAgentFilesService(_deps: ServiceDeps): AgentFilesService {
  return {
    syncBundled(w, input: { files: BundledAgentFile[] }) {
      const added: string[] = [];
      const retired: string[] = [];
      for (const file of [...input.files].sort((a, b) => compareKeys(a.key, b.key))) {
        const row = fileRow(w.db, file.key, 'bundled', null);
        const current = versionById(w.db, row?.current_version_id ?? null);
        if (current && current.sha256 === sha256(file.content)) continue;
        const { file_id, version } = addVersion(
          w,
          { row, key: file.key, layer: 'bundled', project: null },
          file.content,
          `Bundled with Docket ${APP_VERSION}`,
        );
        w.event({
          type: 'agent_file.updated',
          summary: `Bundled ${agentFileName(file.key)} ${current ? 'updated' : 'added'}: v${version.version_no}`,
          data: { key: file.key, layer: 'bundled', version_no: version.version_no },
          objects: [{ kind: 'agent_file', id: file_id }],
          inverse: null,
        });
        added.push(file.key);
      }
      // Decision 66: a reference the image no longer ships is retired, so installs stop
      // sending it and `docket-update` removes an unmodified copy. Only references of a
      // skill that did load: a missing skills folder retires nothing. An owner's edit
      // of it stays in effect. Skills themselves keep their bundled layer.
      const shipped = new Set(input.files.map((f) => f.key));
      const loadedSkills = new Set(
        input.files.map((f) => skillKeyParts(f.key)?.skill).filter((s): s is string => !!s),
      );
      const bundledRefs = w.db.sqlite
        .prepare(
          `SELECT id, key, current_version_id FROM agent_files
           WHERE layer = 'bundled' AND project_key IS NULL AND current_version_id IS NOT NULL`,
        )
        .all() as { id: string; key: string; current_version_id: string }[];
      for (const row of bundledRefs.sort((a, b) => compareKeys(a.key, b.key))) {
        const parts = skillKeyParts(row.key);
        if (!parts?.topic || shipped.has(row.key) || !loadedSkills.has(parts.skill)) continue;
        const current = versionById(w.db, row.current_version_id);
        w.update('agent_files', row.id, { current_version_id: null });
        w.event({
          type: 'agent_file.updated',
          summary: `Bundled ${agentFileName(row.key)} retired: Docket no longer ships it`,
          data: {
            key: row.key,
            layer: 'bundled',
            version_no: current?.version_no ?? null,
            retired: true,
          },
          objects: [{ kind: 'agent_file', id: row.id }],
          inverse: null,
        });
        retired.push(row.key);
      }
      return { added, retired };
    },

    list(r, input) {
      const project = input.project ?? null;
      if (project) requireProject(r.db, project);
      const files = keysOf(r.db, project)
        .map((key) => listRow(r.db, key, project))
        .filter((row): row is AgentFileRow => row !== null);
      return { project, files };
    },

    get(r, input) {
      return agentFileDetail(r.db, input.key, input.project ?? null);
    },

    put(w, input) {
      const project = input.layer === 'project' ? (input.project ?? null) : null;
      if (project) requireProject(w.db, project);
      const bundledRow = fileRow(w.db, input.key, 'bundled', null);
      const bundled = versionById(w.db, bundledRow?.current_version_id ?? null);
      if (!bundled) {
        throw new ToolError(
          'not_found',
          `No agent file ${input.key}. Only the files Docket ships can be edited.`,
        );
      }
      const row = fileRow(w.db, input.key, input.layer, project);
      const current = versionById(w.db, row?.current_version_id ?? null);
      const currentNo = current?.version_no ?? 0;
      if (input.expected_version !== currentNo) {
        throw conflict(
          `The ${LAYER_NAMES[input.layer]} of ${agentFileName(input.key)}`,
          currentNo,
          input.expected_version,
          agentFileDetail(w.db, input.key, project),
        );
      }
      const { file_id, version, inverse } = addVersion(
        w,
        { row, key: input.key, layer: input.layer, project },
        input.content,
        input.note ?? null,
        { bundled_hash_at_edit: bundled.sha256 },
      );
      w.event({
        type: 'agent_file.updated',
        summary: `Edited ${whereOf(input.key, input.layer, project)}: v${version.version_no}`,
        project_key: project,
        data: {
          key: input.key,
          layer: input.layer,
          project,
          version_no: { old: currentNo, new: version.version_no },
          note: input.note ?? null,
        },
        objects: [{ kind: 'agent_file', id: file_id }],
        inverse,
      });
      return agentFileDetail(w.db, input.key, project);
    },

    revert(w, input) {
      const project = input.layer === 'project' ? (input.project ?? null) : null;
      if (project) requireProject(w.db, project);
      const row = fileRow(w.db, input.key, input.layer, project);
      const current = versionById(w.db, row?.current_version_id ?? null);
      if (!row || !current) {
        throw new ToolError(
          'not_found',
          `No ${LAYER_NAMES[input.layer]} of ${whereOf(input.key, input.layer, project)} to revert; it already uses the layer below.`,
        );
      }
      const inverse = w.update('agent_files', row.id, {
        current_version_id: null,
        bundled_hash_at_edit: null,
      });
      // What applies now: the layer below.
      const below = effectiveLayer(layersOf(w.db, input.key, project)) ?? 'bundled';
      w.event({
        type: 'agent_file.reverted',
        summary: `Reverted ${whereOf(input.key, input.layer, project)} to ${LAYER_NAMES[below]}`,
        project_key: project,
        data: {
          key: input.key,
          layer: input.layer,
          project,
          from_version_no: current.version_no,
          to_layer: below,
        },
        objects: [{ kind: 'agent_file', id: row.id }],
        inverse: [inverse],
      });
      return agentFileDetail(w.db, input.key, project);
    },

    workflow(r, input) {
      requireProject(r.db, input.key);
      return workflowOf(r.db, input.key);
    },

    putWorkflow(w, input) {
      requireProject(w.db, input.key);
      const before = workflowOf(w.db, input.key);
      if (input.expected_version !== before.version_no) {
        throw conflict(
          `The Workflow notes of ${input.key}`,
          before.version_no,
          input.expected_version,
          before,
        );
      }
      const versionNo = before.version_no + 1;
      const inverse = w.insert('project_workflows', {
        id: newId('wf', Date.parse(w.now)),
        project_key: input.key,
        version_no: versionNo,
        content_md: input.content_md,
        author: authorOf(w.actor),
        note: input.note ?? null,
      });
      const cleared = input.content_md.trim() === '';
      w.event({
        type: 'workflow.updated',
        summary: cleared
          ? `Cleared the Workflow notes of ${input.key}: v${versionNo}`
          : `Edited the Workflow notes of ${input.key}: v${versionNo}`,
        project_key: input.key,
        data: {
          project: input.key,
          version_no: { old: before.version_no, new: versionNo },
          note: input.note ?? null,
        },
        objects: [{ kind: 'project', id: input.key }],
        inverse: [inverse],
      });
      return workflowOf(w.db, input.key);
    },
  };
}
