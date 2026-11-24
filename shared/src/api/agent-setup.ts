/**
 * Agent setup (owner decision 29; BUILD_SPEC §4, §5.17, §7; UI_SPEC §6.7b;
 * contracts/ui-api.md US13): the agent files and their layers, the
 * project's Workflow notes, installs, the install log, the check, and the
 * push folder. `GET /install/:token` is the one route without the owner
 * session: the copy-paste command downloads the bundle with a single-use
 * token (auth `token`). Shared contract file (tasks.md, Slice rules).
 *
 * B21 resolutions (limits and shapes the spec doesn't name; listed in the
 * B21 PR): file content ≤ 50,000 characters per version; `expected_version`
 * is the layer's current `version_no`, 0 when it has none; GETs return every
 * version's content, so diffs need no per-version route; the token is 32
 * random bytes as base64url, stored only as a sha256; unknown, expired and
 * used tokens all answer `404 not_found`.
 */
import { z } from 'zod';
import {
  AGENT_FILE_LAYERS,
  EDITABLE_AGENT_FILE_LAYERS,
  INSTALL_CHECK_STATES,
  INSTALL_CLIENTS,
  INSTALL_FILE_CHANGES,
  INSTALL_METHODS,
  INSTALL_TARGET_KINDS,
  type InstallClient,
} from '../enums.js';
import { objectId, projectKey, text } from '../mcp/common.js';
import { expectedVersion, input, jsonResponse, noInput, ownerMutationOutput } from './common.js';
import { json, route } from './route.js';

// ---- Limits and formats ----

export const AGENT_SETUP_LIMITS = {
  /** One agent file version (skills are ≤ 10 KB today). */
  agent_file_content: 50_000,
  /** Workflow notes (BUILD_SPEC §5.17; FR-123). */
  workflow_md: 10_000,
  /** The note on an edit, a revert or a workflow version. */
  note: 500,
  /** A skill's name: the `<name>` in `skill:<name>` and `skills/<name>/`. */
  skill_name: 60,
  /** A host path for an install (the same bound as a run's workspace path). */
  install_path: 1_000,
  /** How long an install token is valid (BUILD_SPEC §5.17: 10 minutes). */
  install_token_ttl_ms: 10 * 60_000,
} as const;

/**
 * `agents_block`, `skill:<name>` with a name of `a-z0-9-`, or exactly
 * `guide:onboarding` (the onboarding guide; decision 31, B30 contract change).
 */
export const AGENT_FILE_KEY_RE = /^(agents_block|skill:[a-z0-9-]{1,60}|guide:onboarding)$/;
/** An install token: 32 random bytes, base64url without padding. */
export const INSTALL_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export const agentFileKey = z.string().trim().regex(AGENT_FILE_KEY_RE, {
  error:
    'Expected an agent file key: agents_block, guide:onboarding, or skill:<name> like skill:docket-worker.',
});
export const installToken = z
  .string()
  .regex(INSTALL_TOKEN_RE, { error: 'Expected an install token (43 characters).' });

export const agentFileLayerSchema = z.enum(AGENT_FILE_LAYERS);
export const editableLayerSchema = z.enum(EDITABLE_AGENT_FILE_LAYERS);
const note = text(AGENT_SETUP_LIMITS.note);

/** `project` is given exactly when the layer is `project`. */
function projectMatchesLayer(
  v: { layer: 'service' | 'project'; project?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (v.layer === 'project' && v.project === undefined) {
    ctx.addIssue({ code: 'custom', path: ['project'], message: 'is required for layer project' });
  }
  if (v.layer === 'service' && v.project !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['project'], message: 'is only for layer project' });
  }
}

// ---- Shapes ----

/** One immutable version of an agent file, with its content. */
export const agentFileVersionSchema = z.object({
  id: z.string(),
  version_no: z.number().int(),
  sha256: z.string(),
  author: z.string(),
  note: z.string().nullable(),
  created_at: z.string(),
  content: z.string(),
});
export type AgentFileVersion = z.infer<typeof agentFileVersionSchema>;

