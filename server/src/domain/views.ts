/**
 * The owner's read models (UI_SPEC §6): the `views` service.
 *
 * Stub (tasks.md T047): each method throws `NotImplementedError` until
 * US2 (T073), US7 and US10 fills it in, here, in place. The signatures are in contracts.ts.
 */
import { notImplemented, type ViewsService, type ServiceDeps } from './contracts.js';

export function createViewsService(_deps: ServiceDeps): ViewsService {
  return {
    bootstrap: notImplemented('views.bootstrap'),
    needsYou: notImplemented('views.needsYou'),
    work: notImplemented('views.work'),
    itemDetail: notImplemented('views.itemDetail'),
    agents: notImplemented('views.agents'),
    labelPage: notImplemented('views.labelPage'),
    settings: notImplemented('views.settings'),
  };
}
