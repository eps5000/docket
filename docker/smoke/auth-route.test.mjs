import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  PILOT_MCP_URL,
  assessDisposable,
  assertNoDrift,
  authCandidates,
  changedLabels,
  fixtureEnvironment,
  hashOnlySnapshot,
  preflight,
  runFakeClient,
  runGuardedFakeClient,
  validateRoute,
} from './auth-route.mjs';

async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'dkt34-auth-route-'));
  const userHome = path.join(root, 'user');
  const projectRoot = path.join(root, 'project');
  const profile = path.join(root, 'pilot');
  await Promise.all([mkdir(userHome), mkdir(projectRoot), mkdir(profile)]);
  try {
    await run({ root, userHome, projectRoot, profile });
  } finally {
    assert.equal(path.dirname(root), tmpdir());
    assert.match(path.basename(root), /^dkt34-auth-route-/);
    await rm(root, { recursive: true, force: true });
  }
}

test('preflight accepts only the exact disposable MCP route and isolated profile', async () => {
  await fixture(async ({ userHome, projectRoot, profile }) => {
    for (const surface of ['codex', 'claude', 'orca-codex', 'orca-claude']) {
      const route = await validateRoute({
        surface,
        profile,
        projectRoot,
        userHome,
        mcpUrl: PILOT_MCP_URL,
      });
      assert.equal(route.surface, surface);
    }
    for (const mcpUrl of ['http://127.0.0.1:7420/mcp', 'http://127.0.0.1:7421/mcp']) {
      await assert.rejects(
        validateRoute({ surface: 'codex', profile, projectRoot, userHome, mcpUrl }),
        /STOP_DISPOSABLE_MCP_ROUTE/,
      );
    }
    await assert.rejects(
      validateRoute({
        surface: 'codex',
        profile: userHome,
        projectRoot,
        userHome,
        mcpUrl: PILOT_MCP_URL,
      }),
      /STOP_PROFILE_OVERLAP/,
    );
    await assert.rejects(
      validateRoute({
        surface: 'orca-claude',
        profile: projectRoot,
        projectRoot,
        userHome,
        mcpUrl: PILOT_MCP_URL,
      }),
      /STOP_PROFILE_OVERLAP/,
    );
  });
});

test('snapshot emits hashes and metadata only, and detects default/project drift', async () => {
  await fixture(async ({ userHome, projectRoot }) => {
    const codex = path.join(userHome, '.codex');
    await mkdir(codex);
    const auth = path.join(codex, 'auth.json');
    const secretLikeFixture = `FAKE_TEST_ONLY_${randomUUID()}`;
    await writeFile(auth, secretLikeFixture);
    const before = await hashOnlySnapshot({ userHome, projectRoot });
    assert.equal(before.codex_auth.presence, 'file');
    assert.equal(before.codex_auth.sha256.length, 64);
    assert.equal(before.project_mcp.presence, 'absent');
    assert.equal(JSON.stringify(before).includes(secretLikeFixture), false);
    await writeFile(auth, `changed-${secretLikeFixture}`);
    const after = await hashOnlySnapshot({ userHome, projectRoot });
    assert.deepEqual(changedLabels(before, after), ['codex_auth']);
    assert.throws(
      () => assertNoDrift(before, after),
      (error) => {
        assert.equal(error.message, 'STOP_DEFAULT_OR_PROJECT_DRIFT');
        assert.deepEqual(error.changedLabels, ['codex_auth']);
        return true;
      },
    );
  });
});

