import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { APP_NAME } from '@tasklite/shared';
import { createApp } from './app.js';
import { describeSeed, isDatabaseEmpty, loadSampleSeed } from './db/seed/loader.js';
import { createRuntime } from './runtime.js';
import { APP_VERSION } from './version.js';

const here = dirname(fileURLToPath(import.meta.url));

// The image and the workspace share one layout: server/dist/ next to web/dist/.
const webRoot = resolve(here, '../../web/dist');

// Never log secrets: no token, key, cookie or Authorization header is printed here.
const runtime = createRuntime({ dataDir: '/data', env: process.env });
const { config } = runtime;

if (config.seed === 'sample') {
  if (isDatabaseEmpty(runtime.db)) {
    const summary = loadSampleSeed(runtime.db, { now: new Date(), docsDir: config.paths.docs });
    console.log(`Loaded the sample seed: ${describeSeed(summary)}`);
  } else {
    console.log('TASKLITE_SEED=sample ignored: the database already has data.');
  }
}

const app = createApp(runtime, { webRoot });

const server = serve({ fetch: app.fetch, hostname: '0.0.0.0', port: config.port }, (info) => {
  console.log(`${APP_NAME} ${APP_VERSION} listening on 0.0.0.0:${info.port}`);
  console.log('Owner key: run `tasklite owner-key` in the container to print it.');
});

// Docker sends SIGTERM on stop; close the listener so the container stops promptly.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void runtime.close().finally(() => server.close(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
