/**
 * Installs (owner decision 29; BUILD_SPEC §5.17; FR-124 to FR-127; tasks.md
 * T155, T156): the bundle builder, the single-use download token, push
 * install into the opt-in push root, the install log, the check, and the
 * push folder's status and *Test*.
 *
 * **What is installed** is the effective set for the project (or
 * service-wide), laid out for the client and target (`installLayout` in
 * @docket/shared): each skill's `SKILL.md`, the AGENTS.md block merged
 * into CLAUDE.md or AGENTS.md between the Docket markers, and
 * `.docket-manifest.json` with the install ID and each file's key, version
 * ID, path and sha256. The block is rendered for installing: the template's
 * leading comment stripped and `{{KEY}}` filled for a project's repo
 * install (`renderAgentsBlock`). The manifest's sha256 is the installed
 * content's, CR bytes removed (`withoutCr`), so the check compares like with
 * like on any OS.
 *
 * **Command installs** (`record`): a 32-byte base64url token, stored only as
 * its sha256 with a 10-minute expiry; the row stays out of the install log
 * until the token is used. `record` appends `install.recorded` with
 * `data.stage: "command_issued"` ("Install command created: …"), and the
 * download appends a second one with stage `downloaded` ("Installed by
 * command: …"). The download (`GET /install/:token`) runs as the system:
 * unknown, expired and used tokens are all the same `404`, and the token is
 * marked used inside the write, so two racing downloads can't both succeed.
 * The token never goes into a row, an event, a log line or the bundle.
 *
 * **Push installs** (`prepare` writes, `record` logs with stage `pushed`):
 * only when `DOCKET_PUSH_ROOT` is set and the folder is there; every path
 * goes through the push-root guard (push-root.ts). All targets are checked,
 * and the instructions file's markers validated, before anything is written.
 *
 * **The check** (push installs): each manifest file is edited, missing, or
 * fine; `docket-*` skill folders the install didn't write are extra, and so
 * are old `tasklite-*` ones (B28).
 *
 * **Old skill folders** (B28): a push install, like the command's install
 * step, removes the `tasklite-*` skill folders the previous manifest at the
 * location recorded, but only while each holds nothing but its unmodified
 * `SKILL.md`; an edited one is kept and listed as `kept_edited`.
 * Edited files carry `local_content` (≤ 50,000 characters) for the diff.
 * Command installs are checked by their check command (`checkCommands`).
 *
 * **Connection files** (decision 32; BUILD_SPEC §5.17a): a repo install also
 * writes the client's project connection file (`.mcp.json`, or
 * `.codex/config.toml`), merging only the `docket` entry (connection.ts in
 * @docket/shared). It is in the manifest as `connection`, at the version
 * `connection:local` or `connection:protected` (the trust mode it was written
 * in), with the sha256 of the entry's canonical text, so the check and drift
 * compare only that entry. It never holds a secret: in protected mode it
 * names the `DOCKET_TOKEN` environment variable. A user-wide install writes
 * none (the user-wide connection stays a copy-paste command).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { access, constants as fsConstants, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AGENT_FILE_KEY_RE,
  AGENT_SETUP_LIMITS,
  AGENTS_BLOCK_KEY,
  BrokenMarkersError,
  CLIENT_MARKERS,
  CONNECTION_FILES,
  CONNECTION_KEY,
  IMPORT_AGENTS_LINE,
  INSTALL_CLIENTS,
  INSTALLED_SCRIPT_KEYS,
  importsAgentsMd,
  installClientsOf,
  ConnectionFileError,
  connectionCanonical,
  connectionEntry,
  connectionVersionId,
  installedConnection,
  isConnectionVersionId,
  mergeConnection,
  INSTALL_CLIENT_LABELS,
  ToolError,
  checkCommands,
  fillsProjectKey,
  installCommands,
  installLayout,
  installPathOf,
  installedBlock,
  isLegacySkillName,
  isSafeCommandPath,
  isSkillReferenceKey,
  skillKeyParts,
  isScriptKey,
  mergeMarkedSection,
  normalizeWorkspace,
  renderAgentsBlock,
  uninstallCommands,
  UPDATE_SCRIPT_KEYS,
  updateCommands,
  updateNotice,
  USER_WIDE_REFUSED,
  WAIT_SCRIPT_KEYS,
  withoutCr,
  type CreateInstallResponse,
  type InstallClientResult,
  type InstallOverviewResponse,
  type InstallRemoval,
  type InstallStateResponse,
  type InstallCheckResponse,
  type InstallClient,
  type InstallMethod,
  type InstallRow,
  type InstallTargetKind,
  type InstallWorktree,
  type UninstallResponse,
} from '@docket/shared';
import type { Db } from '../db/client.js';
import { tarGzBytes, type TarFileEntry } from '../jobs/tar.js';
import { effectiveAgentFiles } from './agent-files.js';
import {
  type InstallBundle,
  type InstallsService,
  type PreparedInstall,
  type PreparedUpdate,
  type ReadContext,
  type ServiceDeps,
} from './contracts.js';
import { newId } from './ids.js';
import {
  CHECK_SCRIPT_PS1,
  CHECK_SCRIPT_SH,
  SHIPPED_CHECK_SHA256,
  checkPs1,
  checkSh,
} from './check-scripts.js';
import { readMainManifests } from './install-main.js';
import { updatePs1, updateSh } from './update-scripts.js';
import { waitPs1, waitSh } from './wait-scripts.js';
import { installPs1, installSh, installWrapperPs1, installWrapperSh } from './install-scripts.js';
import { PushRoot, SymlinkRefused } from './push-root.js';
import {
  uninstallPs1,
  uninstallSh,
  type UninstallEntry,
  type UninstallPlan,
} from './uninstall-scripts.js';
import type { WriteContext } from './write.js';

// ---- Rows and helpers ----

export interface InstallDbRow {
  id: string;
  at: string;
  client: InstallClient;
  target_kind: InstallTargetKind;
  project_key: string | null;
  path: string | null;
  method: InstallMethod;
  manifest: string;
  token_used_at: string | null;
  /** Decision 50: set once the install is removed. */
  removed_at: string | null;
  /** Decision 50: `InstallRemoval` as JSON. */
  removal: string | null;
}

/** The columns every install read selects, so a removed install is always seen as removed. */
export const INSTALL_COLUMNS =
  'id, at, client, target_kind, project_key, path, method, manifest, token_used_at, removed_at, removal';

/** The `installs.manifest` column: key → version and sha256, in install order. */
/**
 * An install's manifest as stored: key → the version sent and its sha256.
 * `installed_as`: the skill folder's name on disk when it differs from the
 * key's, for installs from before the rename (B28's migration maps
 * `skill:tasklite-worker` to `skill:docket-worker`, installed as
 * `tasklite-worker`).
 */
export type ManifestMap = Record<
  string,
  { version_id: string; sha256: string; installed_as?: string }
>;

/** One file as installed. */
interface InstallFile {
  key: string;
  version_id: string;
  /** Relative to the base, `/`-separated. */
  path: string;
  /** What is written: a skill's text, or the rendered block (merged between the markers). */
  content: string;
  /** sha256 of `content` without CR bytes (what the check compares). */
  sha256: string;
}

export const hashText = (text: string): string =>
  createHash('sha256')
    .update(Buffer.from(withoutCr(text), 'utf8'))
    .digest('hex');
const hashBytes = (bytes: Buffer): string =>
  createHash('sha256').update(bytes.toString('latin1').replace(/\r/g, ''), 'latin1').digest('hex');
export const tokenHash = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

const NOT_FOUND =
  'This install link is unknown, expired or already used. Make a new install command in Agent files.';

function requireProject(db: Db, key: string): void {
  const p = db.sqlite
    .prepare('SELECT key FROM projects WHERE key = ? AND deleted_at IS NULL')
    .get(key);
  if (!p) throw new ToolError('not_found', `No project ${key}. Check the key in Settings.`);
}

const installRowById = (db: Db, id: string) =>
  db.sqlite.prepare(`SELECT ${INSTALL_COLUMNS} FROM installs WHERE id = ?`).get(id) as
    InstallDbRow | undefined;

/** The version texts, by ID (immutable, so a command install's bundle matches its manifest). */
function versionContent(db: Db, id: string): string {
  const row = db.sqlite.prepare('SELECT content FROM agent_file_versions WHERE id = ?').get(id) as
    { content: string } | undefined;
  if (!row) throw new ToolError('not_found', NOT_FOUND);
  return row.content;
}

/** The MCP address the connection files name: the first allowed host's. */
export const mcpUrlOf = (allowedHosts: readonly string[]): string =>
  `http://${allowedHosts[0] ?? '127.0.0.1:7420'}/mcp`;

/**
 * The connection file as installed (decision 32): its manifest entry, and the
 * text Docket merges in (the `docket` entry). `version_id` records the mode.
 */
export function connectionFileFor(
  client: InstallClient,
  url: string,
  protectedMode: boolean,
): InstallFile {
  return {
    key: CONNECTION_KEY,
    version_id: connectionVersionId(protectedMode),
    path: CONNECTION_FILES[client],
    content: connectionEntry(client, url, protectedMode),
    sha256: hashText(connectionCanonical(client, url, protectedMode)),
  };
}

