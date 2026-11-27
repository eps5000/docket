import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PILOT_MCP_URL = 'http://127.0.0.2:7421/mcp';
export const SURFACES = ['codex', 'claude', 'orca-codex', 'orca-claude'];

const DEFAULT_FILES = {
  codex_config: ['.codex', 'config.toml'],
  codex_auth: ['.codex', 'auth.json'],
  claude_state: ['.claude.json'],
  claude_auth: ['.claude', '.credentials.json'],
  claude_settings: ['.claude', 'settings.json'],
};
const PROJECT_FILES = {
  project_mcp: ['.mcp.json'],
  project_codex: ['.codex', 'config.toml'],
  project_claude: ['.claude', 'settings.json'],
  project_claude_local: ['.claude', 'settings.local.json'],
};

function sameOrInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function normalized(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export async function validateRoute({ surface, profile, projectRoot, userHome, mcpUrl }) {
  if (!SURFACES.includes(surface)) throw new Error('STOP_SURFACE_UNKNOWN');
  if (mcpUrl !== PILOT_MCP_URL) throw new Error('STOP_DISPOSABLE_MCP_ROUTE');
  if (!path.isAbsolute(profile)) throw new Error('STOP_PROFILE_NOT_ABSOLUTE');
  const profileStat = await lstat(profile).catch((error) => {
    if (error.code === 'ENOENT') throw new Error('STOP_PROFILE_ABSENT');
    throw error;
  });
  if (!profileStat.isDirectory() || profileStat.isSymbolicLink())
    throw new Error('STOP_PROFILE_UNSAFE');
  const realProfile = normalized(await realpath(profile));
  const realProject = normalized(await realpath(projectRoot));
  const realHome = normalized(await realpath(userHome));
  if (
    sameOrInside(realProfile, realProject) ||
    sameOrInside(realProject, realProfile) ||
    sameOrInside(realHome, realProfile) ||
    sameOrInside(realProfile, path.join(realHome, '.codex')) ||
    sameOrInside(realProfile, path.join(realHome, '.claude')) ||
    realProfile === path.join(realHome, '.claude.json')
  ) {
    throw new Error('STOP_PROFILE_OVERLAP');
  }
  return { surface, profile: realProfile, mcpUrl };
}

async function fileDigest(filename) {
  const stat = await lstat(filename).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stat === null) return { presence: 'absent' };
  if (!stat.isFile() || stat.isSymbolicLink()) return { presence: 'unsafe' };
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return {
    presence: 'file',
    sha256: hash.digest('hex'),
    bytes: stat.size,
    modified_ms: stat.mtimeMs,
  };
}

export async function hashOnlySnapshot({ userHome, projectRoot }) {
  const result = {};
  for (const [label, segments] of Object.entries(DEFAULT_FILES)) {
    result[label] = await fileDigest(path.join(userHome, ...segments));
  }
  for (const [label, segments] of Object.entries(PROJECT_FILES)) {
    result[label] = await fileDigest(path.join(projectRoot, ...segments));
  }
  return result;
}

export function changedLabels(before, after) {
  return Object.keys(before).filter(
    (label) => JSON.stringify(before[label]) !== JSON.stringify(after[label]),
  );
}

/** Pure validation of action-time Docker inspect data; it never runs Docker or removes a resource. */
export function assessDisposable({ pilot, live, dev, volumeUsers }) {
  if (!pilot || !live || !dev || !Array.isArray(volumeUsers))
    throw new Error('STOP_RESOURCE_UNKNOWN');
  const ids = [pilot.id, live.id, dev.id];
  if (ids.some((id) => !/^[a-f0-9]{64}$/.test(id)) || new Set(ids).size !== 3) {
    throw new Error('STOP_RESOURCE_IDENTITY');
  }
  if (
    pilot.address !== '127.0.0.2:7421' ||
    live.address !== '127.0.0.1:7420' ||
    dev.address !== '127.0.0.1:7421' ||
    pilot.seed !== 'sample' ||
    pilot.health !== 'healthy' ||
    live.health !== 'healthy' ||
    dev.health !== 'healthy'
  ) {
    throw new Error('STOP_RESOURCE_ROUTE');
  }
  if (
    !/^dkt[0-9]+-[a-z0-9-]+$/.test(pilot.containerName) ||
    !/^dkt[0-9]+-[a-z0-9-]+$/.test(pilot.volume) ||
    !pilot.mounts?.includes(pilot.volume) ||
    live.mounts?.includes(pilot.volume) ||
    dev.mounts?.includes(pilot.volume) ||
    volumeUsers.length !== 1 ||
    volumeUsers[0] !== pilot.id
  ) {
    throw new Error('STOP_RESOURCE_OWNERSHIP');
  }
  return { decision: 'IDENTITY_CANDIDATE', containerId: pilot.id, volume: pilot.volume };
}

