import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SecretStore, base32, loadConfig, parseDuration } from '../../src/config.js';
import { tempDir, type TempDir } from '../helpers.js';

let tmp: TempDir;
beforeEach(() => {
  tmp = tempDir('tasklite-config-');
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
      backupAt: '03:00',
      backupKeepDays: 14,
      backupExtraDir: null,
      seed: null,
      tz: null,
    });
    expect(c.paths.db.replace(/\\/g, '/')).toBe('/data/tasklite.db');
    expect(c.paths.ownerKey.replace(/\\/g, '/')).toBe('/data/secrets/owner-key');
  });

  it('reads every variable', () => {
    const c = loadConfig({
      TASKLITE_TOKEN: ' tok-1234567890abcdef ',
      TASKLITE_PORT: '8080',
      TASKLITE_ALLOWED_HOSTS: 'Tasklite.local:8080, 127.0.0.1:8080',
      TASKLITE_LIVE_WINDOW: '90s',
      TASKLITE_STALE_AFTER: '1h',
      TASKLITE_LEASE: '45m',
      TASKLITE_BACKUP_AT: '23:30',
      TASKLITE_BACKUP_KEEP: '30',
      TASKLITE_BACKUP_EXTRA_DIR: '/backups-extra',
      TASKLITE_SEED: 'sample',
      TZ: 'Europe/London',
    });
    expect(c).toMatchObject({
      tokenFromEnv: 'tok-1234567890abcdef',
      port: 8080,
      allowedHosts: ['tasklite.local:8080', '127.0.0.1:8080'],
      liveWindowMs: 90_000,
      staleAfterMs: 3_600_000,
      leaseMs: 45 * 60_000,
      backupAt: '23:30',
      backupKeepDays: 30,
      backupExtraDir: '/backups-extra',
      seed: 'sample',
      tz: 'Europe/London',
    });
  });

  it.each([
    [{ TASKLITE_PORT: 'abc' }, /TASKLITE_PORT/],
    [{ TASKLITE_ALLOWED_HOSTS: ' , ' }, /TASKLITE_ALLOWED_HOSTS/],
    [{ TASKLITE_LEASE: '5 minutes' }, /TASKLITE_LEASE/],
    [{ TASKLITE_BACKUP_AT: '3am' }, /TASKLITE_BACKUP_AT/],
    [{ TASKLITE_BACKUP_KEEP: '0' }, /TASKLITE_BACKUP_KEEP/],
    [{ TASKLITE_SEED: 'demo' }, /TASKLITE_SEED/],
  ])('rejects %j', (env, message) => {
    expect(() => loadConfig(env)).toThrow(message);
  });

  it('never puts the token in an error message', () => {
    expect(() => loadConfig({ TASKLITE_TOKEN: 'secret-token-value', TASKLITE_PORT: 'x' })).toThrow(
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

  it('uses TASKLITE_TOKEN without writing it to disk', () => {
    const config = loadConfig(
      { TASKLITE_TOKEN: 'env-token-0123456789abcdef' },
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
