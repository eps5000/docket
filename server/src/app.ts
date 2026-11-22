import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { createApiApp, errorResponse } from './api/app.js';
import { allowedOriginsFor, bearerAuth, hostGuard, originGuard } from './api/guards.js';
import { SESSION_COOKIE, ensureLocalCsrfCookie } from './api/session.js';
import { changesWait } from './api/routes/agent-wait.js';
import { installRoutes } from './api/routes/install.js';
import { uploadRoutes } from './api/routes/upload.js';
import { migrationStatus } from './db/client.js';
import type { Runtime } from './runtime.js';

export interface AppOptions {
  /** Directory holding the web build (index.html and assets/). */
  webRoot: string;
}

/** Paths owned by the server. They never fall back to the SPA. */
const SERVER_PREFIXES = [
  '/api',
  '/mcp',
  '/agent',
  '/agent-upload',
  '/install',
  '/healthz',
  '/readyz',
];

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

  // Agents: MCP over Streamable HTTP. Protected mode puts it behind the bearer token;
  // local trust (decision 32) needs none and ignores one if sent.
  if (config.protectedMode) {
    app.use(
      '/mcp',
      bearerAuth(() => runtime.secrets.agentToken()),
    );
  }
  app.all('/mcp', (c) => runtime.mcp.handle(c.req.raw));

  // Agents: wait on the change feed (decision 40), behind the same rule as /mcp.
  if (config.protectedMode) {
    app.use(
      '/agent/*',
      bearerAuth(() => runtime.secrets.agentToken()),
    );
  }
  app.get('/agent/changes/wait', (c) => changesWait(runtime, c));

  // Agents: bulk document upload (BUILD_SPEC §5.10), behind the same rule as /mcp.
  if (config.protectedMode) {
    app.use(
      '/agent-upload',
      bearerAuth(() => runtime.secrets.agentToken()),
    );
  }
  const uploadApp = new Hono();
  uploadApp.onError((err, c) => errorResponse(c, err, runtime.log));
  uploadRoutes(uploadApp, { services: runtime.services, write: runtime.write, log: runtime.log });
  app.route('/', uploadApp);

  // The install bundle (decision 29, BUILD_SPEC §5.17): no session or bearer; the
  // single-use token in the path is the credential, behind the Host and Origin guards above.
  const installApp = new Hono();
  installApp.onError((err, c) => errorResponse(c, err, runtime.log));
  installRoutes(installApp, { services: runtime.services, write: runtime.write, log: runtime.log });
  app.route('/', installApp);

  // The owner: the UI API, behind the owner session.
  app.route(
    '/api',
    createApiApp({
      db: runtime.db,
      write: runtime.write,
      sessions: runtime.sessions,
      protectedMode: config.protectedMode,
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

  // Local trust (decision 32): there is nothing to unlock, so the Unlock screen goes home.
  if (!config.protectedMode) {
    app.get('/unlock', (c) => {
      c.header('Cache-Control', 'no-store');
      return c.redirect('/', 302);
    });
  }

  // SPA fallback: unknown GET paths that look like client routes get index.html.
  app.get('*', async (c, next) => {
    if (isServerPath(c.req.path) || looksLikeFile(c.req.path)) return next();
    try {
      const html = await readFile(join(webRoot, 'index.html'), 'utf8');
      c.header('Cache-Control', 'no-cache');
      // Local trust: the page gets its CSRF cookie with the HTML, before its first mutation.
      if (!config.protectedMode) {
        const session = runtime.sessions.verify(getCookie(c, SESSION_COOKIE));
        ensureLocalCsrfCookie(c, runtime.sessions, session);
      }
      return c.html(html);
    } catch {
      return next();
    }
  });

  return app;
}
