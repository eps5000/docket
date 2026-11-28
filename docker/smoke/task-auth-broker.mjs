import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  PILOT_MCP_URL,
  assessDisposable,
  assertNoDrift,
  fixtureEnvironment,
  hashOnlySnapshot,
  runFakeClient,
  validateRoute,
} from './auth-route.mjs';

const PILOT_TASK = 'DKT-10';
const PILOT_SCOPE = 'docket:sample:pilot';
const MAX_LEASE_MS = 5 * 60 * 1000;
const STOP_CODES = new Set([
  'STOP_SURFACE_UNKNOWN',
  'STOP_DISPOSABLE_MCP_ROUTE',
  'STOP_PROFILE_NOT_ABSOLUTE',
  'STOP_PROFILE_ABSENT',
  'STOP_PROFILE_UNSAFE',
  'STOP_PROFILE_OVERLAP',
  'STOP_RESOURCE_PROVENANCE',
  'STOP_RESOURCE_UNKNOWN',
  'STOP_RESOURCE_IDENTITY',
  'STOP_RESOURCE_ROUTE',
  'STOP_RESOURCE_OWNERSHIP',
  'STOP_TASK_PROFILE_DIRECTORY',
  'STOP_FAKE_SCRIPT_PATH',
  'STOP_HASH_TARGET_CHANGED',
  'STOP_DEFAULT_OR_PROJECT_DRIFT',
  'STOP_FAKE_LEASE_INVALID',
  'STOP_FAKE_LEASE_EXPIRED',
  'STOP_FAKE_CLIENT_EXIT',
]);

function keyName(surface) {
  if (surface === 'codex' || surface === 'orca-codex') return 'CODEX_API_KEY';
  if (surface === 'claude' || surface === 'orca-claude') return 'ANTHROPIC_API_KEY';
  throw new Error('STOP_SURFACE_UNKNOWN');
}

function syntheticBinding(value) {
  return typeof value === 'string' && /^FAKE_[A-Z0-9_]{1,80}$/.test(value);
}

function stop(error) {
  if (error instanceof Error && STOP_CODES.has(error.message)) return new Error(error.message);
  return new Error('STOP_FAKE_BROKER_ERROR');
}

async function assertTaskDirectories(profile, env) {
  const realProfile = await realpath(profile);
  for (const directory of [
    env.HOME,
    env.APPDATA,
    env.LOCALAPPDATA,
    env.TMP,
    env.CODEX_HOME,
    env.CLAUDE_CONFIG_DIR,
    path.join(profile, 'fixture'),
  ]) {
    const stat = await lstat(directory).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink())
      throw new Error('STOP_TASK_PROFILE_DIRECTORY');
    const realDirectory = await realpath(directory);
    const relative = path.relative(realProfile, realDirectory);
    if (
      relative === '' ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error('STOP_TASK_PROFILE_DIRECTORY');
    }
  }
}

async function assertFakeScript(script, profile) {
  if (typeof script !== 'string' || !path.isAbsolute(script))
    throw new Error('STOP_FAKE_SCRIPT_PATH');
  const expected = path.join(profile, 'fixture', 'fake-client.mjs');
  const stat = await lstat(script).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error('STOP_FAKE_SCRIPT_PATH');
  if ((await realpath(script)) !== (await realpath(expected)))
    throw new Error('STOP_FAKE_SCRIPT_PATH');
}