/** A layer's current version, without content (the file list). */
export const agentFileVersionRefSchema = agentFileVersionSchema.omit({ content: true });
export type AgentFileVersionRef = z.infer<typeof agentFileVersionRefSchema>;

/** A file is a skill, the AGENTS.md block, or the onboarding guide (decision 31; B30). */
export const agentFileKindSchema = z.enum(['skill', 'agents_block', 'guide']);

const agentFileLayersOf = <S extends z.ZodType>(layer: S) =>
  z.object({ bundled: layer.nullable(), service: layer.nullable(), project: layer.nullable() });

/** One row of the file list (UI_SPEC §6.7b): its effective layer and version, and the flag. */
export const agentFileRowSchema = z.object({
  key: z.string(),
  kind: agentFileKindSchema,
  /** The skill's name, or "AGENTS.md block". */
  name: z.string(),
  effective_layer: agentFileLayerSchema,
  effective: agentFileVersionRefSchema,
  /** Each layer's current version; `project` is null without a project or an override. */
  layers: agentFileLayersOf(agentFileVersionRefSchema),
  /** The bundled version changed after the owner edited the effective layer (FR-122). */
  bundled_updated: z.boolean(),
});
export type AgentFileRow = z.infer<typeof agentFileRowSchema>;

/** A layer of one file: its current version number and every version, newest first. */
export const agentFileLayerDetailSchema = z.object({
  file_id: z.string(),
  current_version_no: z.number().int(),
  versions: z.array(agentFileVersionSchema),
});

/** One file with every layer and its history (UI_SPEC §6.7b file view). */
export const agentFileDetailSchema = z.object({
  key: z.string(),
  kind: agentFileKindSchema,
  name: z.string(),
  /** The project asked about, or null for the service-wide view. */
  project: z.string().nullable(),
  effective_layer: agentFileLayerSchema,
  layers: agentFileLayersOf(agentFileLayerDetailSchema),
  /**
   * "Bundled version updated" (BUILD_SPEC §5.17): the edited layer was based
   * on bundled version X (`from`, null if it's no longer known), and bundled
   * is now Y (`to`). Both are in `layers.bundled.versions`, for the
   * three-way view. Null when the flag doesn't apply.
   */
  bundled_updated: z
    .object({
      edited_layer: editableLayerSchema,
      from_version_id: z.string().nullable(),
      to_version_id: z.string(),
    })
    .nullable(),
});
export type AgentFileDetail = z.infer<typeof agentFileDetailSchema>;

/** One Workflow notes version. */
export const workflowVersionSchema = z.object({
  /**
   * The version's `wf_…` ID, as `get_agent_files` and proposals name it
   * (optional; B27a: the proposal review finds its three-way base by it).
   */
  id: z.string().optional(),
  version_no: z.number().int(),
  content_md: z.string(),
  author: z.string(),
  note: z.string().nullable(),
  created_at: z.string(),
});

/** A project's Workflow notes: the current version (0 and empty when none) and the history. */
export const workflowSchema = z.object({
  project: z.string(),
  version_no: z.number().int(),
  content_md: z.string(),
  /** Newest first. */
  versions: z.array(workflowVersionSchema),
});
export type Workflow = z.infer<typeof workflowSchema>;

/** One file in an install's manifest (FR-126), as written to `.docket-manifest.json`. */
export const manifestEntrySchema = z.object({
  key: z.string(),
  version_id: z.string(),
  sha256: z.string(),
});

/** Why the uninstall left a file in place (decision 50). */
export const UNINSTALL_KEPT_REASONS = [
  'modified',
  'link',
  'not_a_file',
  'damaged_markers',
  'other_files',
  'has_kept_files',
] as const;
export type UninstallKeptReason = (typeof UNINSTALL_KEPT_REASONS)[number];

