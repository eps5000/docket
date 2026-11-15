import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { createApp } from '../../src/app.js';
import type { ToolHandlers } from '../../src/mcp/register.js';
import { createRuntime, type Runtime } from '../../src/runtime.js';
import { TestClock, tempDir } from '../helpers.js';

export const ORIGIN = 'http://127.0.0.1:7420';

export interface TestServer {
  app: Hono;
  runtime: Runtime;
  clock: TestClock;
  dataDir: string;
  /** `app.request` with an absolute URL on the allowed host. */
  request(path: string, init?: RequestInit): Promise<Response>;
  cleanup(): Promise<void>;
}

export function createTestServer(
  opts: {
    env?: Record<string, string>;
    keepAliveMs?: number;
    clock?: TestClock;
    toolHandlers?: Partial<ToolHandlers>;
  } = {},
): TestServer {
  const tmp = tempDir('tasklite-int-');
  const dataDir = join(tmp.dir, 'data');
  const webRoot = join(tmp.dir, 'web');
  mkdirSync(dataDir);
  mkdirSync(webRoot);
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Task Lite</title>');
  const clock = opts.clock ?? new TestClock();
  const runtime = createRuntime({
    dataDir,
    env: opts.env ?? {},
    clock: clock.now,
    streamKeepAliveMs: opts.keepAliveMs,
    toolHandlers: opts.toolHandlers,
  });
  const app = createApp(runtime, { webRoot });
  return {
    app,
    runtime,
    clock,
    dataDir,
    request: (path, init) => Promise.resolve(app.request(`${ORIGIN}${path}`, init)),
    cleanup: async () => {
      await runtime.close();
      tmp.cleanup();
    },
  };
}

export function initializeBody(clientName = 'claude-code', id = 1) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: clientName, version: '1.0.0' },
    },
  });
}

export const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

/** All Set-Cookie headers of a response, parsed into name → {value, attributes}. */
export function parseSetCookies(
  res: Response,
): Record<string, { value: string; attributes: string[] }> {
  const out: Record<string, { value: string; attributes: string[] }> = {};
  for (const header of res.headers.getSetCookie()) {
    const [pair, ...attributes] = header.split(';').map((s) => s.trim());
    const eq = pair!.indexOf('=');
    out[pair!.slice(0, eq)] = { value: pair!.slice(eq + 1), attributes };
  }
  return out;
}

/** Read from a streaming body until `predicate` matches the text so far, or the timeout passes. */
export async function readUntil(
  res: Response,
  predicate: (text: string) => boolean,
  timeoutMs = 2_000,
): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (!predicate(text)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
      ]);
      if (chunk === null || chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text;
}
