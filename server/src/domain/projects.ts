/**
 * Projects: the blocker rule and delete together (BUILD_SPEC §5.2, §5.12): the `projects` service.
 *
 * US4 (T106) fills `setDefaultSatisfiedWhen`: Settings → "Blockers clear
 * when". Owner only; undoable; re-evaluates blocked state at once and
 * records `project.updated` with what changed.
 *
 * US10 (T131) fills delete (BUILD_SPEC §5.12; O10; FR-104). Owner only, and
 * the owner types the key to confirm. In one transaction:
 * - the project's rows go: its items (their checklists, runs, packets,
 *   questions, links and the rest cascade), labels, documents, decision
 *   records, and its events (the history);
 * - the `projects` row stays as the tombstone, with `deleted_at` set, so
 *   every lookup that filters on it answers `not_found` and the key is not
 *   reused;
 * - one `project.updated` event records the delete (old/new `deleted_at`
 *   and the counts). Its `item_id` is null, so no other project's Activity
 *   shows it, and `get_changes` lists it as a project change. Not undoable.
 *
 * After the commit, `removeDeletedDocs` removes `/data/docs/<KEY>` for every
 * tombstone. A failure is logged and retried at the next startup. Backups
 * are untouched and age out on their own retention.
 *
 * US9 (T141) opens new projects for the Jira import (`openProject`). A key
 * held by a live project is refused. A key held by a tombstone is refused
 * while its documents folder still exists (the cleanup hasn't finished, and
 * the new project's documents would land among the old ones); once the
 * folder is gone, the tombstone row is revived as the new project. It keeps
 * its `next_seq`, so the new items never reuse an ID an agent may still hold
 * for a deleted item.
 *
 * Decision 31 (US15, T164): every new project goes through `insertProject`
 * with the same key and tombstone rules, and records `project.created`:
 * the owner's *New project* (`create`), the Jira import (`openProject`; it
 * wrote `project.updated` until B30), and an agent's `onboard_project` on a
 * free key (onboarding.ts), which sets `created_by`. Only the owner changes
 * a project's settings or deletes one (FR-140).
 */
import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SATISFIED_WHEN_LABELS, ToolError, type Project, type SatisfiedWhen } from '@docket/shared';
import type { Db } from '../db/client.js';
import type { ProjectsService, ServiceDeps } from './contracts.js';
import { newId } from './ids.js';
import { blockDiff } from './links.js';
import { BlockIndex } from './model.js';
import type { WriteContext } from './write.js';

interface ProjectRow {
  id: string;
  key: string;
  name: string;
  short_name: string;
  color: string;
  default_satisfied_when: SatisfiedWhen;
  version: number;
  created_by: string | null;
  coordinators?: string | null;
}

/** Decision 42: the stored JSON list, cleaned; empty when none are registered. */
const coordinatorList = (stored: string | null | undefined): string[] => {
  try {
    const names: unknown = JSON.parse(stored ?? '[]');
    return Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : [];
  } catch {
    return [];
  }
};

const projectView = (p: ProjectRow): Project => ({
  key: p.key,
  name: p.name,
  short_name: p.short_name,
  color: p.color,
  default_satisfied_when: p.default_satisfied_when,
  version: p.version,
  created_by: p.created_by,
  // Decision 42: present once the owner registers one, so other responses stay as they were.
  ...(coordinatorList(p.coordinators).length > 0
    ? { coordinators: coordinatorList(p.coordinators) }
    : {}),
});

const items = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`;

/** Colours for new projects, picked from the key so a project keeps its colour. */
export const PROJECT_COLORS = ['#3b5bdb', '#d9480f', '#2b8a3e', '#862e9c', '#c2255c', '#0b7285'];

/** The default colour for a key: the same key always gets the same one. */
export const defaultColor = (key: string): string =>
  PROJECT_COLORS[[...key].reduce((n, ch) => n + ch.charCodeAt(0), 0) % PROJECT_COLORS.length]!;

/**
 * Why `key` can't be used for a new project right now, or null when it can
 * (US9; B15's tombstones). Read-only: the dry run checks it up front, and
 * `openProject` checks it again inside the commit.
 */
export function newProjectKeyProblem(db: Db, docsDir: string, key: string): ToolError | null {
  const row = db.sqlite.prepare('SELECT deleted_at FROM projects WHERE key = ?').get(key) as
    { deleted_at: string | null } | undefined;
  if (!row) return null;
  if (row.deleted_at === null) {
    return new ToolError(
      'conflict',
      `Project ${key} already exists. Pick another key, or import into ${key} if it's empty.`,
      { details: { fields: { 'target.key': 'already exists' } } },
    );
  }
  if (existsSync(join(docsDir, key))) {
    return new ToolError(
      'conflict',
      `Project ${key} was deleted and its documents are still being removed. Try again in a minute, or pick another key.`,
      { details: { fields: { 'target.key': 'deleted project still being cleaned up' } } },
    );
  }
  return null;
}

