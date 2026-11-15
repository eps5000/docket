/**
 * Every tool's handler, by group (one file per group; slices fill them in).
 * The type requires all 38: a missing handler fails the typecheck.
 */
import type { ToolHandlers } from '../register.js';
import { readHandlers } from './read.js';
import { itemsHandlers } from './items.js';
import { runsHandlers } from './runs.js';
import { checklistHandlers } from './checklist.js';
import { evidenceHandlers } from './evidence.js';
import { reviewHandlers } from './review.js';
import { decisionsHandlers } from './decisions.js';
import { recoveryHandlers } from './recovery.js';

export const TOOL_HANDLERS: ToolHandlers = {
  ...readHandlers,
  ...itemsHandlers,
  ...runsHandlers,
  ...checklistHandlers,
  ...evidenceHandlers,
  ...reviewHandlers,
  ...decisionsHandlers,
  ...recoveryHandlers,
};

/** Which group file each tool's handler lives in. */
export const HANDLER_GROUPS: Record<string, readonly string[]> = {
  read: Object.keys(readHandlers),
  items: Object.keys(itemsHandlers),
  runs: Object.keys(runsHandlers),
  checklist: Object.keys(checklistHandlers),
  evidence: Object.keys(evidenceHandlers),
  review: Object.keys(reviewHandlers),
  decisions: Object.keys(decisionsHandlers),
  recovery: Object.keys(recoveryHandlers),
};
