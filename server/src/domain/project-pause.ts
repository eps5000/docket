/**
 * Pause project (owner decision 53; BUILD_SPEC §5.37). A pause is an active,
 * owner-authority, project-scope decision record with `pauses_project` set:
 * nothing else stores it, so it survives a restart and withdrawing the record
 * from anywhere lifts it. Each project's pause is its own.
 *
 * - Every parked run in the project is held by it (decision-hold.ts).
 * - New claims and resumes are refused with `project_paused`; reads, notes,
 *   commits, parking, releasing and finishing keep working, and a write on a
 *   parked run records the work without resuming it.
 * - `pause_lifted_at` is when the owner lifted it, so aging restarts then.
 */
import { ToolError, type ProjectPause } from '@docket/shared';
import type { Db } from '../db/client.js';

/** The pause and its decision's title, which a held run's wait card shows. */
export type ActivePause = ProjectPause & { title: string };

interface PauseRow {
  id: string;
  project_key: string;
  title: string;
  decision_md: string;
  author: string;
  created_at: string;
}

const COLUMNS = 'id, project_key, title, decision_md, author, created_at';

const pauseOf = (row: PauseRow): ActivePause => ({
  decision_id: row.id,
  title: row.title,
  reason: row.decision_md,
  paused_by: row.author,
  paused_at: row.created_at,
});

/** The pause as the API shows it, without the decision title. */
export const publicPause = (p: ActivePause): ProjectPause => ({
  decision_id: p.decision_id,
  reason: p.reason,
  paused_by: p.paused_by,
  paused_at: p.paused_at,
});

/** The project's pause, or null when it isn't paused. */
export function projectPause(db: Db, project: string): ActivePause | null {
  const row = db.sqlite
    .prepare(
      `SELECT ${COLUMNS} FROM decision_records
       WHERE project_key = ? AND pauses_project = 1 AND status = 'active'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(project) as PauseRow | undefined;
  return row ? pauseOf(row) : null;
}

/** Every paused project's pause, for lists of projects. */
export function projectPauses(db: Db): Map<string, ProjectPause> {
  const out = new Map<string, ProjectPause>();
  for (const row of db.sqlite
    .prepare(
      `SELECT ${COLUMNS} FROM decision_records
       WHERE pauses_project = 1 AND status = 'active'
       ORDER BY created_at, id`,
    )
    .all() as PauseRow[]) {
    out.set(row.project_key, publicPause(pauseOf(row)));
  }
  return out;
}

/** When the owner last lifted a pause on this project; null if they never have. */
export function pauseLiftedAt(db: Db, project: string): string | null {
  const row = db.sqlite
    .prepare(
      `SELECT max(pause_lifted_at) AS at FROM decision_records
       WHERE project_key = ? AND pauses_project = 1`,
    )
    .get(project) as { at: string | null };
  return row.at;
}

const day = (at: string) => at.slice(0, 10);

/** What an agent working in the project reads: `get_context`, and a write on a parked run. */
export const pausedForAgents = (project: string, p: ProjectPause) =>
  `the owner paused ${project} on ${day(p.paused_at)}: ${p.reason}. Don't start new work. Save your work and park_run at the next safe point; only the owner can resume it.`;

/** The one line `get_digest` shows instead of next work. */
export const pausedForCoordinators = (project: string, p: ProjectPause) =>
  `the owner paused ${project} on ${day(p.paused_at)}: ${p.reason}. Don't dispatch or resume work here; ask the owner to resume it.`;

/** The result note when a write names a parked run of a paused project. */
export const pausedParkNote = (project: string) =>
  `${project} is paused: your work was recorded and this run stays parked until the owner resumes the project.`;

/** The refusal for a new claim, a resume, or new work under a parked run. */
export function projectPausedError(project: string, p: ProjectPause): ToolError {
  return new ToolError(
    'project_paused',
    `The owner paused ${project}: ${p.reason}. Nothing new can start here until the owner resumes it, so ask the owner or take work from another project.`,
    {
      details: {
        project,
        reason: p.reason,
        decision_id: p.decision_id,
        paused_by: p.paused_by,
        paused_at: p.paused_at,
        ask: 'the owner',
      },
    },
  );
}

/** Throw `project_paused` while the project is paused. */
export function assertNotPaused(db: Db, project: string): void {
  const pause = projectPause(db, project);
  if (pause) throw projectPausedError(project, pause);
}