const uninstallPath = text(AGENT_SETUP_LIMITS.install_path);
const uninstallPaths = z.array(uninstallPath).max(200);
const uninstallKept = z
  .array(z.object({ path: uninstallPath, why: z.enum(UNINSTALL_KEPT_REASONS) }))
  .max(200);

/**
 * How an install was removed (decision 50): `command`, by its uninstall
 * command, which lists each file; or `marked`, the owner saying a legacy
 * user-wide install was removed outside Docket, with no file lists.
 */
export const installRemovalSchema = z.object({
  how: z.enum(['command', 'marked']),
  removed: z.array(z.string()),
  kept: z.array(z.object({ path: z.string(), why: z.enum(UNINSTALL_KEPT_REASONS) })),
  gone: z.array(z.string()),
});
export type InstallRemoval = z.infer<typeof installRemovalSchema>;

/** An install log row (UI_SPEC §6.7b; FR-126). */
export const installRowSchema = z.object({
  id: z.string(),
  at: z.string(),
  client: z.enum(INSTALL_CLIENTS),
  target_kind: z.enum(INSTALL_TARGET_KINDS),
  project: z.string().nullable(),
  /** The host path; null for a command install the owner ran without one. */
  path: z.string().nullable(),
  method: z.enum(INSTALL_METHODS),
  file_count: z.number().int(),
  manifest: z.array(manifestEntrySchema),
  /** When the command's download used the token; null for push. */
  token_used_at: z.string().nullable(),
  /** Decision 50: when this install was removed; null while it's in place. */
  removed_at: z.string().nullable(),
  /** Decision 50: how it was removed and what happened to each file. */
  removal: installRemovalSchema.nullable(),
});
export type InstallRow = z.infer<typeof installRowSchema>;

/** A copy-paste command for each shell (UI_SPEC §6.7b: each with *Copy*). */
export const shellCommandsSchema = z.object({ powershell: z.string(), bash: z.string() });

// ---- GET /api/agent-files?project ----

export const agentFilesQuery = input({ project: projectKey.optional() });
export const agentFilesResponse = jsonResponse({
  project: z.string().nullable(),
  files: z.array(agentFileRowSchema),
});
export type AgentFilesResponse = z.infer<typeof agentFilesResponse>;

// ---- GET /api/agent-files/:key?project ----

export const agentFileParams = input({ key: agentFileKey });
export const agentFileQuery = agentFilesQuery;
export const agentFileResponse = agentFileDetailSchema;
export type AgentFileResponse = z.infer<typeof agentFileResponse>;

// ---- PUT /api/agent-files/:key ----

export const putAgentFileBody = input({
  layer: editableLayerSchema,
  project: projectKey.optional(),
  /** The whole file, as written (not trimmed). */
  content: z.string().min(1).max(AGENT_SETUP_LIMITS.agent_file_content),
  /** The layer's current `version_no`, 0 when it has none yet. */
  expected_version: expectedVersion,
  note: note.optional(),
}).superRefine(projectMatchesLayer);
export const putAgentFileResponse = ownerMutationOutput({ file: agentFileDetailSchema });
export type PutAgentFileResponse = z.infer<typeof putAgentFileResponse>;

// ---- POST /api/agent-files/:key/revert ----

export const revertAgentFileBody = input({
  layer: editableLayerSchema,
  project: projectKey.optional(),
}).superRefine(projectMatchesLayer);
export const revertAgentFileResponse = putAgentFileResponse;
export type RevertAgentFileResponse = z.infer<typeof revertAgentFileResponse>;

// ---- GET and PUT /api/projects/:key/workflow ----

export const workflowParams = input({ key: projectKey });
export const workflowResponse = workflowSchema;
export type WorkflowResponse = z.infer<typeof workflowResponse>;

