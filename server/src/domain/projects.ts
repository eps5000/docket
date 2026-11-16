/**
 * Projects: the blocker rule and delete together (BUILD_SPEC §5.2, §5.12): the `projects` service.
 *
 * US4 (T106) fills `setDefaultSatisfiedWhen`: Settings → "Blockers clear
 * when". Owner only; undoable; re-evaluates blocked state at once and
 * records `project.updated` with what changed. Deleting a project is US10's
 * (T118) and stays a stub here.
 */
import {
  SATISFIED_WHEN_LABELS,
  ToolError,
  type Project,
  type SatisfiedWhen,
} from '@tasklite/shared';
import { notImplemented, type ProjectsService, type ServiceDeps } from './contracts.js';
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

export function createProjectsService(_deps: ServiceDeps): ProjectsService {
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
    delete: notImplemented('projects.delete'),
    removeDeletedDocs: notImplemented('projects.removeDeletedDocs'),
  };
}
