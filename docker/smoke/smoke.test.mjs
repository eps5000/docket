import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const runner = fileURLToPath(new URL('./smoke.mjs', import.meta.url));

async function fakeDocket(rejectReady, run) {
  const calls = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'DELETE') {
      response.writeHead(202).end();
      return;
    }

    let body = '';
    for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body);
    if (rpc.method === 'notifications/initialized') {
      response.writeHead(202).end();
      return;
    }

    const reply = (result) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        'mcp-session-id': 'fake-smoke-session',
      });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    };
    if (rpc.method === 'initialize') {
      reply({ protocolVersion: '2025-06-18', capabilities: {} });
      return;
    }

    assert.equal(rpc.method, 'tools/call');
    const { name, arguments: args } = rpc.params;
    calls.push({ name, args });
    if (name === 'create_item') {
      reply({ structuredContent: { item: { id: 'RCP-101' } } });
      return;
    }

    assert.equal(name, 'set_status');
    assert.equal(args.id, 'RCP-101');
    if (args.status === 'ready') {
      const created = calls[0].args;
      const shaped =
        created.outcome_md?.trim() && created.acceptance?.length > 0 && created.shared === 'none';
      if (!shaped || rejectReady) {
        reply({
          isError: true,
          content: [
            {
              type: 'text',
              text: rejectReady
                ? 'design_review: synthetic Ready hold'
                : 'not_declared: outcome, acceptance and shared changes required',
            },
          ],
        });
        return;
      }
    }
    reply({ structuredContent: { item: { id: 'RCP-101', status: args.status } } });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`, calls);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function prepare(base) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, DOCKET_URL: base };
    delete env.DOCKET_TOKEN;
    const child = spawn(process.execPath, [runner, 'prepare', 'codex'], {
      env,
      windowsHide: true,
      signal: AbortSignal.timeout(10_000),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('prepare creates a shaped sample item and reaches Ready before printing the prompt', async () => {
  await fakeDocket(false, async (base, calls) => {
    const result = await prepare(base);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(
      calls.map((call) => call.name),
      ['create_item', 'set_status', 'set_status'],
    );
    assert.equal(calls[0].args.project, 'RCP');
    assert.match(calls[0].args.outcome_md, /Codex CLI \(host\)/);
    assert.equal(calls[0].args.acceptance.length, 1);
    assert.equal(calls[0].args.shared, 'none');
    assert.deepEqual(
      calls.slice(1).map((call) => call.args.status),
      ['planning', 'ready'],
    );
    assert.match(result.stdout, /Prepared RCP-101 for Codex CLI \(host\)/);
    assert.match(result.stdout, /claim_lead on RCP-101/);
  });
});

test('prepare reports a rejected Ready gate and does not print a client prompt', async () => {
  await fakeDocket(true, async (base, calls) => {
    const result = await prepare(base);
    assert.equal(result.code, 1);
    assert.deepEqual(
      calls.slice(1).map((call) => call.args.status),
      ['planning', 'ready'],
    );
    assert.match(
      result.stderr,
      /Couldn't move RCP-101 to ready: design_review: synthetic Ready hold/,
    );
    assert.doesNotMatch(result.stdout, /Paste this into the client|claim_lead on RCP-101/);
  });
});