/** Each file as installed, for a client, target and project; a repo install adds its connection file. */
function filesFor(
  keys: { key: string; version_id: string; content: string }[],
  client: InstallClient,
  target: InstallTargetKind,
  project: string | null,
  connection: { url: string; protectedMode: boolean },
): InstallFile[] {
  const layout = installLayout(client, target);
  const fill = fillsProjectKey(target, project);
  const files = keys
    .filter(({ key }) => key !== CONNECTION_KEY && !isScriptKey(key))
    .map(({ key, version_id, content }) => {
      const text = key === AGENTS_BLOCK_KEY ? renderAgentsBlock(content, fill) : content;
      return {
        key,
        version_id,
        path: installPathOf(layout, key),
        content: text,
        sha256: hashText(text),
      };
    });
  for (const script of scriptFiles(layout)) files.push(script);
  if (target === 'repo') {
    files.push(connectionFileFor(client, connection.url, connection.protectedMode));
  }
  return files;
}

/** The `version_id` of an installed script: its text's hash (scripts have no stored versions). */
const scriptVersionId = (text: string): string => `script:${hashText(text).slice(0, 12)}`;

const MANIFEST_SCRIPTS: Record<
  (typeof WAIT_SCRIPT_KEYS)[number] | (typeof UPDATE_SCRIPT_KEYS)[number],
  () => string
> = {
  [WAIT_SCRIPT_KEYS[0]]: waitSh,
  [WAIT_SCRIPT_KEYS[1]]: waitPs1,
  [UPDATE_SCRIPT_KEYS[0]]: updateSh,
  [UPDATE_SCRIPT_KEYS[1]]: updatePs1,
};

/** `docket-wait` (decision 40) and `docket-update` (decision 56), one manifest entry per script. */
function scriptFiles(layout: ReturnType<typeof installLayout>): InstallFile[] {
  return INSTALLED_SCRIPT_KEYS.map((key) => {
    const content = MANIFEST_SCRIPTS[key]();
    return {
      key,
      version_id: scriptVersionId(content),
      path: installPathOf(layout, key),
      content,
      sha256: hashText(content),
    };
  });
}

/**
 * `.docket-manifest.json`: one file per line, so the bash check command can
 * read it without a JSON parser (each line holds `"key"`, `"path"`,
 * `"version_id"` and `"sha256"` in that order).
 */
