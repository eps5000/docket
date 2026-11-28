/**
 * Export a running Docket volume through a read-only mount. The caller must
 * mount a different disposable volume for `out`; this module never prepares
 * or modifies the source directory.
 */
import Database from 'better-sqlite3';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { Config } from '../config.js';
import { migrationStatus } from '../db/client.js';
import { runExport, type ExportResult } from './export.js';

export class ReadOnlyExportRefused extends Error {
  override name = 'ReadOnlyExportRefused';
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

interface MountIdentity {
  id: string;
  device: string;
  root: string;
  source: string;
}

function unescapeMount(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

/** Linux mountinfo distinguishes two bind paths to the same backing volume. */
function linuxMountIdentity(path: string): MountIdentity {
  const lines = readFileSync('/proc/self/mountinfo', 'utf8').split('\n');
  let best: { mountPoint: string; identity: MountIdentity } | undefined;
  for (const line of lines) {
    const fields = line.split(' ');
    const separator = fields.indexOf('-');
    if (separator < 0 || fields.length < separator + 3) continue;
    const mountPoint = unescapeMount(fields[4]!);
    if (!within(mountPoint, path) || (best && best.mountPoint.length >= mountPoint.length)) {
      continue;
    }
    best = {
      mountPoint,
      identity: {
        id: fields[0]!,
        device: fields[2]!,
        root: unescapeMount(fields[3]!),
        source: unescapeMount(fields[separator + 2]!),
      },
    };
  }
  if (!best) throw new Error('mount identity unavailable');
  return best.identity;
}

function separateMounts(a: MountIdentity, b: MountIdentity): boolean {
  if (a.id === b.id) return false;
  if (a.device !== b.device || a.source !== b.source) return true;
  // Two bind mounts of one volume may have different mount IDs. Their backing
  // roots must also be disjoint, including subdirectory bind mounts.
  return !within(a.root, b.root) && !within(b.root, a.root);
}

function existingSecret(path: string): string {
  try {
    const value = readFileSync(path, 'utf8').trim();
    if (value.length >= 8) return value;
  } catch {
    // The refusal is deliberately the same for an absent and an unreadable key.
  }
  throw new ReadOnlyExportRefused('Required service secret guard is unavailable.');
}

function sameFile(a: Stats, b: Stats): boolean {
  return (
    (process.platform === 'win32' || a.dev === b.dev) &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

function guardedDocument(docs: string, storedPath: string): { bytes: Buffer; mtime: Date } {
  const parts = storedPath.split('/');
  if (
    parts.length < 1 ||
    parts.some((part) => part === '' || part === '.' || part === '..' || /[\\:\0]/.test(part))
  ) {
    throw new ReadOnlyExportRefused('Referenced document path is unsafe.');
  }
  try {
    const root = realpathSync(docs);
    let full = root;
    for (const part of parts) {
      full = join(full, part);
      if (lstatSync(full).isSymbolicLink()) throw new Error('document alias');
    }
    if (!within(root, realpathSync(full))) throw new Error('document escape');
    const before = lstatSync(full);
    if (!before.isFile()) throw new Error('not a regular file');
    const fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fstatSync(fd);
      if (!sameFile(before, opened)) throw new Error('document changed before read');
      const bytes = readFileSync(fd);
      if (
        !sameFile(opened, fstatSync(fd)) ||
        !sameFile(opened, lstatSync(full)) ||
        !within(root, realpathSync(full))
      ) {
        throw new Error('document changed during read');
      }
      return { bytes, mtime: opened.mtime };
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new ReadOnlyExportRefused('Referenced document is missing or unsafe.');
  }
}

/** Values remain in this one-shot process; no key is persisted or logged. */
function knownSecrets(config: Config, source: string): string[] {
  try {
    for (const path of [config.paths.secrets, config.paths.ownerKey]) {
      if (!within(source, realpathSync(path))) throw new Error('alias');
    }
    const values = [existingSecret(config.paths.ownerKey)];
    if (config.tokenFromEnv) {
      if (config.tokenFromEnv.length < 8) throw new Error('short token');
      values.push(config.tokenFromEnv);
    }
    if (existsSync(config.paths.agentToken)) {
      if (!within(source, realpathSync(config.paths.agentToken))) throw new Error('alias');
      values.push(existingSecret(config.paths.agentToken));
    } else if (!config.tokenFromEnv) {
      throw new Error('missing token');
    }
    return values;
  } catch {
    throw new ReadOnlyExportRefused('Required service secret guard is unavailable.');
  }
}

function checkedDestination(
  config: Config,
  out: string,
  mountIdentity: (path: string) => MountIdentity,
): string {
  if (!isAbsolute(out)) {
    throw new ReadOnlyExportRefused('Use an absolute destination on a separate scratch mount.');
  }
  let source: string;
  let destinationParent: string;
  try {
    source = realpathSync(config.dataDir);
    destinationParent = realpathSync(dirname(out));
    for (const path of [config.paths.db, config.paths.docs]) {
      if (!within(source, realpathSync(path))) throw new Error('source alias');
    }
  } catch {
    throw new ReadOnlyExportRefused('Source or scratch destination is unavailable.');
  }
  if (within(source, destinationParent) || within(destinationParent, source)) {
    throw new ReadOnlyExportRefused('Source and destination must be separate mounts.');
  }
  try {
    if (!separateMounts(mountIdentity(source), mountIdentity(destinationParent))) {
      throw new Error('same mount');
    }
  } catch {
    throw new ReadOnlyExportRefused('Source and destination must be separate mounts.');
  }
  try {
    lstatSync(out);
    throw new ReadOnlyExportRefused('Destination already exists.');
  } catch (error) {
    if (error instanceof ReadOnlyExportRefused) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ReadOnlyExportRefused('Destination cannot be verified.');
    }
  }
  return source;
}

export async function runReadOnlyExport(input: {
  config: Config;
  out: string;
  clock?: () => Date;
  /** Synthetic test seam only; the CLI always reads the actual Linux mount table. */
  mountIdentity?: (path: string) => MountIdentity;
}): Promise<ExportResult> {
  const { config, out } = input;
  const source = checkedDestination(config, out, input.mountIdentity ?? linuxMountIdentity);
  let sqlite: Database.Database;
  try {
    sqlite = new Database(config.paths.db, { readonly: true, fileMustExist: true });
  } catch {
    throw new ReadOnlyExportRefused('Source database cannot be opened read-only.');
  }
  try {
    if (!migrationStatus({ sqlite }).current) {
      throw new ReadOnlyExportRefused('Source schema differs from this Docket build.');
    }
    const secrets = knownSecrets(config, source);
    return await runExport({
      config,
      sqlite,
      clock: input.clock ?? (() => new Date()),
      secrets: () => secrets,
      out,
      requireCompleteDocuments: true,
      readDocument: (path) => guardedDocument(config.paths.docs, path),
    });
  } catch (error) {
    if (error instanceof ReadOnlyExportRefused) throw error;
    throw new ReadOnlyExportRefused(
      'Read-only snapshot or export failed; no complete archive written.',
    );
  } finally {
    sqlite.close();
  }
}
