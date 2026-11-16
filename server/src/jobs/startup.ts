/**
 * Startup housekeeping (BUILD_SPEC §5.10, §5.12), run by `index.ts` before
 * the server listens:
 * - uploads left in `docs/.staging` by the restart are removed (no upload
 *   survives one);
 * - the documents folder of every deleted project (tombstone) is removed,
 *   retrying any removal that failed after its delete committed.
 */
import { readContext } from '../domain/contracts.js';
import { SYSTEM_ACTOR } from '../domain/write.js';
import type { Runtime } from '../runtime.js';
import { clearStaging } from './backup.js';

export async function startupHousekeeping(
  runtime: Pick<Runtime, 'config' | 'db' | 'services' | 'clock'>,
): Promise<{ staged: number; removed: string[] }> {
  const staged = clearStaging(runtime.config.paths.docs);
  const removed = await runtime.services.projects.removeDeletedDocs(
    readContext(runtime.db, SYSTEM_ACTOR, runtime.clock()),
  );
  return { staged, removed };
}
