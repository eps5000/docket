/**
 * Backups (BUILD_SPEC §5.13); the job itself lives in jobs/backup.ts: the `backup` service.
 *
 * Stub (tasks.md T047): each method throws `NotImplementedError` until
 * US10 fills it in, here, in place. The signatures are in contracts.ts.
 */
import { notImplemented, type BackupService, type ServiceDeps } from './contracts.js';

export function createBackupService(_deps: ServiceDeps): BackupService {
  return {
    status: notImplemented('backup.status'),
    runNow: notImplemented('backup.runNow'),
  };
}
