/**
 * The service's moving parts, wired once: configuration and secrets, the
 * database (migrated), the write path and its change bus, owner sessions,
 * the domain services, the MCP hub and the call log. `index.ts` and the tests both build one.
 */
import { EventEmitter } from 'node:events';
import { SERVER_INSTRUCTIONS } from '@docket/shared';
import { OwnerSessions } from './api/session.js';
import { SecretStore, loadConfig, type Config } from './config.js';
import { migrateDb, openDb, type Db } from './db/client.js';
import { ChangeWaiters } from './domain/change-wait.js';
import type { Services } from './domain/contracts.js';
import { createServices, type ServiceOverrides } from './domain/services.js';
import { WritePath } from './domain/write.js';
import { CallLog } from './jobs/logs.js';
import { registerPrompts } from './mcp/prompts.js';
import { registerTools, type ToolHandlers } from './mcp/register.js';
import { McpHub } from './mcp/server.js';
import { TOOL_HANDLERS } from './mcp/tools/index.js';
import { APP_VERSION } from './version.js';

export interface RuntimeOptions {
  /** The data volume; `/data` in the container. */
  dataDir?: string;
  env?: Record<string, string | undefined>;
  clock?: () => Date;
  streamKeepAliveMs?: number;
  log?: (line: string) => void;
  /** Replace tool handlers (tests only); the rest keep their real handlers. */
  toolHandlers?: Partial<ToolHandlers>;
  /** Replace service methods (tests only); the rest keep their real implementations. */
  services?: ServiceOverrides;
}

export interface Runtime {
  config: Config;
  secrets: SecretStore;
  db: Db;
  /** Emits `change` (seq numbers) after each commit, and `close` on shutdown. */
  bus: EventEmitter;
  write: WritePath;
  /** Clients waiting on the change feed (decision 40). */
  changes: ChangeWaiters;
  sessions: OwnerSessions;
  /** The domain services (contracts.ts): both adapters call only these. */
  services: Services;
  mcp: McpHub;
  callLog: CallLog;
  clock: () => Date;
  streamKeepAliveMs?: number;
  log: (line: string) => void;
  close(): Promise<void>;
}

export function createRuntime(opts: RuntimeOptions = {}): Runtime {
  const clock = opts.clock ?? (() => new Date());
  const log = opts.log ?? ((line: string) => console.log(line));
  const config = loadConfig(opts.env ?? process.env, { dataDir: opts.dataDir });
  // Old TASKLITE_* settings still work, with one warning per key and never a value (B28).
  for (const warning of config.deprecations) log(`Warning: ${warning}`);
  if (config.legacyDbFile) {
    log(
      `Using the database file ${config.paths.db}, from before the rename to Docket; it is kept as it is.`,
    );
  }
  const secrets = new SecretStore(config);
  const db = openDb(config.paths.db);
  migrateDb(db);

  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  const write = new WritePath({
    db,
    clock,
    knownSecrets: () => secrets.known(),
    onCommit: (seqs) => bus.emit('change', seqs),
  });

  const callLog = new CallLog({ dir: config.paths.logs, clock });
  const services = createServices({ config, secrets, callLog, clock, log }, opts.services);

  let closed = false;
  const handlers = { ...TOOL_HANDLERS, ...opts.toolHandlers } as ToolHandlers;
  const runtime: Runtime = {
    config,
    secrets,
    db,
    bus,
    write,
    changes: new ChangeWaiters(db, bus),
    sessions: new OwnerSessions({ db, secrets, clock }),
    services,
    mcp: new McpHub({
      version: APP_VERSION,
      clock,
      instructions: SERVER_INSTRUCTIONS,
      textOnlyClients: config.textOnlyClients,
      // Each new MCP session's server gets all 51 tools (MCP_SPEC §5) and the
      // onboard prompt (§5.11).
      configure: (server, session) => {
        registerTools(server, { runtime, session, handlers });
        registerPrompts(server, { runtime, session });
      },
    }),
    callLog,
    clock,
    streamKeepAliveMs: opts.streamKeepAliveMs,
    log,
    async close() {
      if (closed) return;
      closed = true;
      bus.emit('close');
      // B52: in-flight git stops before the database it would write to closes.
      await services.sharedChanges.stopRadar();
      await this.mcp.close();
      db.sqlite.close();
    },
  };
  return runtime;
}
