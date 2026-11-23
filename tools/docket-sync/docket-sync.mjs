#!/usr/bin/env node
/**
 * docket-sync (owner decision 49): a small host process that collects data for
 * Docket, which runs in a container. It stores no token and never writes to an
 * outside service. README.md has the source contract and the install steps.
 *
 *   node docket-sync.mjs start    Run in the foreground (launch.ps1 runs this for the task)
 *   node docket-sync.mjs once     Run every source once, then exit
 *   node docket-sync.mjs status   Show each source's last result, with no content
 *   node docket-sync.mjs stop     Ask the running instance to finish and exit
 *   node docket-sync.mjs help     Show this
 *
 * Settings: DOCKET_SYNC_URL, DOCKET_SYNC_HOME.
 */
import { createDocket } from './lib/docket.mjs';
import { createRunner, loadSources } from './lib/runner.mjs';
import {
  acquireLock,
  createLog,
  defaultHome,
  inspectState,
  isRunning,
  openStore,
  requestStop,
} from './lib/store.mjs';

const DEFAULT_URL = 'http://127.0.0.1:7420';
const EXIT_STATE = 3;
const STOP_WAIT_MS = 60_000;

const HELP = `docket-sync: collect data for Docket on this computer. Read-only, no stored token.

  start    Run in the foreground. Only one instance runs per state folder.
  once     Run every source once, then exit. Exit 1 if any source failed.
  status   Show each source's last result. Add --json for the same facts as JSON.
  stop     Ask the running instance to finish its current step and exit.
  help     Show this.

  DOCKET_SYNC_URL    Docket's address (default ${DEFAULT_URL})
  DOCKET_SYNC_HOME   State and log folder (default %LOCALAPPDATA%\\docket-sync)
`;

const baseUrl = (env) => env.DOCKET_SYNC_URL || DEFAULT_URL;

async function open(env, onStop) {
  const home = defaultHome(env);
  const release = await acquireLock(home, onStop ? { onStop } : {});
  if (!release) {
    process.stderr.write(`docket-sync is already running for ${home}.\n`);
    return { code: 2 };
  }
  const log = createLog(home, { echo: Boolean(process.stdout.isTTY) });
  let store;
  try {
    store = openStore(home);
  } catch (err) {
    log('state_unavailable', { error: err.code ?? 'error' });
    process.stderr.write(`docket-sync can't read the state file in ${home}. It is unchanged.\n`);
    await release();
    return { code: EXIT_STATE };
  }
  if (store.recovered) log('state_recovered');
  const sources = await loadSources(log);
  const runner = createRunner({
    docket: createDocket({ baseUrl: baseUrl(env) }),
    sources,
    store,
    log,
  });
  return { runner, log, release };
}

async function start(env) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  const opened = await open(env, stop);
  if (!opened.runner) return opened.code;
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.once('SIGBREAK', stop);
  opened.log('started', { pid: process.pid });
  await opened.runner.run(controller.signal);
  opened.log('stopped', { pid: process.pid });
  await opened.release();
  return 0;
}

async function once(env) {
  const opened = await open(env);
  if (!opened.runner) return opened.code;
  const results = await opened.runner.once();
  await opened.release();
  for (const [name, outcome] of Object.entries(results)) {
    process.stdout.write(`${name}: ${outcome}\n`);
  }
  return Object.values(results).includes('failed') ? 1 : 0;
}

async function status(env, args) {
  const home = defaultHome(env);
  const running = await isRunning(home);
  const { state, unreadable } = inspectState(home);
  const sources = Object.fromEntries(
    Object.entries(state?.sources ?? {}).map(([name, s]) => [
      name,
      {
        last_attempt_at: s.last_attempt_at,
        last_success_at: s.last_success_at,
        last_error: s.last_error,
        failures: s.failures,
        records_sent: s.records_sent,
        next_at: s.next_at ? new Date(s.next_at).toISOString() : null,
      },
    ]),
  );
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ running, home, unreadable, sources })}\n`);
    return 0;
  }
  const lines = [`docket-sync: ${running ? 'running' : 'stopped'}`];
  if (unreadable) lines.push('The state file could not be read.');
  if (Object.keys(sources).length === 0) lines.push('No sources have run yet.');
  for (const [name, s] of Object.entries(sources)) {
    lines.push(
      `${name}: last success ${s.last_success_at ?? 'never'}, last error ${s.last_error ?? 'none'}, ${s.records_sent} record(s) sent`,
    );
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

async function stopRunning(env) {
  const home = defaultHome(env);
  if (!(await isRunning(home))) {
    process.stdout.write('docket-sync is not running.\n');
    return 0;
  }
  const answer = await requestStop(home);
  if (answer !== 'stopping') {
    process.stderr.write(`docket-sync did not accept the stop (${answer}).\n`);
    return 1;
  }
  const deadline = Date.now() + STOP_WAIT_MS;
  while (await isRunning(home)) {
    if (Date.now() > deadline) {
      process.stderr.write('docket-sync accepted the stop but is still running.\n');
      return 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  process.stdout.write('docket-sync stopped.\n');
  return 0;
}

const [command = 'help', ...args] = process.argv.slice(2);
let code;
if (command === 'start') code = await start(process.env);
else if (command === 'once') code = await once(process.env);
else if (command === 'status') code = await status(process.env, args);
else if (command === 'stop') code = await stopRunning(process.env);
else if (command === 'help' || command === '--help') {
  process.stdout.write(HELP);
  code = 0;
} else {
  process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
  code = 1;
}
process.exitCode = code;
