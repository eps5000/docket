import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { APP_NAME } from '@tasklite/shared';
import { createApp } from './app.js';

const here = dirname(fileURLToPath(import.meta.url));

// The image and the workspace share one layout: server/dist/ next to web/dist/.
const webRoot = resolve(here, '../../web/dist');
const dataDir = '/data';
const port = Number(process.env.TASKLITE_PORT ?? 7420);

const app = createApp({ webRoot, dataDir });

const server = serve({ fetch: app.fetch, hostname: '0.0.0.0', port }, (info) => {
  console.log(`${APP_NAME} listening on 0.0.0.0:${info.port}`);
});

// Docker sends SIGTERM on stop; close the listener so the container stops promptly.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
