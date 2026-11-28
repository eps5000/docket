import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PILOT_MCP_URL } from './auth-route.mjs';
import { runFakeBrokeredPilot } from './task-auth-broker.mjs';

const ACCOUNT = 'FAKE_ACCOUNT_BOUND';
const BILLING = 'FAKE_BILLING_BOUND';

function manifest() {
  const pilotId = 'a'.repeat(64);
  return {
    kind: 'fake',
    pilot: {
      id: pilotId,
      address: '127.0.0.2:7421',
      seed: 'sample',
      health: 'healthy',
      containerName: 'dkt35-pilot',
      volume: 'dkt35-pilot-data',
      mounts: ['dkt35-pilot-data'],
      mountTarget: '/data',
    },
    live: {
      id: 'b'.repeat(64),
      address: '127.0.0.1:7420',
      health: 'healthy',
      mounts: ['docket-data'],
    },
    dev: {
      id: 'c'.repeat(64),
      address: '127.0.0.1:7421',
      health: 'healthy',
      mounts: ['docket-dev-data'],
    },
    volumeUsers: [pilotId],
  };
}

function fakeProvider({ changeLease, issueError, revokeError } = {}) {
  const issued = [];
  const revoked = [];
  const fakeKey = `FAKE_DKT35_${randomUUID()}`;
  return {
    kind: 'fake',
    issued,
    revoked,
    fakeKey,
    async issue(request) {
      issued.push(request);
      if (issueError) throw issueError;
      const lease = {
        kind: 'fake',
        taskId: 'DKT-10',
        surface: request.surface,
        scope: 'docket:sample:pilot',
        mcpUrl: PILOT_MCP_URL,
        keyName: request.surface.endsWith('codex') ? 'CODEX_API_KEY' : 'ANTHROPIC_API_KEY',
        accountBinding: request.accountBinding,
        billingBinding: request.billingBinding,
        leastPrivilege: true,
        revocable: true,
        issuedAtMs: request.nowMs,
        expiresAtMs: request.nowMs + 60_000,
        fakeKey,
        async revoke(reason) {
          revoked.push(reason);
          if (revokeError) throw revokeError;
        },
      };
      return changeLease ? changeLease(lease) : lease;
    },
  };
}

async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'dkt35-broker-'));
  const userHome = path.join(root, 'user');
  const projectRoot = path.join(root, 'project');
  const profile = path.join(root, 'pilot');
  await Promise.all([mkdir(userHome), mkdir(projectRoot), mkdir(profile)]);
  for (const name of ['home', 'roaming', 'local', 'temp', 'codex', 'claude', 'fixture']) {
    await mkdir(path.join(profile, name));
  }
  const script = path.join(profile, 'fixture', 'fake-client.mjs');
  const output = path.join(root, 'fake-output.json');
  await writeFile(
    script,
    `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(output)}, JSON.stringify({
  codex: Object.hasOwn(process.env, 'CODEX_API_KEY'),
  claude: Object.hasOwn(process.env, 'ANTHROPIC_API_KEY'),
  home: process.env.HOME,
  temp: process.env.TEMP,
  mcp: process.env.DOCKET_MCP_URL,
}));`,
  );
  const options = {
    surface: 'codex',
    profile,
    projectRoot,
    userHome,
    mcpUrl: PILOT_MCP_URL,
    manifest: manifest(),
    script,
    accountBinding: ACCOUNT,
    billingBinding: BILLING,
    parentEnv: {
      ...process.env,
      CODEX_API_KEY: 'FAKE_PARENT_KEY',
      ANTHROPIC_API_KEY: 'FAKE_PARENT_KEY',
    },
    clock: () => 1_800_000_000_000,
  };
  try {
    await run({ root, output, script, options });
  } finally {
    assert.equal(path.dirname(root), tmpdir());
    assert.match(path.basename(root), /^dkt35-broker-/);
    await rm(root, { recursive: true, force: true });
  }
}

