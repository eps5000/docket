/**
 * Projects: the blocker rule and delete together (BUILD_SPEC §5.2, §5.12): the `projects` service.
 *
 * Stub (tasks.md T047): each method throws `NotImplementedError` until
 * US4 (T093) and US10 (T118) fills it in, here, in place. The signatures are in contracts.ts.
 */
import { notImplemented, type ProjectsService, type ServiceDeps } from './contracts.js';

export function createProjectsService(_deps: ServiceDeps): ProjectsService {
  return {
    setDefaultSatisfiedWhen: notImplemented('projects.setDefaultSatisfiedWhen'),
    delete: notImplemented('projects.delete'),
    removeDeletedDocs: notImplemented('projects.removeDeletedDocs'),
  };
}
