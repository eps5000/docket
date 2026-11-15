/**
 * Links, blocked state and cycle rejection (BUILD_SPEC §5.2): the `links` service.
 *
 * Stub (tasks.md T047): each method throws `NotImplementedError` until
 * US4 (T093) fills it in, here, in place. The signatures are in contracts.ts.
 */
import { notImplemented, type LinksService, type ServiceDeps } from './contracts.js';

export function createLinksService(_deps: ServiceDeps): LinksService {
  return {
    link: notImplemented('links.link'),
    unlink: notImplemented('links.unlink'),
    blockState: notImplemented('links.blockState'),
  };
}
