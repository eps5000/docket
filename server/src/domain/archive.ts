/**
 * Archive and cancel (BUILD_SPEC §5.1, §5.8; owner decision 23): the `archive` service.
 *
 * Stub (tasks.md T047): each method throws `NotImplementedError` until
 * US7 (T112) fills it in, here, in place. The signatures are in contracts.ts.
 */
import { notImplemented, type ArchiveService, type ServiceDeps } from './contracts.js';

export function createArchiveService(_deps: ServiceDeps): ArchiveService {
  return {
    archive: notImplemented('archive.archive'),
    unarchive: notImplemented('archive.unarchive'),
    archiveMany: notImplemented('archive.archiveMany'),
    cancel: notImplemented('archive.cancel'),
  };
}