export const putWorkflowBody = input({
  /** Empty clears the notes (a new, empty version). */
  content_md: z.string().max(AGENT_SETUP_LIMITS.workflow_md),
  /** The current `version_no`, 0 when the project has no notes yet. */
  expected_version: expectedVersion,
  note: note.optional(),
});
export const putWorkflowResponse = ownerMutationOutput({ workflow: workflowSchema });
export type PutWorkflowResponse = z.infer<typeof putWorkflowResponse>;

// ---- POST /api/installs ----

/** Decision 50: why a new user-wide install is refused. */
export const USER_WIDE_REFUSED =
  'User-wide installs are no longer supported because they reach unrelated projects. Choose a project and install into its repo.';

export const createInstallBody = input({
  /** One client: the original form (B21), still accepted. */
  client: z.enum(INSTALL_CLIENTS).optional(),
  /** Several clients in one install (decision 34): each gets its files, manifest and log row. */
  clients: z
    .array(z.enum(INSTALL_CLIENTS))
    .min(1)
    .max(INSTALL_CLIENTS.length)
    .refine((v) => new Set(v).size === v.length, { error: 'lists a client twice' })
    .optional(),
  /** Decision 50: only `repo`. `user` stays in the enum so the refusal can say why. */
  target_kind: z.enum(INSTALL_TARGET_KINDS),
  /** The project whose effective files to install (decision 50: required). */
  project: projectKey.optional(),
  /** The host path. Required for push; optional for a command (it runs where it's pasted). */
  path: text(AGENT_SETUP_LIMITS.install_path).optional(),
  method: z.enum(INSTALL_METHODS),
}).superRefine((v, ctx) => {
  if (v.target_kind === 'user') {
    ctx.addIssue({ code: 'custom', path: ['target_kind'], message: USER_WIDE_REFUSED });
  } else if (v.project === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['project'],
      message: 'is required: choose a project to install into its repo',
    });
  }
  if (v.method === 'push' && v.path === undefined) {
    ctx.addIssue({ code: 'custom', path: ['path'], message: 'is required for method push' });
  }
  if ((v.client === undefined) === (v.clients === undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: ['clients'],
      message: 'pass client or clients (one of the two)',
    });
  }
});

/** The clients an install body names, in the order they're installed (Claude Code first). */
export function installClientsOf(body: {
  client?: InstallClient | undefined;
  clients?: readonly InstallClient[] | undefined;
}): InstallClient[] {
  const named = body.clients ?? (body.client ? [body.client] : []);
  return INSTALL_CLIENTS.filter((c) => named.includes(c));
}

/**
 * One client's part of an install (decision 34): its own install ID, and the
 * files it wrote (push, each with what changed) or will write (command, no
 * change yet). `note` explains a file Docket wrote in a special way, such as a
 * new CLAUDE.md that imports AGENTS.md.
 */
export const installClientResultSchema = z.object({
  client: z.enum(INSTALL_CLIENTS),
  install_id: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      change: z.enum(INSTALL_FILE_CHANGES).optional(),
      note: z.string().optional(),
    }),
  ),
  /** Command installs: this client's check one-liners. */
  check_command: shellCommandsSchema.optional(),
});
export type InstallClientResult = z.infer<typeof installClientResultSchema>;
export const createInstallResponse = jsonResponse({
  /** The first client's install ID (the single-client form's only one). */
  install_id: z.string(),
  /** Every client's part, in install order: the one summary the dialog shows (decision 34). */
  clients: z.array(installClientResultSchema),
  /** Command installs: the one-liners that download `GET /install/:token` and unpack it. */
  command: shellCommandsSchema.optional(),
  /** Command installs: the first client's check (each client's is in `clients`). */
  check_command: shellCommandsSchema.optional(),
  /** Command installs: when the token stops working. */
  expires_at: z.string().optional(),
  /** Push installs: what was written, every client's files together. */
  result: z
    .object({
      files: z.array(z.object({ path: z.string(), change: z.enum(INSTALL_FILE_CHANGES) })),
    })
    .optional(),
});
export type CreateInstallResponse = z.infer<typeof createInstallResponse>;

