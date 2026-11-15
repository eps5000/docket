/**
 * The service's moving parts, wired once: configuration and secrets, the
 * database (migrated), the write path and its change bus, owner sessions,
 * the domain services, the MCP hub and the call log. `index.ts` and the tests both build one.
 */
import { EventEmitter } from 'node:events';
import { SERVER_INSTRUCTIONS } from '@tasklite/shared';
import { OwnerSessions } from './api/session.js';
import { SecretStore, loadConfig, type Config } from './config.js';
import { migrateDb, openDb, type Db } from './db/client.js';
import type { Services } from './domain/contracts.js';
import { createServices, type ServiceOverrides } from './domain/services.js';
import { WritePath } from './domain/write.js';
import { CallLog } from './jobs/logs.js';
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
    sessions: new OwnerSessions({ db, secrets, clock }),
    services,
    mcp: new McpHub({
      version: APP_VERSION,
      clock,
      instructions: SERVER_INSTRUCTIONS,
      // Each new MCP session's server gets all 36 tools (MCP_SPEC §5).
      configure: (server, session) => registerTools(server, { runtime, session, handlers }),
    }),
    callLog,
    clock,
    streamKeepAliveMs: opts.streamKeepAliveMs,
    log,
    async close() {
      if (closed) return;
      closed = true;
      bus.emit('close');
      await this.mcp.close();
      db.sqlite.close();
    },
  };
  return runtime;
}
