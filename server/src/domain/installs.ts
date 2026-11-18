/**
 * Installs (owner decision 29; BUILD_SPEC §5.17; FR-124 to FR-127; tasks.md
 * T155, T156): the bundle builder, the single-use download token, push
 * install into the opt-in push root, the install log, the check, and the
 * push folder's status and *Test*.
 *
 * **What is installed** is the effective set for the project (or
 * service-wide), laid out for the client and target (`installLayout` in
 * @tasklite/shared): each skill's `SKILL.md`, the AGENTS.md block merged
 * into CLAUDE.md or AGENTS.md between the Task Lite markers, and
 * `.tasklite-manifest.json` with the install ID and each file's key, version
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
 * only when `TASKLITE_PUSH_ROOT` is set and the folder is there; every path
 * goes through the push-root guard (push-root.ts). All targets are checked,
 * and the instructions file's markers validated, before anything is written.
 *
 * **The check** (push installs): each manifest file is edited, missing, or
 * fine; `tasklite-*` skill folders the install didn't write are extra.
 * Edited files carry `local_content` (≤ 50,000 characters) for the diff.
 * Command installs are checked by their check command (`checkCommands`).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { access, constants as fsConstants, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AGENT_SETUP_LIMITS,
  AGENTS_BLOCK_KEY,
  BrokenMarkersError,
  INSTALL_CLIENT_LABELS,
  ToolError,
  checkCommands,
  fillsProjectKey,
  installCommands,
  installLayout,
  installPathOf,
  installedBlock,
  isSafeCommandPath,
  mergeMarkedSection,
  renderAgentsBlock,
  withoutCr,
  type CreateInstallResponse,
  type InstallCheckResponse,
  type InstallClient,
  type InstallMethod,
  type InstallRow,
  type InstallTargetKind,
} from '@tasklite/shared';
import type { Db } from '../db/client.js';
import { tarGzBytes, type TarFileEntry } from '../jobs/tar.js';
import { effectiveAgentFiles } from './agent-files.js';
import {
  type InstallBundle,
  type InstallsService,
  type PreparedInstall,
  type ServiceDeps,
} from './contracts.js';
import { newId } from './ids.js';
import { CHECK_SCRIPT_PS1, CHECK_SCRIPT_SH, checkPs1, checkSh } from './check-scripts.js';
import { installPs1, installSh } from './install-scripts.js';
import { PushRoot, SymlinkRefused } from './push-root.js';
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
}

/** The `installs.manifest` column: key → version and sha256, in install order. */
export type ManifestMap = Record<string, { version_id: string; sha256: string }>;

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

/** The version texts, by ID (immutable, so a command install's bundle matches its manifest). */
function versionContent(db: Db, id: string): string {
  const row = db.sqlite.prepare('SELECT content FROM agent_file_versions WHERE id = ?').get(id) as
    { content: string } | undefined;
  if (!row) throw new ToolError('not_found', NOT_FOUND);
  return row.content;
}

/** Each file as installed, for a client, target and project. */
function filesFor(
  keys: { key: string; version_id: string; content: string }[],
  client: InstallClient,
  target: InstallTargetKind,
  project: string | null,
): InstallFile[] {
  const layout = installLayout(client, target);
  const fill = fillsProjectKey(target, project);
  return keys.map(({ key, version_id, content }) => {
    const text = key === AGENTS_BLOCK_KEY ? renderAgentsBlock(content, fill) : content;
    return {
      key,
      version_id,
      path: installPathOf(layout, key),
      content: text,
      sha256: hashText(text),
    };
  });
}

/**
 * `.tasklite-manifest.json`: one file per line, so the bash check command can
 * read it without a JSON parser (each line holds `"key"`, `"path"`,
 * `"version_id"` and `"sha256"` in that order).
 */
export function manifestJson(meta: {
  install_id: string;
  client: InstallClient;
  target_kind: InstallTargetKind;
  project: string | null;
  installed_at: string;
  files: InstallFile[];
}): string {
  const head = {
    install_id: meta.install_id,
    client: meta.client,
    target: meta.target_kind,
    project: meta.project,
    installed_at: meta.installed_at,
    source: 'Task Lite, Agent files',
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
  };
}