test('four fake surfaces receive only their synthetic lease and revoke on release', async () => {
  await fixture(async ({ output, options }) => {
    for (const surface of ['codex', 'claude', 'orca-codex', 'orca-claude']) {
      const provider = fakeProvider();
      const result = await runFakeBrokeredPilot({ ...options, surface, provider });
      const observed = JSON.parse(await readFile(output, 'utf8'));
      assert.equal(result.decision, 'FAKE_ONLY');
      assert.equal(result.real_client_invoked, false);
      assert.equal(result.fake_child_invoked, true);
      assert.equal(result.resource_assessment, 'IDENTITY_CANDIDATE');
      assert.equal(result.revoke_call_completed, true);
      assert.equal(observed.codex, surface.endsWith('codex'));
      assert.equal(observed.claude, surface.endsWith('claude'));
      assert.equal(observed.home, path.join(options.profile, 'home'));
      assert.equal(observed.temp, path.join(options.profile, 'temp'));
      assert.equal(observed.mcp, PILOT_MCP_URL);
      assert.deepEqual(provider.revoked, ['RELEASE']);
      assert.equal(provider.issued.length, 1);
      assert.equal(JSON.stringify({ result, observed }).includes(provider.fakeKey), false);
    }
  });
});

test('a no-op fake revoke is reported only as a completed callback', async () => {
  await fixture(async ({ options }) => {
    const provider = fakeProvider({
      changeLease: (lease) => ({ ...lease, revoke: async () => {} }),
    });
    const result = await runFakeBrokeredPilot({ ...options, provider });
    assert.equal(result.revoke_call_completed, true);
    assert.equal(Object.hasOwn(result, 'lease_revoked'), false);
    assert.deepEqual(provider.revoked, []);
  });
});

test('missing or real provider, unsafe route, profile, script and manifest stop before issue', async () => {
  await fixture(async ({ root, options }) => {
    const provider = fakeProvider();
    await assert.rejects(
      runFakeBrokeredPilot({ ...options, provider: null }),
      /STOP_BROKER_UNAVAILABLE/,
    );
    await assert.rejects(
      runFakeBrokeredPilot({ ...options, provider: { ...provider, kind: 'real' } }),
      /STOP_BROKER_UNAVAILABLE/,
    );
    await assert.rejects(
      runFakeBrokeredPilot({ ...options, provider, mcpUrl: 'http://127.0.0.1:7420/mcp' }),
      /STOP_DISPOSABLE_MCP_ROUTE/,
    );
    await assert.rejects(
      runFakeBrokeredPilot({ ...options, provider, profile: options.userHome }),
      /STOP_PROFILE_OVERLAP/,
    );
    const outside = path.join(root, 'outside.mjs');
    await writeFile(outside, 'process.exit(0);');
    await assert.rejects(
      runFakeBrokeredPilot({ ...options, provider, script: outside }),
      /STOP_FAKE_SCRIPT_PATH/,
    );
    await assert.rejects(
      runFakeBrokeredPilot({
        ...options,
        provider,
        manifest: { ...options.manifest, kind: 'real' },
      }),
      /STOP_RESOURCE_PROVENANCE/,
    );
    await assert.rejects(
      runFakeBrokeredPilot({
        ...options,
        provider,
        manifest: {
          ...options.manifest,
          pilot: { ...options.manifest.pilot, mounts: ['dkt35-pilot-data', 'docket-data'] },
        },
      }),
      /STOP_RESOURCE_OWNERSHIP/,
    );
    await assert.rejects(
      runFakeBrokeredPilot({ ...options, provider, accountBinding: 'real-account-name' }),
      /STOP_BINDING_UNREVIEWED/,
    );
    assert.equal(provider.issued.length, 0);
  });
});

