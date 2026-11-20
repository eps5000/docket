/**
 * Shared changes and conflict guardrails (owner decision 36; BUILD_SPEC §5.21;
 * MCP_SPEC §5.15; FR-158–FR-164): shared part keys, the four tools' schemas,
 * the fields added to claim_lead, set_status and submit_packet, and
 * `get_context.shared`. Shared contract file (tasks.md, Slice rules).
 *
 * B38 resolutions (listed in the B38 PR):
 * - **Keys** are `<kind>:<name>`, normalised by `normaliseSharedPartKey`, so
 *   `Table: Decks` and `table:decks` are one part. Per kind: `table` lowercases
 *   the name; `model` keeps it; `endpoint` is `METHOD /path` (method
 *   uppercased, one space, no trailing slash); `file` is a repo-relative path
 *   with forward slashes (no leading `./` or `/`, no `..`); `other` is a slug
 *   (`a-z0-9-`). At most 200 characters in all.
 * - **Paths** are repo-relative globs (`*`, `**`, `?`), forward slashes, at
 *   most 20 per part and 300 characters each.
 * - **Changed files** (submit_packet, set_status done): up to 2,000
 *   repo-relative paths, normalised like `file:` names.
 */
import { z } from 'zod';
import {
  BRANCH_SOURCES,
  SHARED_CHANGES,
  SHARED_PART_KINDS,
  STATUSES,
  type SharedPartKind,
} from '../enums.js';
import {
  itemId,
  mutationInput,
  mutationOutput,
  projectKey,
  readInput,
  readOutput,
  text,
} from './common.js';
import { LIMITS } from './limits.js';

/** types.ts's statusSchema, restated: types.ts imports this file for get_context.shared. */
const statusSchema = z.enum(STATUSES);

// ---- Keys and paths ----

const ENDPOINT_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/** A repo-relative path: forward slashes, no leading `./` or `/`, no `..` segment. Null when invalid. */
export function normaliseRepoPath(raw: string): string | null {
  let path = raw
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/');
  while (path.startsWith('./')) path = path.slice(2);
  if (path.endsWith('/')) path = path.slice(0, -1);
  if (path === '' || path === '.' || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return null;
  if (path.split('/').some((seg) => seg === '..' || seg === '.')) return null;
  return path;
}

export type SharedPartKeyResult =
  { ok: true; key: string; kind: SharedPartKind; name: string } | { ok: false; error: string };

/**
 * Normalise a shared part key (`model:Token`, `table:decks`,
 * `endpoint:POST /decks/{id}/export`, `file:src/…/Snapshot.cs`,
 * `other:<slug>`). The server, the owner API and the web client all use it.
 */
export function normaliseSharedPartKey(raw: string): SharedPartKeyResult {
  const value = raw.trim();
  const colon = value.indexOf(':');
  if (colon <= 0) {
    return {
      ok: false,
      error: `must be <kind>:<name>, where kind is one of ${SHARED_PART_KINDS.join(', ')} (for example model:Token)`,
    };
  }
  const kind = value.slice(0, colon).trim().toLowerCase();
  if (!(SHARED_PART_KINDS as readonly string[]).includes(kind)) {
    return {
      ok: false,
      error: `has an unknown kind "${kind}"; use ${SHARED_PART_KINDS.join(', ')}`,
    };
  }
  let name = value.slice(colon + 1).trim();
  if (name === '') return { ok: false, error: 'needs a name after the kind' };
  switch (kind as SharedPartKind) {
    case 'table':
      if (/\s/.test(name)) return { ok: false, error: 'a table name has no spaces' };
      name = name.toLowerCase();
      break;
    case 'model':
      if (/\s/.test(name)) return { ok: false, error: 'a model name has no spaces' };
      break;
    case 'endpoint': {
      const m = /^([A-Za-z]+)\s+(\/\S*)$/.exec(name);
      const method = m?.[1]?.toUpperCase();
      if (!m || !(ENDPOINT_METHODS as readonly string[]).includes(method!)) {
        return { ok: false, error: 'an endpoint is METHOD /path, for example POST /decks/{id}' };
      }
      let path = m[2]!;
      if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
      name = `${method} ${path}`;
      break;
    }
    case 'file': {
      const path = normaliseRepoPath(name);
      if (path === null) return { ok: false, error: 'a file is a repo-relative path' };
      name = path;
      break;
    }
    case 'other': {
      const slug = name
        .toLowerCase()
        .replace(/[\s_]+/g, '-')
        .replace(/-{2,}/g, '-');
      if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
        return { ok: false, error: 'an other part is a slug: a-z, 0-9 and -' };
      }
      name = slug;
      break;
    }
  }
  const key = `${kind}:${name}`;
  if (key.length > LIMITS.shared_part_key) {
    return { ok: false, error: `must be at most ${LIMITS.shared_part_key} characters` };
  }
  return { ok: true, key, kind: kind as SharedPartKind, name };
}