export interface NewProject {
  key: string;
  name: string;
  color?: string;
  default_satisfied_when?: SatisfiedWhen;
  /** The agent that created it (`onboard_project`); null for the owner and imports. */
  created_by?: string | null;
}

/**
 * Insert a new project in the caller's transaction: a fresh row, or the key's
 * tombstone revived once its cleanup has finished (it keeps its `next_seq`,
 * so no ID an agent may still hold is reused). Records `project.created`.
 * Callers check who may create (`create` and `openProject`: the owner;
 * onboarding: an agent through `onboard_project`).
 */
export function insertProject(w: WriteContext, docsDir: string, input: NewProject): Project {
  const problem = newProjectKeyProblem(w.db, docsDir, input.key);
  if (problem) throw problem;
  const sql = w.db.sqlite;
  const tombstone = sql.prepare('SELECT * FROM projects WHERE key = ?').get(input.key) as
    (ProjectRow & { deleted_at: string; next_seq: number }) | undefined;
  const fields = {
    name: input.name,
    short_name: input.name,
    color: input.color ?? defaultColor(input.key),
    default_satisfied_when: input.default_satisfied_when ?? ('done' as const),
    created_by: input.created_by ?? null,
  };
  let id: string;
  if (tombstone) {
    id = tombstone.id;
    w.update('projects', id, { ...fields, deleted_at: null });
  } else {
    id = newId('prj', new Date(w.now).getTime());
    w.insert('projects', { id, key: input.key, ...fields, next_seq: 1 });
  }
  const by = fields.created_by ? ` by ${fields.created_by}` : '';
  w.event({
    type: 'project.created',
    summary: `Created project ${input.name} (${input.key})${by}${tombstone ? ', reusing the key of a deleted project' : ''}`,
    project_key: input.key,
    data: {
      old: tombstone ? { deleted_at: tombstone.deleted_at } : null,
      new: { key: input.key, ...fields, deleted_at: null },
      reused_key: !!tombstone,
      ...(tombstone ? { next_seq: tombstone.next_seq } : {}),
    },
    objects: [{ kind: 'project', id: input.key }],
  });
  return projectView(sql.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow);
}

/**
 * Open a new project for an import, in the caller's transaction (US9). Owner
 * only. Records `project.created` (B30; `project.updated` before).
 */
export function openProject(
  w: WriteContext,
  docsDir: string,
  input: { key: string; name: string },
): Project {
  if (w.actor.kind !== 'owner') {
    throw new ToolError('forbidden', 'Only the owner creates projects, through the Jira import.');
  }
  return insertProject(w, docsDir, input);
}

