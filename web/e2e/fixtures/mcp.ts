/**
 * The MCP client helper (tasks.md T062): drive agent actions from browser
 * tests with the official SDK client over Streamable HTTP at `/mcp`, using
 * the agent bearer token. Each helper is one MCP session, so it has its own
 * `clientInfo` (and so its own identity, BUILD_SPEC owner decision 16).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { baseURL } from '../container';
import { agentToken } from './container';

export interface ToolCallResult {
  isError: boolean;
  /** `structuredContent`: the tool's result, or the ToolError `{code, message}` when `isError`. */
  structured: Record<string, unknown>;
  /** The compact text rendering. */
  text: string;
}

export interface McpAgent {
  client: Client;
  /** Call a tool; never throws for tool errors (they come back with `isError`). */
  call(name: string, args?: Record<string, unknown>): Promise<ToolCallResult>;
  listTools(): Promise<string[]>;
  close(): Promise<void>;
}

/** A valid `ask_owner` question (decision 47), synthetic, with the given sentence. */
export const askForm = (question: string) => ({
  question,
  context: 'The planner can remember the week you were looking at in two different places.',
  why_it_matters: 'It decides whether a shared link and a page reload keep your place.',
  options: [
    {
      label: 'In the URL',
      description: 'The week is part of the page address.',
      consequences: 'Reloads and shared links keep the week, but the address gets longer.',
      recommended: true,
    },
    {
      label: 'In this browser',
      description: 'The browser remembers the week.',
      consequences: 'The address stays short, but a shared link opens on the current week.',
    },
  ],
  recommendation_reason: 'People expect a link they share to open on what they were seeing.',
});

/** Connect as an agent named `name` (e.g. `codex`), optionally with a version. */
export async function connectAgent(name = 'e2e-agent', version = '0.0.0'): Promise<McpAgent> {
  const client = new Client({ name, version });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseURL), {
    requestInit: { headers: { Authorization: `Bearer ${agentToken()}` } },
  });
  await client.connect(transport);
  return {
    client,
    async call(tool, args = {}) {
      const res = (await client.callTool({ name: tool, arguments: args })) as {
        isError?: boolean;
        structuredContent?: Record<string, unknown>;
        content?: { type: string; text?: string }[];
      };
      return {
        isError: res.isError === true,
        structured: res.structuredContent ?? {},
        text: (res.content ?? [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('\n'),
      };
    },
    async listTools() {
      const { tools } = await client.listTools();
      return tools.map((t) => t.name);
    },
    async close() {
      await client.close();
    },
  };
}