// ---- GET /api/installs?project ----

export const installsQuery = input({ project: projectKey.optional() });
export const installsResponse = jsonResponse({ installs: z.array(installRowSchema) });
export type InstallsResponse = z.infer<typeof installsResponse>;

// ---- POST /api/installs/:id/check ----

export const installParams = input({ id: objectId });
export const installCheckResponse = jsonResponse({
  install_id: z.string(),
  checked_at: z.string(),
  state: z.enum(['up_to_date', 'differs']),
  /** Only the files that differ; empty when up to date. */
  files: z.array(
    z.object({
      /** The manifest key; null for an extra skill folder the install didn't write. */
      key: z.string().nullable(),
      path: z.string(),
      state: z.enum(INSTALL_CHECK_STATES),
      /**
       * Push checks, edited files only (B24): the installed text, at most
       * 50,000 characters, so the UI can diff it against the version sent.
       * For the AGENTS.md block it is the text between the markers.
       */
      local_content: z.string().max(AGENT_SETUP_LIMITS.agent_file_content).optional(),
    }),
  ),
});
export type InstallCheckResponse = z.infer<typeof installCheckResponse>;

// ---- GET /api/install-state?project&path ----

/**
 * Install state per client (decision 34; UI_SPEC §6.7b), computed from the
 * latest install's manifest and the open drift records: nothing new is stored.
 * - `not_installed`: no push install, and no command install downloaded;
 * - `changed`: open drift on that install ("Changed outside Docket");
 * - `update_available`: a file Docket would install now differs from the
 *   version sent (newer bundled skills, an edit, a new or removed skill, or
 *   another trust mode for the connection file);
 * - `up_to_date`.
 */
export const INSTALL_STATES = [
  'not_installed',
  'up_to_date',
  'update_available',
  'changed',
] as const;
export type InstallState = (typeof INSTALL_STATES)[number];

/**
 * Where a repo install lives when it's a separate worktree (decision 50), from
 * what agents reported on their runs. Docket adds no Git read for this.
 * `merged`: that run's ticket has a merged PR recorded.
 */
export const installWorktreeSchema = z.object({
  name: z.string(),
  branch: z.string(),
  merged: z.boolean(),
});
export type InstallWorktree = z.infer<typeof installWorktreeSchema>;

export const installStateQuery = input({
  /** A project's repo installs; omitted: user-wide. */
  project: projectKey.optional(),
  /** The repo folder, to look for client markers when it's inside the push folder. */
  path: text(AGENT_SETUP_LIMITS.install_path).optional(),
});
export const installStateResponse = jsonResponse({
  project: z.string().nullable(),
  target_kind: z.enum(INSTALL_TARGET_KINDS),
  clients: z.array(
    z.object({
      client: z.enum(INSTALL_CLIENTS),
      state: z.enum(INSTALL_STATES),
      /** The latest install the state is based on; null when not installed. */
      install: installRowSchema.nullable(),
      /** `update_available`: the keys whose version differs, or that were added or removed. */
      outdated: z.array(z.string()),
      /** `changed`: the open drift records (Agent files → Changed outside Docket). */
      drift_ids: z.array(z.string()),
      /** The folder has this client's markers; null when Docket can't see the folder. */
      markers: z.boolean().nullable(),
      /** Decision 50: the install is in a separate worktree, as Docket's runs recorded it. */
      worktree: installWorktreeSchema.nullable(),
      /**
       * Decision 56: what the repo's main branch holds. `current` or `behind`
       * when Docket read it with read-only git, `absent` when it has no
       * install, `unknown` when Docket can't read the repo.
       */
      repo_main: z.object({
        state: z.enum(['current', 'behind', 'absent', 'unknown']),
        branch: z.string().nullable(),
      }),
      /** Decision 56: an update the project fetched that isn't known to be on main yet. */
      update_on_branch: z.object({ install_id: z.string(), at: z.string() }).nullable(),
    }),
  ),
  /**
   * The clients the Install dialog ticks: those the folder has markers for
   * (`.claude/`, `CLAUDE.md`; `.codex/`, `.agents/`, `AGENTS.md`) or that are
   * installed, else both.
   */
  defaults: z.array(z.enum(INSTALL_CLIENTS)),
  /** Decision 56: the command a project's coordinator runs to take an update. */
  update_command: z.object({ powershell: z.string(), bash: z.string() }),
});
export type InstallStateResponse = z.infer<typeof installStateResponse>;