test('fake child hash guard stops on default auth drift without exposing content', async () => {
  await fixture(async ({ root, userHome, projectRoot, profile }) => {
    const codex = path.join(userHome, '.codex');
    await mkdir(codex);
    const auth = path.join(codex, 'auth.json');
    await writeFile(auth, 'FAKE_BEFORE');
    const script = path.join(root, 'fake-drift.mjs');
    await writeFile(
      script,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(auth)}, 'FAKE_AFTER');`,
    );
    const env = fixtureEnvironment({
      surface: 'codex',
      profile,
      mcpUrl: PILOT_MCP_URL,
      parentEnv: process.env,
    });
    await assert.rejects(
      runGuardedFakeClient({ script, env, userHome, projectRoot }),
      /STOP_DEFAULT_OR_PROJECT_DRIFT/,
    );
  });
});

test('disposable resource assessment accepts only exact sole-use sample identity', () => {
  const pilot = {
    id: 'a'.repeat(64),
    address: '127.0.0.2:7421',
    seed: 'sample',
    health: 'healthy',
    containerName: 'dkt34-pilot',
    volume: 'dkt34-pilot-data',
    mounts: ['dkt34-pilot-data'],
  };
  const live = {
    id: 'b'.repeat(64),
    address: '127.0.0.1:7420',
    health: 'healthy',
    mounts: ['docket-data'],
  };
  const dev = {
    id: 'c'.repeat(64),
    address: '127.0.0.1:7421',
    health: 'healthy',
    mounts: ['docket-dev-data'],
  };
  assert.equal(
    assessDisposable({ pilot, live, dev, volumeUsers: [pilot.id] }).decision,
    'IDENTITY_CANDIDATE',
  );
  assert.throws(
    () => assessDisposable({ pilot, live, dev, volumeUsers: [pilot.id, live.id] }),
    /STOP_RESOURCE_OWNERSHIP/,
  );
  assert.throws(
    () =>
      assessDisposable({
        pilot: { ...pilot, address: '127.0.0.1:7420' },
        live,
        dev,
        volumeUsers: [pilot.id],
      }),
    /STOP_RESOURCE_ROUTE/,
  );
  assert.throws(
    () => assessDisposable({ pilot: { ...pilot, mounts: [] }, live, dev, volumeUsers: [pilot.id] }),
    /STOP_RESOURCE_OWNERSHIP/,
  );
});

test('fake process receives task-only homes and endpoint without inherited credentials', async () => {
  await fixture(async ({ root, profile }) => {
    const output = path.join(root, 'fixture-result.json');
    const script = path.join(root, 'fake-client.mjs');
    await writeFile(
      script,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(output)}, JSON.stringify({home:process.env.HOME, codex:process.env.CODEX_HOME, claude:process.env.CLAUDE_CONFIG_DIR, mcp:process.env.DOCKET_MCP_URL, inheritedKey:'OPENAI_API_KEY' in process.env || 'ANTHROPIC_API_KEY' in process.env}));`,
    );
    const parentEnv = {
      ...process.env,
      OPENAI_API_KEY: 'FAKE_TEST_ONLY',
      ANTHROPIC_API_KEY: 'FAKE_TEST_ONLY',
    };
    for (const surface of ['codex', 'claude', 'orca-codex', 'orca-claude']) {
      const env = fixtureEnvironment({ surface, profile, mcpUrl: PILOT_MCP_URL, parentEnv });
      assert.equal(Object.hasOwn(env, 'OPENAI_API_KEY'), false);
      assert.equal(Object.hasOwn(env, 'ANTHROPIC_API_KEY'), false);
      assert.equal(await runFakeClient({ script, env }), 0);
      const observed = JSON.parse(await readFile(output, 'utf8'));
      assert.equal(observed.home, path.join(profile, 'home'));
      assert.equal(observed.codex, path.join(profile, 'codex'));
      assert.equal(observed.claude, path.join(profile, 'claude'));
      assert.equal(observed.mcp, PILOT_MCP_URL);
      assert.equal(observed.inheritedKey, false);
    }
  });
});

test('all surfaces remain STOP without an independently reviewed auth/startup source', async () => {
  await fixture(async ({ userHome, projectRoot, profile }) => {
    const result = await preflight(
      ['preflight', '--surface', 'orca-claude', '--profile', profile, '--mcp-url', PILOT_MCP_URL],
      { userHome, projectRoot, env: { ANTHROPIC_API_KEY: 'FAKE_TEST_ONLY' } },
    );
    assert.equal(result.decision, 'STOP');
    assert.equal(result.client_invoked, false);
    assert.deepEqual(result.auth_candidate_names, ['ANTHROPIC_API_KEY']);
    assert.equal(JSON.stringify(result).includes('FAKE_TEST_ONLY'), false);
    assert.deepEqual(authCandidates('codex', { OPENAI_API_KEY: 'FAKE_TEST_ONLY' }), [
      'OPENAI_API_KEY',
    ]);
    assert.deepEqual(
      authCandidates('codex', {
        OPENAI_FEDERATION_RULE_ID: 'FAKE',
        OPENAI_IDENTITY_TOKEN_FILE: 'FAKE',
      }),
      ['OPENAI_IDENTITY_TOKEN_FILE', 'OPENAI_FEDERATION_RULE_ID'],
    );
    assert.deepEqual(
      authCandidates('claude', { ANTHROPIC_AUTH_TOKEN: 'FAKE', ANTHROPIC_PROFILE: 'FAKE' }),
      ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_PROFILE'],
    );
    const unreadable = {};
    Object.defineProperty(unreadable, 'ANTHROPIC_API_KEY', {
      enumerable: true,
      get() {
        throw new Error('credential value was read');
      },
    });
    assert.deepEqual(authCandidates('claude', unreadable), ['ANTHROPIC_API_KEY']);
  });
});
