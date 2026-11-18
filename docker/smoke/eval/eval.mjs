#!/usr/bin/env node
/**
 * Skills eval (tasks.md T148; owner decision 27; SC-001, SC-012, SC-014).
 *
 * Runs the US1 and US11 scenarios with a real client, installed Claude Code
 * in headless mode (`claude -p`), against a disposable Task Lite with the
 * sample data. Each scenario runs twice: with the two core skills
 * (`tasklite-worker`, `tasklite-coordinator`) in the run folder's
 * `.claude/skills/`, and without them. It records, per run: Task Lite calls,
 * errors, the SC-001 opening (calls and result tokens to reach full context),
 * model tokens and cost, whether a skill was invoked, and the scenario's
 * outcome checks (each failed check is a mistake).
 *
 *   node docker/smoke/eval/eval.mjs [--model sonnet] [--only us1|us11] [--arms with,without]
 *
 * Safe by construction:
 * - the MCP server comes from a temporary `--mcp-config` file in the run
 *   folder with `--strict-mcp-config`, so no user or project MCP server is
 *   used, and nothing is added to the client's configuration;
 * - `--setting-sources project` keeps the user's settings and hooks out;
 * - each run works in a fresh temporary folder with a local bare `origin`;
 * - the container must be a disposable one (DOCKET_EVAL_CONTAINER,
 *   default `tasklite`) on a throwaway volume, started with
 *   DOCKET_SEED=sample: before every run its database is deleted and the
 *   sample seed reloads (as the e2e fixtures do). Never point it at real data.
 *
 * Output: a Markdown results table, plus each run's stream-json transcript,
 * in the folder printed at the end. Node 22, no dependencies.
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const BASE = 'http://127.0.0.1:7420';
const CONTAINER = process.env.DOCKET_EVAL_CONTAINER ?? 'tasklite';
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i === -1 ? dflt : args[i + 1];
};
const MODEL = opt('--model', 'sonnet');
const ONLY = opt('--only', null);
const ARMS = opt('--arms', 'without,with').split(',');
const OUT = mkdtempSync(join(tmpdir(), 'tasklite-skills-eval-'));
const say = (s = '') => process.stdout.write(`${s}\n`);

const docker = (a) =>
  execFileSync('docker', a, {
    encoding: 'utf8',
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  }).trim();
const git = (cwd, a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const tokens = (text) => Math.ceil(text.length / 4); // the contract budgets' estimate

async function waitReady() {
  for (let i = 0; i < 120; i++) {
    const ok = await fetch(`${BASE}/readyz`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Task Lite did not become ready');
}

/** A fresh sample seed: stop, delete the database and documents, start (the seed reloads). */
async function resetSeed() {
  const volume = docker([
    'inspect',
    '--format',
    '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}',
    CONTAINER,
  ]);
  if (volume === 'tasklite-data') {
    throw new Error(
      `Refusing to reset "${CONTAINER}": it uses the tasklite-data volume, which may hold your real data. Use a disposable instance.`,
    );
  }
  docker(['stop', '--time', '10', CONTAINER]);
  const image = docker(['inspect', '--format', '{{.Config.Image}}', CONTAINER]);
  docker([
    'run',
    '--rm',
    '--entrypoint',
    'sh',
    '-v',
    `${volume}:/data`,
    image,
    '-c',
    'rm -rf /data/tasklite.db /data/tasklite.db-wal /data/tasklite.db-shm /data/docs /data/logs',
  ]);
  docker(['start', CONTAINER]);
  await waitReady();
}

/** A plain JSON-RPC MCP session (the harness's own scripted actions and checks). */
async function mcp(clientName) {
  const token = docker(['exec', CONTAINER, 'tasklite', 'agent-token']);
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  let session = null;
  let id = 0;
  async function rpc(method, params, notify = false) {
    const body = { jsonrpc: '2.0', method, params };
    if (!notify) body.id = ++id;
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: session ? { ...headers, 'mcp-session-id': session } : headers,
      body: JSON.stringify(body),
    });
    session ??= res.headers.get('mcp-session-id');
    if (notify || res.status === 202) return null;
    const text = await res.text();
    const json = text.trimStart().startsWith('{')
      ? JSON.parse(text)
      : JSON.parse(
          text
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5))
            .at(-1),
        );
    if (json.error) throw new Error(`${method}: ${json.error.message}`);
    return json.result;
  }
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: clientName, version: '1.0.0' },
  });
  await rpc('notifications/initialized', {}, true);
  return {
    token,
    async call(name, a = {}) {
      const r = await rpc('tools/call', { name, arguments: a });
      if (r.isError) throw new Error(`${name}: ${(r.content ?? []).map((c) => c.text).join(' ')}`);
      return r.structuredContent ?? {};
    },
  };
}

