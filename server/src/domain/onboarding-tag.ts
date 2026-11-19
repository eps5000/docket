/**
 * Session tagging (owner decision 31; BUILD_SPEC §5.20; B30): which onboarding
 * session an event belongs to, so the review card can count what it changed.
 *
 * The rule: an event an agent writes is tagged with `data.onboarding_session`
 * when its project (the event's `project_key`, else its item's project) has a
 * session in progress started by the same client (`onboarding_sessions.client`,
 * the normalised MCP `clientInfo.name`). `agent_label` doesn't narrow it:
 * labels are optional and per call, a reconnecting agent may not repeat one,
 * and the same-client rule of `onboard_project` (MCP_SPEC §5.11) is per client
 * too. Owner and system events are never tagged. A run's events are tagged the
 * same way, since a run belongs to its caller's client.
 */
import type { Statement } from 'better-sqlite3';
import type { Db } from '../db/client.js';
import type { Actor } from './write.js';

const statements = new WeakMap<Db, { session: Statement; project: Statement }>();

function prepared(db: Db) {
  let s = statements.get(db);
  if (!s) {
    s = {
      session: db.sqlite.prepare(
        "SELECT id FROM onboarding_sessions WHERE project_key = ? AND client = ? AND state = 'in_progress'",
      ),
      project: db.sqlite.prepare('SELECT project_key FROM items WHERE id = ?'),
    };
    statements.set(db, s);
  }
  return s;
}

/** The in-progress session `actor` started on `projectKey`, or null. */
export function activeSessionOf(
  db: Db,
  actor: Pick<Actor, 'kind' | 'client'>,
  projectKey: string | null | undefined,
): string | null {
  if (actor.kind !== 'agent' || !actor.client || !projectKey) return null;
  const row = prepared(db).session.get(projectKey, actor.client) as { id: string } | undefined;
  return row?.id ?? null;
}

/** The session an event belongs to (see the rule above), or null. */
export function sessionForEvent(
  db: Db,
  actor: Pick<Actor, 'kind' | 'client'>,
  event: { project_key?: string | null; item_id?: string | null },
): string | null {
  if (actor.kind !== 'agent' || !actor.client) return null;
  let project = event.project_key ?? null;
  if (!project && event.item_id) {
    project =
      (prepared(db).project.get(event.item_id) as { project_key: string } | undefined)
        ?.project_key ?? null;
  }
  return activeSessionOf(db, actor, project);
}
