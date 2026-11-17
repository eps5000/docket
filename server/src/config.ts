/**
 * Configuration (BUILD_SPEC §2 "Configuration" and "Volume layout") and
 * secret bootstrap (§3).
 *
 * - Every variable has its documented default.
 * - The agent token comes from TASKLITE_TOKEN, else /data/secrets/agent-token
 *   (generated on first boot). The owner key is always /data/secrets/owner-key
 *   (generated on first boot: 32 random bytes, base32). Both files are 0600.
 * - Secrets are never logged: nothing here prints them, and config errors
 *   name the variable, never a secret value.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Config {
  dataDir: string;
  /** TASKLITE_TOKEN, when set. Otherwise the token lives in `paths.agentToken`. */
  tokenFromEnv: string | null;
  port: number;
  allowedHosts: string[];
  liveWindowMs: number;
  staleAfterMs: number;
  leaseMs: number;
  /** A run parked longer than this shows under Problems; it keeps its claim (§5.16). */
  parkMaxMs: number;
  /** A parked run `resume_ready` this long shows as "Ready to resume, unattended" (§5.16). */
  resumeUnattendedMs: number;
  /** A resource unreleased this long after its run ended is orphaned (§5.16). */
  orphanAfterMs: number;
  /** `HH:MM`, local time. */
  backupAt: string;
  backupKeepDays: number;
  backupExtraDir: string | null;
  seed: 'sample' | null;
  /** Display time zone; storage is always UTC. */
  tz: string | null;
  /**
   * `clientInfo.name`s (lower-cased) whose sessions get text-only tool results:
   * no `outputSchema`, no `structuredContent` (MCP_SPEC §3 Results; owner decision 28).
   */
  textOnlyClients: string[];
  paths: {
    db: string;
    docs: string;
    secrets: string;
    agentToken: string;
    ownerKey: string;
    logs: string;
    backups: string;
  };
}

export const DEFAULTS = {
  TASKLITE_PORT: '7420',
  TASKLITE_ALLOWED_HOSTS: '127.0.0.1:7420,localhost:7420',
  TASKLITE_LIVE_WINDOW: '2m',
  TASKLITE_STALE_AFTER: '30m',
  TASKLITE_LEASE: '60m',
  TASKLITE_PARK_MAX: '24h',
  TASKLITE_RESUME_UNATTENDED: '30m',
  TASKLITE_ORPHAN_AFTER: '15m',
  TASKLITE_BACKUP_AT: '03:00',
  TASKLITE_BACKUP_KEEP: '14',
  // Claude Code gives the model `structuredContent`, not the text (BUILD_SPEC §12 V6).
  TASKLITE_TEXT_ONLY_CLIENTS: 'claude-code',
} as const;

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
  source: Record<string, string | undefined> = process.env,
  opts: { dataDir?: string } = {},
): Config {
  const get = (name: keyof typeof DEFAULTS) => env(source, name) ?? DEFAULTS[name];
  const dataDir = opts.dataDir ?? '/data';

  const port = Number(get('TASKLITE_PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigError('TASKLITE_PORT must be a port number (1–65535)');
  }

  const allowedHosts = get('TASKLITE_ALLOWED_HOSTS')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (allowedHosts.length === 0) {
    throw new ConfigError('TASKLITE_ALLOWED_HOSTS must list at least one host:port');
  }

  const backupAt = get('TASKLITE_BACKUP_AT');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(backupAt)) {
    throw new ConfigError(`TASKLITE_BACKUP_AT must be HH:MM (got "${backupAt}")`);
  }

  const backupKeepDays = Number(get('TASKLITE_BACKUP_KEEP'));
  if (!Number.isInteger(backupKeepDays) || backupKeepDays < 1) {
    throw new ConfigError('TASKLITE_BACKUP_KEEP must be a whole number of days, at least 1');
  }

  const seedValue = env(source, 'TASKLITE_SEED');
  if (seedValue !== undefined && seedValue !== 'sample') {
    throw new ConfigError(`TASKLITE_SEED must be "sample" or unset (got "${seedValue}")`);
  }

  // `none` turns text-only results off for every client.
  const textOnly = get('TASKLITE_TEXT_ONLY_CLIENTS');
  const textOnlyClients =
    textOnly.toLowerCase() === 'none'
      ? []
      : textOnly
          .split(',')
          .map((c) => c.trim().toLowerCase())
          .filter(Boolean);

  const secrets = join(dataDir, 'secrets');
  return {
    dataDir,
    tokenFromEnv: env(source, 'TASKLITE_TOKEN') ?? null,
    port,
    allowedHosts,
    liveWindowMs: parseDuration(get('TASKLITE_LIVE_WINDOW'), 'TASKLITE_LIVE_WINDOW'),
    staleAfterMs: parseDuration(get('TASKLITE_STALE_AFTER'), 'TASKLITE_STALE_AFTER'),
    leaseMs: parseDuration(get('TASKLITE_LEASE'), 'TASKLITE_LEASE'),
    parkMaxMs: parseDuration(get('TASKLITE_PARK_MAX'), 'TASKLITE_PARK_MAX'),
    resumeUnattendedMs: parseDuration(
      get('TASKLITE_RESUME_UNATTENDED'),
      'TASKLITE_RESUME_UNATTENDED',
    ),
    orphanAfterMs: parseDuration(get('TASKLITE_ORPHAN_AFTER'), 'TASKLITE_ORPHAN_AFTER'),
    backupAt,
    backupKeepDays,
    backupExtraDir: env(source, 'TASKLITE_BACKUP_EXTRA_DIR') ?? null,
    seed: seedValue === 'sample' ? 'sample' : null,
    tz: env(source, 'TZ') ?? null,
    textOnlyClients,
    paths: {
      db: join(dataDir, 'tasklite.db'),
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