/** A run folder: a git repo with a local bare origin, and the skills when `withSkills`. */
function workspace(name, withSkills) {
  const dir = join(OUT, name);
  const origin = join(OUT, `${name}-origin.git`);
  mkdirSync(dir, { recursive: true });
  git(OUT, ['init', '-q', '--bare', origin]);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'eval@example.test']);
  git(dir, ['config', 'user.name', 'Skills eval']);
  writeFileSync(join(dir, 'README.md'), '# Recipe app (eval)\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
  git(dir, ['remote', 'add', 'origin', origin]);
  git(dir, ['push', '-q', '-u', 'origin', 'main']);
  if (withSkills) {
    for (const s of ['tasklite-worker', 'tasklite-coordinator']) {
      cpSync(join(REPO, 'skills', s), join(dir, '.claude', 'skills', s), { recursive: true });
    }
  }
  writeFileSync(
    join(dir, '.eval-mcp.json'),
    JSON.stringify({
      mcpServers: {
        tasklite: {
          type: 'http',
          url: `${BASE}/mcp`,
          headers: { Authorization: 'Bearer ${DOCKET_TOKEN}' },
        },
      },
    }),
  );
  return { dir, sha: git(dir, ['rev-parse', 'HEAD']) };
}

/** Run `claude -p` and summarise its stream-json transcript. */
function claude(dir, prompt, label, token) {
  const log = join(OUT, `${label}.jsonl`);
  const argv = [
    '-p',
    prompt,
    '--strict-mcp-config',
    '--mcp-config',
    join(dir, '.eval-mcp.json'),
    '--setting-sources',
    'project',
    '--model',
    MODEL,
    '--output-format',
    'stream-json',
    '--verbose',
    '--allowedTools',
    'mcp__tasklite',
    'Skill',
    'Read',
    'Write',
    'Edit',
    'Bash(git:*)',
    'Bash(mkdir:*)',
    'Bash(ls:*)',
  ];
  return new Promise((done, fail) => {
    const child = spawn('claude', argv, {
      cwd: dir,
      env: { ...process.env, DOCKET_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => child.kill(), 20 * 60_000);
    child.on('error', fail);
    child.on('close', () => {
      clearTimeout(timer);
      writeFileSync(log, out);
      done(summarise(out, log));
    });
  });
}

function summarise(stream, log) {
  const lines = stream
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l));
  const uses = new Map();
  const calls = [];
  let result = null;
  for (const m of lines) {
    if (m.type === 'assistant') {
      for (const c of m.message?.content ?? []) {
        if (c.type === 'tool_use') uses.set(c.id, { name: c.name, input: c.input });
      }
    } else if (m.type === 'user') {
      for (const c of m.message?.content ?? []) {
        if (c.type !== 'tool_result') continue;
        const u = uses.get(c.tool_use_id);
        const text = Array.isArray(c.content)
          ? c.content.map((x) => x.text ?? '').join('\n')
          : String(c.content ?? '');
        calls.push({
          name: u?.name ?? '?',
          input: u?.input,
          error: !!c.is_error,
          tokens: tokens(text),
          text,
        });
      }
    } else if (m.type === 'result') {
      result = m;
    }
  }
  const tl = calls.filter((c) => c.name.startsWith('mcp__docket__'));
  const claims = tl
    .filter((c) => c.name.endsWith('__claim_lead') && !c.error)
    .map((c) => c.input?.id);
  const firstContext = tl.findIndex((c) => c.name.endsWith('__get_context'));
  const opening = firstContext === -1 ? null : tl.slice(0, firstContext + 1);
  const u = result?.usage ?? {};
  return {
    log,
    claims,
    tasklite_calls: tl.length,
    tasklite_errors: tl
      .filter((c) => c.error)
      .map((c) => `${c.name.replace('mcp__docket__', '')}: ${c.text.slice(0, 120)}`),
    sequence: tl.map((c) => c.name.replace('mcp__docket__', '') + (c.error ? '✗' : '')),
    opening: opening && {
      calls: opening.length,
      tokens: opening.reduce((n, c) => n + c.tokens, 0),
    },
    result_tokens: tl.reduce((n, c) => n + c.tokens, 0),
    skills_invoked: calls
      .filter((c) => c.name === 'Skill')
      .map((c) => c.input?.skill ?? c.input?.command ?? '?'),
    other_tools: calls.filter((c) => !c.name.startsWith('mcp__docket__') && c.name !== 'Skill')
      .length,
    model_tokens: {
      input:
        (u.input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0),
      output: u.output_tokens ?? 0,
    },
    cost_usd: result?.total_cost_usd ?? null,
    turns: result?.num_turns ?? null,
    final: (result?.result ?? '').slice(0, 400),
  };
}

