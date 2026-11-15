/**
 * Questions and owner notes (BUILD_SPEC §5.7): the `messages` service.
 *
 * Stub (tasks.md T047): each method throws `NotImplementedError` until
 * US6 (T107) fills it in, here, in place. The signatures are in contracts.ts.
 */
import { notImplemented, type MessagesService, type ServiceDeps } from './contracts.js';

export function createMessagesService(_deps: ServiceDeps): MessagesService {
  return {
    askOwner: notImplemented('messages.askOwner'),
    answer: notImplemented('messages.answer'),
    addOwnerNote: notImplemented('messages.addOwnerNote'),
    markDelivered: notImplemented('messages.markDelivered'),
  };
}