export function manifestJson(meta: {
  install_id: string;
  client: InstallClient;
  target_kind: InstallTargetKind;
  project: string | null;
  installed_at: string;
  files: Pick<InstallFile, 'key' | 'path' | 'version_id' | 'sha256'>[];
}): string {
  const head = {
    install_id: meta.install_id,
    client: meta.client,
    target: meta.target_kind,
    project: meta.project,
    installed_at: meta.installed_at,
    source: 'Docket, Agent files',
  };
  const headLines = Object.entries(head).map(
    ([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`,
  );
  const fileLines = meta.files.map(
    (f, i) =>
      `    ${JSON.stringify({ key: f.key, path: f.path, version_id: f.version_id, sha256: f.sha256 })}${i < meta.files.length - 1 ? ',' : ''}`,
  );
  return ['{', ...headLines, '  "files": [', ...fileLines, '  ]', '}', ''].join('\n');
}

/** "Claude Code, RCP's repo at C:/code/recipes, 6 files". */
function describe(row: {
  client: InstallClient;
  target_kind: InstallTargetKind;
  project_key: string | null;
  path: string | null;
  count: number;
}): string {
  const where =
    row.target_kind === 'user'
      ? 'user-wide'
      : row.project_key
        ? `${row.project_key}'s repo`
        : 'a repo (service-wide files)';
  const at = row.path ? ` at ${row.path}` : '';
  return `${INSTALL_CLIENT_LABELS[row.client]}, ${where}${at}, ${row.count} files`;
}

const manifestOf = (files: { key: string; version_id: string; sha256: string }[]): ManifestMap =>
  Object.fromEntries(files.map((f) => [f.key, { version_id: f.version_id, sha256: f.sha256 }]));

function toRow(r: InstallDbRow): InstallRow {
  const manifest = JSON.parse(r.manifest) as ManifestMap;
  const entries = Object.entries(manifest).map(([key, v]) => ({
    key,
    version_id: v.version_id,
    sha256: v.sha256,
  }));
  return {
    id: r.id,
    at: r.at,
    client: r.client,
    target_kind: r.target_kind,
    project: r.project_key,
    path: r.path,
    method: r.method,
    file_count: entries.length,
    manifest: entries,
    token_used_at: r.token_used_at,
    removed_at: r.removed_at,
    removal: r.removal ? (JSON.parse(r.removal) as InstallRemoval) : null,
  };
}

/**
 * Which recorded folders are separate worktrees (decision 50), from what
 * agents reported on their runs. No Git read: a folder no run reported, or one
 * on its repo's main branch, isn't called a worktree. A folder that is the
 * run's own repo root is the main checkout, whatever branch it's on.
 */
function worktreesByPath(db: Db): Map<string, InstallWorktree> {
  const runs = db.sqlite
    .prepare(
      `SELECT item_id, workspace FROM runs WHERE workspace IS NOT NULL
       ORDER BY coalesce(json_extract(workspace, '$.updated_at'), updated_at) DESC, id DESC`,
    )
    .all() as { item_id: string; workspace: string }[];
  const merged = new Set(
    (
      db.sqlite
        .prepare(
          "SELECT DISTINCT item_id FROM artifacts WHERE kind = 'pr' AND lower(state) = 'merged'",
        )
        .all() as { item_id: string }[]
    ).map((a) => a.item_id),
  );
  const seen = new Set<string>();
  const out = new Map<string, InstallWorktree>();
  for (const run of runs) {
    let w: { path?: unknown; branch?: unknown; base_ref?: unknown; repo?: unknown };
    try {
      w = JSON.parse(run.workspace) as typeof w;
    } catch {
      continue;
    }
    if (typeof w.path !== 'string' || !w.path) continue;
    const key = normalizeWorkspace(w.path);
    // The latest run in a folder speaks for it.
    if (seen.has(key)) continue;
    seen.add(key);
    if (typeof w.branch !== 'string' || !w.branch) continue;
    const base =
      typeof w.base_ref === 'string' ? w.base_ref.replace(/^(refs\/heads\/|origin\/)/, '') : '';
    if (w.branch === 'main' || w.branch === 'master' || w.branch === base) continue;
    if (typeof w.repo === 'string' && normalizeWorkspace(w.repo) === key) continue;
    out.set(key, {
      name: key.slice(key.lastIndexOf('/') + 1),
      branch: w.branch,
      merged: merged.has(run.item_id),
    });
  }
  return out;
}

/** What an install's uninstall step may remove, from its stored manifest. */
function uninstallEntries(row: InstallDbRow): UninstallEntry[] {
  const layout = installLayout(row.client, row.target_kind);
  const manifest = JSON.parse(row.manifest) as ManifestMap;
  const entries: UninstallEntry[] = Object.entries(manifest).map(([key, sent]) => ({
    kind: key === AGENTS_BLOCK_KEY ? 'block' : key === CONNECTION_KEY ? 'connection' : 'file',
    path: sent.installed_as
      ? `${layout.skillsDir}/${sent.installed_as}/SKILL.md`
      : key === CONNECTION_KEY
        ? CONNECTION_FILES[row.client]
        : installPathOf(layout, key),
    sha256: sent.sha256.toLowerCase(),
  }));
  // docket-check isn't in the manifest: it's removed only while it matches this Docket's copy.
  for (const [name, text] of checkScripts()) {
    entries.push({ kind: 'script', path: `${layout.dir}/${name}`, sha256: hashText(text) });
  }
  return entries;
}

function uninstallPlan(row: InstallDbRow): UninstallPlan {
  return {
    install_id: row.id,
    client: row.client,
    dir: installLayout(row.client, row.target_kind).dir,
    // A user-wide install's folder is always home; a repo install's is known if it was given.
    recordedBase: row.target_kind === 'user' || row.path !== null,
    entries: uninstallEntries(row),
  };
}

/** Every path a report may name for this install: its entries, their folders and its manifest. */
function reportablePaths(row: InstallDbRow): Set<string> {
  const layout = installLayout(row.client, row.target_kind);
  const out = new Set<string>([layout.manifest, layout.legacyManifest]);
  for (const e of uninstallEntries(row)) {
    out.add(e.path);
    if (e.path.endsWith('/SKILL.md')) out.add(e.path.slice(0, -'SKILL.md'.length));
    // A skill reference's folder (decision 66), which uninstall removes once it's empty.
    const ref = /^(.*\/references\/)[^/]+\.md$/.exec(e.path);
    if (ref) out.add(ref[1]!);
  }
  return out;
}

/** One installed file as the push check read it (B24's check; reused by drift, B27b). */
export interface InspectedFile {
  /** The manifest key, or `skill:<name>` for an extra `docket-*` skill folder. */
  key: string;
  /** As shown: relative to the base, `~/` for user-wide; an extra folder ends in `/`. */
  path: string;
  state: 'ok' | 'edited' | 'missing' | 'extra';
  /**
   * The installed text's sha256 as the check hashes it (CR bytes removed; the
   * block between its markers); null when missing. A symlink, never followed,
   * hashes its path, and a damaged section hashes the whole file, so each
   * reads as edited with no text.
   */
  sha256: string | null;
  /** The installed text, for the diff; null when it can't be read as the file's text. */
  text: string | null;
}

/**
 * Read a push install's files through the push-root guard and compare each
 * with the manifest (BUILD_SPEC §5.17 *Check*): edited, missing, or as sent;
 * `docket-*` skill folders the install didn't write are extra. Reads only.
 */
export async function inspectPushInstall(
  root: PushRoot,
  row: Pick<InstallDbRow, 'client' | 'target_kind' | 'path' | 'manifest'>,
): Promise<InspectedFile[]> {
  const base = await root.base(row.path!);
  const layout = installLayout(row.client, row.target_kind);
  const manifest = JSON.parse(row.manifest) as ManifestMap;
  const files: InspectedFile[] = [];

  for (const [key, sent] of Object.entries(manifest)) {
    const rel = sent.installed_as
      ? `${layout.skillsDir}/${sent.installed_as}/SKILL.md`
      : key === CONNECTION_KEY
        ? CONNECTION_FILES[row.client]
        : installPathOf(layout, key);
    const path = layout.display + rel;
    let bytes: Buffer | null;
    try {
      bytes = await root.read(base, rel);
    } catch (err) {
      if (err instanceof SymlinkRefused) {
        files.push({ key, path, state: 'edited', sha256: hashText(`symlink:${rel}`), text: null });
        continue;
      }
      throw err;
    }
    if (bytes === null) {
      files.push({ key, path, state: 'missing', sha256: null, text: null });
      continue;
    }
    if (key === CONNECTION_KEY) {
      // Only the docket entry is compared (decision 32): other servers there are the owner's.
      const entry = installedConnection(row.client, bytes.toString('latin1'));
      if (entry === null) files.push({ key, path, state: 'missing', sha256: null, text: null });
      else if (entry === 'invalid') {
        files.push({
          key,
          path,
          state: 'edited',
          sha256: hashBytes(bytes),
          text: bytes.toString('utf8'),
        });
      } else {
        const sha = hashBytes(Buffer.from(entry, 'latin1'));
        const text = Buffer.from(entry, 'latin1').toString('utf8');
        files.push({ key, path, state: sha === sent.sha256 ? 'ok' : 'edited', sha256: sha, text });
      }
    } else if (key === AGENTS_BLOCK_KEY) {
      const block = installedBlock(bytes.toString('latin1'));
      if (block === null) files.push({ key, path, state: 'missing', sha256: null, text: null });
      else if (block === 'broken') {
        files.push({ key, path, state: 'edited', sha256: hashBytes(bytes), text: null });
      } else {
        const sha = hashBytes(Buffer.from(block, 'latin1'));
        const text = Buffer.from(block, 'latin1').toString('utf8');
        files.push({ key, path, state: sha === sent.sha256 ? 'ok' : 'edited', sha256: sha, text });
      }
    } else {
      const sha = hashBytes(bytes);
      files.push({
        key,
        path,
        state: sha === sent.sha256 ? 'ok' : 'edited',
        sha256: sha,
        text: bytes.toString('utf8'),
      });
    }
  }

  const sentSkills = new Set(
    Object.entries(manifest)
      .filter(([k]) => k.startsWith('skill:') && !isSkillReferenceKey(k))
      .map(([k, v]) => v.installed_as ?? skillKeyParts(k)!.skill),
  );
  for (const name of (await root.folders(base, layout.skillsDir)).sort()) {
    // An old `tasklite-*` folder the manifest doesn't list is extra too (B28: one an
    // install kept because it was edited locally); its key keeps the old name.
    if (!(name.startsWith('docket-') || isLegacySkillName(name)) || sentSkills.has(name)) continue;
    const rel = `${layout.skillsDir}/${name}/SKILL.md`;
    let bytes: Buffer | null = null;
    try {
      bytes = await root.read(base, rel);
    } catch (err) {
      if (!(err instanceof SymlinkRefused)) throw err;
    }
    files.push({
      key: `skill:${name}`,
      path: `${layout.display}${layout.skillsDir}/${name}/`,
      state: 'extra',
      sha256: bytes ? hashBytes(bytes) : hashText(''),
      text: bytes ? bytes.toString('utf8') : null,
    });
  }
  return files;
}

/**
 * The old `tasklite-*` skill folders the manifest at this location recorded
 * (`.docket-manifest.json`, else the old `.tasklite-manifest.json`; B28),
 * with the sha256 each `SKILL.md` was installed with, for those still there.
 * A manifest that can't be read records nothing.
 */
async function recordedLegacySkills(
  root: PushRoot,
  base: string,
  layout: ReturnType<typeof installLayout>,
): Promise<{ name: string; sha256: string }[]> {
  const present = new Set(await root.folders(base, layout.skillsDir));
  const out = new Map<string, string>();
  for (const rel of [layout.manifest, layout.legacyManifest]) {
    let parsed: { files?: { key?: unknown; path?: unknown; sha256?: unknown }[] };
    try {
      const bytes = await root.read(base, rel);
      if (bytes === null) continue;
      parsed = JSON.parse(bytes.toString('utf8')) as typeof parsed;
    } catch {
      continue;
    }
    for (const f of Array.isArray(parsed.files) ? parsed.files : []) {
      if (typeof f.key !== 'string' || typeof f.sha256 !== 'string') continue;
      const m = /^skill:([a-z0-9-]{1,60})$/.exec(f.key);
      if (!m || !isLegacySkillName(m[1]!) || out.has(m[1]!)) continue;
      if (f.path !== `${layout.skillsDir}/${m[1]}/SKILL.md` || !present.has(m[1]!)) continue;
      out.set(m[1]!, f.sha256.toLowerCase());
    }
  }
  return [...out].map(([name, sha256]) => ({ name, sha256 }));
}

/**
 * The skill references (decision 66) the manifest at this location recorded
 * and this install no longer sends, with the sha256 each was installed with,
 * for those whose recorded path is where a reference belongs.
 */
async function recordedStaleReferences(
  root: PushRoot,
  base: string,
  layout: ReturnType<typeof installLayout>,
  sending: ReadonlySet<string>,
): Promise<{ rel: string; sha256: string }[]> {
  let parsed: { files?: { key?: unknown; path?: unknown; sha256?: unknown }[] };
  try {
    const bytes = await root.read(base, layout.manifest);
    if (bytes === null) return [];
    parsed = JSON.parse(bytes.toString('utf8')) as typeof parsed;
  } catch {
    return [];
  }
  const out: { rel: string; sha256: string }[] = [];
  for (const f of Array.isArray(parsed.files) ? parsed.files : []) {
    if (typeof f.key !== 'string' || typeof f.sha256 !== 'string') continue;
    if (!isSkillReferenceKey(f.key) || sending.has(f.key)) continue;
    if (!AGENT_FILE_KEY_RE.test(f.key) || f.path !== installPathOf(layout, f.key)) continue;
    out.push({ rel: f.path, sha256: f.sha256.toLowerCase() });
  }
  return out;
}

/** The installed `docket-check` scripts (bash, PowerShell), written next to the manifest. */
const checkScripts = (): [string, string][] => [
  [CHECK_SCRIPT_SH, checkSh()],
  [CHECK_SCRIPT_PS1, checkPs1()],
];

/** One file's part in an install's summary. */
type InstallFileResult = InstallClientResult['files'][number];

/** What the summary says about a new CLAUDE.md that imports AGENTS.md (decision 34). */
const IMPORT_NOTE = `starts with ${IMPORT_AGENTS_LINE}, so Claude Code also reads the repo's AGENTS.md`;

/** One client's push, planned: every write checked before any is made (decision 34). */
interface PlannedPush {
  base: string;
  layout: ReturnType<typeof installLayout>;
  writes: { rel: string; bytes: Buffer; note?: string }[];
  recorded: { name: string; sha256: string }[];
  /** Skill references the previous manifest recorded that this install doesn't send (decision 66). */
  staleRefs: { rel: string; sha256: string }[];
}

/**
 * The files a command install will write for a client, as the summary lists
 * them (decision 34): the skills, the manifest and check scripts, the
 * instructions file's Docket section, and the connection file's entry.
 */
function plannedPaths(
  client: InstallClient,
  target: InstallTargetKind,
  files: InstallFile[],
): InstallFileResult[] {
  const layout = installLayout(client, target);
  const out: InstallFileResult[] = [];
  for (const f of files) {
    if (f.key === AGENTS_BLOCK_KEY) {
      out.push({
        path: layout.display + f.path,
        note: importsAgentsMd(client, target)
          ? `its Docket section; a new one ${IMPORT_NOTE} when the repo has one`
          : 'its Docket section',
      });
    } else if (f.key === CONNECTION_KEY) {
      out.push({ path: f.path, note: 'its docket server entry' });
    } else {
      out.push({ path: layout.display + f.path });
    }
  }
  out.push({ path: layout.display + layout.manifest });
  for (const [name] of checkScripts()) out.push({ path: `${layout.display}${layout.dir}/${name}` });
  return out;
}

/**
 * The keys an install's manifest no longer matches (decision 34: "update
 * available"): an effective file whose version differs from the one sent, a
 * file added since, a file sent that's no longer installed, or a connection
 * file written in another trust mode.
 */
export function outdatedKeys(
  row: Pick<InstallDbRow, 'manifest' | 'target_kind'>,
  effective: { key: string; version: { id: string } }[],
  protectedMode: boolean,
): string[] {
  const manifest = JSON.parse(row.manifest) as ManifestMap;
  const out: string[] = [];
  const now = new Map(effective.map((e) => [e.key, e.version.id]));
  for (const [key, id] of now) {
    if (manifest[key]?.version_id !== id) out.push(key);
  }
  for (const key of Object.keys(manifest)) {
    if (key === CONNECTION_KEY) {
      if (manifest[key]!.version_id !== connectionVersionId(protectedMode)) out.push(key);
    } else if (!isScriptKey(key) && !now.has(key)) out.push(key);
  }
  // Decisions 40 and 56: an install without the current scripts is out of date.
  for (const key of INSTALLED_SCRIPT_KEYS) {
    if (manifest[key]?.version_id !== scriptVersionId(MANIFEST_SCRIPTS[key]())) out.push(key);
  }
  return out;
}

/**
 * Decision 56: an update fetched by `docket-update`, not yet seen on the main
 * branch. It's a command row with no token, so the log and the state skip it
 * (they need a used token) while drift can still compare reports against it.
 */
export const isPendingUpdate = (
  row: Pick<InstallDbRow, 'method' | 'token_used_at' | 'removed_at'> & {
    token_sha256?: string | null;
  },
): boolean =>
  row.method === 'command' && !row.token_sha256 && !row.token_used_at && !row.removed_at;

const PENDING_UPDATE_SQL = `method = 'command' AND token_sha256 IS NULL AND token_used_at IS NULL AND removed_at IS NULL`;

/** Whether two manifests name the same version and hash for every key. */
function sameManifest(a: ManifestMap, b: ManifestMap): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (k) =>
        b[k] !== undefined &&
        a[k]!.version_id === b[k]!.version_id &&
        a[k]!.sha256.toLowerCase() === b[k]!.sha256.toLowerCase(),
    )
  );
}

