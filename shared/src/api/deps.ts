/**
 * Dependencies: removing a link and the project's blocker rule (BUILD_SPEC
 * §5.2, §7; contracts/ui-api.md US4). Shared contract file (tasks.md, Slice rules).
 */
import { z } from 'zod';
import { objectId, projectKey, text } from '../mcp/common.js';
import { LIMITS } from '../mcp/limits.js';
import { satisfiedWhenSchema } from '../mcp/types.js';
import { expectedVersion, input, noInput, ownerMutationOutput } from './common.js';
import { json, route } from './route.js';
import { projectSchema } from './types.js';

export const linkParams = input({ linkId: objectId });
export const linkDeleteResponse = ownerMutationOutput({
  removed: z.literal(true),
  /** Items that are no longer blocked. */
  unblocked: z.array(z.string()),
});

export const projectParams = input({ key: projectKey });
export const projectPatchBody = input({
  default_satisfied_when: satisfiedWhenSchema.optional(),
  /** Decision 42: the coordinators who may use `update_run_status` on this project's runs. */
  coordinators: z.array(text(LIMITS.orchestrator_name)).max(LIMITS.coordinators_max).optional(),
  expected_version: expectedVersion.optional(),
}).refine((b) => b.default_satisfied_when !== undefined || b.coordinators !== undefined, {
  error: 'Pass default_satisfied_when or coordinators.',
});
export const projectPatchResponse = ownerMutationOutput({
  project: projectSchema,
  /** "2 items are blocked again" (UI_SPEC §6.7). */
  reblocked: z.array(z.string()),
  unblocked: z.array(z.string()),
});
export type ProjectPatchResponse = z.infer<typeof projectPatchResponse>;

export const depsRoutes = {
  /** Cycle fix, and removing a canceled blocker. */
  'links.delete': route({
    method: 'DELETE',
    path: '/api/links/:linkId',
    group: 'deps',
    params: linkParams,
    query: noInput,
    body: noInput,
    response: json(linkDeleteResponse),
    undoable: true,
  }),
  /** Settings → "Blockers clear when" (clarification route). */
  'projects.patch': route({
    method: 'PATCH',
    path: '/api/projects/:key',
    group: 'deps',
    params: projectParams,
    query: noInput,
    body: projectPatchBody,
    response: json(projectPatchResponse),
    undoable: true,
  }),
} as const;