/** Candidate evidence only. Presence never proves ownership, permission, or a valid login. */
export function authCandidates(surface, env) {
  const names =
    surface.endsWith('codex') || surface === 'codex'
      ? [
          'OPENAI_API_KEY',
          'CODEX_ACCESS_TOKEN',
          'OPENAI_IDENTITY_TOKEN_FILE',
          'OPENAI_WORKLOAD_IDENTITY_PROVIDER_ID',
        ]
      : ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_PROFILE'];
  return names.filter(
    (name) => Object.hasOwn(env, name) && typeof env[name] === 'string' && env[name].length > 0,
  );
}

/** No credential environment variable crosses this boundary. Only a reviewed provider may add one later. */
export function fixtureEnvironment({ surface, profile, mcpUrl, parentEnv }) {
  if (!SURFACES.includes(surface) || mcpUrl !== PILOT_MCP_URL)
    throw new Error('STOP_DISPOSABLE_MCP_ROUTE');
  const env = {};
  for (const name of [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'WINDIR',
    'ComSpec',
    'TMP',
    'TEMP',
  ]) {
    if (Object.hasOwn(parentEnv, name)) env[name] = parentEnv[name];
  }
  env.HOME = path.join(profile, 'home');
  env.USERPROFILE = env.HOME;
  env.APPDATA = path.join(profile, 'roaming');
  env.LOCALAPPDATA = path.join(profile, 'local');
  env.CODEX_HOME = path.join(profile, 'codex');
  env.CLAUDE_CONFIG_DIR = path.join(profile, 'claude');
  env.DOCKET_URL = 'http://127.0.0.2:7421';
  env.DOCKET_MCP_URL = mcpUrl;
  return env;
}

/** Test-only execution seam: accepts Node itself and never exposes child output. */
export async function runFakeClient({ script, env, timeoutMs = 3000 }) {
  if (!path.isAbsolute(script) || !script.endsWith('.mjs')) throw new Error('STOP_FIXTURE_PATH');
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env,
      stdio: 'ignore',
      windowsHide: true,
      signal: AbortSignal.timeout(timeoutMs),
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
}

function argumentsOf(argv) {
  if (argv[0] !== 'preflight') throw new Error('STOP_COMMAND_UNKNOWN');
  const result = {};
  for (let i = 1; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || !argv[i + 1]) throw new Error('STOP_ARGUMENTS');
    const key = argv[i].slice(2);
    if (!['surface', 'profile', 'mcp-url'].includes(key) || Object.hasOwn(result, key)) {
      throw new Error('STOP_ARGUMENTS');
    }
    result[key] = argv[i + 1];
  }
  if (!result.surface || !result.profile || !result['mcp-url']) throw new Error('STOP_ARGUMENTS');
  return result;
}

export async function preflight(
  argv,
  { userHome = homedir(), projectRoot = process.cwd(), env = process.env } = {},
) {
  const args = argumentsOf(argv);
  const route = await validateRoute({
    surface: args.surface,
    profile: args.profile,
    projectRoot,
    userHome,
    mcpUrl: args['mcp-url'],
  });
  const hashes = await hashOnlySnapshot({ userHome, projectRoot });
  return {
    decision: 'STOP',
    reason: 'AUTH_SOURCE_AND_STARTUP_NOT_INDEPENDENTLY_REVIEWED',
    surface: route.surface,
    mcp_url: route.mcpUrl,
    auth_candidate_names: authCandidates(route.surface, env),
    hashes,
    client_invoked: false,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await preflight(process.argv.slice(2));
    console.log(JSON.stringify(result));
    process.exitCode = 2;
  } catch (error) {
    console.error(error.message?.startsWith('STOP_') ? error.message : 'STOP_PREFLIGHT_ERROR');
    process.exitCode = 2;
  }
}
