import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { APP_NAME } from '@docket/shared';
import { createApp } from './app.js';
import { describeSeed, isDatabaseEmpty, loadSampleSeed } from './db/seed/loader.js';
import { ensureReleasesAtStart } from './domain/release-migration.js';
import { readContext } from './domain/contracts.js';
import { SYSTEM_ACTOR } from './domain/write.js';
import { holdServerLock, startBackupJob } from './jobs/backup.js';
import { syncBundledFiles } from './jobs/bundled.js';
import { startupHousekeeping } from './jobs/startup.js';
import {
  classifyLegacyOverlapsOnce,
  restartSweep,
  startDriftCheck,
  startRadar,
  startRunActivity,
  startSweeper,
  type Sweeper,
} from './jobs/sweeper.js';
import { createRuntime } from './runtime.js';
import { APP_VERSION } from './version.js';

const here = dirname(fileURLToPath(import.meta.url));

// The image and the workspace share one layout: server/dist/ next to web/dist/.
const webRoot = resolve(here, '../../web/dist');

// Never log secrets: no token, key, cookie or Authorization header is printed here.
const runtime = createRuntime({ dataDir: '/data', env: process.env });
const { config } = runtime;

// Service start (BUILD_SPEC §5.3; decision 41): runs still open from before stay open, and
// each lead's lease runs at least DOCKET_RESTART_GRACE_MINUTES from now.
const { kept, ended, unparked } = restartSweep(runtime);
if (unparked.length > 0) {
  console.log(`Service restarted: ${unparked.length} coordinator park(s) ran out while down.`);
}
if (kept.length > 0) {
  console.log(`Service restarted: kept ${kept.length} open run(s); their agents can continue.`);
}
if (ended.length > 0) {
  console.log(`Service restarted: ${ended.length} child run(s) missed their deadline and ended.`);
}

if (config.seed === 'sample') {
  if (isDatabaseEmpty(runtime.db)) {
    const summary = loadSampleSeed(runtime.db, {
      now: new Date(),
      docsDir: config.paths.docs,
      stress: config.seedStress,
    });
    console.log(`Loaded the sample seed: ${describeSeed(summary)}`);
    // Decision 67: the seed's open epics get their Release, as an upgraded database would.
    ensureReleasesAtStart(runtime.write, (line) => console.log(line));
  } else {
    console.log('DOCKET_SEED=sample ignored: the database already has data.');
  }
}

// The agent files shipped in the image (BUILD_SPEC §5.17): a new bundled version for
// each file whose content changed. Owner edits are never overwritten.
const { added } = syncBundledFiles(runtime);
if (added.length > 0) console.log(`Loaded bundled agent files: ${added.join(', ')}.`);

// `docket restore` refuses while this lock is fresh (BUILD_SPEC §5.13).
const lock = holdServerLock(config);

// Housekeeping (BUILD_SPEC §5.10, §5.12): uploads interrupted by the restart, and
// the documents of deleted projects whose removal failed after the commit.
const { staged, removed } = await startupHousekeeping(runtime);
if (staged > 0) console.log(`Removed ${staged} unfinished upload(s) from docs/.staging.`);
if (removed.length > 0) {
  console.log(`Removed the documents of deleted project(s): ${removed.join(', ')}.`);
}

const app = createApp(runtime, { webRoot });
// The nightly backup at DOCKET_BACKUP_AT (BUILD_SPEC §5.13).
const backups = startBackupJob({
  config,
  log: runtime.log,
  backup: () =>
    runtime.services.backup.runNow(readContext(runtime.db, SYSTEM_ACTOR, runtime.clock())),
});
// Lease expiry and the 60 s pings to sessions of open runs (BUILD_SPEC §5.3, §5.4).
// Decision 39: overlaps from before it get the new rule once.
classifyLegacyOverlapsOnce(runtime);
const sweeper = startSweeper(runtime);
// The push folder's drift check, at startup and every DOCKET_DRIFT_CHECK_INTERVAL (decision 30).
const driftCheck = startDriftCheck(runtime);
// B52: the jobs that read git start once the listener is up, each after its own delay.
let radar: Sweeper | null = null;
let runActivity: Sweeper | null = null;
let stopping = false;

const server = serve({ fetch: app.fetch, hostname: '0.0.0.0', port: config.port }, (info) => {
  console.log(`${APP_NAME} ${APP_VERSION} listening on 0.0.0.0:${info.port}`);
  console.log('Owner key: run `docket owner-key` in the container to print it.');
  if (stopping) return;
  // The conflict radar, every 15 minutes for projects with a repository (decision 36).
  radar = startRadar(runtime);
  // Decision 42: newer activity on parked and silent runs, every two minutes.
  runActivity = startRunActivity(runtime);
});

// Docker sends SIGTERM on stop; close the listener so the container stops promptly.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    stopping = true;
    void sweeper.stop();
    void driftCheck.stop();
    backups.stop();
    // B52: in-flight git ends before the database closes and the lock is released.
    void Promise.allSettled([radar?.stop(), runActivity?.stop()])
      .then(() => runtime.close())
      .finally(() => {
        lock.stop();
        server.close(() => process.exit(0));
      });
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
