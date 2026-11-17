/**
 * Installs (owner decision 29; BUILD_SPEC §5.17): the bundle builder, the
 * single-use download token, push install into the opt-in push root, the
 * install log, the check, and the push folder's status and *Test*.
 *
 * Stub (tasks.md T150): each method throws `NotImplementedError` until US13
 * (T155, T156) fills it in, here, in place. The signatures are in
 * contracts.ts.
 */
import { notImplemented, type InstallsService, type ServiceDeps } from './contracts.js';

export function createInstallsService(_deps: ServiceDeps): InstallsService {
  return {
    prepare: notImplemented('installs.prepare'),
    record: notImplemented('installs.record'),
    list: notImplemented('installs.list'),
    check: notImplemented('installs.check'),
    bundleForToken: notImplemented('installs.bundleForToken'),
    markDownloaded: notImplemented('installs.markDownloaded'),
    pushTarget: notImplemented('installs.pushTarget'),
    testPushTarget: notImplemented('installs.testPushTarget'),
  };
}