// ---- Scenarios ----

const US1_PROMPT = `You are a coding agent. Task Lite (the MCP server "docket") is where this team's work is tracked.
Pick up the best ready item in project RCP and work it end to end.
The repository is your current folder (remote "origin", base branch "main"). The real work is simulated here: on a new branch named after the item (for example rcp-17), add notes/<ITEM-ID>.md with three lines on how you would implement the item, commit it and push it.
Then finish the item in Task Lite the way the workflow requires. Don't ask me anything; you are on your own.`;

async function us1(arm) {
  await resetSeed();
  const ws = workspace(`us1-${arm}`, arm === 'with');
  const agent = await mcp('eval-harness');
  // MCP_SPEC §7.1: work sent back (resumable) comes before new work; either is a correct pick.
  const resumable = (
    await agent.call('search_items', { project: 'RCP', filter: 'resumable', limit: 1 })
  ).items?.[0];
  const best = (
    await agent.call('search_items', { project: 'RCP', filter: 'ready_to_start', limit: 1 })
  ).items?.[0];
  const run = await claude(ws.dir, US1_PROMPT, `us1-${arm}`, agent.token);
  // Outcome checks.
  const checks = [];
  const claimed = run.claims[0] ?? null;
  checks.push(['claimed an item before working', !!claimed]);
  const okPick = [resumable?.id, best?.id].filter(Boolean);
  checks.push([
    `picked the resumable or the best ready item (${okPick.join(' or ')}; took ${claimed})`,
    okPick.includes(claimed),
  ]);
  const touched = claimed ? (await agent.call('get_item', { id: claimed })).item : null;
  const handedOff = touched && (touched.status === 'done' || touched.status === 'review');
  checks.push([`${claimed} ended in Review or Done (is ${touched?.status})`, !!handedOff]);
  // A resumed item already has its plan: working its steps is planning in the checklist too.
  checks.push([
    'planned in the checklist (set_plan, or update_step on the plan it resumed)',
    run.sequence.includes('set_plan') ||
      (claimed === resumable?.id && run.sequence.includes('update_step')),
  ]);
  checks.push(['reported a pushed commit (report_commit)', run.sequence.includes('report_commit')]);
  const pushed =
    git(ws.dir, ['ls-remote', '--heads', 'origin'])
      .split('\n')
      .filter((l) => !l.endsWith('refs/heads/main')).length > 0;
  checks.push(['pushed a branch to origin', pushed]);
  const hr = touched?.human_review;
  const needsPacket = Array.isArray(hr) ? hr.length > 0 : (hr?.declared ?? 0) > 0;
  if (needsPacket)
    checks.push([
      'handed off with submit_packet (human review declared)',
      run.sequence.includes('submit_packet'),
    ]);
  checks.push([
    'stayed within SC-001 (≤ 4 calls, ≤ 3,500 tokens to full context)',
    !!run.opening && run.opening.calls <= 4 && run.opening.tokens <= 3500,
  ]);
  return { scenario: 'US1', arm, run, checks };
}

