#!/usr/bin/env node
/**
 * docket-relay (owner decision 46, B55b): when the owner changes a ticket in
 * Docket, tell its coordinator through Orca. It never messages a dispatch.
 *
 *   node docket-relay.mjs start    Run in the foreground (launch.ps1 runs this for the task)
 *   node docket-relay.mjs stop     Ask the running instance to finish its send and exit
 *   node docket-relay.mjs status   Show a compact status, with no message content
 *   node docket-relay.mjs reconcile --deliver | --skip-to-end --reason <text>
 *                                  Leave hold_reconcile
 *   node docket-relay.mjs test-send run:<id>    Send one fixed test message to the Run you name
 *   node docket-relay.mjs help     Show this
 *
 * README.md has the install steps and manage.ps1 the task steps. Settings: DOCKET_RELAY_URL, DOCKET_RELAY_HOME,
 * DOCKET_RELAY_ORCA.
 */
import { randomUUID } from 'node:crypto';
import { createDocket } from './lib/docket.mjs';
import { canDeliver, holdFacts, reconcileDeliver, reconcileSkip } from './lib/hold.mjs';
import { createOrca, findOrca } from './lib/orca.mjs';
import { createRelay } from './lib/relay.mjs';
import {
  acquireLock,
  createLog,
  defaultHome,
  inspectState,
  isRunning,
  openStore,
  requestStop,
} from './lib/store.mjs';
import { isCoordinatorAddress } from './lib/target.mjs';

const DEFAULT_URL = 'http://127.0.0.1:7420';
/** `start` found or entered a hold, or can't read its state: nothing was sent. */
const EXIT_HOLD = 3;
/** Long enough for one Orca call to finish or time out. */
const STOP_WAIT_MS = 60_000;

const HELP = `docket-relay: tell a ticket's Orca coordinator when it changes from the owner side.

  start    Run in the foreground. Only one instance runs per state folder.
           Exits with code ${EXIT_HOLD} in hold_reconcile, having sent nothing.
  stop     Ask the running instance to stop new work, finish or abort its
           current send, save and exit. Waits until it has gone.
  status   Show the last event, last delivery, failures, undelivered tickets
           and any hold. Add --json for the same facts as JSON.
  reconcile --deliver
           Leave the hold: queue the backlog, one message per ticket. The next
           start sends it, within the rate limit.
  reconcile --skip-to-end --reason <text>
           Leave the hold at the end of the feed, recording what was skipped.
  test-send run:<id>
           Send one fixed test message the way the relay does, to prove the
           Orca path after an install. It goes to whatever Run you name. Any
           other kind of address is refused.
  help     Show this.

  DOCKET_RELAY_URL    Docket's address (default ${DEFAULT_URL})
  DOCKET_RELAY_HOME   State and log folder (default %LOCALAPPDATA%\\docket-relay)
  DOCKET_RELAY_ORCA   Full path to the Orca CLI (default: orca.exe on PATH)
`;

const baseUrl = (env) => env.DOCKET_RELAY_URL || DEFAULT_URL;

async function start(env) {
  const home = defaultHome(env);
  const controller = new AbortController();
  const stop = () => controller.abort();
  const release = await acquireLock(home, { onStop: stop });
  if (!release) {
    process.stderr.write(`docket-relay is already running for ${home}.\n`);
    return 2;
  }
  const log = createLog(home, { echo: Boolean(process.stdout.isTTY) });
  let store;
  try {
    store = openStore(home);
  } catch (err) {
    log('state_unavailable', { error: err.code ?? 'error' });
    process.stderr.write(
      `docket-relay can't read the state file in ${home}. Nothing was sent and the file is unchanged.\n`,
    );
    await release();
    return EXIT_HOLD;
  }
  const exe = findOrca(env);
  if (!exe) log('orca_not_found');
  const relay = createRelay({
    docket: createDocket({ baseUrl: baseUrl(env) }),
    orca: createOrca({ exe, env }),
    store,
    log,
  });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.once('SIGBREAK', stop);
  log('started', { pid: process.pid, cursor: store.state.cursor ?? 'new' });
  const hold = await relay.run(controller.signal);
  log('stopped', { pid: process.pid, hold: hold?.reason });
  await release();
  if (!hold) return 0;
  process.stderr.write(
    `docket-relay is in hold_reconcile (${hold.reason}). Nothing is being sent and the cursor is not moving.\n` +
      `${leaveHoldText(store.state)}\nRun status to see what is waiting.\n`,
  );
  return EXIT_HOLD;
}

