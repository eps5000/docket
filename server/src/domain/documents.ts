/**
 * Documents (BUILD_SPEC §5.10): the `documents` service.
 *
 * Stub (tasks.md T047): each method throws `NotImplementedError` until
 * US7 (T111) fills it in, here, in place. The signatures are in contracts.ts.
 */
import { notImplemented, type DocumentsService, type ServiceDeps } from './contracts.js';

export function createDocumentsService(_deps: ServiceDeps): DocumentsService {
  return {
    put: notImplemented('documents.put'),
    stage: notImplemented('documents.stage'),
    commitUpload: notImplemented('documents.commitUpload'),
    content: notImplemented('documents.content'),
  };
}
