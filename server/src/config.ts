/**
 * Configuration (BUILD_SPEC §2 "Configuration" and "Volume layout") and
 * secret bootstrap (§3).
 *
 * - Every variable has its documented default.
 * - The agent token comes from DOCKET_TOKEN, else /data/secrets/agent-token
 *   (generated on first boot). The owner key is always /data/secrets/owner-key
 *   (generated on first boot: 32 random bytes, base32). Both files are 0600.
 * - Secrets are never logged: nothing here prints them, and config errors
 *   name the variable, never a secret value.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { LEGACY_DB_FILE, withLegacyEnv } from '@docket/shared';

export interface Config {
  dataDir: string;
  /** DOCKET_TOKEN, when set. Otherwise the token lives in `paths.agentToken`. */
  tokenFromEnv: string | null;
  port: number;
  allowedHosts: string[];
  liveWindowMs: number;
  staleAfterMs: number;
  leaseMs: number;
  /**
   * How long a lease on a single-writer shared part lasts from its latest take
   * (decision 36; BUILD_SPEC §5.21): DOCKET_LEASE_MINUTES, default 120.
   */
  partLeaseMs: number;
  /** A run parked longer than this shows under Problems; it keeps its claim (§5.16). */
  parkMaxMs: number;
  /**
   * How long the leads of the items involved have to fix an agent problem (a
   * radar finding) before it reaches the owner's Problems (owner decision 37;
   * BUILD_SPEC §5.21): DOCKET_AGENT_PROBLEM_GRACE_HOURS, default 24.
   */
  agentProblemGraceMs: number;
  /**
   * How long an overlap Docket handled may stay unresolved before it reaches
   * the owner (owner decision 39; BUILD_SPEC §5.21):
   * DOCKET_OVERLAP_GRACE_HOURS, default 24.
   */
  overlapGraceMs: number;
  /** A parked run `resume_ready` this long shows as "Ready to resume, unattended" (§5.16). */
  resumeUnattendedMs: number;
  /** A resource unreleased this long after its run ended is orphaned (§5.16). */
  orphanAfterMs: number;
  /** `HH:MM`, local time. */
  backupAt: string;
  backupKeepDays: number;
  backupExtraDir: string | null;
  /**
   * Opt-in push install (decision 29; BUILD_SPEC §5.17): the container path of
   * a host folder the owner mounts. Null means push install is off.
   */
  pushRoot: string | null;
  /** The same folder's path on the host, so the UI can show and accept host paths. */
  pushHostPath: string | null;
  /**
   * How often push installs are checked for files edited outside Docket
   * (decision 30; BUILD_SPEC §5.19), and once at startup. Null: the check is
   * off (`0` or `off`). At least one minute (B26 resolution 11).
   */
  driftCheckIntervalMs: number | null;
  seed: 'sample' | null;
  /** B35: the sample seed also loads the stress project, STR (DOCKET_SEED_STRESS=1; e2e and CI). */
  seedStress: boolean;
  /** Display time zone; storage is always UTC. */
  tz: string | null;
  /**
   * Trust mode (owner decision 32; BUILD_SPEC §3). False (the default) is
   * local trust: no owner unlock and no agent token. True (`DOCKET_PROTECTED_MODE=on`)
   * requires the owner session on /api and the bearer token on /mcp. It is
   * configuration only: no route or tool changes it.
   */
  protectedMode: boolean;
  /**
   * `clientInfo.name`s (lower-cased) whose sessions get text-only tool results:
   * no `outputSchema`, no `structuredContent` (MCP_SPEC §3 Results; owner decision 28).
   */
  textOnlyClients: string[];
  /**
   * The data volume's name as the compose file gives it (DOCKET_DATA_VOLUME),
   * shown in Settings' service health. Null when not given.
   */
  dataVolume: string | null;
  /**
   * One warning per old `TASKLITE_*` setting used because its `DOCKET_*` one
   * is unset (B28): "TASKLITE_PORT is deprecated; use DOCKET_PORT". Never a
   * value. The server logs them once at startup.
   */
  deprecations: string[];
  paths: {
    db: string;
    docs: string;
    secrets: string;
    agentToken: string;
    ownerKey: string;
    logs: string;
    backups: string;
  };
  /** Whether the database file still has its old name (`tasklite.db`, kept as it is). */
  legacyDbFile: boolean;
}

