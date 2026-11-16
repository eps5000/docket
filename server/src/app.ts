import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createApiApp, errorResponse } from './api/app.js';
import { allowedOriginsFor, bearerAuth, hostGuard, originGuard } from './api/guards.js';
import { uploadRoutes } from './api/routes/upload.js';
import { migrationStatus } from './db/client.js';
import type { Runtime } from './runtime.js';

export interface AppOptions {
  /** Directory holding the web build (index.html and assets/). */
  webRoot: string;
}

/** Paths owned by the server. They never fall back to the SPA. */
const SERVER_PREFIXES = ['/api', '/mcp', '/agent-upload', '/healthz', '/readyz'];

function isServerPath(path: string): boolean {
  return SERVER_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/** True when the last path segment looks like a file (`app.js`), not a client route. */
function looksLikeFile(path: string): boolean {
  const last = path.slice(path.lastIndexOf('/') + 1);
  return last.includes('.');
}

/** Write and remove a probe file: proves the directory is writable, not just present. */
async function checkWritable(dir: string): Promise<string> {
  const probe = join(dir, `.readyz-${randomUUID()}`);
  try {
    await writeFile(probe, '');
    await rm(probe, { force: true });
    return 'ok';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code ?? 'error';
  }
}

/** Take the write lock and write a row, then roll back: proves the database accepts writes. */
function checkDatabaseWritable(runtime: Runtime): string {
  const { sqlite } = runtime.db;
  try {
    sqlite
      .transaction(() => {
        const now = new Date().toISOString();
        sqlite
          .prepare(
            "INSERT INTO settings (key, value, created_at, updated_at) VALUES ('__readyz', 'null', ?, ?)",
          )
          .run(now, now);
        throw new RollbackProbe();
      })
      .immediate();
    return 'error';
  } catch (err) {
    if (err instanceof RollbackProbe) return 'ok';
    return (err as { code?: string }).code ?? 'error';
  }
}

class RollbackProbe extends Error {}

export function createApp(runtime: Runtime, { webRoot }: AppOptions): Hono {
  const { config } = runtime;
  const app = new Hono();

  // DNS-rebinding and cross-origin guards on everything except the liveness
  // probe, which the container healthcheck calls on its internal port.
  app.use('*', hostGuard(config.allowedHosts, { exempt: (path) => path === '/healthz' }));
  app.use('*', originGuard(allowedOriginsFor(config.allowedHosts)));

  // Liveness: the process is up and answering. Used by the compose healthcheck.
  app.get('/healthz', (c) => c.text('ok'));

  // Readiness: the volume, the database and the docs directory are writable,
  // and the database schema matches this build's migrations.
  app.get('/readyz', async (c) => {
    let migrations = 'error';
    try {
      migrations = migrationStatus(runtime.db).current ? 'ok' : 'pending';
    } catch {
      // Reported as 'error'.
    }
    const checks = {
      data_dir: await checkWritable(config.dataDir),
      database: checkDatabaseWritable(runtime),
      docs_dir: await checkWritable(config.paths.docs),
      migrations,
    };
    const ready = Object.values(checks).every((v) => v === 'ok');
    return c.json({ status: ready ? 'ready' : 'not_ready', checks }, ready ? 200 : 503);
  });

  // Agents: MCP over Streamable HTTP, behind the bearer token.
  app.use(
    '/mcp',
    bearerAuth(() => runtime.secrets.agentToken()),
  );
  app.all('/mcp', (c) => runtime.mcp.handle(c.req.raw));

  // Agents: bulk document upload (BUILD_SPEC §5.10), behind the same bearer token.
  app.use(
    '/agent-upload',
    bearerAuth(() => runtime.secrets.agentToken()),
  );
  const uploadApp = new Hono();
  uploadApp.onError((err, c) => errorResponse(c, err, runtime.log));
  uploadRoutes(uploadApp, { services: runtime.services, write: runtime.write, log: runtime.log });
  app.route('/', uploadApp);

  // The owner: the UI API, behind the owner session.
  app.route(
    '/api',
    createApiApp({
      db: runtime.db,
      write: runtime.write,
      sessions: runtime.sessions,
      services: runtime.services,
      bus: runtime.bus,
      streamKeepAliveMs: runtime.streamKeepAliveMs,
      log: runtime.log,
      agentToken: () => runtime.secrets.agentToken(),
    }),
  );

  // The web build. Hashed assets are immutable; index.html is always revalidated.
  app.use(
    '/assets/*',
    serveStatic({
      root: webRoot,
      onFound: (_path, c) => {
        c.header('Cache-Control', 'public, max-age=31536000, immutable');
      },
    }),
  );
  app.use('*', serveStatic({ root: webRoot }));

  // SPA fallback: unknown GET paths that look like client routes get index.html.
  app.get('*', async (c, next) => {
    if (isServerPath(c.req.path) || looksLikeFile(c.req.path)) return next();
    try {
      const html = await readFile(join(webRoot, 'index.html'), 'utf8');
      c.header('Cache-Control', 'no-cache');
      return c.html(html);
    } catch {
      return next();
    }
  });

  return app;
}
