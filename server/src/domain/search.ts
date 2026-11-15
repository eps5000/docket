/**
 * Search, filters and the change feed (BUILD_SPEC §5.11, §13): the `search` service.
 *
 * Stub (tasks.md T047): each method throws `NotImplementedError` until
 * US1 (T068) and US2 fills it in, here, in place. The signatures are in contracts.ts.
 */
import { notImplemented, type SearchService, type ServiceDeps } from './contracts.js';

export function createSearchService(_deps: ServiceDeps): SearchService {
  return {
    whoami: notImplemented('search.whoami'),
    listProjects: notImplemented('search.listProjects'),
    searchItems: notImplemented('search.searchItems'),
    getChanges: notImplemented('search.getChanges'),
    palette: notImplemented('search.palette'),
  };
}