test('malformed or overlong fake lease stops and revokes without launching a child', async () => {
  await fixture(async ({ output, options }) => {
    for (const changeLease of [
      (lease) => ({ ...lease, surface: 'claude' }),
      (lease) => ({ ...lease, accountBinding: 'FAKE_OTHER' }),
      (lease) => ({ ...lease, expiresAtMs: lease.issuedAtMs + 360_000 }),
      (lease) => ({ ...lease, leastPrivilege: false }),
      (lease) => ({ ...lease, fakeKey: 'not-a-fake-key' }),
    ]) {
      const provider = fakeProvider({ changeLease });
      await assert.rejects(
        runFakeBrokeredPilot({ ...options, provider }),
        /STOP_FAKE_LEASE_INVALID/,
      );
      assert.deepEqual(provider.revoked, ['STOP']);
      await assert.rejects(readFile(output, 'utf8'), { code: 'ENOENT' });
    }
  });
});

test('default auth drift stops and revokes the fake lease without exposing content', async () => {
  await fixture(async ({ root, script, options }) => {
    const authDir = path.join(options.userHome, '.codex');
    await mkdir(authDir);
    const auth = path.join(authDir, 'auth.json');
    await writeFile(auth, 'FAKE_BEFORE');
    await writeFile(
      script,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(auth)}, 'FAKE_AFTER');`,
    );
    const provider = fakeProvider();
    await assert.rejects(
      runFakeBrokeredPilot({ ...options, provider }),
      /STOP_DEFAULT_OR_PROJECT_DRIFT/,
    );
    assert.deepEqual(provider.revoked, ['STOP']);
    assert.equal((await readFile(auth, 'utf8')).includes(provider.fakeKey), false);
    assert.equal(path.dirname(root), tmpdir());
  });
});

test('missing task-only temp and nonzero fake child fail closed', async () => {
  await fixture(async ({ options }) => {
    await rmdir(path.join(options.profile, 'temp'));
    const provider = fakeProvider();
    await assert.rejects(
      runFakeBrokeredPilot({ ...options, provider }),
      /STOP_TASK_PROFILE_DIRECTORY/,
    );
    assert.equal(provider.issued.length, 0);
  });
  await fixture(async ({ script, options }) => {
    await writeFile(script, 'process.exit(2);');
    const provider = fakeProvider();
    await assert.rejects(runFakeBrokeredPilot({ ...options, provider }), /STOP_FAKE_CLIENT_EXIT/);
    assert.deepEqual(provider.revoked, ['STOP']);
  });
});

test('fake lease expiry during a child run stops and revokes', async () => {
  await fixture(async ({ options }) => {
    const provider = fakeProvider();
    let calls = 0;
    const clock = () => {
      calls += 1;
      return 1_800_000_000_000 + (calls === 1 ? 0 : 61_000);
    };
    await assert.rejects(
      runFakeBrokeredPilot({ ...options, provider, clock }),
      /STOP_FAKE_LEASE_EXPIRED/,
    );
    assert.deepEqual(provider.revoked, ['STOP']);
  });
});

test('provider and revoke errors are bounded STOP categories with no fake key leak', async () => {
  await fixture(async ({ options }) => {
    const issueProvider = fakeProvider({ issueError: new Error('FAKE_PROVIDER_DETAIL') });
    await assert.rejects(
      runFakeBrokeredPilot({ ...options, provider: issueProvider }),
      (error) => error.message === 'STOP_FAKE_BROKER_ERROR',
    );
    const forgedStop = fakeProvider({ issueError: new Error('STOP_FAKE_LEASE_INVALID') });
    await assert.rejects(
      runFakeBrokeredPilot({ ...options, provider: forgedStop }),
      (error) => error.message === 'STOP_FAKE_BROKER_ERROR',
    );
    const revokeProvider = fakeProvider({ revokeError: new Error('FAKE_REVOKE_DETAIL') });
    await assert.rejects(
      runFakeBrokeredPilot({ ...options, provider: revokeProvider }),
      (error) => error.message === 'STOP_FAKE_LEASE_REVOKE',
    );
    assert.deepEqual(revokeProvider.revoked, ['RELEASE']);
  });
});
