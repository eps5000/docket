/**
 * Jira import (BUILD_SPEC §9); the reader and mapper live in server/src/import/jira/: the `jiraImport` service.
 *
 * Stub (tasks.md T047): each method throws `NotImplementedError` until
 * US9 fills it in, here, in place. The signatures are in contracts.ts.
 */
import { notImplemented, type JiraImportService, type ServiceDeps } from './contracts.js';

export function createJiraImportService(_deps: ServiceDeps): JiraImportService {
  return {
    dryRun: notImplemented('jiraImport.dryRun'),
    get: notImplemented('jiraImport.get'),
    commit: notImplemented('jiraImport.commit'),
    cancel: notImplemented('jiraImport.cancel'),
  };
}