const leaveHoldText = (state) =>
  canDeliver(state)
    ? 'Leave it with: reconcile --deliver, or reconcile --skip-to-end --reason <text>'
    : 'Its position cannot be proved, so leave it with: reconcile --skip-to-end --reason <text>';

const when = (entry) => entry?.at ?? 'never';

function holdLines(state, facts) {
  const lines = [
    `HOLD: hold_reconcile (${state.hold.reason}) since ${state.hold.since}. Nothing is being sent and the cursor is not moving.`,
  ];
  const range = facts.first_at ? `, from ${facts.first_at} to ${facts.last_at}` : '';
  const count = `${facts.events} event(s) on ${facts.tickets} ticket(s)${range}`;
  lines.push(
    facts.complete
      ? `waiting: ${count}`
      : `waiting: at least ${count}. The rest of the feed could not be counted.`,
  );
  lines.push(leaveHoldText(state));
  return lines;
}

function statusLines(running, state, facts) {
  if (!state) return [`docket-relay: ${running ? 'running' : 'stopped'}`, 'No state yet.'];
  const c = state.counters;
  const lines = [
    `docket-relay: ${running ? 'running' : 'stopped'}`,
    ...(state.hold ? holdLines(state, facts) : []),
    `docket: ${state.docket.connected ? 'connected' : `down (${state.docket.error ?? 'not yet contacted'})`}, since ${when(state.docket)}`,
    `cursor: ${state.cursor ?? 'none'}`,
    `last event: ${state.last_event ? `${state.last_event.at} ${state.last_event.item} (${state.last_event.kinds.join(', ')})` : 'never'}`,
    `last delivery: ${state.last_delivery ? `${state.last_delivery.at} ${state.last_delivery.item} to ${state.last_delivery.to} (${state.last_delivery.kinds.join(', ')}) in ${state.last_delivery.latency_ms} ms` : 'never'}`,
    `last failure: ${state.last_failure ? `${state.last_failure.at} ${state.last_failure.reason}` : 'none'}`,
    `waiting to send: ${Object.keys(state.batches).length} ticket(s)`,
    `counts: delivered ${c.delivered}, no live lead ${c.no_live_lead}, undelivered ${c.undelivered}, skipped ${c.skipped}, send failures ${c.send_failures}`,
  ];
  for (const entry of state.undelivered.slice(-5)) {
    lines.push(
      `undelivered: ${entry.at} ${entry.item} (${entry.kinds.join(', ')}): ${entry.reason}`,
    );
  }
  const reconciled = state.reconciles.at(-1);
  if (reconciled) {
    lines.push(
      `last reconcile: ${reconciled.at} ${reconciled.action} (${reconciled.hold_reason}), ${reconciled.events} event(s) on ${reconciled.tickets} ticket(s)`,
    );
  }
  return lines;
}

async function status(env, args) {
  const home = defaultHome(env);
  const running = await isRunning(home);
  const { state, unreadable } = inspectState(home);
  const facts = state?.hold
    ? await holdFacts(state, createDocket({ baseUrl: baseUrl(env) }))
    : null;
  if (args.includes('--json')) {
    const detail = state
      ? {
          hold: state.hold ? { ...state.hold, waiting: facts } : null,
          cursor: state.cursor,
          docket: state.docket,
          waiting: Object.keys(state.batches).length,
          last_event: state.last_event,
          last_delivery: state.last_delivery,
          last_failure: state.last_failure,
          counters: state.counters,
          undelivered: state.undelivered,
          reconciles: state.reconciles,
        }
      : unreadable
        ? { hold: { state: 'hold_reconcile', reason: 'state_unreadable', waiting: null } }
        : {};
    process.stdout.write(`${JSON.stringify({ running, home, ...detail })}\n`);
  } else if (unreadable) {
    process.stdout.write(
      `docket-relay: ${running ? 'running' : 'stopped'}\n` +
        'HOLD: hold_reconcile (state_unreadable). Nothing is being sent. What is waiting is unknown.\n' +
        'Leave it with: reconcile --skip-to-end --reason <text>\n',
    );
  } else {
    process.stdout.write(`${statusLines(running, state, facts).join('\n')}\n`);
  }
  return 0;
}

