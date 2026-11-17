/**
 * Tool registration (MCP_SPEC §3, §6, §9; tasks.md T040). One helper wires
 * every tool the same way, so handlers only implement behaviour:
 *
 * - `tools/list`: name, the MCP_SPEC description (mcp-copy.ts), the input and
 *   output JSON Schema generated from the shared zod schemas, annotations.
 * - `tools/call`:
 *   1. validate the arguments against the zod schema; a bad call gets a
 *      `validation` ToolError, even from a stub;
 *   2. the `run_id` signal hook: resume the run if it is parked (US11),
 *      classify the signal (session or report), record it and renew the
 *      lead lease;
 *   3. run the handler, which calls the domain services (domain/contracts.ts);
 *      a service that is still a stub answers `unavailable` "Not implemented
 *      yet: <tool>". Mutating handlers write through `ctx.mutate`, which
 *      applies the call's idempotency key (replay → `replayed: true`; same
 *      key, different arguments → `validation`);
 *   4. add the write path's warnings (MCP_SPEC §3.4) to the result, check
 *      the result against the output schema (a mismatch is a bug:
 *      `internal`), then return `structuredContent` plus the compact text;
 *   5. errors become `isError` results carrying the ToolError (§6);
 *   6. one call-log line per call: never the arguments.
 *
 * Text-only sessions (MCP_SPEC §3 Results; owner decision 28; server.ts
 * `resultMode`) get the same tools without `outputSchema`, and results
 * without `structuredContent`: the text block alone, `isError` as usual.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  ToolError,
  getTool,
  inputJsonSchema,
  outputJsonSchema,
  renderError,
  renderResult,
  toolAnnotations,
  TOOL_DESCRIPTIONS,
  TOOLS,
  validationError,
  type AnyToolDef,
  type ErrorCode as ToolErrorCode,
  type SignalKind,
  type ToolInput,
  type ToolName,
  type ToolOutput,
} from '@tasklite/shared';
import {
  isNotImplemented,
  readContext,
  type ReadContext,
  type Services,
} from '../domain/contracts.js';
import { newId } from '../domain/ids.js';
import { mapDbError, type Actor, type WriteContext } from '../domain/write.js';
import type { Runtime } from '../runtime.js';
import type { McpSessionInfo, ResultMode } from './server.js';

// ---- Handlers ----

/** The `run_id` a call carried, and how it counts (BUILD_SPEC §5.4; MCP_SPEC §9). */
export interface RunSignal {
  run_id: string;
  /** `session` when the call comes from the session that started the run; otherwise `report`. */
  kind: SignalKind;
  /** Whether the run exists. Unknown runs are left to the handler (US1: `not_found` or `conflict`). */
  known: boolean;
}

export interface ToolContext {
  readonly tool: AnyToolDef;
  readonly runtime: Runtime;
  /** The calling MCP session (identity from `initialize`). */
  readonly session: McpSessionInfo | undefined;
  /** The caller as an event actor: the session's client, `agent_label` if given, session and run. */
  readonly actor: Actor;
  readonly signal: RunSignal | null;
  readonly now: Date;
  /** The domain services (domain/contracts.ts): handlers call only these. */
  readonly services: Services;
  /** A read context for this call: the database, the caller and the time. */
  readonly read: ReadContext;
  /**
   * Run `fn` as this call's mutation, through the one write path: secret
   * checks, one transaction, events, and the call's `idempotency_key`.
   * Mutating tools only.
   */
  mutate<T>(fn: (w: WriteContext) => T): T;
}

export type ToolHandler<N extends ToolName> = (
  args: ToolInput<N>,
  ctx: ToolContext,
) => ToolOutput<N> | Promise<ToolOutput<N>>;

export type ToolHandlers = { [N in ToolName]: ToolHandler<N> };

/** A tool's arguments as a service takes them: the idempotency key belongs to the write path. */
export function serviceArgs<T extends object>(args: T): Omit<T, 'idempotency_key'> {
  return omit(args as T & { idempotency_key?: unknown }, 'idempotency_key');
}

/** `obj` without `keys`. */
export function omit<T extends object, K extends keyof T>(obj: T, ...keys: K[]): Omit<T, K> {
  const out = { ...obj };
  for (const key of keys) delete out[key];
  return out;
}

/** The message every stub returns until its slice implements it. */
export const notImplementedMessage = (name: ToolName) => `Not implemented yet: ${name}`;

