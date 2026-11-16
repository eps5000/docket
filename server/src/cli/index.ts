#!/usr/bin/env node
/**
 * The `tasklite` command inside the container (BUILD_SPEC §3, §5.13, §8; MCP_SPEC §11):
 *
 *   tasklite owner-key        print the owner key (for the Unlock screen)
 *   tasklite agent-token      print the agent bearer token
 *   tasklite backup now       take a verified backup now (also the extra copy, if set)
 *   tasklite restore <file>   restore a backup; refuses while the server runs
 *   tasklite checksums        print item, event and document checksums (SC-008 checks)
 *   tasklite seed sample      load the sample data into an empty database
 *
 * `--data-dir <path>` points at a data directory other than /data, and
 * `seed sample --now <ISO time>` pins the seed's clock (both for local checks).
 * Only `owner-key` and `agent-token` print a secret, and only when asked.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SecretStore, ensureDataDirs, loadConfig } from '../config.js';
import { migrateDb, openDb } from '../db/client.js';
import { describeSeed, isDatabaseEmpty, loadSampleSeed } from '../db/seed/loader.js';
import {
  ArchiveError,
  RestoreRefused,
  liveChecksums,
  restoreBackup,
  runBackup,
} from '../jobs/backup.js';

const USAGE = `Usage:
  tasklite owner-key            Print the owner key
  tasklite agent-token          Print the agent bearer token
  tasklite backup now           Take a verified backup now
  tasklite restore <file>       Restore a backup (stop the service first)
  tasklite checksums            Print item, event and document checksums
  tasklite seed sample          Load the sample data into an empty database
Options:
  --data-dir <path>             Data directory (default /data)
  --now <ISO time>              Seed clock (default: now)
  --through-seq <n>             checksums: only events up to this seq`;

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
  args.splice(i, 2);
  return value;
}

const out = (line: string) => process.stdout.write(`${line}\n`);
const err = (line: string) => process.stderr.write(`${line}\n`);

export async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const dataDir = option(args, '--data-dir') ?? '/data';
  const nowText = option(args, '--now');
  const throughSeq = option(args, '--through-seq');
  const [command, sub, ...rest] = args;
  const config = loadConfig(process.env, { dataDir });

  switch (command) {
    case 'owner-key':
      out(new SecretStore(config).ownerKey());
      return 0;
    case 'agent-token':
      out(new SecretStore(config).agentToken());
      return 0;

    case 'backup': {
      if (sub !== 'now' || rest.length > 0) break;
      ensureDataDirs(config);
      const db = openDb(config.paths.db);
      try {
        migrateDb(db);
        const result = await runBackup({
          config,
          sqlite: db.sqlite,
          clock: () => new Date(),
          log: () => {},
        });
        out(`Backup written and verified: ${result.archive_path}`);
        out(`Kept ${config.backupKeepDays} days in ${config.paths.backups}.`);
        if (result.extra_copy?.ok) out(`Extra copy: ${result.extra_copy.path}`);
        if (result.extra_copy && !result.extra_copy.ok) {
          err(`Extra backup copy failed: ${result.extra_copy.error}`);
          err('The backup in the data volume is fine.');
        }
        if (!config.backupExtraDir) {
          out('No extra location (TASKLITE_BACKUP_EXTRA_DIR is not set).');
        }
        return 0;
      } finally {
        db.sqlite.close();
      }
    }

    case 'restore': {
      if (!sub || rest.length > 0) break;
      try {
        const result = await restoreBackup({ config, file: sub, log: out });
        const c = result.checksums;
        out(`Restored ${result.archive} (taken ${result.manifest.created_at}).`);
        out(
          `Verified identical: ${c.items.count} items, ${c.events.count} events, ${c.documents.count} document versions (${c.documents.bytes} bytes).`,
        );
        out(`items ${c.items.sha256}`);
        out(`events ${c.events.sha256}`);
        out(`documents ${c.documents.sha256}`);
        out('Start the service again: docker compose up -d');
        return 0;
      } catch (e) {
        if (e instanceof RestoreRefused || e instanceof ArchiveError) {
          err(`Restore refused: ${e.message}`);
          err('Nothing was changed.');
          return 1;
        }
        throw e;
      }
    }

    case 'checksums': {
      if (sub !== undefined) break;
      const seq = throughSeq === undefined ? undefined : Number(throughSeq);
      if (seq !== undefined && !Number.isInteger(seq)) throw new Error('--through-seq is a number');
      out(JSON.stringify(liveChecksums(config.paths, { throughSeq: seq })));
      return 0;
    }

    case 'seed': {
      if (sub !== 'sample') break;
      const now = nowText ? new Date(nowText) : new Date();
      if (Number.isNaN(now.getTime())) throw new Error(`--now is not a valid time: ${nowText}`);
      new SecretStore(config); // creates the volume layout
      const db = openDb(config.paths.db);
      try {
        migrateDb(db);
        if (!isDatabaseEmpty(db)) {
          err('The database already has data; the sample seed only loads into an empty one.');
          return 1;
        }
        const summary = loadSampleSeed(db, { now, docsDir: config.paths.docs });
        out(`Loaded the sample seed: ${describeSeed(summary)}`);
        return 0;
      } finally {
        db.sqlite.close();
      }
    }
    case undefined:
    case 'help':
    case '--help':
      out(USAGE);
      return 0;
  }
  err(`Unknown command: ${args.join(' ')}\n${USAGE}`);
  return 2;
}

/** True when this file is the program (`tasklite …`), not a module a test imported. */
function isMain(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      err(`tasklite: ${(e as Error).message}`);
      process.exitCode = 1;
    },
  );
}