async function us11(arm) {
  await resetSeed();
  const harness = await mcp('eval-harness');
  // Phase A: a dispatched worker (the real client) hits a dependency and must wait the right way.
  const wsA = workspace(`us11-worker-${arm}`, arm === 'with');
  const briefA = [
    'Work Task Lite item RCP-17 in project RCP.',
    `Worktree: ${wsA.dir.replace(/\\/g, '/')} · branch rcp-17 · base origin/main @ ${wsA.sha}`,
    'Claim with claim_lead, passing this workspace, orchestrator {name:"eval", dispatch_id:"d-rcp17"} and this brief verbatim.',
    'The work is simulated: step 1 is adding notes/RCP-17.md (three lines), committed and pushed on branch rcp-17.',
    'Step 2 needs RCP-12 to be done first, and RCP-12 is not done yet. Do not start step 2 before it is.',
    "I can't answer questions; end your session when you can't continue.",
  ].join('\n');
  const runA = await claude(wsA.dir, briefA, `us11-worker-${arm}`, harness.token);

  // Phase B (scripted): a second worker is mid-flight with a dev server and unpushed work.
  const ready = (
    await harness.call('search_items', { project: 'RCP', filter: 'ready_to_start', limit: 5 })
  ).items
    .map((i) => i.id)
    .filter((id) => id !== 'RCP-17');
  const idB = ready[0];
  const briefB = `Work Task Lite item ${idB} using the tasklite-worker skill.\nWorktree: /work/${idB.toLowerCase()} · branch ${idB.toLowerCase()} · base origin/main @ ${wsA.sha}\nConstraints: run the unit tests before each push.`;
  const worker = await mcp('codex-mcp-client');
  const claimB = await worker.call('claim_lead', {
    id: idB,
    agent_label: 'orca-w2',
    workspace: {
      repo: 'recipe-app',
      path: `/work/${idB.toLowerCase()}`,
      branch: idB.toLowerCase(),
      base_ref: 'origin/main',
      base_sha: wsA.sha,
    },
    orchestrator: { name: 'eval', dispatch_id: `d-${idB.toLowerCase()}` },
    brief: briefB,
  });
  await worker.call('set_plan', {
    id: idB,
    run_id: claimB.run_id,
    steps: [{ text: 'Write the migration' }, { text: 'Wire the UI' }],
  });
  await worker.call('heartbeat', {
    run_id: claimB.run_id,
    resources_started: [
      { kind: 'dev_server', label: 'vite dev server', locator: { port: 5173, pid: 4242 } },
    ],
  });
  await worker.call('report_commit', {
    id: idB,
    run_id: claimB.run_id,
    sha: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0',
    branch: idB.toLowerCase(),
    pushed: false,
  });

  // The crash: restart the service.
  const parkedBefore = await harness.call('recovery_report', { include_briefs: true });
  docker(['restart', '--time', '5', CONTAINER]);
  await waitReady();

  // Phase C: the coordinator (the real client) recovers.
  const wsC = workspace(`us11-coord-${arm}`, arm === 'with');
  mkdirSync(join(wsC.dir, 'dispatch'), { recursive: true });
  const promptC = `You coordinate the agents that work through Task Lite (the MCP server "docket") on project RCP.
The machine just crashed and restarted. Every worker process is gone; Task Lite is back up.
Recover: work out what was in flight and get it going again, safely.
You can't start agents in this exercise. Instead, for each worker you would start now, write dispatch/<ITEM-ID>.md in the current folder containing the exact prompt you'd give that worker. Put anything that needs cleaning up on the machine in dispatch/cleanup.md. Don't do the workers' work yourself, and don't ask me anything.`;
  const runC = await claude(wsC.dir, promptC, `us11-coord-${arm}`, harness.token);

  // The restart ended the harness's MCP session too: a new one for the checks.
  const after = await (await mcp('eval-harness')).call('recovery_report', { include_briefs: true });
  const files = existsSync(join(wsC.dir, 'dispatch')) ? readdirSync(join(wsC.dir, 'dispatch')) : [];
  const read = (f) => readFileSync(join(wsC.dir, 'dispatch', f), 'utf8');
  const all = files.map(read).join('\n');
  const checks = [];
  const parked = after.parked.find((p) => p.item.id === 'RCP-17') ?? null;
  const parkedA = runA.sequence.includes('park_run');
  checks.push([
    'worker: claimed RCP-17 with the workspace and brief',
    runA.sequence.includes('claim_lead'),
  ]);
  checks.push(['worker: parked waiting on RCP-12 instead of going quiet or releasing', parkedA]);
  checks.push(['worker: pushed and reported step 1', runA.sequence.includes('report_commit')]);
  checks.push([
    'coordinator: read recovery_report',
    runC.sequence.some((s) => s.startsWith('recovery_report')),
  ]);
  const fileB = files.find((f) => f.toUpperCase().startsWith(idB));
  checks.push([`coordinator: re-dispatched the interrupted ${idB}`, !!fileB]);
  // SC-014: the stored brief, unchanged: verbatim in the prompt, or by its stored version
  // (brief_document_version_id), which tasklite-coordinator §6 prefers.
  const storedB = after.interrupted.find((e) => e.item.id === idB)?.run.brief_document_version_id;
  const textB = fileB ? read(fileB).replace(/\r\n/g, '\n') : '';
  checks.push([
    `coordinator: ${idB}'s brief recovered unchanged (SC-014: verbatim, or by ${storedB})`,
    !!fileB && (textB.includes(briefB) || (!!storedB && textB.includes(storedB))),
  ]);
  checks.push([
    'coordinator: flagged the unpushed commit as possibly lost',
    /unpush|not pushed|a1b2c3d/i.test(all),
  ]);
  checks.push(['coordinator: listed the orphaned dev server for cleanup', /5173|4242/.test(all)]);
  const claimedAgain = runC.sequence.some(
    (s) => s.startsWith('claim_lead') || s.startsWith('release_lead'),
  );
  checks.push(["coordinator: didn't claim or release items itself", !claimedAgain]);
  // tasklite-coordinator §6: interrupted runs with no workspace and no brief weren't dispatched
  // by this coordinator; they're the owner's to handle, not to re-dispatch.
  const notOurs = after.interrupted
    .filter((e) => !e.run.workspace && !e.run.brief_document_version_id)
    .map((e) => e.item.id);
  const strays = notOurs.filter((id) => files.some((f) => f.toUpperCase().startsWith(id)));
  checks.push([
    `coordinator: left runs it didn't dispatch to the owner (${notOurs.join(', ') || 'none'})${strays.length ? `; re-dispatched ${strays.join(', ')}` : ''}`,
    strays.length === 0,
  ]);
  const fileA = files.find((f) => f.toUpperCase().startsWith('RCP-17'));
  const parkedOk =
    !fileA || /run_id|run id|continue under|don.?t claim|do not claim/i.test(read(fileA));
  checks.push([
    'coordinator: left parked RCP-17 parked, or resumed it under its run_id (no new claim)',
    parkedOk,
  ]);
  return {
    scenario: 'US11',
    arm,
    run: merge(runA, runC),
    checks,
    detail: {
      parked_before: parkedBefore.parked.length,
      parked_after: !!parked,
      interrupted_after: after.interrupted.length,
      files,
    },
  };
}