export const DEFAULTS = {
  DOCKET_PORT: '7420',
  DOCKET_ALLOWED_HOSTS: '127.0.0.1:7420,localhost:7420',
  DOCKET_LIVE_WINDOW: '2m',
  DOCKET_STALE_AFTER: '30m',
  DOCKET_LEASE: '60m',
  // Decision 36: a lease on a single-writer shared part, in whole minutes.
  DOCKET_LEASE_MINUTES: '120',
  DOCKET_PARK_MAX: '24h',
  // Decision 37: agent problems reach the owner after this many whole hours unfixed.
  DOCKET_AGENT_PROBLEM_GRACE_HOURS: '24',
  DOCKET_OVERLAP_GRACE_HOURS: '24',
  DOCKET_RESUME_UNATTENDED: '30m',
  DOCKET_ORPHAN_AFTER: '15m',
  DOCKET_DRIFT_CHECK_INTERVAL: '15m',
  DOCKET_BACKUP_AT: '03:00',
  DOCKET_BACKUP_KEEP: '14',
  // Claude Code gives the model `structuredContent`, not the text (BUILD_SPEC §12 V6).
  DOCKET_TEXT_ONLY_CLIENTS: 'claude-code',
  // Decision 32: local trust by default; `on` restores the owner unlock and the agent token.
  DOCKET_PROTECTED_MODE: 'off',
} as const;

/** Every setting the server reads; each one's old `TASKLITE_*` name still works (B28). */
export const SETTING_NAMES = [
  ...(Object.keys(DEFAULTS) as (keyof typeof DEFAULTS)[]),
  'DOCKET_TOKEN',
  'DOCKET_SEED',
  'DOCKET_SEED_STRESS',
  'DOCKET_PUSH_ROOT',
  'DOCKET_PUSH_HOST_PATH',
  'DOCKET_BACKUP_EXTRA_DIR',
  'DOCKET_DATA_VOLUME',
] as const;

/** The database file on the data volume. */
export const DB_FILE = 'docket.db';

/**
 * The database file to open: `docket.db`, unless the volume still holds only
 * the old `tasklite.db` (a volume from before the rename). That file is used
 * where it is, never renamed or moved (B28: existing volumes are never touched).
 */
export function databaseFile(dataDir: string): { path: string; legacy: boolean } {
  const current = join(dataDir, DB_FILE);
  const legacy = join(dataDir, LEGACY_DB_FILE);
  if (!existsSync(current) && existsSync(legacy)) return { path: legacy, legacy: true };
  return { path: current, legacy: false };
}

/** The shortest drift-check interval (B26 resolution 11). */
const MIN_DRIFT_CHECK_INTERVAL_MS = 60_000;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const UNITS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `90s`, `2m`, `1h`, `500ms` → milliseconds. */
export function parseDuration(value: string, name = 'duration'): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)\s*$/.exec(value);
  if (!m) throw new ConfigError(`${name} must look like 90s, 2m or 1h (got "${value}")`);
  const ms = Number(m[1]) * UNITS[m[2]!]!;
  if (!(ms > 0)) throw new ConfigError(`${name} must be greater than zero`);
  return ms;
}