function assertFakeLease(lease, request, nowMs) {
  if (
    !lease ||
    lease.kind !== 'fake' ||
    lease.taskId !== PILOT_TASK ||
    lease.surface !== request.surface ||
    lease.scope !== PILOT_SCOPE ||
    lease.mcpUrl !== PILOT_MCP_URL ||
    lease.keyName !== keyName(request.surface) ||
    lease.accountBinding !== request.accountBinding ||
    lease.billingBinding !== request.billingBinding ||
    lease.leastPrivilege !== true ||
    lease.revocable !== true ||
    !Number.isSafeInteger(lease.issuedAtMs) ||
    !Number.isSafeInteger(lease.expiresAtMs) ||
    lease.issuedAtMs !== nowMs ||
    lease.expiresAtMs <= nowMs ||
    lease.expiresAtMs - nowMs > MAX_LEASE_MS ||
    typeof lease.fakeKey !== 'string' ||
    !/^FAKE_DKT35_[A-Za-z0-9_-]{8,100}$/.test(lease.fakeKey) ||
    typeof lease.revoke !== 'function'
  ) {
    throw new Error('STOP_FAKE_LEASE_INVALID');
  }
}

/**
 * Synthetic contract probe only. A real provider and client command cannot be passed here.
 * The fake key is scoped to a Node fixture process and never returned or logged.
 */
export async function runFakeBrokeredPilot({
  provider,
  surface,
  profile,
  projectRoot,
  userHome,
  mcpUrl,
  manifest,
  script,
  accountBinding,
  billingBinding,
  parentEnv = process.env,
  clock = Date.now,
}) {
  let providerKind;
  let issue;
  try {
    providerKind = provider?.kind;
    issue = provider?.issue;
  } catch {
    throw new Error('STOP_BROKER_UNAVAILABLE');
  }
  if (providerKind !== 'fake' || typeof issue !== 'function')
    throw new Error('STOP_BROKER_UNAVAILABLE');
  if (!syntheticBinding(accountBinding) || !syntheticBinding(billingBinding))
    throw new Error('STOP_BINDING_UNREVIEWED');
  if (typeof clock !== 'function') throw new Error('STOP_CLOCK_UNKNOWN');
  let nowMs;
  try {
    nowMs = clock();
  } catch {
    throw new Error('STOP_CLOCK_UNKNOWN');
  }
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error('STOP_CLOCK_UNKNOWN');
  let route;
  let resource;
  let env;
  let before;
  try {
    route = await validateRoute({ surface, profile, projectRoot, userHome, mcpUrl });
    if (manifest?.kind !== 'fake') throw new Error('STOP_RESOURCE_PROVENANCE');
    resource = assessDisposable(manifest);
    env = fixtureEnvironment({ surface, profile, mcpUrl, parentEnv });
    await assertTaskDirectories(profile, env);
    await assertFakeScript(script, profile);
    before = await hashOnlySnapshot({ userHome, projectRoot });
  } catch (error) {
    throw stop(error);
  }
  const request = Object.freeze({
    taskId: PILOT_TASK,
    surface,
    scope: PILOT_SCOPE,
    mcpUrl: PILOT_MCP_URL,
    accountBinding,
    billingBinding,
    nowMs,
  });

  let lease;
  let failure;
  try {
    lease = await issue.call(provider, request);
    assertFakeLease(lease, request, nowMs);
    env[lease.keyName] = lease.fakeKey;
    const code = await runFakeClient({ script, env });
    if (code !== 0) throw new Error('STOP_FAKE_CLIENT_EXIT');
    const afterMs = clock();
    if (!Number.isSafeInteger(afterMs) || afterMs < nowMs || afterMs >= lease.expiresAtMs)
      throw new Error('STOP_FAKE_LEASE_EXPIRED');
  } catch (error) {
    failure = stop(error);
  }

  try {
    assertNoDrift(before, await hashOnlySnapshot({ userHome, projectRoot }));
  } catch (error) {
    failure = stop(error);
  }
  try {
    if (lease && typeof lease.revoke === 'function') {
      await lease.revoke(failure ? 'STOP' : 'RELEASE');
    }
  } catch {
    failure = new Error('STOP_FAKE_LEASE_REVOKE');
  }
  if (failure) throw failure;
  return {
    decision: 'FAKE_ONLY',
    surface: route.surface,
    resource_assessment: resource.decision,
    fake_child_invoked: true,
    real_client_invoked: false,
    lease_revoked: true,
  };
}