/** The latest install a project's repo has for a client, as the state reads it. */
function latestInstall(db: Db, project: string, client: InstallClient): InstallDbRow | undefined {
  return db.sqlite
    .prepare(
      `SELECT ${INSTALL_COLUMNS} FROM installs
       WHERE client = ? AND target_kind = 'repo' AND project_key = ?
         AND (method = 'push' OR token_used_at IS NOT NULL)
       ORDER BY coalesce(token_used_at, at) DESC, id DESC LIMIT 1`,
    )
    .get(client, project) as InstallDbRow | undefined;
}

/** Record that an update reached the main branch: from here on it's the repo's install. */
export function markUpdateLanded(w: WriteContext, row: InstallDbRow): void {
  w.update('installs', row.id, { token_used_at: w.now });
  const count = Object.keys(JSON.parse(row.manifest) as ManifestMap).length;
  w.event({
    type: 'install.recorded',
    summary: `Update reached the main branch: ${describe({ ...row, count })}`,
    project_key: row.project_key,
    objects: [{ kind: 'install', id: row.id }],
    data: {
      method: row.method,
      client: row.client,
      target_kind: row.target_kind,
      files: count,
      stage: 'update_on_main',
    },
  });
}

/** A text file in the bundle, under `docket-install/`. */
function tarText(name: string, text: string, mtime: Date, mode = 0o644): TarFileEntry {
  const bytes = Buffer.from(text, 'utf8');
  return { name: `docket-install/${name}`, size: bytes.length, mtime, mode, source: { bytes } };
}

// ---- The service ----

