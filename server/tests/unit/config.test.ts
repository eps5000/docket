import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULTS, SecretStore, base32, loadConfig, parseDuration } from '../../src/config.js';
import { tempDir, type TempDir } from '../helpers.js';

let tmp: TempDir;
beforeEach(() => {
  tmp = tempDir('docket-config-');
});
afterEach(() => tmp.cleanup());

describe('loadConfig', () => {
  it('applies every BUILD_SPEC §2 default', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({
      dataDir: '/data',
      tokenFromEnv: null,
      port: 7420,
      allowedHosts: ['127.0.0.1:7420', 'localhost:7420'],
      liveWindowMs: 2 * 60_000,
      staleAfterMs: 30 * 60_000,
      leaseMs: 60 * 60_000,
      parkMaxMs: 24 * 3_600_000,
      resumeUnattendedMs: 30 * 60_000,
      orphanAfterMs: 15 * 60_000,
      backupAt: '03:00',
      backupKeepDays: 14,
      backupExtraDir: null,
      pushRoot: null,
      pushHostPath: null,
      driftCheckIntervalMs: 15 * 60_000,
      seed: null,
      tz: null,
      textOnlyClients: ['claude-code'],
    });
    expect(c.paths.db.replace(/\\/g, '/')).toBe('/data/docket.db');
    expect(c.paths.ownerKey.replace(/\\/g, '/')).toBe('/data/secrets/owner-key');
  });

  it('reads every variable', () => {
    const c = loadConfig({
      DOCKET_TOKEN: ' tok-1234567890abcdef ',
      DOCKET_PORT: '8080',
      DOCKET_ALLOWED_HOSTS: 'Docket.local:8080, 127.0.0.1:8080',
      DOCKET_LIVE_WINDOW: '90s',
      DOCKET_STALE_AFTER: '1h',
      DOCKET_LEASE: '45m',
      DOCKET_PARK_MAX: '12h',
      DOCKET_RESUME_UNATTENDED: '10m',
      DOCKET_ORPHAN_AFTER: '5m',
      DOCKET_BACKUP_AT: '23:30',
      DOCKET_BACKUP_KEEP: '30',
      DOCKET_BACKUP_EXTRA_DIR: '/backups-extra',
      DOCKET_PUSH_ROOT: ' /host-code ',
      DOCKET_PUSH_HOST_PATH: 'C:/Users/me/code',
      DOCKET_DRIFT_CHECK_INTERVAL: '1h',
      DOCKET_SEED: 'sample',
      TZ: 'Europe/London',
      DOCKET_TEXT_ONLY_CLIENTS: ' Claude-Code, my-agent ,',
    });
    expect(c).toMatchObject({
      tokenFromEnv: 'tok-1234567890abcdef',
      port: 8080,
      allowedHosts: ['docket.local:8080', '127.0.0.1:8080'],
      liveWindowMs: 90_000,
      staleAfterMs: 3_600_000,
      leaseMs: 45 * 60_000,
      parkMaxMs: 12 * 3_600_000,
      resumeUnattendedMs: 10 * 60_000,
      orphanAfterMs: 5 * 60_000,
      backupAt: '23:30',
      backupKeepDays: 30,
      backupExtraDir: '/backups-extra',
      pushRoot: '/host-code',
      pushHostPath: 'C:/Users/me/code',
      driftCheckIntervalMs: 3_600_000,
      seed: 'sample',
      tz: 'Europe/London',
      textOnlyClients: ['claude-code', 'my-agent'],
    });
  });

  it('DOCKET_DRIFT_CHECK_INTERVAL: 0 or off turns the check off; otherwise at least 1m', () => {
    for (const off of ['0', 'off', 'OFF']) {
      expect(
        loadConfig({ DOCKET_DRIFT_CHECK_INTERVAL: off }).driftCheckIntervalMs,
        off,
      ).toBeNull();
    }
    expect(loadConfig({ DOCKET_DRIFT_CHECK_INTERVAL: '1m' }).driftCheckIntervalMs).toBe(60_000);
    expect(() => loadConfig({ DOCKET_DRIFT_CHECK_INTERVAL: '30s' })).toThrow(/at least 1m/);
    expect(() => loadConfig({ DOCKET_DRIFT_CHECK_INTERVAL: 'hourly' })).toThrow(
      /DOCKET_DRIFT_CHECK_INTERVAL/,
    );
  });

  it('DOCKET_TEXT_ONLY_CLIENTS=none gives every client structured results', () => {
    expect(loadConfig({ DOCKET_TEXT_ONLY_CLIENTS: 'none' }).textOnlyClients).toEqual([]);
    expect(loadConfig({ DOCKET_TEXT_ONLY_CLIENTS: 'NONE' }).textOnlyClients).toEqual([]);
  });

  it.each([
    [{ DOCKET_PORT: 'abc' }, /DOCKET_PORT/],
    [{ DOCKET_ALLOWED_HOSTS: ' , ' }, /DOCKET_ALLOWED_HOSTS/],
    [{ DOCKET_LEASE: '5 minutes' }, /DOCKET_LEASE/],
    [{ DOCKET_PARK_MAX: 'a day' }, /DOCKET_PARK_MAX/],
    [{ DOCKET_RESUME_UNATTENDED: '0m' }, /DOCKET_RESUME_UNATTENDED/],
    [{ DOCKET_ORPHAN_AFTER: '-5m' }, /DOCKET_ORPHAN_AFTER/],
    [{ DOCKET_BACKUP_AT: '3am' }, /DOCKET_BACKUP_AT/],
    [{ DOCKET_BACKUP_KEEP: '0' }, /DOCKET_BACKUP_KEEP/],
    [{ DOCKET_SEED: 'demo' }, /DOCKET_SEED/],
    [{ DOCKET_PUSH_ROOT: 'host-code' }, /DOCKET_PUSH_ROOT/],
    [{ DOCKET_PUSH_HOST_PATH: 'C:/Users/me/code' }, /DOCKET_PUSH_HOST_PATH needs/],
  ])('rejects %j', (env, message) => {
    expect(() => loadConfig(env)).toThrow(message);
  });

  it('docker/.env.example documents every variable with its default', () => {
    const example = readFileSync(new URL('../../../docker/.env.example', import.meta.url), 'utf8');
    for (const [name, value] of Object.entries(DEFAULTS)) {
      expect(example, name).toContain(`# ${name}=${value}`);
    }
    // Opt-in variables with no default are documented with an example value.
    for (const name of ['DOCKET_PUSH_ROOT', 'DOCKET_PUSH_HOST_PATH']) {
      expect(example, name).toMatch(new RegExp(`^# ${name}=\\S`, 'm'));
    }
  });

  it('never puts the token in an error message', () => {
    expect(() => loadConfig({ DOCKET_TOKEN: 'secret-token-value', DOCKET_PORT: 'x' })).toThrow(
      expect.not.objectContaining({ message: expect.stringContaining('secret-token-value') }),
    );
  });
});

