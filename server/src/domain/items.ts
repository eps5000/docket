/**
 * Items: create, edit, status transitions, labels and the owner's field and text edits (BUILD_SPEC §5.1; decision 22): the `items` service.
 *
 * Stub (tasks.md T047): each method throws `NotImplementedError` until
 * US1 (T063) and US7 (T112) fills it in, here, in place. The signatures are in contracts.ts.
 */
import { notImplemented, type ItemsService, type ServiceDeps } from './contracts.js';

export function createItemsService(_deps: ServiceDeps): ItemsService {
  return {
    create: notImplemented('items.create'),
    update: notImplemented('items.update'),
    ownerPatch: notImplemented('items.ownerPatch'),
    setStatus: notImplemented('items.setStatus'),
    get: notImplemented('items.get'),
    upsertLabel: notImplemented('items.upsertLabel'),
    moveLabelToReady: notImplemented('items.moveLabelToReady'),
  };
}