/** A shared part key, normalised (`Table: Decks` → `table:decks`). */
export const sharedPartKey = z
  .string()
  .trim()
  .min(1)
  .max(LIMITS.shared_part_key)
  .transform((value, ctx) => {
    const r = normaliseSharedPartKey(value);
    if (r.ok) return r.key;
    ctx.addIssue({ code: 'custom', message: r.error });
    return z.NEVER;
  });

/** A repo-relative glob on a part (`src/Gameflow.Api/Data/Migrations/**`). */
export const sharedPartPath = z
  .string()
  .trim()
  .min(1)
  .max(LIMITS.shared_part_path)
  .transform((value, ctx) => {
    const path = normaliseRepoPath(value);
    if (path !== null) return path;
    ctx.addIssue({ code: 'custom', message: 'must be a repo-relative path or glob' });
    return z.NEVER;
  });

export const sharedPartPaths = z.array(sharedPartPath).max(LIMITS.shared_part_paths_max);

/** One changed file: repo-relative, normalised like a `file:` name. */
export const changedFile = z
  .string()
  .trim()
  .min(1)
  .max(LIMITS.changed_file)
  .transform((value, ctx) => {
    const path = normaliseRepoPath(value);
    if (path !== null) return path;
    ctx.addIssue({ code: 'custom', message: 'must be a repo-relative path' });
    return z.NEVER;
  });

/** `changed_files` on submit_packet and set_status (≤ 2,000). */
export const changedFilesInput = z.array(changedFile).max(LIMITS.changed_files_max);

/** The branch the work is on (claim_lead, submit_packet, set_status): the radar trial-merges it. */
export const branchInput = text(LIMITS.branch);

export const sharedPartKindSchema = z.enum(SHARED_PART_KINDS);
export const sharedChangeSchema = z.enum(SHARED_CHANGES);
/** How the radar knew a branch (B40): `reported` or `discovered`. */
export const branchSourceSchema = z.enum(BRANCH_SOURCES);

// ---- Shapes ----

/** A registered part, as agents see it. */
export const sharedPartSchema = z.object({
  key: z.string(),
  kind: sharedPartKindSchema,
  /** Repo-relative globs that map changed files to this part. */
  paths: z.array(z.string()),
  /** Only one item at a time may change it, under a lease (take_lease). */
  single_writer: z.boolean(),
  note: z.string().nullable(),
  /** `owner`, or the agent that registered it (`claude · orca-w3`). */
  created_by: z.string(),
  archived: z.boolean(),
});
export type SharedPart = z.infer<typeof sharedPartSchema>;

/** Another item's declared change to a part. */
export const inFlightChangeSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: statusSchema,
  change: sharedChangeSchema,
  note: z.string().nullable(),
});
export type InFlightChange = z.infer<typeof inFlightChangeSchema>;

/** A part's current lease. */
export const leaseRefSchema = z.object({
  item_id: z.string(),
  held_until: z.string(),
});

/** One part an item declares. */
export const declaredChangeSchema = z.object({
  part: z.string(),
  kind: sharedPartKindSchema,
  change: sharedChangeSchema,
  note: z.string().nullable(),
});
export type DeclaredChange = z.infer<typeof declaredChangeSchema>;

/**
 * An item's declaration: `declared` (one or more changes), `none` (declared
 * none: `items.shared_none_at`), or `not_declared` (the Ready gate refuses it).
 */
export const declarationSchema = z.object({
  item_id: z.string(),
  state: z.enum(['declared', 'none', 'not_declared']),
  changes: z.array(declaredChangeSchema),
  declared_by: z.string().nullable(),
  declared_at: z.string().nullable(),
});
export type Declaration = z.infer<typeof declarationSchema>;

/** An in-flight item that changes some of the same parts. */
export const overlapFoundSchema = z.object({
  with: z.object({ id: z.string(), title: z.string(), status: statusSchema }),
  parts: z.array(z.string()),
});
export type OverlapFound = z.infer<typeof overlapFoundSchema>;

// ---- declare_shared_changes ----

export const declaredChangeInput = z.strictObject({
  /** A registered part's key, or one in `new_parts`. */
  part: sharedPartKey,
  change: sharedChangeSchema,
  note: text(LIMITS.shared_change_note).optional(),
});

/** A part to register in the same call. Agents can't set single-writer (FR-158). */
export const newPartInput = z.strictObject({
  key: sharedPartKey,
  /** Must match the key's prefix when given. */
  kind: sharedPartKindSchema.optional(),
  paths: sharedPartPaths.optional(),
  note: text(LIMITS.shared_part_note).optional(),
});