/** A stub handler: `unavailable`, "Not implemented yet: <tool>" (tasks.md T041). */
export function notImplemented<N extends ToolName>(name: N): ToolHandler<N> {
  return () => {
    throw new ToolError('unavailable', notImplementedMessage(name));
  };
}

// ---- tools/list ----

/** The `tools/list` entries, in MCP_SPEC §5 order. Built once: the contract is static. */
export const TOOL_LIST: Tool[] = TOOLS.map((tool) => ({
  name: tool.name,
  description: TOOL_DESCRIPTIONS[tool.name],
  inputSchema: inputJsonSchema(tool) as Tool['inputSchema'],
  outputSchema: outputJsonSchema(tool) as Tool['outputSchema'],
  annotations: toolAnnotations(tool),
}));

/** The same entries for text-only sessions: everything but `outputSchema` (MCP_SPEC §3 Results). */
export const TOOL_LIST_TEXT_ONLY: Tool[] = TOOL_LIST.map((tool) => omit(tool, 'outputSchema'));

/** The `tools/list` entries for a result mode. */
export const toolList = (mode: ResultMode): Tool[] =>
  mode === 'text' ? TOOL_LIST_TEXT_ONLY : TOOL_LIST;

// ---- The run signal hook ----

/**
 * Classify the `run_id` a call carries (BUILD_SPEC §5.4; MCP_SPEC §9). A
 * *session* signal needs the call's MCP session to be the run's, and that
 * session to hold its server→client (`GET`) stream open: only then can the
 * server ping it, so only then may the run show *live* (verification V1).
 * Anything else is *report*. `callTool` then records the signal, which
 * renews the lead lease (`runs.recordSignal`).
 */
export function runSignal(
  runtime: Runtime,
  runId: string,
  session: McpSessionInfo | undefined,
): RunSignal {
  const row = runtime.db.sqlite.prepare('SELECT session_id FROM runs WHERE id = ?').get(runId) as
    { session_id: string | null } | undefined;
  const sameSession = !!row && !!session?.session_id && row.session_id === session.session_id;
  const live = sameSession && runtime.mcp.hasStream(session!.session_id);
  return { run_id: runId, kind: live ? 'session' : 'report', known: !!row };
}

/**
 * Resume a parked run (BUILD_SPEC §5.16): state back to open, lease renewed,
 * `run.resumed`. A mutation of its own through the write path, before the
 * call's own handler, so the handler sees a running run. A call naming a run
 * that isn't parked writes nothing.
 */
export function resumeIfParked(runtime: Runtime, actor: Actor, runId: string): void {
  const row = runtime.db.sqlite.prepare('SELECT state FROM runs WHERE id = ?').get(runId) as
    { state: string } | undefined;
  if (row?.state !== 'parked') return;
  runtime.write.run({ actor, operation: 'run.resume', args: { run_id: runId } }, (w) =>
    runtime.services.runs.resume(w, { run_id: runId }),
  );
}

// ---- tools/call ----

export interface RegisterOptions {
  runtime: Runtime;
  session: () => McpSessionInfo | undefined;
  handlers: ToolHandlers;
}

function toolResult(
  mode: ResultMode,
  text: string,
  structured: Record<string, unknown>,
  isError = false,
): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    // Text-only sessions read the compact text alone (MCP_SPEC §3 Results).
    ...(mode === 'structured' ? { structuredContent: structured } : {}),
    ...(isError ? { isError: true } : {}),
  };
}

function errorResult(mode: ResultMode, err: ToolError): CallToolResult {
  const shape = err.toJSON();
  return toolResult(mode, renderError(shape), shape as unknown as Record<string, unknown>, true);
}

