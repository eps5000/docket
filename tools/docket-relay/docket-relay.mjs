#!/usr/bin/env node
/**
 * docket-relay (owner decision 46): when the owner changes a ticket in Docket,
 * tell the live lead's session through Orca to go and look.
 *
 *   node docket-relay.mjs start    Run in the foreground (the Scheduled Task runs this)
 *   node docket-relay.mjs status   Show a compact status, with no message content
 *   node docket-relay.mjs test-send <address>   Send one fixed test message through Orca
 *   node docket-relay.mjs help     Show this
 *
 * README.md has the install steps. Settings: DOCKET_RELAY_URL, DOCKET_RELAY_HOME,
 * DOCKET_RELAY_ORCA.
 */
import { randomUUID } from 'node:crypto';
import { createDocket } from './lib/docket.mjs';
import { createOrca, findOrca } from './lib/orca.mjs';
import { createRelay } from './lib/relay.mjs';
import {
  acquireLock,
  createLog,
  defaultHome,
  isRunning,
  openStore,
  readState,
} from './lib/store.mjs';

const DEFAULT_URL = 'http://127.0.0.1:7420';

const HELP = `docket-relay: wake the right Orca session when a ticket changes from the owner side.

  start    Run in the foreground. Only one instance runs per state folder.
  status   Show the last event, last delivery, failures and undelivered tickets.
           Add --json for the same facts as JSON.
  test-send <address>
           Send one fixed test message the way the relay does, to prove the
           Orca path after an install. Address: run:<id>, dispatch:<id> or
           orca_session_id:<id>.
  help     Show this.

  DOCKET_RELAY_URL    Docket's address (default ${DEFAULT_URL})
  DOCKET_RELAY_HOME   State and log folder (default %LOCALAPPDATA%\\docket-relay)
  DOCKET_RELAY_ORCA   Full path to the Orca CLI (default: orca.exe on PATH)
`;

const baseUrl = (env) => env.DOCKET_RELAY_URL || DEFAULT_URL;

async function start(env) {
  const home = defaultHome(env);
  const release = await acquireLock(home);
  if (!release) {
    process.stderr.write(`docket-relay is already running for ${home}.\n`);
    return 2;
  }
  const log = createLog(home, { echo: Boolean(process.stdout.isTTY) });
  const store = openStore(home);
  if (store.recovered) log('state_unreadable_restarting_at_feed_end');
  const exe = findOrca(env);
  if (!exe) log('orca_not_found');
  const relay = createRelay({
    docket: createDocket({ baseUrl: baseUrl(env) }),
    orca: createOrca({ exe, env }),
    store,
    log,
  });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.once('SIGBREAK', stop);
  log('started', { pid: process.pid, cursor: store.state.cursor ?? 'new' });
  await relay.run(controller.signal);
  log('stopped', { pid: process.pid });
  await release();
  return 0;
}

const when = (entry) => entry?.at ?? 'never';

function statusLines(running, state) {
  if (!state) return [`docket-relay: ${running ? 'running' : 'stopped'}`, 'No state yet.'];
  const c = state.counters;
  const lines = [
    `docket-relay: ${running ? 'running' : 'stopped'}`,
    `docket: ${state.docket.connected ? 'connected' : `down (${state.docket.error ?? 'not yet contacted'})`}, since ${when(state.docket)}`,
    `cursor: ${state.cursor ?? 'none'}`,
    `last event: ${state.last_event ? `${state.last_event.at} ${state.last_event.item} (${state.last_event.kinds.join(', ')})` : 'never'}`,
    `last delivery: ${state.last_delivery ? `${state.last_delivery.at} ${state.last_delivery.item} to ${state.last_delivery.role} (${state.last_delivery.kinds.join(', ')}) in ${state.last_delivery.latency_ms} ms` : 'never'}`,
    `last failure: ${state.last_failure ? `${state.last_failure.at} ${state.last_failure.reason}` : 'none'}`,
    `waiting to send: ${Object.keys(state.batches).length} ticket(s)`,
    `counts: delivered ${c.delivered} (via coordinator ${c.via_coordinator}), no live lead ${c.no_live_lead}, undelivered ${c.undelivered}, send failures ${c.send_failures}`,
  ];
  for (const entry of state.undelivered.slice(-5)) {
    lines.push(
      `undelivered: ${entry.at} ${entry.item} (${entry.kinds.join(', ')}): ${entry.reason}`,
    );
  }
  return lines;
}

async function status(env, args) {
  const home = defaultHome(env);
  const running = await isRunning(home);
  const state = readState(home);
  if (args.includes('--json')) {
    const facts = state
      ? {
          cursor: state.cursor,
          docket: state.docket,
          waiting: Object.keys(state.batches).length,
          last_event: state.last_event,
          last_delivery: state.last_delivery,
          last_failure: state.last_failure,
          counters: state.counters,
          undelivered: state.undelivered,
        }
      : {};
    process.stdout.write(`${JSON.stringify({ running, home, ...facts })}\n`);
  } else {
    process.stdout.write(`${statusLines(running, state).join('\n')}\n`);
  }
  return 0;
}

const TEST_ADDRESS =
  /^(dispatch:ctx_[A-Za-z0-9_-]{1,96}|run:run_[A-Za-z0-9_-]{1,96}|orca_session_id:[A-Za-z0-9_-]{1,84})$/;

async function testSend(env, [to]) {
  if (!TEST_ADDRESS.test(to ?? '')) {
    process.stderr.write('Give one address: run:<id>, dispatch:<id> or orca_session_id:<id>.\n');
    return 1;
  }
  const exe = findOrca(env);
  if (!exe) {
    process.stderr.write('Orca CLI not found. Set DOCKET_RELAY_ORCA to orca.exe.\n');
    return 1;
  }
  const result = await createOrca({ exe, env }).send({
    to,
    subject: 'Docket relay test',
    body: 'This is a test from docket-relay. No action is needed.',
    requestId: randomUUID(),
  });
  if (result.ok) {
    process.stdout.write(`Sent a test message to ${to}.\n`);
    return 0;
  }
  process.stderr.write(`Orca did not accept it: ${result.code}.\n`);
  return 1;
}

const [command = 'help', ...args] = process.argv.slice(2);
let code;
if (command === 'start') code = await start(process.env);
else if (command === 'status') code = await status(process.env, args);
else if (command === 'test-send') code = await testSend(process.env, args);
else if (command === 'help' || command === '--help') {
  process.stdout.write(HELP);
  code = 0;
} else {
  process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
  code = 1;
}
process.exitCode = code;
