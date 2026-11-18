/**
 * The MCP endpoint (MCP_SPEC §1; BUILD_SPEC §3).
 *
 * - Streamable HTTP at `/mcp` with stateful sessions (`Mcp-Session-Id`):
 *   POST for requests, GET for the server→client stream, DELETE to end.
 * - Bearer auth and the Host/Origin guards run before this (api/guards.ts).
 * - Server info: `name: "docket"`, `version` = the app version.
 * - Identity: `clientInfo.name` from `initialize`, normalised (contains
 *   codex → `codex`; contains claude → `claude`; else as is). Each session's
 *   ID and client are recorded here, so tools (B3) can bind runs to the
 *   session that started them (MCP_SPEC §9).
 *
 * - The server→client stream (`GET`, one per session): the hub tracks which
 *   sessions hold one open, so the sweeper can ping them every 60 s (an
 *   answered ping is a *session* signal, BUILD_SPEC §5.4). A session without
 *   a stream can't be pinged, and its runs can only show *reported*.
 *
 * - Result mode (MCP_SPEC §3 Results; owner decision 28): decided once, at
 *   `initialize`. A session whose `clientInfo.name` is in
 *   DOCKET_TEXT_ONLY_CLIENTS (exact, ignoring case) is `text`: its
 *   `tools/list` has no `outputSchema` and its results no
 *   `structuredContent`, so the model reads the compact text. Every other
 *   session is `structured`.
 *
 * - Capabilities: `tools` and `prompts`, each with `listChanged: false`; no
 *   resources. `initialize` returns the server instructions (MCP_SPEC §2).
 *   The tools and the `onboard` prompt (decision 31) are registered by
 *   `configure` (mcp/register.ts, mcp/prompts.ts).
 */
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { EmptyResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { resultMode, type ResultMode } from '../domain/compat.js';

export type { ResultMode };

export const SERVER_NAME = 'docket';

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
  /** Decided at `initialize`; `structured` until then. */
  result_mode: ResultMode;
  started_at: string;
  last_seen_at: string;
}

interface Entry {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  info: McpSessionInfo;
  /** Open `GET` streams (the transport allows one at a time). */
  streams: number;
}

export interface McpHubOptions {
  version: string;
  clock?: () => Date;
  /** Returned as `instructions` in the `initialize` result (MCP_SPEC §2). */
  instructions?: string;
  /** Lower-cased `clientInfo.name`s whose sessions get text-only results (config). */
  textOnlyClients?: readonly string[];
  /** Called for each new server, before it connects; registers the tools. */
  configure?: (server: McpServer, session: () => McpSessionInfo | undefined) => void;
}

const jsonRpcError = (status: number, code: number, message: string) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const isEventStream = (res: Response) =>
  (res.headers.get('content-type') ?? '').includes('text/event-stream');

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

  /** Whether the session holds an open server→client (`GET`) stream. */
  hasStream(sessionId: string): boolean {
    return (this.entries.get(sessionId)?.streams ?? 0) > 0;
  }

  /**
   * Ping a session over its `GET` stream (MCP `ping`). True when the client
   * answered within `timeoutMs`; false without a stream, on error or timeout.
   */
  async ping(sessionId: string, timeoutMs: number): Promise<boolean> {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.streams === 0) return false;
    try {
      await entry.server.server.request({ method: 'ping' }, EmptyResultSchema, {
        timeout: timeoutMs,
      });
      entry.info.last_seen_at = this.clock().toISOString();
      return true;
    } catch {
      return false;
    }
  }

  async handle(req: Request): Promise<Response> {
    const sessionId = req.headers.get('mcp-session-id');
    if (sessionId) {
      const entry = this.entries.get(sessionId);
      if (!entry) return jsonRpcError(404, -32001, 'Session not found; initialize a new session.');
      entry.info.last_seen_at = this.clock().toISOString();
      const res = await entry.transport.handleRequest(req);
      if (req.method === 'GET' && res.ok && res.body && isEventStream(res)) {
        return this.track(entry, res);
      }
      return res;
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
      result_mode: 'structured',
      started_at: now,
      last_seen_at: now,
    };
    // Capabilities are declared by `configure` (registerTools): McpServer's own
    // tool handling would force `listChanged: true`.
    const server = new McpServer(
      { name: SERVER_NAME, version: this.opts.version },
      this.opts.instructions !== undefined ? { instructions: this.opts.instructions } : {},
    );
    let entry: Entry | undefined;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        info.session_id = id;
        entry = { transport, server, info, streams: 0 };
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
      info.result_mode = resultMode(clientInfo.name, this.opts.textOnlyClients ?? []);
    }
    // Not an initialize request: nothing to keep.
    if (!entry) await server.close();
    return res;
  }

  /** Count the stream as open until the client goes away or the server ends it. */
  private track(entry: Entry, res: Response): Response {
    entry.streams += 1;
    let open = true;
    const done = () => {
      if (open) {
        open = false;
        entry.streams = Math.max(0, entry.streams - 1);
      }
    };
    const reader = res.body!.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            done();
            controller.close();
          } else {
            controller.enqueue(chunk.value);
          }
        } catch (err) {
          done();
          controller.error(err);
        }
      },
      cancel(reason) {
        done();
        return reader.cancel(reason);
      },
    });
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }

  async close(): Promise<void> {
    const servers = [...this.entries.values()].map((e) => e.server);
    this.entries.clear();
    await Promise.allSettled(servers.map((s) => s.close()));
  }
}
