import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';

export interface AppOptions {
  /** Directory holding the web build (index.html and assets/). */
  webRoot: string;
  /** The data volume, `/data` in the container. */
  dataDir: string;
}

/** Paths owned by the server. They never fall back to the SPA. */
const SERVER_PREFIXES = ['/api', '/mcp', '/healthz', '/readyz'];

function isServerPath(path: string): boolean {
  return SERVER_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/** True when the last path segment looks like a file (`app.js`), not a client route. */
function looksLikeFile(path: string): boolean {
  const last = path.slice(path.lastIndexOf('/') + 1);
  return last.includes('.');
}

/** Write and remove a probe file: proves the volume is writable, not just present. */
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

export function createApp({ webRoot, dataDir }: AppOptions): Hono {
  const app = new Hono();

  // Liveness: the process is up and answering. Used by the compose healthcheck.
  app.get('/healthz', (c) => c.text('ok'));

  // Readiness. Today the only dependency is a writable /data volume.
  // There is no database yet: B2 (Phase 2) extends this to check that the
  // database opens, the docs directory is writable and migrations are current.
  app.get('/readyz', async (c) => {
    const checks = { data_dir: await checkWritable(dataDir) };
    const ready = Object.values(checks).every((v) => v === 'ok');
    return c.json({ status: ready ? 'ready' : 'not_ready', checks }, ready ? 200 : 503);
  });

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
