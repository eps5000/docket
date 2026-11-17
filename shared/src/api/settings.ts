/**
 * Settings: projects, connections, service health, and deleting a project
 * (BUILD_SPEC §5.12, §5.13, §7; UI_SPEC §6.7; contracts/ui-api.md US10).
 * The blocker rule (`PATCH /api/projects/:key`) is in deps.ts; lock and
 * rotate-key are in session.ts. Shared contract file (tasks.md, Slice rules).
 */
import { z } from 'zod';
import { projectKey } from '../mcp/common.js';
import { input, jsonResponse, noInput } from './common.js';
import { json, route } from './route.js';
import { projectSchema } from './types.js';

export const projectSettingsSchema = projectSchema.extend({
  counts: z.object({
    epics: z.number().int(),
    items: z.number().int(),
    documents: z.number().int(),
    for_you: z.number().int(),
    done: z.number().int(),
    active: z.number().int(),
    review: z.number().int(),
    planning: z.number().int(),
    decisions: z.number().int(),
  }),
  labels: z.array(z.string()),
});

export const clientStatusSchema = z.object({
  client: z.string(),
  transport: z.string(),
  last_seen_at: z.string().nullable(),
  status: z.enum(['verified', 'not_verified', 'not_configured']),
  /** How the client's tool results are shaped (MCP_SPEC §3 Results): `text` = text-only. */
  result_mode: z.enum(['structured', 'text']),
  notes: z.string().nullable(),
});

export const backupLocationSchema = z.object({
  location: z.enum(['volume', 'extra']),
  path: z.string(),
  last_success_at: z.string().nullable(),
  keep_days: z.number().int(),
  /** "Extra backup copy failed: <reason>" until a later copy succeeds. */
  last_error: z.string().nullable(),
});

export const settingsResponse = jsonResponse({
  projects: z.array(projectSettingsSchema),
  connections: z.object({
    clients: z.array(clientStatusSchema),
    endpoint: z.object({
      mcp_url: z.string(),
      web_url: z.string(),
      bind: z.literal('loopback'),
      auth: z.literal('bearer'),
      origins: z.array(z.string()),
    }),
  }),
  health: z.object({
    database: z.object({ state: z.string(), bytes: z.number().int().nullable() }),
    documents: z.object({ state: z.string(), bytes: z.number().int().nullable() }),
    volume_free_bytes: z.number().int().nullable(),
    backups: z.array(backupLocationSchema),
    extra_backup_configured: z.boolean(),
    restarted_at: z.string(),
    /** "0 runs were active…": runs interrupted by the last restart. */
    interrupted_at_restart: z.number().int(),
  }),
});
export type SettingsResponse = z.infer<typeof settingsResponse>;

/**
 * Settings → Connections → *Reveal token* (UI_SPEC §6.7; MCP_SPEC §11): the
 * agent bearer token, behind the owner session. The server answers with
 * `Cache-Control: no-store` and never writes the value to any log.
 */
export const agentTokenResponse = jsonResponse({ token: z.string() });

export const deleteProjectParams = input({ key: projectKey });
/** The owner types the key to confirm (BUILD_SPEC §5.12). */
export const deleteProjectBody = input({ confirm_key: projectKey });
export const deleteProjectResponse = jsonResponse({ deleted: z.literal(true), key: z.string() });

export const settingsRoutes = {
  'settings.get': route({
    method: 'GET',
    path: '/api/settings',
    group: 'settings',
    params: noInput,
    query: noInput,
    body: null,
    response: json(settingsResponse),
  }),
  /** *Reveal token*: owner session only; `Cache-Control: no-store`; never logged. */
  'settings.agentToken': route({
    method: 'GET',
    path: '/api/settings/agent-token',
    group: 'settings',
    params: noInput,
    query: noInput,
    body: null,
    response: json(agentTokenResponse),
  }),
  /** Not undoable: removes the records and documents together (O10). */
  'projects.delete': route({
    method: 'DELETE',
    path: '/api/projects/:key',
    group: 'settings',
    params: deleteProjectParams,
    query: noInput,
    body: deleteProjectBody,
    response: json(deleteProjectResponse),
  }),
} as const;
