/**
 * Backups (BUILD_SPEC §5.13; owner decision 24): the `backup` service.
 *
 * The work is in jobs/backup.ts (the nightly job, the archive, verifying it,
 * the extra copy and restore). This service is what the server and Settings
 * see: where each location is, its last successful backup and its last
 * error, and *back up now* on the server's own connection.
 */
import { backupStatus, runBackup } from '../jobs/backup.js';
import type { BackupService, ServiceDeps } from './contracts.js';

export function createBackupService(deps: ServiceDeps): BackupService {
  let running: Promise<Awaited<ReturnType<typeof runBackup>>> | null = null;
  return {
    status: () => backupStatus(deps.config),
    runNow(r) {
      // One backup at a time: a second request waits for the one in progress.
      running ??= runBackup({
        config: deps.config,
        sqlite: r.db.sqlite,
        clock: deps.clock,
        log: deps.log,
      }).finally(() => {
        running = null;
      });
      return running;
    },
  };
}