function env(source: Record<string, string | undefined>, name: string): string | undefined {
  const value = source[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

export function loadConfig(
  rawSource: Record<string, string | undefined> = process.env,
  opts: { dataDir?: string } = {},
): Config {
  const { env: source, warnings: deprecations } = withLegacyEnv(rawSource, SETTING_NAMES);
  const get = (name: keyof typeof DEFAULTS) => env(source, name) ?? DEFAULTS[name];
  const dataDir = opts.dataDir ?? '/data';

  const port = Number(get('DOCKET_PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigError('DOCKET_PORT must be a port number (1–65535)');
  }

  const allowedHosts = get('DOCKET_ALLOWED_HOSTS')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (allowedHosts.length === 0) {
    throw new ConfigError('DOCKET_ALLOWED_HOSTS must list at least one host:port');
  }

  const backupAt = get('DOCKET_BACKUP_AT');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(backupAt)) {
    throw new ConfigError(`DOCKET_BACKUP_AT must be HH:MM (got "${backupAt}")`);
  }

  const backupKeepDays = Number(get('DOCKET_BACKUP_KEEP'));
  if (!Number.isInteger(backupKeepDays) || backupKeepDays < 1) {
    throw new ConfigError('DOCKET_BACKUP_KEEP must be a whole number of days, at least 1');
  }

  const seedValue = env(source, 'DOCKET_SEED');
  if (seedValue !== undefined && seedValue !== 'sample') {
    throw new ConfigError(`DOCKET_SEED must be "sample" or unset (got "${seedValue}")`);
  }

  const stressValue = (env(source, 'DOCKET_SEED_STRESS') ?? '0').toLowerCase();
  if (!['1', '0', 'on', 'off', 'true', 'false'].includes(stressValue)) {
    throw new ConfigError(`DOCKET_SEED_STRESS must be 1 or 0 (got "${stressValue}")`);
  }

  // `none` turns text-only results off for every client.
  const textOnly = get('DOCKET_TEXT_ONLY_CLIENTS');
  const textOnlyClients =
    textOnly.toLowerCase() === 'none'
      ? []
      : textOnly
          .split(',')
          .map((c) => c.trim().toLowerCase())
          .filter(Boolean);

  // Push install (§5.17): off unless DOCKET_PUSH_ROOT is set. The host path
  // only describes the push root, so it means nothing without one.
  const pushRoot = env(source, 'DOCKET_PUSH_ROOT') ?? null;
  const pushHostPath = env(source, 'DOCKET_PUSH_HOST_PATH') ?? null;
  if (pushRoot !== null && !isAbsolute(pushRoot)) {
    throw new ConfigError(
      `DOCKET_PUSH_ROOT must be an absolute path inside the container (got "${pushRoot}")`,
    );
  }
  if (pushHostPath !== null && pushRoot === null) {
    throw new ConfigError('DOCKET_PUSH_HOST_PATH needs DOCKET_PUSH_ROOT; set both or neither');
  }

  // Drift checks (decision 30): `0` or `off` turns them off; otherwise at least a minute.
  const driftValue = get('DOCKET_DRIFT_CHECK_INTERVAL');
  let driftCheckIntervalMs: number | null = null;
  if (!['0', 'off'].includes(driftValue.toLowerCase())) {
    driftCheckIntervalMs = parseDuration(driftValue, 'DOCKET_DRIFT_CHECK_INTERVAL');
    if (driftCheckIntervalMs < MIN_DRIFT_CHECK_INTERVAL_MS) {
      throw new ConfigError(
        `DOCKET_DRIFT_CHECK_INTERVAL must be at least 1m, or 0 / off to turn it off (got "${driftValue}")`,
      );
    }
  }

  const leaseMinutes = Number(get('DOCKET_LEASE_MINUTES'));
  if (!Number.isInteger(leaseMinutes) || leaseMinutes < 1) {
    throw new ConfigError(
      `DOCKET_LEASE_MINUTES must be a whole number of minutes, at least 1 (got "${get('DOCKET_LEASE_MINUTES')}")`,
    );
  }

  const graceHours = Number(get('DOCKET_AGENT_PROBLEM_GRACE_HOURS'));
  if (!Number.isInteger(graceHours) || graceHours < 0) {
    throw new ConfigError(
      `DOCKET_AGENT_PROBLEM_GRACE_HOURS must be a whole number of hours, 0 or more (got "${get('DOCKET_AGENT_PROBLEM_GRACE_HOURS')}")`,
    );
  }

  const overlapGraceHours = Number(get('DOCKET_OVERLAP_GRACE_HOURS'));
  if (!Number.isInteger(overlapGraceHours) || overlapGraceHours < 0) {
    throw new ConfigError(
      `DOCKET_OVERLAP_GRACE_HOURS must be a whole number of hours, 0 or more (got "${get('DOCKET_OVERLAP_GRACE_HOURS')}")`,
    );
  }

  const protectedValue = get('DOCKET_PROTECTED_MODE').toLowerCase();
  if (!['on', 'off', 'true', 'false'].includes(protectedValue)) {
    throw new ConfigError(
      `DOCKET_PROTECTED_MODE must be on or off (true or false also work; got "${protectedValue}")`,
    );
  }

  const secrets = join(dataDir, 'secrets');
  const db = databaseFile(dataDir);
  return {
    dataDir,
    tokenFromEnv: env(source, 'DOCKET_TOKEN') ?? null,
    port,
    allowedHosts,
    liveWindowMs: parseDuration(get('DOCKET_LIVE_WINDOW'), 'DOCKET_LIVE_WINDOW'),
    staleAfterMs: parseDuration(get('DOCKET_STALE_AFTER'), 'DOCKET_STALE_AFTER'),
    leaseMs: parseDuration(get('DOCKET_LEASE'), 'DOCKET_LEASE'),
    partLeaseMs: leaseMinutes * 60_000,
    parkMaxMs: parseDuration(get('DOCKET_PARK_MAX'), 'DOCKET_PARK_MAX'),
    agentProblemGraceMs: graceHours * 3_600_000,
    overlapGraceMs: overlapGraceHours * 3_600_000,
    resumeUnattendedMs: parseDuration(get('DOCKET_RESUME_UNATTENDED'), 'DOCKET_RESUME_UNATTENDED'),
    orphanAfterMs: parseDuration(get('DOCKET_ORPHAN_AFTER'), 'DOCKET_ORPHAN_AFTER'),
    backupAt,
    backupKeepDays,
    backupExtraDir: env(source, 'DOCKET_BACKUP_EXTRA_DIR') ?? null,
    pushRoot,
    pushHostPath,
    driftCheckIntervalMs,
    seed: seedValue === 'sample' ? 'sample' : null,
    seedStress: ['1', 'on', 'true'].includes(stressValue),
    tz: env(source, 'TZ') ?? null,
    protectedMode: protectedValue === 'on' || protectedValue === 'true',
    textOnlyClients,
    dataVolume: env(source, 'DOCKET_DATA_VOLUME') ?? null,
    deprecations,
    legacyDbFile: db.legacy,
    paths: {
      db: db.path,
      docs: join(dataDir, 'docs'),
      secrets,
      agentToken: join(secrets, 'agent-token'),
      ownerKey: join(secrets, 'owner-key'),
      logs: join(dataDir, 'logs'),
      backups: join(dataDir, 'backups'),
    },
  };
}

/** Create the volume layout's directories. The secrets directory is private to the service user. */
export function ensureDataDirs(config: Config): void {
  for (const dir of [config.paths.docs, config.paths.logs, config.paths.backups]) {
    mkdirSync(dir, { recursive: true });
  }
  mkdirSync(config.paths.secrets, { recursive: true, mode: 0o700 });
  chmodSync(config.paths.secrets, 0o700);
}

// ---- Secrets ----

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding. */
export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export const generateOwnerKey = () => base32(randomBytes(32));
export const generateAgentToken = () => `tl_${randomBytes(32).toString('base64url')}`;

/** Write a secret file with mode 0600 atomically (write a temporary file, then rename). */
export function writeSecretFile(path: string, value: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${value}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function readOrCreate(path: string, generate: () => string): string {
  if (existsSync(path)) {
    chmodSync(path, 0o600);
    const value = readFileSync(path, 'utf8').trim();
    if (value) return value;
  }
  const value = generate();
  writeSecretFile(path, value);
  return value;
}

/** The agent token and the owner key. Read once at boot; rotation replaces the owner key. */
export class SecretStore {
  private token: string;
  private key: string;

  constructor(private readonly config: Config) {
    ensureDataDirs(config);
    this.token = config.tokenFromEnv ?? readOrCreate(config.paths.agentToken, generateAgentToken);
    this.key = readOrCreate(config.paths.ownerKey, generateOwnerKey);
  }

  agentToken(): string {
    return this.token;
  }

  ownerKey(): string {
    return this.key;
  }

  /** Replace the owner key on disk and in memory. Callers end all owner sessions. */
  rotateOwnerKey(): void {
    const next = generateOwnerKey();
    writeSecretFile(this.config.paths.ownerKey, next);
    this.key = next;
  }

  /** Values the write path rejects if they appear in any text. */
  known(): string[] {
    return [this.token, this.key];
  }
}