describe('parseDuration', () => {
  it.each([
    ['500ms', 500],
    ['90s', 90_000],
    ['2m', 120_000],
    ['1h', 3_600_000],
    ['1d', 86_400_000],
  ])('%s', (text, ms) => expect(parseDuration(text)).toBe(ms));
});

describe('base32', () => {
  it('matches RFC 4648 test vectors (no padding)', () => {
    expect(base32(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32(Buffer.from('f'))).toBe('MY');
  });
});

describe('secret bootstrap', () => {
  it('generates the agent token and owner key on first boot, mode 0600, and keeps them', () => {
    const config = loadConfig({}, { dataDir: tmp.dir });
    const first = new SecretStore(config);
    expect(first.ownerKey()).toMatch(/^[A-Z2-7]{52}$/);
    expect(first.agentToken()).toMatch(/^tl_[A-Za-z0-9_-]{43}$/);
    expect(readFileSync(config.paths.ownerKey, 'utf8')).toBe(`${first.ownerKey()}\n`);
    expect(readFileSync(config.paths.agentToken, 'utf8')).toBe(`${first.agentToken()}\n`);
    if (process.platform !== 'win32') {
      expect(statSync(config.paths.ownerKey).mode & 0o777).toBe(0o600);
      expect(statSync(config.paths.agentToken).mode & 0o777).toBe(0o600);
      expect(statSync(config.paths.secrets).mode & 0o777).toBe(0o700);
    }
    const second = new SecretStore(config);
    expect(second.ownerKey()).toBe(first.ownerKey());
    expect(second.agentToken()).toBe(first.agentToken());
  });

  it('uses DOCKET_TOKEN without writing it to disk', () => {
    const config = loadConfig(
      { DOCKET_TOKEN: 'env-token-0123456789abcdef' },
      { dataDir: tmp.dir },
    );
    const store = new SecretStore(config);
    expect(store.agentToken()).toBe('env-token-0123456789abcdef');
    expect(() => readFileSync(config.paths.agentToken)).toThrow();
  });

  it.skipIf(process.platform === 'win32')('tightens the mode of an existing key file', () => {
    const config = loadConfig({}, { dataDir: tmp.dir });
    new SecretStore(config);
    writeFileSync(config.paths.ownerKey, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRST\n', {
      mode: 0o644,
    });
    new SecretStore(config);
    expect(statSync(config.paths.ownerKey).mode & 0o777).toBe(0o600);
  });

  it('rotates the owner key on disk', () => {
    const config = loadConfig({}, { dataDir: tmp.dir });
    const store = new SecretStore(config);
    const old = store.ownerKey();
    store.rotateOwnerKey();
    expect(store.ownerKey()).not.toBe(old);
    expect(readFileSync(join(tmp.dir, 'secrets', 'owner-key'), 'utf8').trim()).toBe(
      store.ownerKey(),
    );
    expect(store.known()).toEqual([store.agentToken(), store.ownerKey()]);
  });
});
