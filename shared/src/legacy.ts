/**
 * The names from before the rename to Docket (B28; the product was formerly
 * Task Lite). Only compatibility code reads them, so that nothing already
 * installed or configured breaks:
 *
 * - settings: a `TASKLITE_*` variable is read when its `DOCKET_*` one is
 *   unset, with one startup warning per key (never the value);
 * - the marked section: a `<!-- tasklite:begin/end -->` pair is a valid
 *   Docket section, and an install replaces it with the `docket` markers;
 * - installs: `.tasklite-manifest.json` is read when there is no
 *   `.docket-manifest.json`, and `tasklite-*` skill folders that an earlier
 *   install recorded are removed when unmodified (BUILD_SPEC §5.17);
 * - agent file keys: `skill:tasklite-*` maps to `skill:docket-*`;
 * - the data volume: a database file still called `tasklite.db`, and backups
 *   named `tasklite-*.tar.gz`, are still read.
 *
 * The CI grep guard (server/tests/unit/rename-guard.test.ts) allows the old
 * names here and in the compatibility code that uses these constants.
 */

/** The old settings prefix: `TASKLITE_PORT` is read as `DOCKET_PORT` when that is unset. */
export const LEGACY_ENV_PREFIX = 'TASKLITE_';
export const ENV_PREFIX = 'DOCKET_';

/** The old marked-section markers, still recognised as a Docket section. */
export const LEGACY_BEGIN = '<!-- tasklite:begin -->';
export const LEGACY_END = '<!-- tasklite:end -->';

/** The old manifest file name, in the client's folder; read when the new one is absent. */
export const LEGACY_MANIFEST_NAME = '.tasklite-manifest.json';

/** The old installed check scripts, next to the old manifest. Never deleted. */
export const LEGACY_CHECK_SCRIPTS = ['tasklite-check.sh', 'tasklite-check.ps1'] as const;

/** The old skill folder prefix: `tasklite-worker`. */
export const LEGACY_SKILL_PREFIX = 'tasklite-';
export const SKILL_PREFIX = 'docket-';

/** The old database file name on the data volume. */
export const LEGACY_DB_FILE = 'tasklite.db';

/** The old backup archive prefix (`tasklite-YYYYMMDD-HHMM.tar.gz`) and manifest format. */
export const LEGACY_BACKUP_PREFIX = 'tasklite-';
export const LEGACY_BACKUP_FORMAT = 'tasklite-backup';

/** The old data volume, which the compose file no longer names (the README says how to move it). */
export const LEGACY_VOLUME = 'tasklite-data';

/** Whether `name` is an old skill folder name: `tasklite-worker`. */
export const isLegacySkillName = (name: string): boolean => name.startsWith(LEGACY_SKILL_PREFIX);

/** `tasklite-worker` → `docket-worker`; any other name unchanged. */
export const mapLegacySkillName = (name: string): string =>
  isLegacySkillName(name) ? SKILL_PREFIX + name.slice(LEGACY_SKILL_PREFIX.length) : name;

/** Whether `key` is an old skill key: `skill:tasklite-worker`. */
export const isLegacySkillKey = (key: string): boolean =>
  key.startsWith(`skill:${LEGACY_SKILL_PREFIX}`);

/** `skill:tasklite-worker` → `skill:docket-worker`; any other key unchanged. */
export const mapLegacySkillKey = (key: string): string =>
  isLegacySkillKey(key) ? `skill:${mapLegacySkillName(key.slice('skill:'.length))}` : key;

/**
 * Settings with the old prefix, read as the new ones (B28). Returns the
 * environment to read, and one warning per old key used: `TASKLITE_PORT is
 * deprecated; use DOCKET_PORT`. A `DOCKET_*` value always wins; values are
 * never in the warnings.
 */
export function withLegacyEnv(
  source: Record<string, string | undefined>,
  names: readonly string[],
): { env: Record<string, string | undefined>; warnings: string[] } {
  const env = { ...source };
  const warnings: string[] = [];
  const set = (v: string | undefined) => v !== undefined && v.trim() !== '';
  for (const name of names) {
    if (!name.startsWith(ENV_PREFIX)) continue;
    const old = LEGACY_ENV_PREFIX + name.slice(ENV_PREFIX.length);
    if (!set(source[name]) && set(source[old])) {
      env[name] = source[old];
      warnings.push(`${old} is deprecated; use ${name}`);
    }
  }
  return { env, warnings };
}