function merge(a, b) {
  return {
    log: `${a.log} + ${b.log}`,
    claims: [...a.claims, ...b.claims],
    tasklite_calls: a.tasklite_calls + b.tasklite_calls,
    tasklite_errors: [...a.tasklite_errors, ...b.tasklite_errors],
    sequence: [...a.sequence, '|', ...b.sequence],
    opening: a.opening,
    result_tokens: a.result_tokens + b.result_tokens,
    skills_invoked: [...a.skills_invoked, ...b.skills_invoked],
    other_tools: a.other_tools + b.other_tools,
    model_tokens: {
      input: a.model_tokens.input + b.model_tokens.input,
      output: a.model_tokens.output + b.model_tokens.output,
    },
    cost_usd: (a.cost_usd ?? 0) + (b.cost_usd ?? 0),
    turns: (a.turns ?? 0) + (b.turns ?? 0),
    final: `${a.final}\n---\n${b.final}`,
  };
}

// ---- Main ----

const results = [];
for (const scenario of [us1, us11]) {
  if (ONLY && scenario.name !== ONLY) continue;
  for (const arm of ARMS) {
    say(`Running ${scenario.name} ${arm} skills…`);
    const r = await scenario(arm);
    results.push(r);
    writeFileSync(join(OUT, `${r.scenario}-${arm}.json`), JSON.stringify(r, null, 2));
    const failed = r.checks.filter(([, ok]) => !ok).length;
    say(
      `  ${r.run.tasklite_calls} calls, ${r.run.tasklite_errors.length} errors, ${failed} failed checks`,
    );
  }
}

say(
  '\n| Scenario | Skills | Task Lite calls | Errors | SC-001 opening (calls / result tokens) | All result tokens | Model tokens in / out | Cost USD | Skill invoked | Mistakes (failed checks) |',
);
say('|---|---|---|---|---|---|---|---|---|---|');
for (const r of results) {
  const failed = r.checks.filter(([, ok]) => !ok).map(([c]) => c);
  say(
    `| ${r.scenario} | ${r.arm} | ${r.run.tasklite_calls} | ${r.run.tasklite_errors.length} | ${r.run.opening ? `${r.run.opening.calls} / ${r.run.opening.tokens}` : 'never reached get_context'} | ${r.run.result_tokens} | ${r.run.model_tokens.input} / ${r.run.model_tokens.output} | ${r.run.cost_usd?.toFixed(2) ?? '?'} | ${r.run.skills_invoked.join(', ') || '—'} | ${failed.length === 0 ? 'none' : failed.join('; ')} |`,
  );
}
say(`\nTranscripts and per-run JSON: ${OUT}`);
