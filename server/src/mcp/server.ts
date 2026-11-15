/**
 * The MCP endpoint (MCP_SPEC §1; BUILD_SPEC §3).
 *
 * - Streamable HTTP at `/mcp` with stateful sessions (`Mcp-Session-Id`):
 *   POST for requests, GET for the server→client stream, DELETE to end.
 * - Bearer auth and the Host/Origin guards run before this (api/guards.ts).
 * - Server info: `name: "tasklite"`, `version` = the app version.
 * - Identity: `clientInfo.name` from `initialize`, normalised (contains
 *   codex → `codex`; contains claude → `claude`; else as is). Each session's
 *   ID and client are recorded here, so tools (B3) can bind runs to the
 *   session that started them (MCP_SPEC §9).
 *
 * Tools, their schemas and the server instructions arrive in B3 (Phase 3a).
 */
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

export const SERVER_NAME = 'tasklite';

/** Normalise `clientInfo.name` (BUILD_SPEC §3). */
export function normaliseClientName(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  const lower = trimmed.toLowerCase();
  if (lower.includes('codex')) return 'codex';
  if (lower.includes('claude')) return 'claude';
  return trimmed || 'unknown';
}

export interface McpSessionInfo {
  session_id: string;
  /** Normalised client name. */
  client: string;
  client_name: string | null;
  client_version: string | null;
  started_at: string;
  last_seen_at: string;
}

interface Entry {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  info: McpSessionInfo;
}

export interface McpHubOptions {
  version: string;
  clock?: () => Date;
  /** Called for each new server, before it connects; B3 registers tools here. */
  configure?: (server: McpServer, session: () => McpSessionInfo | undefined) => void;
}

const jsonRpcError = (status: number, code: number, message: string) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export class McpHub {
  private readonly entries = new Map<string, Entry>();
  private readonly clock: () => Date;

  constructor(private readonly opts: McpHubOptions) {
    this.clock = opts.clock ?? (() => new Date());
  }

  /** The recorded identity of a live session. */
  session(sessionId: string): McpSessionInfo | undefined {
    return this.entries.get(sessionId)?.info;
  }

  sessions(): McpSessionInfo[] {
    return [...this.entries.values()].map((e) => e.info);
  }

  async handle(req: Request): Promise<Response> {
    const sessionId = req.headers.get('mcp-session-id');
    if (sessionId) {
      const entry = this.entries.get(sessionId);
      if (!entry) return jsonRpcError(404, -32001, 'Session not found; initialize a new session.');
      entry.info.last_seen_at = this.clock().toISOString();
      return entry.transport.handleRequest(req);
    }
    if (req.method !== 'POST') {
      return jsonRpcError(400, -32000, 'Bad request: no Mcp-Session-Id; initialize first.');
    }
    return this.initialize(req);
  }

  private async initialize(req: Request): Promise<Response> {
    const now = this.clock().toISOString();
    const info: McpSessionInfo = {
      session_id: '',
      client: 'unknown',
      client_name: null,
      client_version: null,
      started_at: now,
      last_seen_at: now,
    };
    const server = new McpServer({ name: SERVER_NAME, version: this.opts.version });
    let entry: Entry | undefined;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        info.session_id = id;
        entry = { transport, server, info };
        this.entries.set(id, entry);
      },
      onsessionclosed: (id) => {
        this.entries.delete(id);
      },
    });
    transport.onclose = () => {
      if (info.session_id) this.entries.delete(info.session_id);
    };
    this.opts.configure?.(server, () => (info.session_id ? info : undefined));
    await server.connect(transport);

    const res = await transport.handleRequest(req);
    const clientInfo = server.server.getClientVersion();
    if (entry && clientInfo) {
      info.client_name = clientInfo.name;
      info.client_version = clientInfo.version;
      info.client = normaliseClientName(clientInfo.name);
    }
    // Not an initialize request: nothing to keep.
    if (!entry) await server.close();
    return res;
  }

  async close(): Promise<void> {
    const servers = [...this.entries.values()].map((e) => e.server);
    this.entries.clear();
    await Promise.allSettled(servers.map((s) => s.close()));
  }
}