const RECONCILE_USAGE =
  'Use exactly one of: reconcile --deliver, or reconcile --skip-to-end --reason <text>.\n';

function parseReconcile(args) {
  const rest = [...args];
  const deliver = rest.includes('--deliver');
  const skip = rest.includes('--skip-to-end');
  const at = rest.indexOf('--reason');
  const reason = at === -1 ? undefined : rest[at + 1];
  if (at !== -1) rest.splice(at, 2);
  const flags = rest.filter((arg) => arg !== '--deliver' && arg !== '--skip-to-end');
  if (flags.length > 0 || deliver === skip || (deliver && at !== -1)) return null;
  return { deliver, reason };
}

async function reconcile(env, args) {
  const parsed = parseReconcile(args);
  if (!parsed) {
    process.stderr.write(RECONCILE_USAGE);
    return 1;
  }
  const home = defaultHome(env);
  const release = await acquireLock(home);
  if (!release) {
    process.stderr.write(`docket-relay is running for ${home}. Stop it first.\n`);
    return 2;
  }
  try {
    const log = createLog(home, { echo: false });
    const store = openStore(home);
    const docket = createDocket({ baseUrl: baseUrl(env) });
    const result = parsed.deliver
      ? await reconcileDeliver({ store, docket, log })
      : await reconcileSkip({ store, docket, log, reason: parsed.reason });
    if (result.ok) {
      process.stdout.write(
        parsed.deliver
          ? `Left the hold. ${result.events} event(s) on ${result.tickets} ticket(s) are queued. Start the relay to send them.\n`
          : `Left the hold at the end of the feed. Skipped ${result.events} event(s) on ${result.tickets} ticket(s)${result.backlog_known ? '' : ', plus a backlog that could not be counted'}. Start the relay to continue.\n`,
      );
      return 0;
    }
    const messages = {
      not_in_hold: 'docket-relay is not in hold_reconcile. Nothing changed.',
      reason_required:
        'Give a one-line --reason of at most 200 characters, with no ticket text. Nothing changed.',
      needs_skip: `The stored position can't be proved (${result.reason}), so there is no backlog to deliver. Use --skip-to-end --reason <text>.`,
    };
    process.stderr.write(`${messages[result.code]}\n`);
    return 1;
  } catch (err) {
    process.stderr.write(
      `Could not reconcile (${err.code ?? 'error'}). The hold and the cursor are unchanged.\n`,
    );
    return 1;
  } finally {
    await release();
  }
}

async function stopRunning(env) {
  const home = defaultHome(env);
  if (!(await isRunning(home))) {
    process.stdout.write('docket-relay is not running.\n');
    return 0;
  }
  const answer = await requestStop(home);
  if (answer !== 'stopping') {
    process.stderr.write(`docket-relay did not accept the stop (${answer}).\n`);
    return 1;
  }
  const deadline = Date.now() + STOP_WAIT_MS;
  while (await isRunning(home)) {
    if (Date.now() > deadline) {
      process.stderr.write('docket-relay accepted the stop but is still running.\n');
      return 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  process.stdout.write('docket-relay stopped.\n');
  return 0;
}

async function testSend(env, [to]) {
  if (!isCoordinatorAddress(to)) {
    process.stderr.write('Give one Run address: run:<id>. Any other address is refused.\n');
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
else if (command === 'stop') code = await stopRunning(process.env);
else if (command === 'status') code = await status(process.env, args);
else if (command === 'reconcile') code = await reconcile(process.env, args);
else if (command === 'test-send') code = await testSend(process.env, args);
else if (command === 'help' || command === '--help') {
  process.stdout.write(HELP);
  code = 0;
} else {
  process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
  code = 1;
}
process.exitCode = code;