/** One installed file as the push check read it (B24's check; reused by drift, B27b). */
export interface InspectedFile {
  /** The manifest key, or `skill:<name>` for an extra `tasklite-*` skill folder. */
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
 * `tasklite-*` skill folders the install didn't write are extra. Reads only.
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
    const rel = installPathOf(layout, key);
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
    if (key === AGENTS_BLOCK_KEY) {
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
    Object.keys(manifest)
      .filter((k) => k.startsWith('skill:'))
      .map((k) => k.slice('skill:'.length)),
  );
  for (const name of (await root.folders(base, layout.skillsDir)).sort()) {
    if (!name.startsWith('tasklite-') || sentSkills.has(name)) continue;
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

/** The installed `tasklite-check` scripts (bash, PowerShell), written next to the manifest. */
const checkScripts = (): [string, string][] => [
  [CHECK_SCRIPT_SH, checkSh()],
  [CHECK_SCRIPT_PS1, checkPs1()],
];

/** What `prepare` hands `record` beyond the contract's fields. */
interface Prepared extends PreparedInstall {
  install_id: string;
}

// ---- The service ----

export function createInstallsService(deps: ServiceDeps): InstallsService {
  const { config } = deps;

  /** The push root, opened and checked; `validation` when push is off or the folder isn't there. */
  async function pushRoot(): Promise<PushRoot> {
    if (!config.pushRoot) {
      throw new ToolError(
        'validation',
        "Push install is off: TASKLITE_PUSH_ROOT isn't set. Use the install command instead.",
      );
    }
    return PushRoot.open(config.pushRoot, config.pushHostPath);
  }

  /** Write the files into the push root. Everything is checked before the first write. */
  async function push(
    root: PushRoot,
    input: PreparedInstall['input'],
    install_id: string,
    files: InstallFile[],
    now: string,
  ): Promise<{ path: string; change: 'created' | 'updated' | 'unchanged' }[]> {
    const base = await root.base(input.path!);
    const layout = installLayout(input.client, input.target_kind);
    const writes: { rel: string; bytes: Buffer }[] = [];

    for (const f of files) {
      if (f.key === AGENTS_BLOCK_KEY) {
        const old = await root.read(base, f.path);
        let merged;
        try {
          merged = mergeMarkedSection(
            old === null ? null : old.toString('latin1'),
            Buffer.from(f.content, 'utf8').toString('latin1'),
            layout.display + f.path,
          );
        } catch (err) {
          if (err instanceof BrokenMarkersError) throw new ToolError('validation', err.message);
          throw err;
        }
        writes.push({ rel: f.path, bytes: Buffer.from(merged.text, 'latin1') });
      } else {
        writes.push({ rel: f.path, bytes: Buffer.from(f.content, 'utf8') });
      }
    }
    const manifest = manifestJson({
      install_id,
      client: input.client,
      target_kind: input.target_kind,
      project: input.project ?? null,
      installed_at: now,
      files,
    });
    writes.push({ rel: layout.manifest, bytes: Buffer.from(manifest, 'utf8') });
    // tasklite-check, next to the manifest (decision 30): what agents run to report on claim.
    for (const [name, text] of checkScripts()) {
      writes.push({ rel: `${layout.dir}/${name}`, bytes: Buffer.from(text, 'utf8') });
    }

    // Check every target first: no symlinks, no folders leading out of the root.
    for (const w of writes) await root.checkWritable(base, w.rel);

    const out: { path: string; change: 'created' | 'updated' | 'unchanged' }[] = [];
    for (const w of writes) {
      const old = await root.read(base, w.rel);
      const change = old === null ? 'created' : old.equals(w.bytes) ? 'unchanged' : 'updated';
      if (change !== 'unchanged') await root.write(base, w.rel, w.bytes);
      out.push({ path: layout.display + w.rel, change });
    }
    return out;
  }

  return {
    async prepare(r, input) {
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
          'No agent files are loaded yet. They load when Task Lite starts; restart it and try again.',
        );
      }
      const files = filesFor(
        effective.map((e) => ({
          key: e.key,
          version_id: e.version.id,
          content: e.version.content,
        })),
        input.client,
        input.target_kind,
        project,
      );
      const install_id = newId('ins', Date.parse(r.now));
      const prepared: Prepared = {
        input,
        install_id,
        manifest: files.map((f) => ({ key: f.key, version_id: f.version_id, sha256: f.sha256 })),
      };
      if (input.method === 'push') {
        const root = await pushRoot();
        prepared.result = { files: await push(root, input, install_id, files, r.now) };
      }
      return prepared;
    },

    record(w: WriteContext, p: PreparedInstall): CreateInstallResponse {
      const { input, manifest } = p;
      const id = (p as Prepared).install_id ?? newId('ins', Date.parse(w.now));
      const project = input.project ?? null;
      const describeArgs = {
        client: input.client,
        target_kind: input.target_kind,
        project_key: project,
        path: input.path ?? null,
        count: manifest.length,
      };
      const base = {
        id,
        at: w.now,
        client: input.client,
        target_kind: input.target_kind,
        project_key: project,
        path: input.path ?? null,
        method: input.method,
        manifest: manifestOf(manifest),
      };
      const data = {
        method: input.method,
        client: input.client,
        target_kind: input.target_kind,
        files: manifest.length,
      };

      if (input.method === 'push') {
        w.insert('installs', base);
        w.event({
          type: 'install.recorded',
          summary: `Installed by push: ${describe(describeArgs)}`,
          project_key: project,
          objects: [{ kind: 'install', id }],
          data: { ...data, stage: 'pushed' },
        });
        return { install_id: id, result: p.result ?? { files: [] } };
      }

      const token = randomBytes(32).toString('base64url');
      const expires = new Date(
        Date.parse(w.now) + AGENT_SETUP_LIMITS.install_token_ttl_ms,
      ).toISOString();
      w.insert('installs', { ...base, token_sha256: tokenHash(token), token_expires_at: expires });
      w.event({
        type: 'install.recorded',
        summary: `Install command created: ${describe(describeArgs)}`,
        project_key: project,
        objects: [{ kind: 'install', id }],
        data: { ...data, stage: 'command_issued' },
      });
      const url = `http://${config.allowedHosts[0] ?? '127.0.0.1:7420'}/install/${token}`;
      const where = { client: input.client, target_kind: input.target_kind, path: input.path };
      return {
        install_id: id,
        command: installCommands({ ...where, url }),
        check_command: checkCommands(where),
        expires_at: expires,
      };
    },

    list(r, query) {
      const rows = r.db.sqlite
        .prepare(
          `SELECT id, at, client, target_kind, project_key, path, method, manifest, token_used_at
           FROM installs
           WHERE (method = 'push' OR token_used_at IS NOT NULL) AND (? IS NULL OR project_key = ?)
           ORDER BY coalesce(token_used_at, at) DESC, id DESC
           LIMIT 100`,
        )
        .all(query.project ?? null, query.project ?? null) as InstallDbRow[];
      return { installs: rows.map(toRow) };
    },

    async check(r, { id }): Promise<InstallCheckResponse> {
      const row = r.db.sqlite
        .prepare(
          `SELECT id, at, client, target_kind, project_key, path, method, manifest, token_used_at
           FROM installs WHERE id = ?`,
        )
        .get(id) as InstallDbRow | undefined;
      if (!row || (row.method === 'command' && !row.token_used_at)) {
        throw new ToolError('not_found', `No install ${id}.`);
      }
      if (row.method !== 'push' || !row.path) {
        throw new ToolError(
          'validation',
          'This install was made by command, so Task Lite can’t see its files. Run its check command where it was installed.',
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
      const row = r.db.sqlite
        .prepare(
          `SELECT id, at, client, target_kind, project_key, path, method, manifest, token_used_at
           FROM installs
           WHERE token_sha256 = ? AND method = 'command' AND token_used_at IS NULL AND token_expires_at > ?`,
        )
        .get(tokenHash(token), r.now) as InstallDbRow | undefined;
      if (!row) throw new ToolError('not_found', NOT_FOUND);

      const manifest = JSON.parse(row.manifest) as ManifestMap;
      const files = filesFor(
        Object.entries(manifest).map(([key, v]) => ({
          key,
          version_id: v.version_id,
          content: versionContent(r.db, v.version_id),
        })),
        row.client,
        row.target_kind,
        row.project_key,
      );
      const layout = installLayout(row.client, row.target_kind);
      const now = new Date(r.now);
      const entry = (name: string, text: string, mode = 0o644): TarFileEntry => {
        const bytes = Buffer.from(text, 'utf8');
        return {
          name: `tasklite-install/${name}`,
          size: bytes.length,
          mtime: now,
          mode,
          source: { bytes },
        };
      };
      const copied = files.filter((f) => f.key !== AGENTS_BLOCK_KEY);
      const block = files.find((f) => f.key === AGENTS_BLOCK_KEY);
      const scripts = checkScripts().map(([name, text]) => ({
        path: `${layout.dir}/${name}`,
        text,
        mode: name === CHECK_SCRIPT_SH ? 0o755 : 0o644,
      }));
      const list = [...copied.map((f) => f.path), layout.manifest, ...scripts.map((x) => x.path)];
      const entries: TarFileEntry[] = [
        ...copied.map((f) => entry(`files/${f.path}`, f.content)),
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
        // tasklite-check, next to the manifest (decision 30).
        ...scripts.map((x) => entry(`files/${x.path}`, x.text, x.mode)),
        entry('files.txt', `${list.join('\n')}\n`),
        entry('block.md', block?.content ?? ''),
        entry('install.sh', installSh(layout.instructions), 0o755),
        entry('install.ps1', installPs1(layout.instructions)),
      ];
      return {
        install_id: row.id,
        filename: `tasklite-${row.id}.tar.gz`,
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
            "Push install is off: TASKLITE_PUSH_ROOT isn't set. Mount a folder and set it, then restart Task Lite.",
        };
      }
      let root: PushRoot;
      try {
        root = await PushRoot.open(config.pushRoot, config.pushHostPath);
      } catch (err) {
        return { ok: false, message: (err as Error).message };
      }
      const probe = join(root.real, `.tasklite-probe-${randomUUID()}`);
      const shown = config.pushHostPath ?? config.pushRoot;
      try {
        const fh = await open(probe, 'wx', 0o644);
        await fh.close();
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? 'error';
        return {
          ok: false,
          message: `Couldn't write a test file in ${shown} (${code}). Make the folder writable by Task Lite (uid 10001), then test again.`,
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
