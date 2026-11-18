/**
 * Jira import: dry run, review, commit, cancel (BUILD_SPEC §9, §7; UI_SPEC
 * §9.2; contracts/ui-api.md US9; decision T12).
 *
 * The dry run reads Jira in the background and builds the mapped records in
 * memory; the client polls `GET /api/import/jira/:id` for progress and the
 * report. The API token lives in memory for the import session only (1 hour
 * or until cancel), and never appears in a response, the report or a log.
 *
 * Shared contract file (tasks.md, Slice rules).
 */
import { z } from 'zod';
import { objectId, projectKey, text } from '../mcp/common.js';
import { LIMITS } from '../mcp/limits.js';
import { input, jsonResponse, noInput, ownerMutationOutput } from './common.js';
import { json, route } from './route.js';

export const jiraTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('new'), key: projectKey, name: text(80) }),
  z.strictObject({ kind: z.literal('existing'), key: projectKey }),
]);

export const jiraDryRunBody = input({
  /** `https://yoursite.atlassian.net`. */
  site_url: z.url({ protocol: /^https$/ }).max(LIMITS.url),
  email: z.email().max(320),
  /** Held in memory for this import only. */
  api_token: z.string().min(1).max(1_000),
  jira_project: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_]{0,19}$/, { error: 'Expected a Jira project key, like ABC.' }),
  target: jiraTargetSchema,
});

export const JIRA_IMPORT_STATES = [
  'running',
  'ready',
  'failed',
  'canceled',
  'committing',
  'committed',
] as const;

export const jiraReportSchema = z.object({
  totals: z.object({
    issues: z.number().int(),
    would_import: z.number().int(),
    skipped: z.number().int(),
    lossy: z.number().int(),
  }),
  /** The mapping table: Jira → Docket, count, lossy count. */
  mapping: z.array(
    z.object({
      jira: z.string(),
      task_lite: z.string(),
      count: z.number().int(),
      lossy: z.number().int(),
    }),
  ),
  /** Per-field counts: mapped, skipped, lossy. */
  fields: z.array(
    z.object({
      field: z.string(),
      mapped: z.number().int(),
      skipped: z.number().int(),
      lossy: z.number().int(),
    }),
  ),
  lossy_items: z.array(z.object({ key: z.string(), title: z.string(), reason: z.string() })),
  cycles: z.array(z.array(z.string())),
  /** "Story points → customfield_10016", "Start date → not found". */
  fields_used: z.array(z.object({ field: z.string(), jira_field: z.string().nullable() })),
  attachments: z.object({
    count: z.number().int(),
    bytes: z.number().int(),
    skipped: z.array(z.object({ key: z.string(), name: z.string(), reason: z.string() })),
  }),
});
export type JiraReport = z.infer<typeof jiraReportSchema>;

export const jiraImportSchema = z.object({
  import_id: z.string(),
  state: z.enum(JIRA_IMPORT_STATES),
  jira_project: z.string(),
  target: z.object({ kind: z.enum(['new', 'existing']), key: z.string() }),
  /** "Reading 140 of 512 issues…", "Downloading attachments 12 of 40". */
  progress: z
    .object({
      phase: z.enum(['reading', 'mapping', 'importing', 'attachments']),
      done: z.number().int(),
      total: z.number().int().nullable(),
    })
    .nullable(),
  report: jiraReportSchema.nullable(),
  result: z
    .object({
      imported: z.number().int(),
      project: z.string(),
      failed_attachments: z.array(z.object({ name: z.string(), reason: z.string() })),
      report_document_id: z.string().nullable(),
    })
    .nullable(),
  /** "Couldn't sign in to Jira. Check the email and API token." */
  error: z.string().nullable(),
  expires_at: z.string(),
});
export type JiraImport = z.infer<typeof jiraImportSchema>;

export const jiraImportParams = input({ id: objectId });
export const jiraImportResponse = jsonResponse({ import: jiraImportSchema });
export const jiraCommitResponse = ownerMutationOutput({ import: jiraImportSchema });

export const importRoutes = {
  'jira.dryRun': route({
    method: 'POST',
    path: '/api/import/jira/dry-run',
    group: 'import',
    params: noInput,
    query: noInput,
    body: jiraDryRunBody,
    response: json(jiraImportResponse),
  }),
  'jira.get': route({
    method: 'GET',
    path: '/api/import/jira/:id',
    group: 'import',
    params: jiraImportParams,
    query: noInput,
    body: null,
    response: json(jiraImportResponse),
  }),
  /** One transaction; attachment bytes download after the commit. Not undoable. */
  'jira.commit': route({
    method: 'POST',
    path: '/api/import/jira/:id/commit',
    group: 'import',
    params: jiraImportParams,
    query: noInput,
    body: noInput,
    response: json(jiraCommitResponse),
  }),
  /** Cancel: drops the in-memory records and the token. */
  'jira.cancel': route({
    method: 'DELETE',
    path: '/api/import/jira/:id',
    group: 'import',
    params: jiraImportParams,
    query: noInput,
    body: noInput,
    response: json(jsonResponse({ canceled: z.literal(true) })),
  }),
} as const;
