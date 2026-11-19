#!/usr/bin/env node
/**
 * The real-client smoke kit (BUILD_SPEC §10 "Smoke test with real clients";
 * requirement O07; tasks.md T133, T146). The owner runs it by hand, once
 * per client surface, next to the checklist for that surface in this folder.
 *
 *   node docker/smoke/smoke.mjs preflight
 *       The service answers, and /mcp accepts a session (initialize +
 *       whoami). In local trust (the default; decision 32) no token is
 *       needed; in protected mode DOCKET_TOKEN must be set and clean.
 *   node docker/smoke/smoke.mjs prepare <surface>
 *       Creates a disposable ticket in the sample project RCP, moves it to
 *       Ready, and prints the prompt to paste into the client.
 *   node docker/smoke/smoke.mjs check <surface> <ITEM-ID>
 *       Reads the ticket back and checks what the client did: the lead
 *       claim by the expected client and label, a plan of two steps, the
 *       first step done, and a run that is still open. Prints PASS or FAIL
 *       for each, then the checks only a person can make in the UI.
 *   node docker/smoke/smoke.mjs pdf
 *       Puts a one-page PDF on RCP-14, for the by-hand PDF preview check.
 *
 * Surfaces: codex, claude, orca-codex, orca-claude.
 *
 * Run it against a disposable instance loaded with the sample data
 * (DOCKET_SEED=sample on an empty volume; see README.md here), never
 * against your real data. Node 22, no dependencies. It talks plain
 * JSON-RPC to /mcp, with the token from DOCKET_TOKEN when it is set (protected
 * mode), and never prints it.
 * DOCKET_URL overrides http://127.0.0.1:7420.
 */
const BASE = (process.env.DOCKET_URL ?? 'http://127.0.0.1:7420').replace(/\/$/, '');

const SURFACES = {
  codex: { name: 'Codex CLI (host)', client: 'codex', label: 'smoke-codex' },
  claude: { name: 'Claude Code (host)', client: 'claude', label: 'smoke-claude' },
  'orca-codex': { name: 'Orca worker · Codex', client: 'codex', label: 'orca-smoke-codex' },
  'orca-claude': { name: 'Orca worker · Claude', client: 'claude', label: 'orca-smoke-claude' },
};

const say = (line = '') => process.stdout.write(`${line}\n`);
const fail = (line) => {
  process.stderr.write(`${line}\n`);
  process.exit(1);
};

/** The agent token, or null: local trust (decision 32) needs none. */
function token() {
  const raw = process.env.DOCKET_TOKEN;
  if (!raw) return null;
  if (raw !== raw.trim()) {
    fail(
      'DOCKET_TOKEN has leading or trailing whitespace (often a newline). Set it again without it.',
    );
  }
  return raw;
}

/** One MCP session over Streamable HTTP with JSON responses. */
async function connect() {
  const bearer = token();
  const headers = {
    ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
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
    if (res.status === 401) {
      fail(
        bearer
          ? '/mcp refused the token (401). Check DOCKET_TOKEN.'
          : '/mcp needs a token (401): this Docket is in protected mode. Set DOCKET_TOKEN (Settings → Reveal token, or `docker compose exec docket docket agent-token`).',
      );
    }
    if (!res.ok && res.status !== 202) fail(`/mcp answered ${res.status}: ${await res.text()}`);
    session ??= res.headers.get('mcp-session-id');
    if (notify || res.status === 202) return null;
    const text = await res.text();
    // JSON, or an SSE stream with the answer in a `data:` line.
    const json = text.trimStart().startsWith('{')
      ? JSON.parse(text)
      : JSON.parse(
          text
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5))
            .at(-1) ?? '{}',
        );
    if (json.error) fail(`${method} failed: ${json.error.message}`);
    return json.result;
  }
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'docket-smoke-kit', version: '1.0.0' },
  });
  await rpc('notifications/initialized', {}, true);
  return {
    async call(name, args = {}) {
      const result = await rpc('tools/call', { name, arguments: args });
      return {
        ok: !result.isError,
        data: result.structuredContent ?? {},
        text: (result.content ?? []).map((c) => c.text ?? '').join('\n'),
      };
    },
    async close() {
      if (!session) return;
      await fetch(`${BASE}/mcp`, {
        method: 'DELETE',
        headers: { ...headers, 'mcp-session-id': session },
      }).catch(() => {});
    },
  };
}

function surfaceOf(name) {
  const s = SURFACES[name];
  if (!s) fail(`Unknown surface "${name}". Use one of: ${Object.keys(SURFACES).join(', ')}.`);
  return s;
}

async function preflight() {
  const health = await fetch(`${BASE}/healthz`).catch(() => null);
  if (!health?.ok) fail(`Nothing healthy answers at ${BASE}/healthz. Start the service first.`);
  const ready = await fetch(`${BASE}/readyz`);
  say(`Service: ${BASE} · readyz ${ready.status} ${await ready.text()}`);
  const mcp = await connect();
  try {
    const who = await mcp.call('whoami');
    if (!who.ok) fail(`whoami failed: ${who.text}`);
    say('Token: accepted by /mcp (not printed).');
    say(`whoami: ${who.text.split('\n')[0]}`);
    const projects = await mcp.call('list_projects');
    if (!projects.text.includes('RCP')) {
      say('Warning: no RCP project. Run the smoke test on a sample instance (see README.md).');
    }
  } finally {
    await mcp.close();
  }
  say('Preflight passed.');
}