export function createProjectsService(deps: ServiceDeps): ProjectsService {
  return {
    setDefaultSatisfiedWhen(w, input) {
      if (w.actor.kind !== 'owner') {
        throw new ToolError(
          'forbidden',
          "Only the owner sets a project's blocker rule. Set satisfied_when on a link with link_items instead.",
        );
      }
      const sql = w.db.sqlite;
      const found = sql
        .prepare('SELECT * FROM projects WHERE key = ? AND deleted_at IS NULL')
        .get(input.key) as ProjectRow | undefined;
      if (!found) {
        throw new ToolError('not_found', `No project ${input.key}. Check the key in Settings.`);
      }
      const row = w.checkVersion(
        'projects',
        found.id,
        input.expected_version,
      ) as unknown as ProjectRow;
      // Decision 42: the owner names who may use update_run_status on this project's runs.
      if (input.coordinators !== undefined) {
        const names = [...new Set(input.coordinators.map((n) => n.trim()).filter(Boolean))];
        const old = coordinatorList(row.coordinators);
        if (JSON.stringify(names) !== JSON.stringify(old)) {
          const inverse = w.update('projects', row.id, { coordinators: JSON.stringify(names) });
          w.event({
            type: 'project.updated',
            summary: names.length
              ? `Coordinators for ${row.name}: ${names.join(', ')}`
              : `No coordinators registered for ${row.name}`,
            project_key: row.key,
            data: { old: { coordinators: old }, new: { coordinators: names } },
            objects: [{ kind: 'project', id: row.key }],
            inverse: [inverse],
          });
        }
      }
      const rule = input.default_satisfied_when;
      if (rule === undefined || row.default_satisfied_when === rule) {
        const now = sql.prepare('SELECT * FROM projects WHERE id = ?').get(row.id) as ProjectRow;
        return { project: projectView(now), reblocked: [], unblocked: [] };
      }
      const before = new BlockIndex(w.db);
      const inverse = w.update('projects', row.id, { default_satisfied_when: rule });
      const after = new BlockIndex(w.db);
      // Only items in this project can follow its default.
      const affected = [...after.blockers.keys()].filter((id) => after.project(id) === row.key);
      const diff = blockDiff(before, after, affected);
      const changes: string[] = [];
      if (diff.reblocked.length > 0) changes.push(`${items(diff.reblocked.length)} blocked again`);
      if (diff.unblocked.length > 0) changes.push(`${items(diff.unblocked.length)} unblocked`);
      w.event({
        type: 'project.updated',
        summary: `Blocker rule for ${row.name} set to ${SATISFIED_WHEN_LABELS[rule]}${changes.length > 0 ? ` · ${changes.join(' · ')}` : ''}`,
        project_key: row.key,
        data: {
          old: { default_satisfied_when: row.default_satisfied_when },
          new: { default_satisfied_when: rule },
          ...diff,
        },
        inverse: [inverse],
        objects: [
          { kind: 'project', id: row.key },
          ...[...diff.reblocked, ...diff.unblocked].map((id) => ({ kind: 'item' as const, id })),
        ],
      });
      const updated = sql.prepare('SELECT * FROM projects WHERE id = ?').get(row.id) as ProjectRow;
      return { project: projectView(updated), ...diff };
    },
    delete(w, input) {
      if (w.actor.kind !== 'owner') {
        throw new ToolError('forbidden', 'Only the owner deletes a project, in Settings.');
      }
      const sql = w.db.sqlite;
      const row = sql
        .prepare('SELECT * FROM projects WHERE key = ? AND deleted_at IS NULL')
        .get(input.key) as ProjectRow | undefined;
      if (!row) {
        throw new ToolError('not_found', `No project ${input.key}. Check the key in Settings.`);
      }
      if (input.confirm_key !== row.key) {
        throw new ToolError('validation', `Type ${row.key} to confirm deleting ${row.name}.`, {
          details: { fields: { confirm_key: `must be ${row.key}` } },
        });
      }
      const n = (q: string) => (sql.prepare(q).get({ key: row.key }) as { n: number }).n;
      const counts = {
        items: n('SELECT count(*) AS n FROM items WHERE project_key = @key'),
        documents: n('SELECT count(*) AS n FROM documents WHERE project_key = @key'),
        events: n(
          'SELECT count(*) AS n FROM events WHERE project_key = @key OR item_id IN (SELECT id FROM items WHERE project_key = @key)',
        ),
      };
      // Items first: their dependents cascade (checklists, runs, packets, links, documents on items…).
      sql
        .prepare(
          'DELETE FROM events WHERE project_key = @key OR item_id IN (SELECT id FROM items WHERE project_key = @key)',
        )
        .run({ key: row.key });
      sql.prepare('DELETE FROM items WHERE project_key = ?').run(row.key);
      sql.prepare('DELETE FROM documents WHERE project_key = ?').run(row.key);
      sql.prepare('DELETE FROM labels WHERE project_key = ?').run(row.key);
      sql.prepare('DELETE FROM decision_records WHERE project_key = ?').run(row.key);
      // Decision 49: a revived key must not inherit this project's repository.
      sql.prepare('DELETE FROM project_git WHERE project_key = ?').run(row.key);
      w.update('projects', row.id, { deleted_at: w.now });
      w.event({
        type: 'project.updated',
        summary: `Deleted project ${row.name} (${row.key}): ${items(counts.items)}, ${counts.documents} ${counts.documents === 1 ? 'document' : 'documents'}`,
        project_key: row.key,
        data: {
          old: { deleted_at: null },
          new: { deleted_at: w.now },
          items: counts.items,
          documents: counts.documents,
          events: counts.events,
        },
        objects: [{ kind: 'project', id: row.key }],
      });
      return { deleted: true, key: row.key };
    },

    removeDeletedDocs(r) {
      const removed: string[] = [];
      const keys = (
        r.db.sqlite
          .prepare('SELECT key FROM projects WHERE deleted_at IS NOT NULL ORDER BY key')
          .all() as { key: string }[]
      ).map((p) => p.key);
      for (const key of keys) {
        const dir = join(deps.config.paths.docs, key);
        try {
          statSync(dir);
        } catch {
          continue; // Already gone.
        }
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
          removed.push(key);
        } catch (err) {
          deps.log(
            `Deleted project ${key}: its documents folder couldn't be removed (${(err as NodeJS.ErrnoException).code ?? 'error'}); retrying at the next start.`,
          );
        }
      }
      return Promise.resolve(removed);
    },

    // *New project* (decision 31; FR-135). Not undoable: no inverse.
    create(w, input) {
      if (w.actor.kind !== 'owner') {
        throw new ToolError(
          'forbidden',
          'Only the owner creates projects in Settings. Agents set one up with onboard_project.',
        );
      }
      return insertProject(w, deps.config.paths.docs, {
        key: input.key,
        name: input.name,
        color: input.color,
        default_satisfied_when: input.default_satisfied_when,
      });
    },
  };
}