export function createInstallsService(deps: ServiceDeps): InstallsService {
  const { config } = deps;
  /** What the connection files name (decision 32): this Docket's MCP address, and the trust mode. */
  const connection = () => ({
    url: mcpUrlOf(config.allowedHosts ?? []),
    protectedMode: config.protectedMode === true,
  });
  /** This Docket's address, for the commands an agent or the owner copies. */
  const baseUrl = () => `http://${config.allowedHosts?.[0] ?? '127.0.0.1:7420'}`;

  /** The push root, opened and checked; `validation` when push is off or the folder isn't there. */
  async function pushRoot(): Promise<PushRoot> {
    if (!config.pushRoot) {
      throw new ToolError(
        'validation',
        "Push install is off: DOCKET_PUSH_ROOT isn't set. Use the install command instead.",
      );
    }
    return PushRoot.open(config.pushRoot, config.pushHostPath);
  }

  /**
   * Which clients' markers the repo folder has (decision 34), when Docket can
   * see it: a repo install's folder inside a ready push folder. Null
   * otherwise (a command install's folder, or user-wide).
   */
  async function clientMarkers(
    target: InstallTargetKind,
    path: string | undefined,
  ): Promise<Record<InstallClient, boolean> | null> {
    if (target !== 'repo' || !path || !config.pushRoot) return null;
    try {
      const root = await PushRoot.open(config.pushRoot, config.pushHostPath);
      const base = await root.base(path);
      const found = {} as Record<InstallClient, boolean>;
      for (const client of INSTALL_CLIENTS) {
        found[client] = false;
        for (const marker of CLIENT_MARKERS[client]) {
          if (await root.exists(base, marker)) found[client] = true;
        }
      }
      return found;
    } catch {
      return null;
    }
  }

  /** One client's files in a command bundle, under `docket-install/<prefix>`. */
  function clientEntries(
    r: ReadContext,
    row: InstallDbRow,
    prefix: string,
    now: Date,
  ): TarFileEntry[] {
    const manifest = JSON.parse(row.manifest) as ManifestMap;
    // The connection file is rewritten in the mode it was recorded in (its version ID).
    const sentConnection = manifest[CONNECTION_KEY];
    const files = filesFor(
      Object.entries(manifest)
        // Neither has a stored version: `filesFor` writes them.
        .filter(([key]) => key !== CONNECTION_KEY && !isScriptKey(key))
        .map(([key, v]) => ({
          key,
          version_id: v.version_id,
          content: versionContent(r.db, v.version_id),
        })),
      row.client,
      row.target_kind,
      row.project_key,
      {
        url: connection().url,
        protectedMode:
          sentConnection && isConnectionVersionId(sentConnection.version_id)
            ? sentConnection.version_id === connectionVersionId(true)
            : connection().protectedMode,
      },
    ).filter(
      (f) =>
        (f.key !== CONNECTION_KEY || sentConnection !== undefined) &&
        // An install recorded before docket-wait existed keeps the files its manifest lists.
        (!isScriptKey(f.key) || manifest[f.key] !== undefined),
    );
    const layout = installLayout(row.client, row.target_kind);
    const entry = (name: string, text: string, mode = 0o644) =>
      tarText(`${prefix}${name}`, text, now, mode);
    const copied = files.filter((f) => f.key !== AGENTS_BLOCK_KEY && f.key !== CONNECTION_KEY);
    const block = files.find((f) => f.key === AGENTS_BLOCK_KEY);
    const conn = files.find((f) => f.key === CONNECTION_KEY);
    const scripts = checkScripts().map(([name, text]) => ({
      path: `${layout.dir}/${name}`,
      text,
      mode: name === CHECK_SCRIPT_SH ? 0o755 : 0o644,
    }));
    const list = [...copied.map((f) => f.path), layout.manifest, ...scripts.map((x) => x.path)];
    const imports = importsAgentsMd(row.client, row.target_kind);
    return [
      ...copied.map((f) =>
        entry(`files/${f.path}`, f.content, f.path.endsWith('.sh') ? 0o755 : 0o644),
      ),
      entry(
        `files/${layout.manifest}`,
        manifestJson({
          install_id: row.id,
          client: row.client,
          target_kind: row.target_kind,
          project: row.project_key,
          installed_at: r.now,
          files,
        }),
      ),
      // docket-check, next to the manifest (decision 30).
      ...scripts.map((x) => entry(`files/${x.path}`, x.text, x.mode)),
      entry('files.txt', `${list.join('\n')}\n`),
      entry('block.md', block?.content ?? ''),
      // The connection file's docket entry, merged by the install step (decision 32).
      ...(conn ? [entry('connection.txt', conn.content)] : []),
      entry('install.sh', installSh(layout.instructions, layout.dir, row.client, imports), 0o755),
      entry('install.ps1', installPs1(layout.instructions, layout.dir, row.client, imports)),
    ];
  }

  /**
   * Plan one client's push: every write's bytes, with every target checked
   * and the instructions file's markers validated, before anything is
   * written. A multi-client install plans every client first (decision 34),
   * so nothing is written unless all of them can be. A new CLAUDE.md starts
   * with `@AGENTS.md` when the repo had AGENTS.md before this install.
   */
  async function planPush(
    root: PushRoot,
    input: PreparedInstall['input'],
    client: InstallClient,
    install_id: string,
    files: InstallFile[],
    now: string,
  ): Promise<PlannedPush> {
    const base = await root.base(input.path!);
    const layout = installLayout(client, input.target_kind);
    const writes: PlannedPush['writes'] = [];

    for (const f of files) {
      if (f.key === CONNECTION_KEY) {
        // Merge only the docket entry; an invalid file is refused before anything is written.
        const old = await root.read(base, f.path);
        try {
          const merged = mergeConnection(
            client,
            old === null ? null : old.toString('latin1'),
            f.content,
            f.path,
          );
          writes.push({ rel: f.path, bytes: Buffer.from(merged.text, 'latin1') });
        } catch (err) {
          if (err instanceof ConnectionFileError) throw new ToolError('validation', err.message);
          throw err;
        }
      } else if (f.key === AGENTS_BLOCK_KEY) {
        const old = await root.read(base, f.path);
        const importAgents =
          old === null &&
          importsAgentsMd(client, input.target_kind) &&
          (await root.exists(base, 'AGENTS.md'));
        let merged;
        try {
          merged = mergeMarkedSection(
            old === null ? null : old.toString('latin1'),
            Buffer.from(f.content, 'utf8').toString('latin1'),
            layout.display + f.path,
            { importAgents },
          );
        } catch (err) {
          if (err instanceof BrokenMarkersError) throw new ToolError('validation', err.message);
          throw err;
        }
        writes.push({
          rel: f.path,
          bytes: Buffer.from(merged.text, 'latin1'),
          ...(merged.imported ? { note: IMPORT_NOTE } : {}),
        });
      } else {
        writes.push({ rel: f.path, bytes: Buffer.from(f.content, 'utf8') });
      }
    }
    const manifest = manifestJson({
      install_id,
      client,
      target_kind: input.target_kind,
      project: input.project ?? null,
      installed_at: now,
      files,
    });
    writes.push({ rel: layout.manifest, bytes: Buffer.from(manifest, 'utf8') });
    // docket-check, next to the manifest (decision 30): what agents run to report on claim.
    for (const [name, text] of checkScripts()) {
      writes.push({ rel: `${layout.dir}/${name}`, bytes: Buffer.from(text, 'utf8') });
    }

    // Check every target first: no symlinks, no folders leading out of the root.
    for (const w of writes) await root.checkWritable(base, w.rel);
    // Old skill folders the previous manifest there recorded (B28), read before it's replaced.
    const recorded = await recordedLegacySkills(root, base, layout);
    const staleRefs = await recordedStaleReferences(
      root,
      base,
      layout,
      new Set(files.map((f) => f.key)),
    );
    return { base, layout, writes, recorded, staleRefs };
  }

  /** Write a planned push; returns what each file did. */
  async function applyPush(root: PushRoot, plan: PlannedPush): Promise<InstallFileResult[]> {
    const { base, layout } = plan;
    const out: InstallFileResult[] = [];
    for (const w of plan.writes) {
      const old = await root.read(base, w.rel);
      const change = old === null ? 'created' : old.equals(w.bytes) ? 'unchanged' : 'updated';
      if (change !== 'unchanged') await root.write(base, w.rel, w.bytes);
      out.push({ path: layout.display + w.rel, change, ...(w.note ? { note: w.note } : {}) });
    }
    // The one deletion (BUILD_SPEC §5.17): a recorded old folder, only while unmodified.
    for (const { name, sha256 } of plan.recorded) {
      const rel = `${layout.skillsDir}/${name}`;
      const removed = await root.removeRecordedSkillFolder(
        base,
        rel,
        (bytes) => hashBytes(bytes) === sha256,
      );
      out.push({ path: `${layout.display}${rel}/`, change: removed ? 'removed' : 'kept_edited' });
    }
    // Decision 66: a reference this install no longer sends, only while unmodified.
    for (const { rel, sha256 } of plan.staleRefs) {
      const removed = await root.removeRecordedFile(base, rel, (b) => hashBytes(b) === sha256);
      const exists = removed || (await root.exists(base, rel));
      if (exists)
        out.push({ path: layout.display + rel, change: removed ? 'removed' : 'kept_edited' });
    }
    return out;
  }

  return {
    async prepare(r, input) {
      // Decision 50: also covers Restore on an old user-wide drift record.
      if (input.target_kind === 'user') throw new ToolError('validation', USER_WIDE_REFUSED);
      const project = input.project ?? null;
      if (project) requireProject(r.db, project);
      if (
        input.method === 'command' &&
        input.path !== undefined &&
        !isSafeCommandPath(input.path)
      ) {
        throw new ToolError(
          'validation',
          'The path has control characters; give a plain folder path.',
        );
      }
      const effective = effectiveAgentFiles(r.db, project);
      if (effective.length === 0) {
        throw new ToolError(
          'validation',
          'No agent files are loaded yet. They load when Docket starts; restart it and try again.',
        );
      }
      const keys = effective.map((e) => ({
        key: e.key,
        version_id: e.version.id,
        content: e.version.content,
      }));
      // One part per client, Claude Code first (decision 34): each its own install.
      const parts = installClientsOf(input).map((client) => {
        const files = filesFor(keys, client, input.target_kind, project, connection());
        return {
          client,
          install_id: newId('ins', Date.parse(r.now)),
          files,
          manifest: files.map((f) => ({ key: f.key, version_id: f.version_id, sha256: f.sha256 })),
          paths: plannedPaths(client, input.target_kind, files),
        };
      });
      const prepared: PreparedInstall = {
        input,
        parts: parts.map(({ files: _f, ...part }) => part),
      };
      if (input.method === 'push') {
        const root = await pushRoot();
        // Plan every client before writing any.
        const plans: PlannedPush[] = [];
        for (const part of parts) {
          plans.push(await planPush(root, input, part.client, part.install_id, part.files, r.now));
        }
        for (const [i, plan] of plans.entries()) {
          prepared.parts[i]!.files = await applyPush(root, plan);
        }
      }
      return prepared;
    },

    record(w: WriteContext, p: PreparedInstall): CreateInstallResponse {
      const { input } = p;
      const project = input.project ?? null;
      const path = input.path ?? null;
      const push = input.method === 'push';
      const token = push ? null : randomBytes(32).toString('base64url');
      const expires = new Date(
        Date.parse(w.now) + AGENT_SETUP_LIMITS.install_token_ttl_ms,
      ).toISOString();
      // One token for the whole command: each client's row keeps the sha256 of the
      // token alone (one client), or of `token:client` (several; decision 34).
      const several = p.parts.length > 1;

      const clients: InstallClientResult[] = [];
      for (const part of p.parts) {
        const id = part.install_id ?? newId('ins', Date.parse(w.now));
        const describeArgs = {
          client: part.client,
          target_kind: input.target_kind,
          project_key: project,
          path,
          count: part.manifest.length,
        };
        const row = {
          id,
          at: w.now,
          client: part.client,
          target_kind: input.target_kind,
          project_key: project,
          path,
          method: input.method,
          manifest: manifestOf(part.manifest),
        };
        const data = {
          method: input.method,
          client: part.client,
          target_kind: input.target_kind,
          files: part.manifest.length,
          ...(several ? { clients: p.parts.map((x) => x.client) } : {}),
        };
        if (push) {
          w.insert('installs', row);
          w.event({
            type: 'install.recorded',
            summary: `Installed by push: ${describe(describeArgs)}`,
            project_key: project,
            objects: [{ kind: 'install', id }],
            data: { ...data, stage: 'pushed' },
          });
          clients.push({ client: part.client, install_id: id, files: part.files ?? [] });
        } else {
          const hash = tokenHash(several ? `${token!}:${part.client}` : token!);
          w.insert('installs', { ...row, token_sha256: hash, token_expires_at: expires });
          w.event({
            type: 'install.recorded',
            summary: `Install command created: ${describe(describeArgs)}`,
            project_key: project,
            objects: [{ kind: 'install', id }],
            data: { ...data, stage: 'command_issued' },
          });
          clients.push({
            client: part.client,
            install_id: id,
            files: part.paths,
            check_command: checkCommands({
              client: part.client,
              target_kind: input.target_kind,
              path: input.path,
            }),
          });
        }
      }

      const first = clients[0]!;
      if (push) {
        return {
          install_id: first.install_id,
          clients,
          result: {
            files: clients.flatMap((c) =>
              c.files.map((f) => ({ path: f.path, change: f.change ?? 'created' })),
            ),
          },
        };
      }
      const url = `http://${config.allowedHosts[0] ?? '127.0.0.1:7420'}/install/${token!}`;
      return {
        install_id: first.install_id,
        clients,
        command: installCommands({
          client: first.client,
          target_kind: input.target_kind,
          path: input.path,
          url,
        }),
        check_command: first.check_command,
        expires_at: expires,
      };
    },

    list(r, query) {
      const rows = r.db.sqlite
        .prepare(
          `SELECT ${INSTALL_COLUMNS}
           FROM installs
           WHERE (method = 'push' OR token_used_at IS NOT NULL) AND (? IS NULL OR project_key = ?)
           ORDER BY coalesce(token_used_at, at) DESC, id DESC
           LIMIT 100`,
        )
        .all(query.project ?? null, query.project ?? null) as InstallDbRow[];
      return { installs: rows.map(toRow) };
    },

    async state(r, query): Promise<InstallStateResponse> {
      const project = query.project ?? null;
      if (project) requireProject(r.db, project);
      // Decision 50: installs are per project, so without one nothing counts as installed.
      const target: InstallTargetKind = 'repo';
      const effective = effectiveAgentFiles(r.db, project);
      const markers = await clientMarkers(target, query.path);
      const worktrees = worktreesByPath(r.db);
      const protectedMode = connection().protectedMode;
      // Decision 56: what the repo's main branch holds, where Docket can read it.
      const repo = project
        ? (r.db.sqlite
            .prepare('SELECT repo_path, main_branch FROM projects WHERE key = ?')
            .get(project) as { repo_path: string | null; main_branch: string })
        : null;
      const onMain =
        repo && project
          ? readMainManifests(r.db, { key: project, ...repo }, INSTALL_CLIENTS, r.now)
          : null;
      const clients = INSTALL_CLIENTS.map((client) => {
        const main = onMain?.get(client) ?? { state: 'unknown' as const, branch: null };
        const mainOutdated =
          main.state === 'present'
            ? outdatedKeys(
                { manifest: JSON.stringify(main.manifest), target_kind: 'repo' },
                effective,
                protectedMode,
              )
            : null;
        const repo_main = {
          state:
            main.state === 'present'
              ? mainOutdated!.length > 0
                ? ('behind' as const)
                : ('current' as const)
              : main.state,
          branch: main.branch,
        };
        // The latest install of this client there: push, or a command that was downloaded.
        let latest = project ? latestInstall(r.db, project, client) : undefined;
        // An update the main branch already holds is the install, even before the next check.
        if (project && main.state === 'present' && main.install_id) {
          const landed = r.db.sqlite
            .prepare(
              `SELECT ${INSTALL_COLUMNS}, token_sha256 FROM installs
               WHERE id = ? AND project_key = ? AND client = ? AND target_kind = 'repo'`,
            )
            .get(main.install_id, project, client) as
            (InstallDbRow & { token_sha256: string | null }) | undefined;
          if (landed && isPendingUpdate(landed)) latest = landed;
        }
        // Decision 50: a removed install is no longer there.
        const row = latest && !latest.removed_at ? latest : undefined;
        const has = markers === null ? null : markers[client];
        const fetched = project
          ? (r.db.sqlite
              .prepare(
                `SELECT id, at FROM installs
                 WHERE client = ? AND target_kind = 'repo' AND project_key = ? AND ${PENDING_UPDATE_SQL}
                 ORDER BY at DESC, id DESC LIMIT 1`,
              )
              .get(client, project) as { id: string; at: string } | undefined)
          : undefined;
        const update_on_branch =
          fetched && fetched.id !== row?.id && (!row || fetched.at >= row.at)
            ? { install_id: fetched.id, at: fetched.at }
            : null;
        if (!row) {
          return {
            client,
            state: 'not_installed' as const,
            install: null,
            outdated: [],
            drift_ids: [],
            markers: has,
            worktree: null,
            repo_main,
            update_on_branch,
          };
        }
        const drift = (
          r.db.sqlite
            .prepare(`SELECT id FROM drift WHERE install_id = ? AND state = 'open' ORDER BY id`)
            .all(row.id) as { id: string }[]
        ).map((d) => d.id);
        // Where the main branch can be read, it decides: that's what new worktrees start from.
        const outdated = mainOutdated ?? outdatedKeys(row, effective, protectedMode);
        return {
          client,
          state:
            drift.length > 0
              ? ('changed' as const)
              : outdated.length > 0
                ? ('update_available' as const)
                : ('up_to_date' as const),
          install: toRow(row),
          outdated,
          drift_ids: drift,
          markers: has,
          worktree: row.path ? (worktrees.get(normalizeWorkspace(row.path)) ?? null) : null,
          repo_main,
          update_on_branch,
        };
      });
      const marked = INSTALL_CLIENTS.filter((c) => markers?.[c]);
      const installed = clients.filter((c) => c.install !== null).map((c) => c.client);
      const picked = INSTALL_CLIENTS.filter((c) => marked.includes(c) || installed.includes(c));
      return {
        project,
        target_kind: target,
        clients,
        defaults: picked.length > 0 ? picked : [...INSTALL_CLIENTS],
        update_command: updateCommands(baseUrl(), protectedMode),
      };
    },

    overview(r): InstallOverviewResponse {
      const rows = r.db.sqlite
        .prepare(
          `SELECT ${INSTALL_COLUMNS.split(', ')
            .map((c) => `i.${c}`)
            .join(', ')}
           FROM installs i JOIN projects p ON p.key = i.project_key AND p.deleted_at IS NULL
           WHERE i.target_kind = 'repo' AND (i.method = 'push' OR i.token_used_at IS NOT NULL)
           ORDER BY coalesce(i.token_used_at, i.at) DESC, i.id DESC`,
        )
        .all() as InstallDbRow[];
      const worktrees = worktreesByPath(r.db);
      const effective = new Map<string, ReturnType<typeof effectiveAgentFiles>>();
      const seen = new Set<string>();
      const out: InstallOverviewResponse['rows'] = [];
      for (const row of rows) {
        const project = row.project_key!;
        // The latest install of each client at each folder; a removed one hides older ones there.
        const where = row.path ? normalizeWorkspace(row.path) : '';
        const key = `${project}|${row.client}|${where}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (row.removed_at) continue;
        if (!effective.has(project)) effective.set(project, effectiveAgentFiles(r.db, project));
        const drift = (
          r.db.sqlite
            .prepare(`SELECT id FROM drift WHERE install_id = ? AND state = 'open' ORDER BY id`)
            .all(row.id) as { id: string }[]
        ).map((d) => d.id);
        const outdated = outdatedKeys(row, effective.get(project)!, connection().protectedMode);
        out.push({
          project,
          client: row.client,
          state:
            drift.length > 0 ? 'changed' : outdated.length > 0 ? 'update_available' : 'up_to_date',
          install: toRow(row),
          outdated,
          drift_ids: drift,
          worktree: row.path ? (worktrees.get(where) ?? null) : null,
        });
      }
      return { rows: out };
    },

    issueUninstall(w, { id }): UninstallResponse {
      const row = installRowById(w.db, id);
      if (!row || (row.method === 'command' && !row.token_used_at)) {
        throw new ToolError('not_found', `No install ${id}.`);
      }
      const token = randomBytes(32).toString('base64url');
      const expires = new Date(
        Date.parse(w.now) + AGENT_SETUP_LIMITS.install_token_ttl_ms,
      ).toISOString();
      w.update('installs', id, {
        removal_token_sha256: tokenHash(token),
        removal_token_expires_at: expires,
        removal_token_used_at: null,
      });
      const count = Object.keys(JSON.parse(row.manifest) as ManifestMap).length;
      w.event({
        type: 'install.recorded',
        summary: `Uninstall command created: ${describe({ ...row, count })}`,
        project_key: row.project_key,
        objects: [{ kind: 'install', id }],
        data: {
          method: 'command',
          client: row.client,
          target_kind: row.target_kind,
          files: count,
          stage: 'uninstall_issued',
        },
      });
      const plan = uninstallPlan(row);
      const url = `http://${config.allowedHosts[0] ?? '127.0.0.1:7420'}/uninstall/${token}`;
      return {
        install_id: id,
        command: uninstallCommands({
          client: row.client,
          target_kind: row.target_kind,
          path: row.path,
          url,
        }),
        script: { powershell: uninstallPs1(plan), bash: uninstallSh(plan) },
        files: plan.entries.map((e) => ({
          path: e.path,
          what: e.kind === 'block' || e.kind === 'connection' ? e.kind : 'file',
        })),
        expires_at: expires,
      };
    },

    async uninstallBundle(r, { token }): Promise<InstallBundle> {
      const row = r.db.sqlite
        .prepare(
          `SELECT ${INSTALL_COLUMNS} FROM installs
           WHERE removal_token_sha256 = ? AND removal_token_used_at IS NULL AND removal_token_expires_at > ?`,
        )
        .get(tokenHash(token), r.now) as InstallDbRow | undefined;
      if (!row) throw new ToolError('not_found', NOT_FOUND);
      const plan = uninstallPlan(row);
      const now = new Date(r.now);
      const entry = (name: string, text: string, mode = 0o644): TarFileEntry => {
        const bytes = Buffer.from(text, 'utf8');
        return {
          name: `docket-uninstall/${name}`,
          size: bytes.length,
          mtime: now,
          mode,
          source: { bytes },
        };
      };
      return {
        install_id: row.id,
        install_ids: [row.id],
        filename: `docket-uninstall-${row.id}.tar.gz`,
        bytes: await tarGzBytes([
          entry('uninstall.sh', uninstallSh(plan), 0o755),
          entry('uninstall.ps1', uninstallPs1(plan)),
        ]),
      };
    },

    markUninstallDownloaded(w, { install_id }) {
      const row = w.require('installs', install_id) as unknown as InstallDbRow & {
        removal_token_used_at: string | null;
      };
      // Checked again inside the write: of two racing downloads, only one gets the step.
      if (row.removal_token_used_at !== null) throw new ToolError('not_found', NOT_FOUND);
      w.update('installs', install_id, {
        removal_token_used_at: w.now,
        // The report comes after the step has run, so the window restarts at the download.
        removal_token_expires_at: new Date(
          Date.parse(w.now) + AGENT_SETUP_LIMITS.install_token_ttl_ms,
        ).toISOString(),
      });
      const count = Object.keys(JSON.parse(row.manifest) as ManifestMap).length;
      w.event({
        type: 'install.recorded',
        summary: `Uninstall command downloaded: ${describe({ ...row, count })}`,
        project_key: row.project_key,
        objects: [{ kind: 'install', id: install_id }],
        data: {
          method: 'command',
          client: row.client,
          target_kind: row.target_kind,
          files: count,
          stage: 'uninstall_downloaded',
        },
      });
    },

    recordUninstall(w, { token, report }) {
      const row = w.db.sqlite
        .prepare(
          `SELECT ${INSTALL_COLUMNS} FROM installs
           WHERE removal_token_sha256 = ? AND removal_token_used_at IS NOT NULL AND removal_token_expires_at > ?`,
        )
        .get(tokenHash(token), w.now) as InstallDbRow | undefined;
      if (!row) throw new ToolError('not_found', NOT_FOUND);
      const known = reportablePaths(row);
      for (const p of [...report.removed, ...report.gone, ...report.kept.map((k) => k.path)]) {
        if (!known.has(p)) {
          throw new ToolError('validation', `${p} isn't a file this install wrote.`);
        }
      }
      const removal: InstallRemoval = { how: 'command', ...report };
      w.update('installs', row.id, {
        removed_at: w.now,
        removal: JSON.stringify(removal),
        // Single use: the report can't be replayed.
        removal_token_sha256: null,
        removal_token_expires_at: null,
        removal_token_used_at: null,
      });
      const count = Object.keys(JSON.parse(row.manifest) as ManifestMap).length;
      w.event({
        type: 'install.recorded',
        summary: `Removed by command: ${describe({ ...row, count })}: ${report.removed.length} removed, ${report.kept.length} kept`,
        project_key: row.project_key,
        objects: [{ kind: 'install', id: row.id }],
        data: {
          method: 'command',
          client: row.client,
          target_kind: row.target_kind,
          files: count,
          stage: 'removed',
          removed: report.removed.length,
          kept: report.kept.length,
          gone: report.gone.length,
        },
      });
      deps.services().drift.closeForRemovedInstall(w, row.id);
      return { recorded: true as const };
    },

    markRemoved(w, { id }) {
      const row = installRowById(w.db, id);
      if (!row || (row.method === 'command' && !row.token_used_at)) {
        throw new ToolError('not_found', `No install ${id}.`);
      }
      if (row.target_kind !== 'user') {
        throw new ToolError(
          'validation',
          'Only a legacy user-wide install can be marked as removed. Use Uninstall for a repo install.',
        );
      }
      if (row.removed_at) {
        throw new ToolError('validation', 'This install is already marked as removed.');
      }
      const removal: InstallRemoval = { how: 'marked', removed: [], kept: [], gone: [] };
      const inverse = w.update('installs', id, {
        removed_at: w.now,
        removal: JSON.stringify(removal),
      });
      const count = Object.keys(JSON.parse(row.manifest) as ManifestMap).length;
      w.event({
        type: 'install.recorded',
        summary: `You marked as removed: ${describe({ ...row, count })}`,
        project_key: null,
        objects: [{ kind: 'install', id }],
        data: {
          method: row.method,
          client: row.client,
          target_kind: row.target_kind,
          files: count,
          stage: 'marked_removed',
        },
        inverse: [inverse],
      });
      return toRow(installRowById(w.db, id)!);
    },

    async check(r, { id }): Promise<InstallCheckResponse> {
      const row = installRowById(r.db, id);
      if (!row || (row.method === 'command' && !row.token_used_at)) {
        throw new ToolError('not_found', `No install ${id}.`);
      }
      if (row.method !== 'push' || !row.path) {
        throw new ToolError(
          'validation',
          'This install was made by command, so Docket can’t see its files. Run its check command where it was installed.',
        );
      }
      const cap = (t: string) => t.slice(0, AGENT_SETUP_LIMITS.agent_file_content);
      const files: InstallCheckResponse['files'] = [];
      for (const f of await inspectPushInstall(await pushRoot(), row)) {
        if (f.state === 'ok') continue;
        if (f.state === 'extra') files.push({ key: null, path: f.path, state: 'extra' });
        else if (f.state === 'missing') files.push({ key: f.key, path: f.path, state: 'missing' });
        else if (f.text === null) files.push({ key: f.key, path: f.path, state: 'edited' });
        else files.push({ key: f.key, path: f.path, state: 'edited', local_content: cap(f.text) });
      }
      return {
        install_id: row.id,
        checked_at: r.now,
        state: files.length === 0 ? 'up_to_date' : 'differs',
        files,
      };
    },

    async bundleForToken(r, { token }): Promise<InstallBundle> {
      // One client: the token's own sha256. Several: `token:client` per row (decision 34).
      const plain = tokenHash(token);
      const rows = (
        r.db.sqlite
          .prepare(
            `SELECT ${INSTALL_COLUMNS}, token_sha256
             FROM installs
             WHERE token_sha256 IN (?, ?, ?) AND method = 'command' AND token_used_at IS NULL AND token_expires_at > ?`,
          )
          .all(
            plain,
            ...INSTALL_CLIENTS.map((c) => tokenHash(`${token}:${c}`)),
            r.now,
          ) as (InstallDbRow & { token_sha256: string })[]
      ).sort((a, b) => INSTALL_CLIENTS.indexOf(a.client) - INSTALL_CLIENTS.indexOf(b.client));
      if (rows.length === 0) throw new ToolError('not_found', NOT_FOUND);

      const now = new Date(r.now);
      const single = rows.length === 1 && rows[0]!.token_sha256 === plain;
      const entries: TarFileEntry[] = [];
      for (const row of rows) {
        entries.push(...clientEntries(r, row, single ? '' : `${row.client}/`, now));
      }
      if (!single) {
        const clients = rows.map((row) => row.client);
        entries.push(
          tarText('install.sh', installWrapperSh(clients), now, 0o755),
          tarText('install.ps1', installWrapperPs1(clients), now),
        );
      }
      const first = rows[0]!;
      return {
        install_id: first.id,
        install_ids: rows.map((row) => row.id),
        filename: `docket-${first.id}.tar.gz`,
        bytes: await tarGzBytes(entries),
      };
    },

    markDownloaded(w, { install_id }) {
      const row = w.require('installs', install_id) as unknown as InstallDbRow;
      // Checked again inside the write: of two racing downloads, only one gets the bundle.
      if (row.token_used_at !== null) throw new ToolError('not_found', NOT_FOUND);
      w.update('installs', install_id, { token_used_at: w.now });
      const count = Object.keys(JSON.parse(row.manifest) as ManifestMap).length;
      w.event({
        type: 'install.recorded',
        summary: `Installed by command: ${describe({ ...row, count })}`,
        project_key: row.project_key,
        objects: [{ kind: 'install', id: install_id }],
        data: {
          method: 'command',
          client: row.client,
          target_kind: row.target_kind,
          files: count,
          stage: 'downloaded',
        },
      });
    },

    prepareUpdate(r, input) {
      requireProject(r.db, input.project);
      const effective = effectiveAgentFiles(r.db, input.project);
      if (effective.length === 0) {
        throw new ToolError(
          'validation',
          'No agent files are loaded yet. They load when Docket starts; restart it and try again.',
        );
      }
      const target = filesFor(
        effective.map((e) => ({
          key: e.key,
          version_id: e.version.id,
          content: e.version.content,
        })),
        input.client,
        'repo',
        input.project,
        connection(),
      );
      const layout = installLayout(input.client, 'repo');
      const reported = new Map(input.files.map((f) => [f.key, f]));
      const plan: PreparedUpdate['plan'] = [];
      const copied: PreparedUpdate['copied'] = [];
      const manifest: PreparedUpdate['manifest'] = [];
      let block: string | null = null;
      let conn: string | null = null;
      const modeOf = (path: string) => (path.endsWith('.sh') ? 0o755 : 0o644);

      for (const f of target) {
        const local = reported.get(f.key);
        const sha = local?.sha256.toLowerCase();
        const sent = local?.sent?.toLowerCase();
        const note =
          f.key === AGENTS_BLOCK_KEY
            ? 'its Docket section'
            : f.key === CONNECTION_KEY
              ? 'its docket server entry'
              : undefined;
        if (local && sha !== f.sha256 && sha !== sent) {
          // Edited here: left alone, and the manifest keeps what Docket last sent.
          plan.push({ change: 'kept', path: f.path, note: 'edited locally' });
          if (sent && local.version_id) {
            manifest.push({
              key: f.key,
              path: f.path,
              version_id: local.version_id,
              sha256: sent,
            });
          }
          continue;
        }
        manifest.push({ key: f.key, path: f.path, version_id: f.version_id, sha256: f.sha256 });
        if (sha === f.sha256) {
          plan.push({ change: 'same', path: f.path });
          continue;
        }
        plan.push({
          change: local ? 'updated' : 'added',
          path: f.path,
          ...(note ? { note } : {}),
        });
        if (f.key === AGENTS_BLOCK_KEY) block = f.content;
        else if (f.key === CONNECTION_KEY) conn = f.content;
        else copied.push({ path: f.path, text: f.content, mode: modeOf(f.path) });
      }

      // docket-check isn't in the manifest: a copy Docket shipped is replaced, an edit is kept.
      for (const [name, text] of checkScripts()) {
        const path = `${layout.dir}/${name}`;
        const local = reported.get(`script:${name}`)?.sha256.toLowerCase();
        if (local === hashText(text)) plan.push({ change: 'same', path });
        else if (local && !SHIPPED_CHECK_SHA256.includes(local)) {
          plan.push({ change: 'kept', path, note: 'edited locally' });
        } else {
          plan.push({ change: local ? 'updated' : 'added', path });
          copied.push({ path, text, mode: modeOf(path) });
        }
      }

      const shipped = new Set(target.map((f) => f.key));
      for (const f of input.files) {
        if (!f.sent || !f.key.startsWith('skill:') || shipped.has(f.key)) continue;
        const path = installPathOf(layout, f.key);
        if (!isSkillReferenceKey(f.key)) {
          plan.push({ change: 'retired', path, note: 'Docket no longer ships it; left in place' });
        } else if (f.sha256.toLowerCase() === f.sent.toLowerCase()) {
          // Decision 66: an unmodified reference Docket no longer ships is removed by the install step.
          plan.push({ change: 'removed', path, note: 'Docket no longer ships it' });
        } else {
          plan.push({
            change: 'kept',
            path,
            note: 'Docket no longer ships it, but it was edited locally; left in place',
          });
        }
      }

      const from = input.from ? installRowById(r.db, input.from) : undefined;
      const own =
        from &&
        from.project_key === input.project &&
        from.client === input.client &&
        from.target_kind === 'repo' &&
        !from.removed_at
          ? from
          : undefined;
      const wanted = manifestOf(manifest);
      const manifestSame = !!own && sameManifest(JSON.parse(own.manifest) as ManifestMap, wanted);
      const changed =
        !manifestSame ||
        plan.some(
          (p) =>
            p.change === 'added' ||
            p.change === 'updated' ||
            p.change === 'retired' ||
            p.change === 'removed',
        );
      if (changed) {
        plan.push({ change: input.from ? 'updated' : 'added', path: layout.manifest });
      }
      return {
        input,
        changed,
        path: own?.path ?? latestInstall(r.db, input.project, input.client)?.path ?? null,
        plan,
        copied,
        block,
        connection: conn,
        manifest,
      };
    },

    recordUpdate(w, p) {
      const { project, client, from } = p.input;
      if (!p.changed) return from ?? null;
      const wanted = manifestOf(p.manifest);
      // Running it again on another branch reuses the same unconfirmed install.
      const pending = w.db.sqlite
        .prepare(
          `SELECT ${INSTALL_COLUMNS} FROM installs
           WHERE client = ? AND target_kind = 'repo' AND project_key = ? AND ${PENDING_UPDATE_SQL}
           ORDER BY at DESC, id DESC LIMIT 20`,
        )
        .all(client, project) as InstallDbRow[];
      const same = pending.find(
        (row) =>
          row.path === p.path && sameManifest(JSON.parse(row.manifest) as ManifestMap, wanted),
      );
      if (same) return same.id;
      const id = newId('ins', Date.parse(w.now));
      w.insert('installs', {
        id,
        at: w.now,
        client,
        target_kind: 'repo',
        project_key: project,
        path: p.path,
        method: 'command',
        manifest: wanted,
      });
      w.event({
        type: 'install.recorded',
        summary: `Update fetched by the project: ${describe({
          client,
          target_kind: 'repo',
          project_key: project,
          path: p.path,
          count: p.manifest.length,
        })}`,
        project_key: project,
        objects: [{ kind: 'install', id }],
        data: {
          method: 'command',
          client,
          target_kind: 'repo',
          files: p.manifest.length,
          stage: 'update_fetched',
        },
      });
      return id;
    },

    async updateBundle(p, installId, now) {
      const at = new Date(now);
      const entry = (name: string, text: string, mode = 0o644): TarFileEntry => {
        const bytes = Buffer.from(text, 'utf8');
        return {
          name: `docket-update/${name}`,
          size: bytes.length,
          mtime: at,
          mode,
          source: { bytes },
        };
      };
      const planText = p.plan.map((x) => `${x.change}\t${x.path}\t${x.note ?? ''}\n`).join('');
      const entries = [entry('plan.txt', planText)];
      if (p.changed) {
        const { client, project } = p.input;
        const layout = installLayout(client, 'repo');
        const imports = importsAgentsMd(client, 'repo');
        entries.push(
          ...p.copied.map((x) => entry(`files/${x.path}`, x.text, x.mode)),
          entry(
            `files/${layout.manifest}`,
            manifestJson({
              install_id: installId!,
              client,
              target_kind: 'repo',
              project,
              installed_at: now,
              files: p.manifest,
            }),
          ),
          entry('files.txt', `${[...p.copied.map((x) => x.path), layout.manifest].join('\n')}\n`),
          ...(p.block !== null ? [entry('block.md', p.block)] : []),
          ...(p.connection !== null ? [entry('connection.txt', p.connection)] : []),
          entry('install.sh', installSh(layout.instructions, layout.dir, client, imports), 0o755),
          entry('install.ps1', installPs1(layout.instructions, layout.dir, client, imports)),
        );
      }
      return tarGzBytes(entries);
    },

    updateNoticeFor(r, { project, reported }) {
      const effective = effectiveAgentFiles(r.db, project);
      const protectedMode = connection().protectedMode;
      // A file the owner has seen as edited isn't a reason to ask for the update again.
      const behind = (row: InstallDbRow) => {
        const known = new Set(
          (
            r.db.sqlite
              .prepare(
                `SELECT DISTINCT file_key FROM drift WHERE install_id = ? AND state IN ('open', 'kept_local')`,
              )
              .all(row.id) as { file_key: string }[]
          ).map((d) => d.file_key),
        );
        return outdatedKeys(row, effective, protectedMode).filter((k) => !known.has(k));
      };
      let count = 0;
      if (reported) {
        const row = installRowById(r.db, reported);
        if (!row || row.project_key !== project || row.target_kind !== 'repo' || row.removed_at) {
          return null;
        }
        count = behind(row).length;
        if (count === 0) return null;
        // A branch behind a main that already has it needs a merge, not an update.
        const newest = latestInstall(r.db, project, row.client);
        if (newest && newest.id !== row.id && !newest.removed_at && behind(newest).length === 0) {
          return null;
        }
      } else {
        for (const client of INSTALL_CLIENTS) {
          const row = latestInstall(r.db, project, client);
          if (row && !row.removed_at) count = Math.max(count, behind(row).length);
        }
        if (count === 0) return null;
      }
      return updateNotice(count, updateCommands(baseUrl(), protectedMode));
    },

    async landedUpdates(r) {
      const rows = r.db.sqlite
        .prepare(
          `SELECT i.id, i.client, i.project_key, p.repo_path, p.main_branch
           FROM installs i JOIN projects p ON p.key = i.project_key AND p.deleted_at IS NULL
           WHERE i.target_kind = 'repo' AND p.repo_path IS NOT NULL
             AND i.method = 'command' AND i.token_sha256 IS NULL
             AND i.token_used_at IS NULL AND i.removed_at IS NULL`,
        )
        .all() as {
        id: string;
        client: InstallClient;
        project_key: string;
        repo_path: string;
        main_branch: string;
      }[];
      const out: string[] = [];
      for (const key of new Set(rows.map((x) => x.project_key))) {
        const mine = rows.filter((x) => x.project_key === key);
        const main = readMainManifests(
          r.db,
          { key, repo_path: mine[0]!.repo_path, main_branch: mine[0]!.main_branch },
          INSTALL_CLIENTS,
          r.now,
        );
        for (const row of mine) {
          const m = main.get(row.client);
          if (m?.state === 'present' && m.install_id === row.id) out.push(row.id);
        }
      }
      return out;
    },

    confirmLanded(w, { ids }) {
      for (const id of ids) {
        const row = w.db.sqlite
          .prepare(`SELECT ${INSTALL_COLUMNS}, token_sha256 FROM installs WHERE id = ?`)
          .get(id) as (InstallDbRow & { token_sha256: string | null }) | undefined;
        if (row && isPendingUpdate(row)) markUpdateLanded(w, row);
      }
    },

    async pushTarget() {
      if (!config.pushRoot) {
        return { configured: false, writable: null, container_path: null, host_path: null };
      }
      let writable = false;
      try {
        const root = await PushRoot.open(config.pushRoot, config.pushHostPath);
        await access(root.real, fsConstants.W_OK);
        writable = true;
      } catch {
        writable = false;
      }
      return {
        configured: true,
        writable,
        container_path: config.pushRoot,
        host_path: config.pushHostPath,
      };
    },

    async testPushTarget() {
      if (!config.pushRoot) {
        return {
          ok: false,
          message:
            "Push install is off: DOCKET_PUSH_ROOT isn't set. Mount a folder and set it, then restart Docket.",
        };
      }
      let root: PushRoot;
      try {
        root = await PushRoot.open(config.pushRoot, config.pushHostPath);
      } catch (err) {
        return { ok: false, message: (err as Error).message };
      }
      const probe = join(root.real, `.docket-probe-${randomUUID()}`);
      const shown = config.pushHostPath ?? config.pushRoot;
      try {
        const fh = await open(probe, 'wx', 0o644);
        await fh.close();
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? 'error';
        return {
          ok: false,
          message: `Couldn't write a test file in ${shown} (${code}). Make the folder writable by Docket (uid 10001), then test again.`,
        };
      }
      await rm(probe, { force: true });
      return {
        ok: true,
        message: `Wrote and removed a test file in ${shown}. Push install works.`,
      };
    },
  };
}