/** Checks shared by the tool and the owner's `PUT /api/items/:id/shared`. */
export function checkDeclaration(
  value: {
    changes?: { part: string }[];
    none?: boolean;
    new_parts?: { key: string; kind?: string }[];
    branch?: string;
    branches?: string[];
  },
  ctx: z.RefinementCtx,
): void {
  if (value.branch !== undefined && value.branches !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['branches'],
      message: 'Pass branch (one) or branches (a list), not both.',
    });
  }
  const hasChanges = value.changes !== undefined;
  if (hasChanges === (value.none === true)) {
    ctx.addIssue({
      code: 'custom',
      path: ['changes'],
      message: 'Pass changes (one or more parts) or none: true, not both.',
    });
  }
  if (value.none === true && value.new_parts !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['new_parts'],
      message: 'new_parts goes with changes, not with none.',
    });
  }
  const seen = new Set<string>();
  value.changes?.forEach((c, i) => {
    if (seen.has(c.part)) {
      ctx.addIssue({
        code: 'custom',
        path: ['changes', i, 'part'],
        message: `lists ${c.part} twice`,
      });
    }
    seen.add(c.part);
  });
  const fresh = new Set<string>();
  value.new_parts?.forEach((p, i) => {
    if (p.kind !== undefined && !p.key.startsWith(`${p.kind}:`)) {
      ctx.addIssue({
        code: 'custom',
        path: ['new_parts', i, 'kind'],
        message: `doesn't match the key ${p.key}`,
      });
    }
    if (fresh.has(p.key)) {
      ctx.addIssue({
        code: 'custom',
        path: ['new_parts', i, 'key'],
        message: `lists ${p.key} twice`,
      });
    }
    fresh.add(p.key);
  });
}

export const declareSharedChangesInput = mutationInput({
  id: itemId,
  /** The whole declaration: it replaces the item's current one. */
  changes: z.array(declaredChangeInput).min(1).max(LIMITS.shared_changes_max).optional(),
  /** Declare that the item changes no shared part. */
  none: z.literal(true).optional(),
  /** Parts that aren't registered yet. */
  new_parts: z.array(newPartInput).min(1).max(LIMITS.shared_new_parts_max).optional(),
  /**
   * B40: the branch the item's work is on, recorded for the conflict radar.
   * B41: a one-branch `branches`; it replaces the item's reported branches.
   * Omit both to keep them as they are.
   */
  branch: branchInput.optional(),
  /**
   * B41: every branch the item's work is on (up to 10), for the conflict
   * radar. They replace the item's reported branches; an empty list clears
   * them, so the radar looks for one by name.
   */
  branches: z.array(branchInput).max(LIMITS.item_branches_max).optional(),
}).superRefine(checkDeclaration);
export const declareSharedChangesOutput = mutationOutput({
  declaration: declarationSchema,
  /** The keys new_parts registered. */
  registered: z.array(z.string()),
  /** In-flight items that change the same parts now (informational; the claim enforces). */
  overlaps: z.array(overlapFoundSchema),
});

// ---- list_shared_parts ----

export const listSharedPartsInput = readInput({
  project: projectKey,
  include_archived: z.boolean().default(false),
});
export const sharedPartRowSchema = sharedPartSchema.extend({
  /** Items in flight (Ready, In progress, Review) that declared a change to it. */
  in_flight: z.array(inFlightChangeSchema),
  lease: leaseRefSchema.nullable(),
});
export type SharedPartRow = z.infer<typeof sharedPartRowSchema>;
export const listSharedPartsOutput = readOutput({
  project: z.string(),
  parts: z.array(sharedPartRowSchema),
});

// ---- take_lease / release_lease ----

export const takeLeaseInput = mutationInput({
  /** The item you lead. */
  id: itemId,
  /** A single-writer part. */
  part: sharedPartKey,
});
export const takeLeaseOutput = mutationOutput({
  part: z.string(),
  item_id: z.string(),
  held_until: z.string(),
  /** True when you already held it and this call renewed it. */
  renewed: z.boolean(),
});

export const releaseLeaseInput = mutationInput({
  id: itemId,
  part: sharedPartKey,
});
export const releaseLeaseOutput = mutationOutput({
  part: z.string(),
  item_id: z.string(),
  released: z.literal(true),
});

// ---- get_context.shared ----

/** One declared change by another in-flight item, for get_context. */
export const contextChangeSchema = inFlightChangeSchema.extend({ part: z.string() });

/**
 * `get_context.shared` (BUILD_SPEC §5.21 Context; FR-164): the item's own
 * declaration, the overlapping declarations of other in-flight items, up to
 * 30 other in-flight declarations in the project, leases held, and radar
 * findings. Counted in the budget; `truncated` when cut.
 */
export const contextSharedSchema = z.object({
  declaration: z.object({
    state: declarationSchema.shape.state,
    changes: z.array(declaredChangeSchema),
  }),
  overlapping: z.array(contextChangeSchema),
  in_flight: z.array(contextChangeSchema),
  leases: z.array(z.object({ part: z.string(), held_until: z.string() })),
  radar: z.array(
    z.object({
      /** The other item, or null for the main branch. */
      with: z.string().nullable(),
      /** The other side's branch (the main branch for `with: null`). */
      branch: z.string(),
      /** B41: this item's branch in the pair (an item may report several). */
      own_branch: z.string(),
      files: z.array(z.string()),
    }),
  ),
  truncated: z.boolean(),
});
export type ContextShared = z.infer<typeof contextSharedSchema>;