// ---- GET /api/install-overview ----

/**
 * Every project's repo installs (decision 50), for All projects: the latest
 * install of each client at each folder. Legacy user-wide installs never
 * appear here, so they can't count as installed for a project.
 */
export const installOverviewResponse = jsonResponse({
  rows: z.array(
    z.object({
      project: z.string(),
      client: z.enum(INSTALL_CLIENTS),
      state: z.enum(INSTALL_STATES),
      install: installRowSchema,
      outdated: z.array(z.string()),
      drift_ids: z.array(z.string()),
      worktree: installWorktreeSchema.nullable(),
    }),
  ),
});
export type InstallOverviewResponse = z.infer<typeof installOverviewResponse>;

// ---- POST /api/installs/:id/uninstall ----

export const uninstallResponse = jsonResponse({
  install_id: z.string(),
  /** The one-liners that download `GET /uninstall/:token` and run it. */
  command: z.object({ powershell: z.string(), bash: z.string() }),
  /** The exact step each command runs, to read before running it. */
  script: z.object({ powershell: z.string(), bash: z.string() }),
  /** What it may remove, as shown. */
  files: z.array(z.object({ path: z.string(), what: z.enum(['file', 'block', 'connection']) })),
  expires_at: z.string(),
});
export type UninstallResponse = z.infer<typeof uninstallResponse>;

// ---- POST /uninstall/:token/report ----

/** What the uninstall step did (decision 50). Paths must be ones this install wrote. */
export const uninstallReportBody = input({
  removed: uninstallPaths,
  kept: uninstallKept,
  gone: uninstallPaths,
});
export const uninstallReportResponse = jsonResponse({ recorded: z.literal(true) });

// ---- POST /api/installs/:id/mark-removed ----

export const markInstallRemovedResponse = jsonResponse({
  mutation_id: z.string(),
  install: installRowSchema,
});
export type MarkInstallRemovedResponse = z.infer<typeof markInstallRemovedResponse>;

// ---- GET /api/push-target, POST /api/push-target/test ----

export const pushTargetResponse = jsonResponse({
  /** `DOCKET_PUSH_ROOT` is set. */
  configured: z.boolean(),
  /** Null when not configured. */
  writable: z.boolean().nullable(),
  container_path: z.string().nullable(),
  host_path: z.string().nullable(),
});
export type PushTargetResponse = z.infer<typeof pushTargetResponse>;

export const pushTargetTestResponse = jsonResponse({ ok: z.boolean(), message: z.string() });
export type PushTargetTestResponse = z.infer<typeof pushTargetTestResponse>;

// ---- GET /install/:token ----

export const installTokenParams = input({ token: installToken });

// ---- Routes ----

