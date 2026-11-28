/**
 * Export a running Docket volume through a read-only mount. The caller must
 * mount a different disposable volume for `out`; this module never prepares
 * or modifies the source directory.
 */
import Database from 'better-sqlite3';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, sep } from 'node:path';
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

function existingSecret(path: string): string {
  try {
    const value = readFileSync(path, 'utf8').trim();
    if (value.length >= 8) return value;
  } catch {
    // The refusal is deliberately the same for an absent and an unreadable key.
  }
  throw new ReadOnlyExportRefused('Required service secret guard is unavailable.');
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

function checkedDestination(config: Config, out: string): string {
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
}): Promise<ExportResult> {
  const { config, out } = input;
  const source = checkedDestination(config, out);
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
