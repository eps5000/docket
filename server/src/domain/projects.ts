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
 */
import { rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  SATISFIED_WHEN_LABELS,
  ToolError,
  type Project,
  type SatisfiedWhen,
} from '@tasklite/shared';
import type { ProjectsService, ServiceDeps } from './contracts.js';
import { blockDiff } from './links.js';
import { BlockIndex } from './model.js';

interface ProjectRow {
  id: string;
  key: string;
  name: string;
  short_name: string;
  color: string;
  default_satisfied_when: SatisfiedWhen;
  version: number;
}

const projectView = (p: ProjectRow): Project => ({
  key: p.key,
  name: p.name,
  short_name: p.short_name,
  color: p.color,
  default_satisfied_when: p.default_satisfied_when,
  version: p.version,
});

const items = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`;

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
      const rule = input.default_satisfied_when;
      if (row.default_satisfied_when === rule) {
        return { project: projectView(row), reblocked: [], unblocked: [] };
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
  };
}