export const agentSetupRoutes = {
  'agentFiles.list': route({
    method: 'GET',
    path: '/api/agent-files',
    group: 'setup',
    params: noInput,
    query: agentFilesQuery,
    body: null,
    response: json(agentFilesResponse),
  }),
  'agentFiles.get': route({
    method: 'GET',
    path: '/api/agent-files/:key',
    group: 'setup',
    params: agentFileParams,
    query: agentFileQuery,
    body: null,
    response: json(agentFileResponse),
  }),
  'agentFiles.put': route({
    method: 'PUT',
    path: '/api/agent-files/:key',
    group: 'setup',
    params: agentFileParams,
    query: noInput,
    body: putAgentFileBody,
    response: json(putAgentFileResponse),
    undoable: true,
  }),
  'agentFiles.revert': route({
    method: 'POST',
    path: '/api/agent-files/:key/revert',
    group: 'setup',
    params: agentFileParams,
    query: noInput,
    body: revertAgentFileBody,
    response: json(revertAgentFileResponse),
    undoable: true,
  }),
  'workflow.get': route({
    method: 'GET',
    path: '/api/projects/:key/workflow',
    group: 'setup',
    params: workflowParams,
    query: noInput,
    body: null,
    response: json(workflowResponse),
  }),
  'workflow.put': route({
    method: 'PUT',
    path: '/api/projects/:key/workflow',
    group: 'setup',
    params: workflowParams,
    query: noInput,
    body: putWorkflowBody,
    response: json(putWorkflowResponse),
    undoable: true,
  }),
  'installs.create': route({
    method: 'POST',
    path: '/api/installs',
    group: 'setup',
    params: noInput,
    query: noInput,
    body: createInstallBody,
    response: json(createInstallResponse),
  }),
  'installs.list': route({
    method: 'GET',
    path: '/api/installs',
    group: 'setup',
    params: noInput,
    query: installsQuery,
    body: null,
    response: json(installsResponse),
  }),
  'installs.state': route({
    method: 'GET',
    path: '/api/install-state',
    group: 'setup',
    params: noInput,
    query: installStateQuery,
    body: null,
    response: json(installStateResponse),
  }),
  'installs.check': route({
    method: 'POST',
    path: '/api/installs/:id/check',
    group: 'setup',
    params: installParams,
    query: noInput,
    body: noInput,
    response: json(installCheckResponse),
  }),
  'installs.overview': route({
    method: 'GET',
    path: '/api/install-overview',
    group: 'setup',
    params: noInput,
    query: noInput,
    body: null,
    response: json(installOverviewResponse),
  }),
  'installs.uninstall': route({
    method: 'POST',
    path: '/api/installs/:id/uninstall',
    group: 'setup',
    params: installParams,
    query: noInput,
    body: noInput,
    response: json(uninstallResponse),
  }),
  'installs.markRemoved': route({
    method: 'POST',
    path: '/api/installs/:id/mark-removed',
    group: 'setup',
    params: installParams,
    query: noInput,
    body: noInput,
    response: json(markInstallRemovedResponse),
    undoable: true,
  }),
  'pushTarget.get': route({
    method: 'GET',
    path: '/api/push-target',
    group: 'setup',
    params: noInput,
    query: noInput,
    body: null,
    response: json(pushTargetResponse),
  }),
  'pushTarget.test': route({
    method: 'POST',
    path: '/api/push-target/test',
    group: 'setup',
    params: noInput,
    query: noInput,
    body: noInput,
    response: json(pushTargetTestResponse),
  }),
  /**
   * The bundle the copy-paste command downloads (a tar.gz). No owner session,
   * no CSRF, no bearer: the single-use token is the credential. It sits behind
   * the app's Host and Origin guards like every route (loopback only).
   */
  'install.download': route({
    method: 'GET',
    path: '/install/:token',
    group: 'install',
    auth: 'token',
    params: installTokenParams,
    query: noInput,
    body: null,
    response: { kind: 'file' },
  }),
  /** Decision 50: the uninstall step's bundle, with the same single-use token rules. */
  'uninstall.download': route({
    method: 'GET',
    path: '/uninstall/:token',
    group: 'install',
    auth: 'token',
    params: installTokenParams,
    query: noInput,
    body: null,
    response: { kind: 'file' },
  }),
  /** Decision 50: the step reports what it did, once, with the token it downloaded with. */
  'uninstall.report': route({
    method: 'POST',
    path: '/uninstall/:token/report',
    group: 'install',
    auth: 'token',
    params: installTokenParams,
    query: noInput,
    body: uninstallReportBody,
    response: json(uninstallReportResponse),
  }),
} as const;
