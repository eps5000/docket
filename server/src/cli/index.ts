#!/usr/bin/env node
/**
 * The `tasklite` command inside the container (BUILD_SPEC §3, §8; MCP_SPEC §11):
 *
 *   tasklite owner-key      print the owner key (for the Unlock screen)
 *   tasklite agent-token    print the agent bearer token
 *   tasklite seed sample    load the sample data into an empty database
 *
 * `--data-dir <path>` points at a data directory other than /data, and
 * `seed sample --now <ISO time>` pins the seed's clock (both for local checks).
 */
import { SecretStore, loadConfig } from '../config.js';
import { migrateDb, openDb } from '../db/client.js';
import { describeSeed, isDatabaseEmpty, loadSampleSeed } from '../db/seed/loader.js';

const USAGE = `Usage:
  tasklite owner-key            Print the owner key
  tasklite agent-token          Print the agent bearer token
  tasklite seed sample          Load the sample data into an empty database
Options:
  --data-dir <path>             Data directory (default /data)
  --now <ISO time>              Seed clock (default: now)`;

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
  args.splice(i, 2);
  return value;
}

export function main(argv: string[]): number {
  const args = [...argv];
  const dataDir = option(args, '--data-dir') ?? '/data';
  const nowText = option(args, '--now');
  const [command, sub] = args;
  const config = loadConfig(process.env, { dataDir });

  switch (command) {
    case 'owner-key':
      process.stdout.write(`${new SecretStore(config).ownerKey()}\n`);
      return 0;
    case 'agent-token':
      process.stdout.write(`${new SecretStore(config).agentToken()}\n`);
      return 0;
    case 'seed': {
      if (sub !== 'sample') break;
      const now = nowText ? new Date(nowText) : new Date();
      if (Number.isNaN(now.getTime())) throw new Error(`--now is not a valid time: ${nowText}`);
      new SecretStore(config); // creates the volume layout
      const db = openDb(config.paths.db);
      try {
        migrateDb(db);
        if (!isDatabaseEmpty(db)) {
          process.stderr.write(
            'The database already has data; the sample seed only loads into an empty one.\n',
          );
          return 1;
        }
        const summary = loadSampleSeed(db, { now, docsDir: config.paths.docs });
        process.stdout.write(`Loaded the sample seed: ${describeSeed(summary)}\n`);
        return 0;
      } finally {
        db.sqlite.close();
      }
    }
    case undefined:
    case 'help':
    case '--help':
      process.stdout.write(`${USAGE}\n`);
      return 0;
  }
  process.stderr.write(`Unknown command: ${args.join(' ')}\n${USAGE}\n`);
  return 2;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`tasklite: ${(err as Error).message}\n`);
  process.exitCode = 1;
}