async function prepare(surfaceName) {
  const s = surfaceOf(surfaceName);
  const mcp = await connect();
  try {
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const created = await mcp.call('create_item', {
      project: 'RCP',
      type: 'Task',
      title: `Smoke test: ${s.name} · ${stamp}`,
      description_md: 'Disposable ticket for the O07 smoke test (docker/smoke). Safe to delete.',
    });
    if (!created.ok) fail(`create_item failed: ${created.text}`);
    const id = created.data.item?.id ?? created.data.id;
    if (!id) fail(`create_item returned no id: ${created.text}`);
    // A new item lands in Inbox; Inbox → Planning → Ready.
    for (const status of ['planning', 'ready']) {
      const moved = await mcp.call('set_status', { id, status });
      if (!moved.ok) fail(`Couldn't move ${id} to ${status}: ${moved.text}`);
    }
    say(`Prepared ${id} for ${s.name}.`);
    say('');
    say('Paste this into the client:');
    say('-----');
    say(
      [
        `Use the docket MCP server for these steps, one tool call each, and tell me each result:`,
        `1. Call whoami.`,
        `2. Call claim_lead on ${id} with agent_label "${s.label}".`,
        `3. Call set_plan on ${id} with two steps: "Read the ticket" and "Report back".`,
        `4. Call update_step on ${id} to mark the first step done.`,
        `5. Call get_item on ${id} and tell me the plan and each step's state.`,
        `Do not release the claim yet.`,
      ].join('\n'),
    );
    say('-----');
    say(`Then run: node docker/smoke/smoke.mjs check ${surfaceName} ${id}`);
  } finally {
    await mcp.close();
  }
}

async function check(surfaceName, id) {
  const s = surfaceOf(surfaceName);
  if (!id) fail('Pass the ticket ID that prepare printed.');
  const mcp = await connect();
  let failed = 0;
  const result = (ok, line) => {
    if (!ok) failed += 1;
    say(`${ok ? 'PASS' : 'FAIL'}  ${line}`);
  };
  try {
    const got = await mcp.call('get_item', { id, view: 'full' });
    if (!got.ok) fail(`get_item ${id} failed: ${got.text}`);
    const item = got.data.item ?? {};
    const runs = item.runs ?? [];
    const lead = runs.find((r) => r.is_lead && !r.end_reason);
    result(Boolean(lead), `${id} has an open lead run`);
    result(
      lead?.client === s.client,
      `the run's client is "${s.client}" (got "${lead?.client ?? 'none'}"): clientInfo was normalised`,
    );
    result(
      lead?.label === s.label,
      `the run's label is "${s.label}" (got "${lead?.label ?? 'none'}")`,
    );
    const work = item.checklist?.work ?? [];
    result(work.length === 2, `the plan has two steps (got ${work.length})`);
    result(work[0]?.state === 'done', `the first step is done (got "${work[0]?.state ?? 'none'}")`);
    result(
      lead ? ['live', 'reported'].includes(lead.run_state) : false,
      `the run state is live or reported (got "${lead?.run_state ?? 'none'}")`,
    );
  } finally {
    await mcp.close();
  }
  say('');
  say('Now check by hand (the checklist for this surface lists them):');
  say(`- Agents shows "${s.client} · ${s.label}" on ${id}, and its run state.`);
  say(`- Settings → Connections shows "${s.name}" last seen just now.`);
  say('- Note the run state: live means the client keeps its session open (V1).');
  say('');
  say(
    failed === 0
      ? `All automatic checks passed for ${s.name}.`
      : `${failed} check(s) failed for ${s.name}.`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
}

/** A one-page PDF ("Docket PDF preview check"), built by hand: no dependencies. */
function tinyPdf() {
  const NL = String.fromCharCode(10);
  const text = 'BT /F1 18 Tf 30 110 Td (Docket PDF preview check) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    ['<< /Length ' + text.length + ' >>', 'stream', text, 'endstream'].join(NL),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4' + NL;
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += [`${i + 1} 0 obj`, body, 'endobj', ''].join(NL);
  });
  const xref = out.length;
  const lines = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f '];
  for (const o of offsets) lines.push(`${String(o).padStart(10, '0')} 00000 n `);
  lines.push(
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(xref),
    '%%EOF',
    '',
  );
  return Buffer.from(out + lines.join(NL), 'latin1');
}

/** Put a small PDF on RCP-14, for the by-hand PDF preview check (UI_SPEC §6.9; B14 carry-over). */
async function pdf() {
  const mcp = await connect();
  try {
    const put = await mcp.call('put_document', {
      item_id: 'RCP-14',
      name: 'pdf-preview-check.pdf',
      kind: 'other',
      mime: 'application/pdf',
      content_base64: tinyPdf().toString('base64'),
    });
    if (!put.ok) fail(`put_document failed: ${put.text}`);
    say('Put pdf-preview-check.pdf on RCP-14.');
    say(`Open ${BASE}/items/RCP-14?tab=details in Chrome, then Documents → pdf-preview-check.pdf.`);
    say('Expect the page "Docket PDF preview check" inside the viewer, and Download to work.');
  } finally {
    await mcp.close();
  }
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'preflight') await preflight();
  else if (command === 'prepare') await prepare(args[0]);
  else if (command === 'check') await check(args[0], args[1]);
  else if (command === 'pdf') await pdf();
  else {
    say(
      'Usage: node docker/smoke/smoke.mjs preflight | prepare <surface> | check <surface> <ITEM-ID> | pdf',
    );
    say(`Surfaces: ${Object.keys(SURFACES).join(', ')}`);
    process.exitCode = command ? 2 : 0;
  }
} catch (err) {
  fail(`smoke: ${err.message}`);
}
