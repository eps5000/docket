/**
 * MCP prompts (MCP_SPEC §1, §5.11; owner decision 31; tasks.md T163).
 *
 * The server's one prompt, `onboard`, offers the onboarding guide to clients
 * that support prompts; `onboard_project` returns the same guide to those
 * that don't.
 *
 * - `prompts/list`: each prompt's name, description and arguments, from
 *   mcp-copy.ts (MCP_SPEC §5.11 verbatim). The list is fixed for the life of
 *   the server, so the capability is `prompts: { listChanged: false }`.
 * - `prompts/get`: the arguments are checked against the shared schema (a
 *   missing or malformed `project_key`, an unknown argument, or an unknown
 *   prompt is a JSON-RPC `InvalidParams` error), then the guide comes from
 *   the `onboarding` service (domain/contracts.ts), as one user message.
 *   While that service is a stub, the message is "Onboarding guide not
 *   available yet" (B29); US15 (T164) fills it in.
 * - Result modes (decision 28) don't apply: a prompt's messages are text in
 *   both modes (MCP_SPEC §3 Results).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  McpError,
  type GetPromptResult,
  type Prompt,
} from '@modelcontextprotocol/sdk/types.js';
import {
  ONBOARD_PROMPT_STUB,
  PROMPTS,
  ToolError,
  onboardPromptArgs,
  validationError,
} from '@docket/shared';
import { isNotImplemented, readContext } from '../domain/contracts.js';
import type { Actor } from '../domain/write.js';
import type { Runtime } from '../runtime.js';
import type { McpSessionInfo } from './server.js';

/** The `prompts/list` entries, in MCP_SPEC §5.11 order. */
export const PROMPT_LIST: Prompt[] = PROMPTS.map((p) => ({
  name: p.name,
  description: p.description,
  arguments: p.arguments.map((a) => ({ ...a })),
}));

export interface PromptOptions {
  runtime: Runtime;
  session: () => McpSessionInfo | undefined;
}

/** Answer one `prompts/get`. Exported for unit tests; `registerPrompts` wires it to MCP. */
export function getPrompt(
  opts: PromptOptions,
  name: string,
  rawArgs: Record<string, string> | undefined,
): GetPromptResult {
  const prompt = PROMPTS.find((p) => p.name === name);
  if (!prompt) throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
  const parsed = onboardPromptArgs.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    throw new McpError(
      ErrorCode.InvalidParams,
      validationError(`prompt ${name}`, onboardPromptArgs, parsed.error).message,
    );
  }
  const { runtime } = opts;
  const session = opts.session();
  const actor: Actor = {
    kind: 'agent',
    client: session?.client ?? 'unknown',
    label: null,
    session_id: session?.session_id ?? null,
    run_id: null,
  };
  let text: string;
  try {
    text = runtime.services.onboarding.guide(
      readContext(runtime.db, actor, runtime.clock()),
      parsed.data,
    );
  } catch (err) {
    if (isNotImplemented(err)) {
      text = ONBOARD_PROMPT_STUB;
    } else if (err instanceof ToolError) {
      const code =
        err.code === 'validation' || err.code === 'not_found'
          ? ErrorCode.InvalidParams
          : ErrorCode.InternalError;
      throw new McpError(code, err.message);
    } else {
      throw err;
    }
  }
  return {
    description: prompt.description,
    messages: [{ role: 'user', content: { type: 'text', text } }],
  };
}

/** Declare the prompts capability and answer `prompts/list` and `prompts/get` (before connect). */
export function registerPrompts(server: McpServer, opts: PromptOptions): void {
  // Declared on the low-level server, as for tools: McpServer's own prompt
  // registration would advertise `listChanged: true`.
  server.server.registerCapabilities({ prompts: { listChanged: false } });
  server.server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: PROMPT_LIST }));
  server.server.setRequestHandler(GetPromptRequestSchema, (request) =>
    getPrompt(opts, request.params.name, request.params.arguments),
  );
}