/** Execute one tool call. Exported for unit tests; `registerTools` wires it to MCP. */
export async function callTool(
  opts: RegisterOptions,
  name: string,
  rawArgs: unknown,
): Promise<CallToolResult> {
  const tool = getTool(name);
  if (!tool) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
  const { runtime } = opts;
  const started = performance.now();
  const session = opts.session();
  const mode: ResultMode = session?.result_mode ?? 'structured';
  let label: string | null = null;
  let runId: string | null = null;
  let code: 'ok' | ToolErrorCode = 'ok';
  try {
    const parsed = tool.input.safeParse(rawArgs ?? {});
    if (!parsed.success) throw validationError(tool.name, tool.input, parsed.error);
    const args = parsed.data as Record<string, unknown>;
    label = typeof args.agent_label === 'string' ? args.agent_label : null;
    runId = typeof args.run_id === 'string' ? args.run_id : null;

    const now = runtime.clock();
    const actor: Actor = {
      kind: 'agent',
      client: session?.client ?? 'unknown',
      label,
      session_id: session?.session_id ?? null,
      run_id: runId,
    };
    let replayed = false;
    const warnings: string[] = [];
    const read = readContext(runtime.db, actor, now);
    const signal = runId ? runSignal(runtime, runId, session) : null;
    // Every call naming a known run is a signal (BUILD_SPEC §5.4): it renews the lead lease.
    if (signal?.known) {
      // A parked run resumes on any later call naming it (§5.16); park_run itself re-parks.
      if (tool.name !== 'park_run') resumeIfParked(runtime, actor, signal.run_id);
      runtime.services.runs.recordSignal(read, {
        run_id: signal.run_id,
        kind: signal.kind,
        session_id: session?.session_id ?? null,
      });
    }
    const ctx: ToolContext = {
      tool,
      runtime,
      session,
      actor,
      signal,
      now,
      services: runtime.services,
      read,
      mutate: (fn) => {
        if (tool.kind !== 'mutating') throw new Error(`${tool.name} is not a mutating tool`);
        const { idempotency_key: key, ...hashed } = args;
        const out = runtime.write.run(
          {
            actor,
            operation: tool.name,
            args: hashed,
            idempotencyKey: typeof key === 'string' ? key : null,
          },
          fn,
        );
        replayed ||= out.replayed;
        for (const w of out.warnings) if (!warnings.includes(w)) warnings.push(w);
        return out.result;
      },
    };

    const handler = opts.handlers[tool.name] as ToolHandler<ToolName>;
    let result = await handler(args as never, ctx);
    if (warnings.length > 0) {
      // Write-check warnings (§3.4) join any the service gave (`finish_run`'s).
      const own = (result as { warnings?: string[] }).warnings ?? [];
      result = { ...result, warnings: [...own, ...warnings.filter((w) => !own.includes(w))] };
    }
    const checked = tool.output.safeParse(result);
    if (!checked.success) {
      throw internal(
        runtime,
        tool.name,
        new Error(`result does not match the output schema: ${checked.error.message}`),
      );
    }
    const structured = { ...(checked.data as Record<string, unknown>) };
    if (replayed) structured.replayed = true;
    return toolResult(mode, renderResult(tool.name, structured, { args, now }), structured);
  } catch (raw) {
    if (raw instanceof McpError) throw raw;
    // A service that is still a stub: "Not implemented yet: <tool>" (tasks.md T041, T048).
    const mapped = isNotImplemented(raw)
      ? new ToolError('unavailable', notImplementedMessage(tool.name))
      : mapDbError(raw);
    const err = mapped instanceof ToolError ? mapped : internal(runtime, tool.name, mapped);
    code = err.code;
    return errorResult(mode, err);
  } finally {
    try {
      runtime.callLog.record({
        tool: tool.name,
        client: session?.client ?? null,
        label,
        run: runId,
        duration_ms: performance.now() - started,
        result: code,
      });
    } catch (logErr) {
      runtime.log(`call log write failed: ${(logErr as Error).message}`);
    }
  }
}

/** An `internal` ToolError with a reference that is logged (never the arguments). */
function internal(runtime: Runtime, tool: string, cause: unknown): ToolError {
  const ref = newId('e', runtime.clock().getTime());
  const message = cause instanceof Error ? cause.message : String(cause);
  runtime.log(`mcp ${tool} internal error ${ref}: ${message}`);
  return new ToolError('internal', `Unexpected error (ref ${ref}). It has been logged.`, {
    details: { ref },
  });
}

/** Register all 38 tools on a session's server (the McpHub `configure` hook). */
export function registerTools(server: McpServer, opts: RegisterOptions): void {
  // The tool list is fixed for the life of the server (MCP_SPEC §1). Declared
  // on the low-level server, before connect: McpServer's own tool registration
  // would advertise `listChanged: true`.
  server.server.registerCapabilities({ tools: { listChanged: false } });
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: toolList(opts.session()?.result_mode ?? 'structured'),
  }));
  server.server.setRequestHandler(CallToolRequestSchema, (request) =>
    callTool(opts, request.params.name, request.params.arguments),
  );
}
